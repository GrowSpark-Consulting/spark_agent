import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getJson = vi.fn();
const postJson = vi.fn();
vi.mock("@/lib/api/client", () => ({ getJson: (...args: unknown[]) => getJson(...args), postJson: (...args: unknown[]) => postJson(...args) }));

const { BillingDataError, cancelPlan, changePlan, fetchAccountStatus, fetchCreditHistory, fetchPayment, fetchPlans, HISTORY_PAGE, isPaymentId, planRelation, reasonLabel, resumePlan, startCheckout, startSetupFee, startTopup } = await import("./billing-data");

const TENANT = "10000000-0000-4000-8000-000000000001";
const OTHER = "10000000-0000-4000-8000-000000000009";

const status = (over: Record<string, unknown> = {}) => ({
  status: "active",
  plan: { key: "growth", name: "Growth", monthlyCredits: 1500 },
  credits: { plan: 1000, topup: 100, total: 1100 },
  creditsGranted: 1600,
  renewsAt: "2026-11-01T00:00:00.000Z",
  trialEndsAt: null,
  aiPaused: false,
  aiPausedReason: null,
  lowCredits: false,
  aiAutoReply: true,
  ...over,
});

/** A query builder that answers the awaited call from `result` and records the calls. */
function fakeClient(result: { data: unknown; error: unknown }) {
  const calls: [string, unknown[]][] = [];
  const builder: Record<string, unknown> = {};
  for (const name of ["select", "eq", "order", "limit"]) {
    builder[name] = (...args: unknown[]) => {
      calls.push([name, args]);
      return builder;
    };
  }
  builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  const client = {
    from: (table: string) => {
      calls.push(["from", [table]]);
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

beforeEach(() => {
  getJson.mockReset();
  postJson.mockReset();
});

describe("fetchAccountStatus", () => {
  it("reads GET /api/billing/balance for this business and parses the shared shape", async () => {
    getJson.mockResolvedValueOnce(status());
    const read = await fetchAccountStatus(TENANT);
    expect(read.plan.name).toBe("Growth");
    expect(getJson).toHaveBeenLastCalledWith("/api/billing/balance", { tenantId: TENANT, signal: undefined });
  });

  it("refuses an answer that is not AccountStatus", async () => {
    getJson.mockResolvedValueOnce({ credits: { total: 5 } });
    await expect(fetchAccountStatus(TENANT)).rejects.toBeInstanceOf(BillingDataError);
    getJson.mockResolvedValueOnce(status({ aiPausedReason: "mystery" }));
    await expect(fetchAccountStatus(TENANT)).rejects.toBeInstanceOf(BillingDataError);
  });
});

describe("fetchPlans", () => {
  const row = (key: string, price: number) => ({ key, name: key.toUpperCase(), price_inr: price, monthly_credits: price * 2, seats: 3, whatsapp_numbers: 1 });

  it("lists the paid plans cheapest first, without the trial", async () => {
    const c = fakeClient({ data: [row("trial", 0), row("starter", 999), row("growth", 2499)], error: null });
    const plans = await fetchPlans(c.client);
    expect(c.calls).toContainEqual(["from", ["plans"]]);
    expect(c.calls).toContainEqual(["order", ["price_inr", { ascending: true }]]);
    expect(plans.map((p) => p.key)).toEqual(["starter", "growth"]);
    expect(plans[1]).toEqual({ key: "growth", name: "GROWTH", priceInr: 2499, monthlyCredits: 4998, seats: 3, whatsappNumbers: 1 });
  });

  it("fails on a bad shape and on a read error", async () => {
    await expect(fetchPlans(fakeClient({ data: [{ key: "x" }], error: null }).client)).rejects.toBeInstanceOf(BillingDataError);
    const boom = new Error("boom");
    await expect(fetchPlans(fakeClient({ data: null, error: boom }).client)).rejects.toBe(boom);
  });
});

describe("planRelation", () => {
  const plans = [
    { key: "starter", name: "Starter", priceInr: 999, monthlyCredits: 1, seats: 1, whatsappNumbers: 1 },
    { key: "growth", name: "Growth", priceInr: 2499, monthlyCredits: 1, seats: 1, whatsappNumbers: 1 },
    { key: "pro", name: "Pro", priceInr: 4999, monthlyCredits: 1, seats: 1, whatsappNumbers: 1 },
  ];
  it("compares by price, not by name", () => {
    expect(plans.map((p) => planRelation(p, { key: "growth" }, plans))).toEqual(["downgrade", "current", "upgrade"]);
  });
  it("treats every paid plan as a step up from a trial or a plan not in the catalogue", () => {
    expect(plans.map((p) => planRelation(p, null, plans))).toEqual(["upgrade", "upgrade", "upgrade"]);
    expect(plans.map((p) => planRelation(p, { key: "trial" }, plans))).toEqual(["upgrade", "upgrade", "upgrade"]);
  });
});

describe("reasonLabel", () => {
  it("words each reason the ledger uses", () => {
    expect(reasonLabel("plan_grant")).toBe("Monthly plan credits");
    expect(reasonLabel("topup")).toBe("Credit top-up");
    expect(reasonLabel("ai_reply")).toBe("AI reply");
  });
  it("shows a reason it doesn't know humanised, never hides it", () => {
    expect(reasonLabel("some_new_reason")).toBe("Some new reason");
    expect(reasonLabel("")).toBe("Other");
  });
});

describe("fetchCreditHistory", () => {
  const entry = (id: number, over: Record<string, unknown> = {}) => ({ id, tenant_id: TENANT, delta: -1, reason: "ai_reply", expires_at: null, created_at: `2026-10-1${id}T10:00:00.000Z`, ...over });

  it("reads this business's newest entries, newest first, and words each reason", async () => {
    const c = fakeClient({ data: [entry(2, { delta: 1000, reason: "topup", expires_at: "2027-01-01T00:00:00.000Z" }), entry(1)], error: null });
    const rows = await fetchCreditHistory(c.client, TENANT);
    expect(c.calls).toContainEqual(["from", ["credit_ledger"]]);
    expect(c.calls).toContainEqual(["eq", ["tenant_id", TENANT]]);
    expect(c.calls).toContainEqual(["order", ["created_at", { ascending: false }]]);
    expect(c.calls).toContainEqual(["limit", [HISTORY_PAGE]]);
    expect(rows.map((r) => [r.id, r.delta, r.label])).toEqual([["2", 1000, "Credit top-up"], ["1", -1, "AI reply"]]);
    expect(rows[0].expiresAt).toBe("2027-01-01T00:00:00.000Z");
  });

  it("drops a row that names another business even if one arrives", async () => {
    const rows = await fetchCreditHistory(fakeClient({ data: [entry(1, { tenant_id: OTHER }), entry(2)], error: null }).client, TENANT);
    expect(rows.map((r) => r.id)).toEqual(["2"]);
  });

  it("is empty with no activity, and fails on a bad shape or a read error", async () => {
    expect(await fetchCreditHistory(fakeClient({ data: [], error: null }).client, TENANT)).toEqual([]);
    await expect(fetchCreditHistory(fakeClient({ data: [{ id: 1 }], error: null }).client, TENANT)).rejects.toBeInstanceOf(BillingDataError);
    const boom = new Error("boom");
    await expect(fetchCreditHistory(fakeClient({ data: null, error: boom }).client, TENANT)).rejects.toBe(boom);
  });
});

// Paying -----------------------------------------------------------------------------------------------------------

const PAYMENT = "20000000-0000-4000-8000-000000000002";
const checkoutAnswer = { paymentId: PAYMENT, payu: { url: "https://test.payu.in/_payment", fields: { key: "k", txnid: "t", hash: "h" } } };
const paymentView = (over: Record<string, unknown> = {}) => ({ id: PAYMENT, kind: "topup", status: "success", amountInr: 1414.82, failureReason: null, createdAt: "2026-10-13T10:00:00.000Z", ...over });

describe("startCheckout", () => {
  it("POSTs { planKey, cycle } for this business and returns PayU's form details", async () => {
    postJson.mockResolvedValue(checkoutAnswer);
    expect(await startCheckout(TENANT, { planKey: "growth", cycle: "yearly" })).toEqual(checkoutAnswer);
    expect(postJson).toHaveBeenCalledWith("/api/billing/checkout", { planKey: "growth", cycle: "yearly" }, { tenantId: TENANT });
  });

  it("sends the phone only when there is one, and rejects a badly typed one before any request", async () => {
    postJson.mockResolvedValue(checkoutAnswer);
    await startCheckout(TENANT, { planKey: "starter", cycle: "monthly", phone: " +919840012345 " });
    expect(postJson).toHaveBeenCalledWith("/api/billing/checkout", { planKey: "starter", cycle: "monthly", phone: "+919840012345" }, { tenantId: TENANT });
    postJson.mockClear();
    await expect(startCheckout(TENANT, { planKey: "starter", cycle: "monthly", phone: "98400" })).rejects.toMatchObject({ name: "ZodError" });
    expect(postJson).not.toHaveBeenCalled();
  });

  it("rejects a plan the API does not sell, with no request", async () => {
    await expect(startCheckout(TENANT, { planKey: "enterprise" as never, cycle: "monthly" })).rejects.toMatchObject({ name: "ZodError" });
    expect(postJson).not.toHaveBeenCalled();
  });

  it("rejects an answer that is not PayU's form details, without putting the answer in the message", async () => {
    postJson.mockResolvedValue({ paymentId: PAYMENT, payu: { url: "https://x", fields: { hash: "SECRET-HASH", n: 1 } } });
    const err = await startCheckout(TENANT, { planKey: "growth", cycle: "monthly" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BillingDataError);
    expect((err as Error).message).not.toContain("SECRET-HASH");
  });
});

describe("startTopup and startSetupFee", () => {
  it("send no body unless a phone is given (the documented { phone? } or no body)", async () => {
    postJson.mockResolvedValue(checkoutAnswer);
    await startTopup(TENANT);
    await startSetupFee(TENANT);
    expect(postJson).toHaveBeenNthCalledWith(1, "/api/billing/topup", undefined, { tenantId: TENANT });
    expect(postJson).toHaveBeenNthCalledWith(2, "/api/billing/setup-fee", undefined, { tenantId: TENANT });
  });

  it("send { phone } when the server asked for one", async () => {
    postJson.mockResolvedValue(checkoutAnswer);
    await startTopup(TENANT, { phone: "+919840012345" });
    await startSetupFee(TENANT, { phone: "+919840012345" });
    expect(postJson).toHaveBeenNthCalledWith(1, "/api/billing/topup", { phone: "+919840012345" }, { tenantId: TENANT });
    expect(postJson).toHaveBeenNthCalledWith(2, "/api/billing/setup-fee", { phone: "+919840012345" }, { tenantId: TENANT });
  });

  it("reject a malformed answer and a bad phone", async () => {
    postJson.mockResolvedValue({ paymentId: PAYMENT });
    await expect(startTopup(TENANT)).rejects.toBeInstanceOf(BillingDataError);
    await expect(startSetupFee(TENANT)).rejects.toBeInstanceOf(BillingDataError);
    postJson.mockClear();
    await expect(startTopup(TENANT, { phone: "nope" })).rejects.toMatchObject({ name: "ZodError" });
    expect(postJson).not.toHaveBeenCalled();
  });
});

describe("changePlan", () => {
  it("POSTs { planKey } and reads each documented outcome", async () => {
    const answers = [
      { action: "upgrade", ...checkoutAnswer },
      { action: "scheduled", planKey: "starter", effectiveAt: "2026-11-01T00:00:00.000Z" },
      { action: "kept" },
      { action: "unchanged" },
    ];
    for (const answer of answers) {
      postJson.mockResolvedValueOnce(answer);
      expect(await changePlan(TENANT, { planKey: "starter" })).toEqual(answer);
    }
    expect(postJson).toHaveBeenCalledWith("/api/billing/change-plan", { planKey: "starter" }, { tenantId: TENANT });
  });

  it("rejects an outcome the contract does not have", async () => {
    postJson.mockResolvedValue({ action: "refunded" });
    await expect(changePlan(TENANT, { planKey: "pro" })).rejects.toBeInstanceOf(BillingDataError);
    postJson.mockResolvedValue({ action: "upgrade", paymentId: PAYMENT });
    await expect(changePlan(TENANT, { planKey: "pro" })).rejects.toBeInstanceOf(BillingDataError);
  });

  it("lets the API's refusal through untouched", async () => {
    const refusal = new Error("conflict");
    postJson.mockRejectedValue(refusal);
    await expect(changePlan(TENANT, { planKey: "pro" })).rejects.toBe(refusal);
  });
});

describe("cancelPlan and resumePlan", () => {
  it("cancel POSTs with no body for this business and reads both documented outcomes", async () => {
    for (const answer of [{ status: "scheduled", endsAt: "2026-11-01T00:00:00.000Z" }, { status: "ended" }]) {
      postJson.mockResolvedValueOnce(answer);
      expect(await cancelPlan(TENANT)).toEqual(answer);
    }
    expect(postJson).toHaveBeenCalledWith("/api/billing/cancel", undefined, { tenantId: TENANT });
  });

  it("resume POSTs with no body and reads { renewsAt }", async () => {
    postJson.mockResolvedValueOnce({ renewsAt: "2026-11-01T00:00:00.000Z" });
    expect(await resumePlan(TENANT)).toEqual({ renewsAt: "2026-11-01T00:00:00.000Z" });
    expect(postJson).toHaveBeenCalledWith("/api/billing/resume", undefined, { tenantId: TENANT });
  });

  it("rejects an answer the contract does not have, and lets the API's refusal through untouched", async () => {
    postJson.mockResolvedValueOnce({ status: "refunded" });
    await expect(cancelPlan(TENANT)).rejects.toBeInstanceOf(BillingDataError);
    postJson.mockResolvedValueOnce({ renewsAt: 5 });
    await expect(resumePlan(TENANT)).rejects.toBeInstanceOf(BillingDataError);
    const refusal = new Error("conflict");
    postJson.mockImplementationOnce(async () => {
      throw refusal;
    });
    await expect(cancelPlan(TENANT)).rejects.toBe(refusal);
  });
});

describe("fetchPayment", () => {
  it("GETs this payment for this business and returns the documented shape", async () => {
    getJson.mockResolvedValue(paymentView());
    expect(await fetchPayment(TENANT, PAYMENT)).toEqual(paymentView());
    expect(getJson).toHaveBeenCalledWith(`/api/billing/payments/${PAYMENT}`, { tenantId: TENANT, signal: undefined });
  });

  it("rejects an unknown status, a missing field and an answer for another payment", async () => {
    getJson.mockResolvedValue(paymentView({ status: "paid" }));
    await expect(fetchPayment(TENANT, PAYMENT)).rejects.toBeInstanceOf(BillingDataError);
    getJson.mockResolvedValue({ id: PAYMENT, status: "success" });
    await expect(fetchPayment(TENANT, PAYMENT)).rejects.toBeInstanceOf(BillingDataError);
    getJson.mockResolvedValue(paymentView({ id: "30000000-0000-4000-8000-000000000003" }));
    await expect(fetchPayment(TENANT, PAYMENT)).rejects.toBeInstanceOf(BillingDataError);
  });
});

describe("isPaymentId", () => {
  it("accepts the API's ids and refuses what PayU's return can carry instead", () => {
    expect(isPaymentId(PAYMENT)).toBe(true);
    expect(isPaymentId("unknown")).toBe(false);
    expect(isPaymentId("")).toBe(false);
    expect(isPaymentId("../balance")).toBe(false);
  });
});
