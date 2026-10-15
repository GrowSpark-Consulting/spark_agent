import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const send = vi.fn();
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: () => ({ rpc }) }));
vi.mock("../inngest/client", () => ({ inngest: { send } }));
const auditQuietly = vi.fn();
vi.mock("../lib/audit", () => ({ auditQuietly: (...args: unknown[]) => auditQuietly(...args) }));

const { createTrialTenant } = await import("./trial");

const USER = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const TENANT = "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f601";
const row = { tenant_id: TENANT, route_code: "TRIAL-7F3K", trial_ends_at: "2026-10-13T09:00:00+00:00", created: true };
const input = { userId: USER, name: "Sunrise Homes", vertical: "sample-pack" };

beforeEach(() => {
  rpc.mockReset().mockResolvedValue({ data: [row], error: null });
  send.mockReset().mockResolvedValue({ ids: ["evt"] });
  auditQuietly.mockReset();
});

describe("createTrialTenant", () => {
  it("creates the business in one call and returns its trial details", async () => {
    await expect(createTrialTenant({ ...input, name: "  Sunrise Homes " })).resolves.toEqual({
      tenantId: TENANT,
      routeCode: "TRIAL-7F3K",
      trialEndsAt: "2026-10-13T09:00:00+00:00",
      created: true,
    });
    expect(rpc).toHaveBeenCalledWith("create_trial_tenant", {
      p_user_id: USER,
      p_name: "Sunrise Homes",
      p_vertical: "sample-pack",
      p_timezone: "Asia/Kolkata",
    });
  });

  it("emits tenant.trial_started with the tenant id only and a fixed event id", async () => {
    await createTrialTenant(input);
    expect(send).toHaveBeenCalledWith({
      id: `trial_started:${TENANT}`,
      name: "tenant.trial_started",
      data: { tenantId: TENANT },
    });
  });

  it("re-sends the same event when the account's existing trial is returned", async () => {
    rpc.mockResolvedValue({ data: [{ ...row, created: false }], error: null });
    await expect(createTrialTenant(input)).resolves.toMatchObject({ tenantId: TENANT, created: false });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ id: `trial_started:${TENANT}` }));
  });

  it("audits the new business, naming the owner who signed up", async () => {
    await createTrialTenant(input);
    expect(auditQuietly).toHaveBeenCalledWith({ tenantId: TENANT, actor: USER, action: "tenant.created", entity: "tenant", entityId: TENANT, diff: { plan: "trial", vertical: "sample-pack" } });
  });

  it("audits nothing for a repeat signup: the business already existed", async () => {
    rpc.mockResolvedValue({ data: [{ ...row, created: false }], error: null });
    await createTrialTenant(input);
    expect(auditQuietly).not.toHaveBeenCalled();
  });

  it("still returns the funded business if the event cannot be sent", async () => {
    send.mockRejectedValue("inngest down");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(createTrialTenant(input)).resolves.toMatchObject({ tenantId: TENANT });
    expect(quiet).toHaveBeenCalledWith(expect.stringContaining("inngest down"));
    quiet.mockRestore();
  });

  it("rejects a vertical that is not a pack key before touching the database", async () => {
    await expect(createTrialTenant({ ...input, vertical: "Real Estate" })).rejects.toThrow();
    await expect(createTrialTenant({ ...input, vertical: "3d-studio" })).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a time zone that is not an IANA name", async () => {
    await expect(createTrialTenant({ ...input, timezone: "India Standard Time" })).rejects.toThrow();
    await expect(createTrialTenant({ ...input, timezone: "IST" })).rejects.toThrow();
    await expect(createTrialTenant({ ...input, timezone: "+05:30" })).rejects.toThrow();
    for (const timezone of ["Asia/Kolkata", "Asia/Calcutta", "Asia/Dubai", "UTC"]) {
      await expect(createTrialTenant({ ...input, timezone })).resolves.toMatchObject({ tenantId: TENANT });
    }
  });

  it("surfaces database errors", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "this account already owns a business" } });
    await expect(createTrialTenant(input)).rejects.toThrow("create_trial_tenant failed");
  });
});
