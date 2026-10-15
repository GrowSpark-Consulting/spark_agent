import { beforeEach, describe, expect, it, vi } from "vitest";

const insert = vi.fn();
const from = vi.fn(() => ({ insert }));
vi.mock("./supabase-admin", () => ({ supabaseAdmin: () => ({ from }) }));

const { auditQuietly, writeAudit } = await import("./audit");

const TENANT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const STAFF = "16fd2706-8baf-433b-82eb-8c7fada847da";
const SEEDED_DEMO_TENANT = "d0000000-0000-0000-0000-000000000001";
const inserted = () => insert.mock.calls[0][0];

beforeEach(() => {
  from.mockClear();
  insert.mockReset().mockResolvedValue({ data: null, error: null });
});

describe("writeAudit", () => {
  it("writes one row to audit_logs", async () => {
    await writeAudit({
      tenantId: TENANT,
      actor: STAFF,
      action: "feature.toggled",
      entity: "feature",
      diff: { key: "reminder_24h", enabled: { from: false, to: true } },
    });
    expect(from).toHaveBeenCalledWith("audit_logs");
    expect(inserted()).toEqual({
      tenant_id: TENANT,
      actor: STAFF,
      action: "feature.toggled",
      entity: "feature",
      entity_id: null,
      diff: { key: "reminder_24h", enabled: { from: false, to: true } },
    });
  });

  it("accepts ai, system, admin actors, platform actions and seeded ids", async () => {
    await writeAudit({ tenantId: SEEDED_DEMO_TENANT, actor: "ai", action: "lead.qualified" });
    await writeAudit({ tenantId: TENANT, actor: "system", action: "trial.expired" });
    await writeAudit({ tenantId: null, actor: `admin:${STAFF}`, action: "plan.updated" });
    expect(insert).toHaveBeenCalledTimes(3);
    expect(insert.mock.calls[2][0]).toMatchObject({ tenant_id: null, actor: `admin:${STAFF}`, diff: null });
  });

  it("masks phone numbers anywhere in the diff", async () => {
    await writeAudit({
      tenantId: TENANT,
      actor: STAFF,
      action: "contact.updated",
      diff: {
        phone: { from: "+919840012345", to: "919812345621" },
        notes: ["Call +919840012345 after 6"],
        amount: 8800000,
        bookedFor: "2026-10-07T10:30:00Z",
      },
    });
    expect(inserted().diff).toEqual({
      phone: { from: "+9198xxxxxx45", to: "+9198xxxxxx21" },
      notes: ["Call +9198xxxxxx45 after 6"],
      amount: 8800000,
      bookedFor: "2026-10-07T10:30:00Z",
    });
  });

  it("rejects a bad actor, action or tenant before touching the database", async () => {
    await expect(writeAudit({ tenantId: TENANT, actor: "raja", action: "feature.toggled" })).rejects.toThrow();
    await expect(writeAudit({ tenantId: TENANT, actor: STAFF, action: "Toggled feature" })).rejects.toThrow();
    await expect(writeAudit({ tenantId: "t1", actor: STAFF, action: "feature.toggled" })).rejects.toThrow();
    expect(insert).not.toHaveBeenCalled();
  });

  it("surfaces database errors", async () => {
    insert.mockResolvedValue({ data: null, error: { message: "permission denied" } });
    await expect(writeAudit({ tenantId: TENANT, actor: "system", action: "trial.expired" })).rejects.toThrow(
      "audit_logs insert failed",
    );
  });
});

describe("auditQuietly", () => {
  const entry = { tenantId: TENANT, actor: STAFF, action: "kb.faq_created", entity: "kb_faq" };

  it("writes the entry", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    await auditQuietly(entry, write);
    expect(write).toHaveBeenCalledWith(entry);
  });

  it("never fails the caller: a failed write is logged with the action and the error's kind, not its text", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(auditQuietly(entry, vi.fn().mockRejectedValue(new TypeError("fetch failed for +919812345621")))).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith("[audit] kb.faq_created was not recorded: TypeError");
    error.mockRestore();
  });
});
