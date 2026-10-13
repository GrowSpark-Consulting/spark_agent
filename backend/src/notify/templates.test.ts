import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeDbResponse } from "../test-support/fake-db";

const writeAudit = vi.fn<(entry: unknown) => Promise<void>>();
vi.mock("../lib/audit", () => ({ writeAudit }));

const { saveSubmittedTemplate } = await import("./templates");

const TENANT = "7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const CONNECTION = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const ROW = "5d6e7f80-9a1b-4c2d-8e3f-4a5b6c7d8e9f";

const components = [
  { type: "BODY", text: "Hi {{1}}, your visit is on {{2}}.", example: { body_text: [["Asha", "Sat 24 Oct"]] } },
  { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Confirm" }] },
];
const submitted = {
  connectionId: CONNECTION,
  name: "reminder_24h_v1",
  language: "ta",
  category: "UTILITY",
  components,
  meta: { id: "1234567890", status: "PENDING", category: "UTILITY" },
};

function db(over: { connection?: FakeDbResponse; saved?: FakeDbResponse } = {}) {
  return fakeDb({
    whatsapp_connections: over.connection ?? { data: [{ id: CONNECTION }], error: null },
    whatsapp_templates: over.saved ?? { data: { id: ROW, status: "pending" }, error: null },
  });
}
const upserted = (calls: ReturnType<typeof db>["calls"]) => calls.find((c) => c.table === "whatsapp_templates" && c.method === "upsert")?.args;

beforeEach(() => {
  writeAudit.mockReset();
  writeAudit.mockResolvedValue(undefined);
});

describe("saveSubmittedTemplate", () => {
  it("stores a submitted template as Meta answered, one row per number, name and language", async () => {
    const { client, calls } = db();
    expect(await saveSubmittedTemplate(TENANT, submitted, client)).toEqual({ id: ROW, status: "pending" });
    expect(upserted(calls)).toEqual([
      {
        tenant_id: TENANT,
        connection_id: CONNECTION,
        name: "reminder_24h_v1",
        language: "ta",
        category: "utility",
        components,
        status: "pending",
        rejection_reason: null,
        meta_template_id: "1234567890",
      },
      { onConflict: "connection_id,name,language" },
    ]);
    // Only a connection of this business.
    expect(calls.filter((c) => c.table === "whatsapp_connections" && c.method === "eq").map((c) => c.args)).toEqual([
      ["tenant_id", TENANT],
      ["id", CONNECTION],
    ]);
    expect(writeAudit).toHaveBeenCalledWith({
      tenantId: TENANT,
      actor: "system",
      action: "template.submitted",
      entity: "whatsapp_template",
      entityId: ROW,
      diff: { name: "reminder_24h_v1", language: "ta", status: "pending" },
    });
  });

  it("keeps Meta's status and category when Meta has already decided or recategorised", async () => {
    const { client, calls } = db();
    await saveSubmittedTemplate(TENANT, { ...submitted, meta: { id: "99", status: "APPROVED", category: "MARKETING" } }, client);
    expect(upserted(calls)?.[0]).toMatchObject({ status: "approved", category: "marketing" });

    const second = db();
    await saveSubmittedTemplate(TENANT, { ...submitted, meta: { id: "99", status: "IN_APPEAL" } }, second.client);
    expect(upserted(second.calls)?.[0]).toMatchObject({ status: "pending", category: "utility" });
  });

  it("accepts the components as the dashboard form submits them", async () => {
    const { client, calls } = db();
    const formShape = { body: "Thanks for visiting.", examples: [] };
    await saveSubmittedTemplate(TENANT, { ...submitted, components: formShape, actor: "0f1e2d3c-4b5a-4697-8877-665544332211" }, client);
    expect(upserted(calls)?.[0]).toMatchObject({ components: formShape });
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ actor: "0f1e2d3c-4b5a-4697-8877-665544332211" }));
  });

  it("refuses a connection of another business before writing anything", async () => {
    const { client, calls } = db({ connection: { data: [], error: null } });
    await expect(saveSubmittedTemplate(TENANT, submitted, client)).rejects.toThrow("does not belong to this business");
    expect(upserted(calls)).toBeUndefined();
  });

  it("refuses what is not a submitted template", async () => {
    const { client, calls } = db();
    await expect(saveSubmittedTemplate(TENANT, { ...submitted, name: "Reminder 24h" }, client)).rejects.toThrow();
    await expect(saveSubmittedTemplate(TENANT, { ...submitted, components: [{ type: "HEADER" }] }, client)).rejects.toThrow("body text");
    await expect(saveSubmittedTemplate(TENANT, { ...submitted, meta: { id: "" } }, client)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("still returns the saved row when the audit row cannot be written", async () => {
    writeAudit.mockRejectedValue(new Error("audit_logs insert failed"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(saveSubmittedTemplate(TENANT, submitted, db().client)).resolves.toEqual({ id: ROW, status: "pending" });
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`audit row not written for template ${ROW}`));
    error.mockRestore();
  });

  it("throws when the save fails, so the caller can retry", async () => {
    const { client } = db({ saved: { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } } });
    await expect(saveSubmittedTemplate(TENANT, submitted, client)).rejects.toThrow("saveSubmittedTemplate: save failed");
    expect(writeAudit).not.toHaveBeenCalled();
  });
});
