import { describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeDbResponse } from "../test-support/fake-db";
import { editFeature, editPlan, extendTrial, grantCredits, listTenants, refundCandidates, type AdminDeps } from "./admin";

const ADMIN = { actor: "admin:0f1e2d3c-4b5a-4697-8877-665544332211" };
const TENANT = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const NOW = new Date("2026-10-14T05:30:00Z");

function deps(tables: Record<string, FakeDbResponse | FakeDbResponse[]>) {
  const db = fakeDb(tables);
  const invalidate = vi.fn();
  const d: AdminDeps = { db: db.client, now: () => NOW, invalidate };
  return { d, calls: db.calls, invalidate };
}
const rpcArgs = (calls: ReturnType<typeof deps>["calls"], name: string) => calls.find((c) => c.table === `rpc:${name}`)?.args[0];

describe("the business list", () => {
  it("maps each business, its live subscription and the setup-fee flag", async () => {
    const { d } = deps({
      "rpc:admin_tenants": {
        data: [
          { tenant_id: TENANT, name: "Skyline Homes", vertical: "real-estate", status: "active", plan_key: "growth", trial_ends_at: null, created_at: "2026-10-01T05:00:00+00:00", setup_call_paid_at: "2026-10-02T05:00:00+00:00", credits: 4200, subscription_status: "active", billing_cycle: "monthly", current_period_end: "2026-11-01T05:00:00+00:00", members: 3, active_numbers: 1 },
          { tenant_id: "t-2", name: "New trial", vertical: "salon", status: "trial", plan_key: "trial", trial_ends_at: "2026-10-20T05:00:00+00:00", created_at: "2026-10-13T05:00:00+00:00", setup_call_paid_at: null, credits: null, subscription_status: null, billing_cycle: null, current_period_end: null, members: 1, active_numbers: 0 },
        ],
        error: null,
      },
    });
    const list = await listTenants(ADMIN, d);
    expect(list[0]).toEqual({
      id: TENANT,
      name: "Skyline Homes",
      vertical: "real-estate",
      status: "active",
      planKey: "growth",
      trialEndsAt: null,
      createdAt: "2026-10-01T05:00:00.000Z",
      setupCallPaidAt: "2026-10-02T05:00:00.000Z",
      credits: 4200,
      subscription: { status: "active", cycle: "monthly", periodEnd: "2026-11-01T05:00:00.000Z" },
      members: 3,
      activeNumbers: 1,
    });
    expect(list[1]).toMatchObject({ status: "trial", credits: 0, subscription: null, trialEndsAt: "2026-10-20T05:00:00.000Z" });
  });
});

describe("extending a trial", () => {
  it("passes the days and the admin, and returns the new end", async () => {
    const { d, calls } = deps({ "rpc:admin_extend_trial": { data: "2026-10-21T05:30:00+00:00", error: null } });
    expect(await extendTrial(ADMIN, TENANT, { days: 7 }, d)).toEqual({ trialEndsAt: "2026-10-21T05:30:00.000Z" });
    expect(rpcArgs(calls, "admin_extend_trial")).toEqual({ p_tenant_id: TENANT, p_days: 7, p_actor: ADMIN.actor });
  });

  it("refuses a business with a plan, an unknown one, and days out of range before asking the database", async () => {
    const paid = deps({ "rpc:admin_extend_trial": { data: null, error: { code: "PA409", message: "admin_extend_trial: the business is not on a trial" } } });
    await expect(extendTrial(ADMIN, TENANT, { days: 7 }, paid.d)).rejects.toMatchObject({ code: "conflict" });
    const gone = deps({ "rpc:admin_extend_trial": { data: null, error: { code: "PA404", message: "admin_extend_trial: unknown business" } } });
    await expect(extendTrial(ADMIN, TENANT, { days: 7 }, gone.d)).rejects.toMatchObject({ code: "not_found" });
    const none = deps({});
    await expect(extendTrial(ADMIN, TENANT, { days: 31 }, none.d)).rejects.toThrow();
    await expect(extendTrial(ADMIN, "not-a-uuid", { days: 7 }, none.d)).rejects.toMatchObject({ code: "not_found" });
    expect(none.calls).toHaveLength(0);
  });
});

describe("granting credits", () => {
  it("grants with an expiry counted from now and the request id, and returns the new balance", async () => {
    const { d, calls } = deps({ "rpc:admin_grant_credits": { data: true, error: null }, "rpc:credit_balance": { data: [{ plan: 0, topup: 0, total: 800 }], error: null } });
    const requestId = "0b800000-0000-4000-8000-000000000001";
    expect(await grantCredits(ADMIN, TENANT, { amount: 500, expiresInDays: 30, note: "Goodwill", requestId }, d)).toEqual({ granted: true, credits: 800 });
    expect(rpcArgs(calls, "admin_grant_credits")).toEqual({
      p_tenant_id: TENANT,
      p_amount: 500,
      p_expires_at: "2026-11-13T05:30:00.000Z",
      p_request_id: requestId,
      p_note: "Goodwill",
      p_actor: ADMIN.actor,
    });
  });

  it("says when a repeated request granted nothing, and that credits without an expiry never expire", async () => {
    const { d, calls } = deps({ "rpc:admin_grant_credits": { data: false, error: null }, "rpc:credit_balance": { data: [{ plan: 0, topup: 0, total: 300 }], error: null } });
    expect(await grantCredits(ADMIN, TENANT, { amount: 500 }, d)).toEqual({ granted: false, credits: 300 });
    expect(rpcArgs(calls, "admin_grant_credits")).toMatchObject({ p_expires_at: null, p_request_id: null, p_note: null });
    await expect(grantCredits(ADMIN, TENANT, { amount: 0 }, deps({}).d)).rejects.toThrow();
  });
});

describe("plans and features", () => {
  const planRow = { key: "starter", name: "Starter", price_inr: 2699, monthly_credits: 1500, seats: 2, whatsapp_numbers: 1, feature_keys: ["ai_auto_reply"] };

  it("edits a plan, leaving out what was not sent, and refreshes feature states", async () => {
    const { d, calls, invalidate } = deps({ "rpc:admin_update_plan": { data: [planRow], error: null } });
    expect(await editPlan(ADMIN, "starter", { priceInr: 2699 }, d)).toEqual({ key: "starter", name: "Starter", priceInr: 2699, monthlyCredits: 1500, seats: 2, whatsappNumbers: 1, featureKeys: ["ai_auto_reply"] });
    expect(rpcArgs(calls, "admin_update_plan")).toEqual({ p_key: "starter", p_name: null, p_price_inr: 2699, p_monthly_credits: null, p_seats: null, p_whatsapp_numbers: null, p_feature_keys: null, p_actor: ADMIN.actor });
    expect(invalidate).toHaveBeenCalled();
  });

  it("explains why a price can't change while businesses are subscribed, and refuses an empty change", async () => {
    const { d } = deps({ "rpc:admin_update_plan": { data: null, error: { code: "PA409", message: "admin_update_plan: businesses are subscribed at this price" } } });
    await expect(editPlan(ADMIN, "growth", { priceInr: 6499 }, d)).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("auto-debits were approved") });
    await expect(editPlan(ADMIN, "growth", {}, deps({}).d)).rejects.toThrow();
    const bad = deps({ "rpc:admin_update_plan": { data: null, error: { code: "P0001", message: "admin_update_plan: no_such is not a feature" } } });
    await expect(editPlan(ADMIN, "growth", { featureKeys: ["no_such"] }, bad.d)).rejects.toMatchObject({ code: "validation_failed", message: "No_such is not a feature." });
  });

  it("edits a feature and refreshes feature states", async () => {
    const { d, invalidate } = deps({ "rpc:admin_update_feature": { data: [{ key: "ai_auto_reply", name: "AI replies", description: "The assistant replies.", default_on: false }], error: null } });
    expect(await editFeature(ADMIN, "ai_auto_reply", { defaultOn: false }, d)).toEqual({ key: "ai_auto_reply", name: "AI replies", description: "The assistant replies.", defaultOn: false });
    expect(invalidate).toHaveBeenCalled();
  });
});

describe("payments to refund", () => {
  it("lists flagged payments in rupees with their PayU id", async () => {
    const { d } = deps({
      "rpc:admin_refund_candidates": {
        data: [{ payment_id: "p-1", tenant_id: TENANT, tenant_name: "Skyline Homes", kind: "setup_fee", amount_paise: 589882, provider_payment_id: "mih-2", method: "CC", paid_at: "2026-10-14T05:00:00+00:00", flagged_at: "2026-10-14T05:00:01+00:00" }],
        error: null,
      },
    });
    expect(await refundCandidates(ADMIN, d)).toEqual([
      { paymentId: "p-1", tenantId: TENANT, tenantName: "Skyline Homes", kind: "setup_fee", amountInr: 5898.82, providerPaymentId: "mih-2", method: "CC", paidAt: "2026-10-14T05:00:00.000Z", flaggedAt: "2026-10-14T05:00:01.000Z" },
    ]);
  });
});
