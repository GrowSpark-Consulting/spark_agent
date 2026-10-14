import { beforeEach, describe, expect, it, vi } from "vitest";

const getJson = vi.fn();
const postJson = vi.fn();
vi.mock("@/lib/api/client", () => ({ getJson: (...a: unknown[]) => getJson(...a), postJson: (...a: unknown[]) => postJson(...a) }));

const { AdminDataError, extendTrial, fetchAdminTenants, fetchRefundCandidates, grantCredits, validateDays, validateGrant } = await import("./billing");

const TENANT = "10000000-0000-0000-0000-000000000004";
const REQUEST = "20000000-0000-4000-8000-000000000001";
const tenant = { id: TENANT, name: "Skyline", vertical: "re", status: "trial", planKey: "trial", trialEndsAt: "2026-10-20T00:00:00Z", createdAt: "2026-10-01T00:00:00Z", setupCallPaidAt: null, credits: 300, subscription: null, members: 1, activeNumbers: 0 };

beforeEach(() => {
  getJson.mockReset();
  postJson.mockReset();
});

describe("admin reads", () => {
  it("reads the businesses and refunds from the documented paths, with no business header", async () => {
    getJson.mockResolvedValueOnce([tenant]).mockResolvedValueOnce([]);
    expect(await fetchAdminTenants()).toHaveLength(1);
    expect(await fetchRefundCandidates()).toEqual([]);
    expect(getJson.mock.calls.map((c) => c[0])).toEqual(["/api/admin/tenants", "/api/admin/payments/refunds"]);
    for (const c of getJson.mock.calls) expect(c[1].tenantId).toBeUndefined();
  });

  it("refuses an answer that is not the contract's shape instead of showing it", async () => {
    getJson.mockResolvedValue([{ ...tenant, credits: "many" }]);
    await expect(fetchAdminTenants()).rejects.toBeInstanceOf(AdminDataError);
  });
});

describe("extendTrial", () => {
  it("posts { days } to the business's path", async () => {
    postJson.mockResolvedValue({ trialEndsAt: "2026-10-27T00:00:00Z" });
    expect(await extendTrial(TENANT, { days: 7 })).toEqual({ trialEndsAt: "2026-10-27T00:00:00Z" });
    expect(postJson).toHaveBeenCalledWith(`/api/admin/tenants/${TENANT}/extend-trial`, { days: 7 });
  });

  it("sends nothing for days outside 1 to 30, and passes a server refusal on", async () => {
    await expect(extendTrial(TENANT, { days: 31 })).rejects.toBeInstanceOf(AdminDataError);
    expect(postJson).not.toHaveBeenCalled();
    postJson.mockRejectedValue(new Error("conflict"));
    await expect(extendTrial(TENANT, { days: 3 })).rejects.toThrow("conflict");
  });
});

describe("grantCredits", () => {
  it("posts the grant with its request id", async () => {
    postJson.mockResolvedValue({ granted: true, credits: 800 });
    const r = await grantCredits(TENANT, { amount: 500, expiresInDays: 30, note: "Goodwill", requestId: REQUEST });
    expect(r).toEqual({ granted: true, credits: 800 });
    expect(postJson).toHaveBeenCalledWith(`/api/admin/tenants/${TENANT}/credits`, { amount: 500, expiresInDays: 30, note: "Goodwill", requestId: REQUEST });
  });

  it("sends nothing for an amount outside 1 to 100,000", async () => {
    await expect(grantCredits(TENANT, { amount: 0 })).rejects.toBeInstanceOf(AdminDataError);
    await expect(grantCredits(TENANT, { amount: 100001 })).rejects.toBeInstanceOf(AdminDataError);
    expect(postJson).not.toHaveBeenCalled();
  });
});

describe("form validation", () => {
  it("checks the days", () => {
    expect(validateDays("7")).toEqual({ value: 7 });
    for (const t of ["", "0", "31", "2.5", "abc"]) expect(validateDays(t).error, t).toBeTruthy();
  });

  it("checks the grant and drops blank optional fields", () => {
    expect(validateGrant("500", "", "  ")).toEqual({ value: { amount: 500 }, fields: {} });
    expect(validateGrant("500", "30", " thanks ").value).toEqual({ amount: 500, expiresInDays: 30, note: "thanks" });
    expect(validateGrant("", "", "").fields.amount).toBeTruthy();
    expect(validateGrant("0", "", "").fields.amount).toBeTruthy();
    expect(validateGrant("5", "400", "").fields.expiresInDays).toBeTruthy();
    expect(validateGrant("5", "", "x".repeat(201)).fields.note).toBeTruthy();
  });
});
