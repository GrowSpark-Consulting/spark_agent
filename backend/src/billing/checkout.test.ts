import type { TenantContext } from "@pakka/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeDbResponse } from "../test-support/fake-db";
import type { FetchLike, PayuConfig } from "./payu";

const invalidateFeatureCache = vi.fn<(tenantId?: string) => void>();
vi.mock("../features/is-enabled", () => ({ invalidateFeatureCache }));

const { cancelPlan, changePlan, handlePayuReturn, handlePayuWebhook, paymentStatus, resumePlan, startCheckout, startSetupFee, startTopup, syncPayment } = await import("./checkout");
type Deps = Parameters<typeof startCheckout>[2] & object;

const TENANT = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const OWNER = "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b";
const PAYMENT = "8e9f0a1b-2c3d-4e5f-8a7b-9c0d1e2f3a4b";
const NOW = new Date("2026-10-13T06:00:00Z");
const payu: PayuConfig = { key: "testkey", salt: "testsalt", mode: "test" };

const context = (role: TenantContext["role"] = "owner"): TenantContext => ({
  user: { id: OWNER, email: "owner@skyline.test" },
  role,
  tenant: { id: TENANT, name: "Skyline Homes", vertical: "real-estate", timezone: "Asia/Kolkata", status: "trial", planKey: "trial", trialEndsAt: null },
});

const plan = (key: string, name: string, price: number, credits: number): FakeDbResponse => ({ data: { key, name, price_inr: price, monthly_credits: credits }, error: null });
const ownerPhone: FakeDbResponse = { data: { whatsapp_phone: "+919800000001" }, error: null };

/** A PayU that answers verify_payment for txnid with `detail` (or nothing for an unknown payment). */
function payuAnswering(detail: Record<string, unknown> | null) {
  return vi.fn<FetchLike>(async (_url, init) => {
    const txnid = new URLSearchParams(init.body).get("var1") ?? "";
    const answer = detail ? { status: 1, transaction_details: { [txnid]: detail } } : { status: 0, transaction_details: { [txnid]: { status: "Not Found" } } };
    return { ok: true, status: 200, json: async () => answer };
  });
}

function deps(tables: Record<string, FakeDbResponse | FakeDbResponse[]>, over: Partial<Deps> = {}) {
  const db = fakeDb(tables);
  const d: Deps = { db: db.client, payu, apiPublicUrl: "https://api.spark.test", appUrl: "https://app.spark.test", now: () => NOW, fetch: payuAnswering(null), ...over };
  return { d, calls: db.calls };
}
const rpcArgs = (calls: ReturnType<typeof deps>["calls"], name: string) => calls.find((c) => c.table === `rpc:${name}`)?.args[0] as Record<string, unknown> | undefined;

beforeEach(() => invalidateFeatureCache.mockReset());

describe("POST /api/billing/checkout", () => {
  const tables = { plans: plan("starter", "Starter", 2499, 1500), memberships: ownerPhone, "rpc:begin_payment": { data: PAYMENT, error: null } };

  it("records the plan's first payment and returns PayU's checkout with the auto-debit approval", async () => {
    const { d, calls } = deps(tables);
    const out = await startCheckout(context(), { planKey: "starter", cycle: "monthly" }, d);
    expect(out.paymentId).toBe(PAYMENT);
    expect(rpcArgs(calls, "begin_payment")).toMatchObject({
      p_tenant_id: TENANT,
      p_kind: "subscribe",
      p_base_paise: 2499_00,
      p_gst_paise: 449_82,
      p_credits: 1500,
      p_plan_key: "starter",
      p_billing_cycle: "monthly",
      p_created_by: OWNER,
    });
    expect(out.payu.url).toBe("https://test.payu.in/_payment");
    expect(out.payu.fields).toMatchObject({
      amount: "2948.82",
      productinfo: "Spark Agent Starter plan (monthly)",
      firstname: "Skyline Homes",
      email: "owner@skyline.test",
      phone: "+919800000001",
      surl: "https://api.spark.test/api/billing/payu/return",
      furl: "https://api.spark.test/api/billing/payu/return",
      si: "4",
      api_version: "7",
    });
    expect(JSON.parse(out.payu.fields.si_details)).toMatchObject({ billingAmount: "2948.82", billingCycle: "MONTHLY", paymentStartDate: "2026-10-13", paymentEndDate: "2036-10-13" });
    expect(out.payu.fields.txnid).toBe(rpcArgs(calls, "begin_payment")?.p_txnid);
  });

  it("charges ten months for a year, and offers cards and net banking only above the auto-debit limit", async () => {
    const yearly = deps(tables);
    const out = await startCheckout(context(), { planKey: "starter", cycle: "yearly", phone: "+919800000009" }, yearly.d);
    expect(rpcArgs(yearly.calls, "begin_payment")).toMatchObject({ p_base_paise: 24990_00, p_billing_cycle: "yearly" });
    expect(out.payu.fields).toMatchObject({ phone: "+919800000009", enforce_paymethod: "creditcard|debitcard|netbanking" });
    expect(yearly.calls.some((c) => c.table === "memberships")).toBe(false);

    const pro = deps({ ...tables, plans: plan("pro", "Pro", 12999, 15000) });
    expect((await startCheckout(context(), { planKey: "pro", cycle: "monthly" }, pro.d)).payu.fields.enforce_paymethod).toBe("creditcard|debitcard|netbanking");
    const growth = deps({ ...tables, plans: plan("growth", "Growth", 5999, 5000) });
    expect((await startCheckout(context(), { planKey: "growth", cycle: "monthly" }, growth.d)).payu.fields.enforce_paymethod).toBeUndefined();
  });

  it("is for the owner only, and says when payments are not switched on", async () => {
    for (const role of ["admin", "staff"] as const) {
      await expect(startCheckout(context(role), { planKey: "starter", cycle: "monthly" }, deps(tables).d)).rejects.toMatchObject({ code: "forbidden" });
    }
    await expect(startCheckout(context(), { planKey: "starter", cycle: "monthly" }, deps(tables, { payu: null }).d)).rejects.toMatchObject({ code: "not_available" });
    await expect(startCheckout(context(), { planKey: "starter", cycle: "monthly" }, deps(tables, { apiPublicUrl: undefined }).d)).rejects.toMatchObject({ code: "not_available" });
  });

  it("refuses the trial plan, a missing phone, and a second plan", async () => {
    await expect(startCheckout(context(), { planKey: "trial", cycle: "monthly" }, deps(tables).d)).rejects.toThrow();
    await expect(startCheckout(context(), { planKey: "starter", cycle: "monthly" }, deps({ ...tables, memberships: { data: { whatsapp_phone: null }, error: null } }).d)).rejects.toMatchObject({
      code: "validation_failed",
      fields: { phone: expect.any(String) },
    });
    const taken = deps({ ...tables, "rpc:begin_payment": { data: null, error: { code: "PA409", message: "begin_payment: the business already has a plan" } } });
    await expect(startCheckout(context(), { planKey: "starter", cycle: "monthly" }, taken.d)).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("Change it from Billing") });
  });
});

describe("POST /api/billing/topup and /setup-fee", () => {
  const tables = { memberships: ownerPhone, "rpc:begin_payment": { data: PAYMENT, error: null } };

  it("sells the 1,000-credit pack as a one-time payment", async () => {
    const { d, calls } = deps(tables);
    const out = await startTopup(context(), {}, d);
    expect(rpcArgs(calls, "begin_payment")).toMatchObject({ p_kind: "topup", p_base_paise: 1199_00, p_gst_paise: 215_82, p_credits: 1000 });
    expect(out.payu.fields).toMatchObject({ amount: "1414.82", productinfo: "Spark Agent top-up: 1,000 credits" });
    expect(out.payu.fields.si).toBeUndefined();
  });

  it("sells the setup fee once, granting no credits", async () => {
    const { d, calls } = deps(tables);
    await startSetupFee(context(), undefined, d);
    expect(rpcArgs(calls, "begin_payment")).toMatchObject({ p_kind: "setup_fee", p_base_paise: 4999_00, p_credits: null });
    const paid = deps({ ...tables, "rpc:begin_payment": { data: null, error: { code: "PA409", message: "already paid" } } });
    await expect(startSetupFee(context(), {}, paid.d)).rejects.toMatchObject({ code: "conflict" });
  });

  it("tells a trial business to choose a plan instead of topping up", async () => {
    const trial = deps({ ...tables, "rpc:begin_payment": { data: null, error: { code: "PA409", message: "top-ups are for a business on a paid plan" } } });
    await expect(startTopup(context(), {}, trial.d)).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("Choose a plan first") });
  });
});

describe("verifying a payment with PayU", () => {
  const open: FakeDbResponse = { data: { id: PAYMENT, status: "created" }, error: null };
  const settled = (kind: string, status: string, applied = true): FakeDbResponse => ({ data: [{ payment_id: PAYMENT, tenant_id: TENANT, kind, status, applied }], error: null });
  const paid = { mihpayid: "25599222315", status: "success", unmappedstatus: "captured", mode: "UPI", amt: "2948.82", transaction_amount: "2948.82" };

  it("applies what PayU says, passing the amount only for a success, and refreshes features after a new plan", async () => {
    const { d, calls } = deps({ payments: [open, { data: { subscriptions: { replaces_subscription_id: null } }, error: null }], "rpc:settle_payment": settled("subscribe", "success") }, { fetch: payuAnswering(paid) });
    expect(await syncPayment("S1abc", d)).toEqual({ paymentId: PAYMENT, status: "success" });
    expect(rpcArgs(calls, "settle_payment")).toEqual({ p_txnid: "S1abc", p_state: "success", p_provider_payment_id: "25599222315", p_method: "UPI", p_amount_paise: 2948_82, p_reason: null });
    expect(invalidateFeatureCache).toHaveBeenCalledWith(TENANT);

    const failed = deps({ payments: open, "rpc:settle_payment": settled("topup", "failed") }, { fetch: payuAnswering({ mihpayid: "1", status: "failure", error_Message: "Bank was unable to authenticate.", amt: "1414.82" }) });
    await syncPayment("T1abc", failed.d);
    expect(rpcArgs(failed.calls, "settle_payment")).toMatchObject({ p_state: "failed", p_amount_paise: null, p_reason: "Bank was unable to authenticate." });
    expect(invalidateFeatureCache).toHaveBeenCalledTimes(1);
  });

  it("does not ask PayU about a payment that is final, or one that isn't ours", async () => {
    const fetch = payuAnswering(paid);
    const { d } = deps({ payments: { data: { id: PAYMENT, status: "success" }, error: null } }, { fetch });
    expect(await syncPayment("S1abc", d)).toEqual({ paymentId: PAYMENT, status: "success" });
    expect(await syncPayment("not-ours!", d)).toBeNull();
    expect(await syncPayment("Sother", deps({ payments: { data: null, error: null } }, { fetch }).d)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("applies nothing, and says so in the log, when PayU's amount is not ours", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { d } = deps({ payments: open, "rpc:settle_payment": { data: null, error: { code: "PA422", message: "settle_payment: PayU reports 100 paise" } } }, { fetch: payuAnswering(paid) });
    expect(await syncPayment("S1abc", d)).toEqual({ paymentId: PAYMENT, status: "created" });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("does not match"));
    error.mockRestore();
  });
});

describe("PayU's return URL and webhook", () => {
  const form = (fields: Record<string, string>) => new Request("https://api.spark.test/api/billing/payu/return", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });

  it("ignores the status posted to it, verifies with PayU, then sends the payer to the Billing screen", async () => {
    const { d, calls } = deps(
      { payments: { data: { id: PAYMENT, status: "created" }, error: null }, "rpc:settle_payment": { data: [{ payment_id: PAYMENT, tenant_id: TENANT, kind: "topup", status: "failed", applied: true }], error: null } },
      { fetch: payuAnswering({ mihpayid: "9", status: "failure", error_Message: "Cancelled by user" }) },
    );
    const response = await handlePayuReturn(form({ txnid: "T1abc", status: "success", hash: "forged" }), d);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`https://app.spark.test/dashboard/billing?payment=${PAYMENT}`);
    expect(rpcArgs(calls, "settle_payment")).toMatchObject({ p_txnid: "T1abc", p_state: "failed" });
  });

  it("still sends the payer back when PayU cannot be asked yet (the screen's polling asks again)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const down = vi.fn<FetchLike>(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    const { d } = deps({ payments: [{ data: { id: PAYMENT, status: "created" }, error: null }, { data: { id: PAYMENT }, error: null }] }, { fetch: down });
    const response = await handlePayuReturn(form({ txnid: "T1abc" }), d);
    expect(response.headers.get("location")).toBe(`https://app.spark.test/dashboard/billing?payment=${PAYMENT}`);
    expect((await handlePayuReturn(form({}), deps({}).d)).headers.get("location")).toBe("https://app.spark.test/dashboard/billing?payment=unknown");
    error.mockRestore();
  });

  it("answers the webhook 200 once handled or not ours, and 503 while PayU cannot be asked, so it retries", async () => {
    const json = (body: unknown) => new Request("https://api.spark.test/api/webhooks/payu", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await handlePayuWebhook(json({ txnid: "Sother" }), deps({ payments: { data: null, error: null } }).d)).status).toBe(200);
    expect((await handlePayuWebhook(json({ hello: "world" }), deps({}).d)).status).toBe(200);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const down = vi.fn<FetchLike>(async () => ({ ok: false, status: 502, json: async () => ({}) }));
    expect((await handlePayuWebhook(json({ txnid: "T1abc" }), deps({ payments: { data: { id: PAYMENT, status: "pending" }, error: null } }, { fetch: down }).d)).status).toBe(503);
    error.mockRestore();
  });
});

describe("GET /api/billing/payments/:id", () => {
  const row = (status: string, updatedAt: string) => ({
    data: { id: PAYMENT, txnid: "T1abc", kind: "topup", status, amount_paise: 1414_82, failure_reason: null, created_at: "2026-10-13T05:59:00+00:00", updated_at: updatedAt },
    error: null,
  });

  it("shows a final payment as stored, without asking PayU", async () => {
    const fetch = payuAnswering(null);
    const { d } = deps({ payments: row("success", "2026-10-13T05:59:30+00:00") }, { fetch });
    expect(await paymentStatus(context("staff"), PAYMENT, d)).toEqual({
      id: PAYMENT,
      kind: "topup",
      status: "success",
      amountInr: 1414.82,
      failureReason: null,
      createdAt: "2026-10-13T05:59:00.000Z",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("asks PayU again for an open payment, at most every few seconds", async () => {
    const recent = deps({ payments: row("created", "2026-10-13T05:59:58+00:00") });
    await paymentStatus(context(), PAYMENT, recent.d);
    expect(recent.calls.some((c) => c.table === "rpc:settle_payment")).toBe(false);

    const old = deps(
      {
        payments: [row("created", "2026-10-13T05:59:00+00:00"), { data: { id: PAYMENT, status: "created" }, error: null }, row("success", "2026-10-13T06:00:00+00:00")],
        "rpc:settle_payment": { data: [{ payment_id: PAYMENT, tenant_id: TENANT, kind: "topup", status: "success", applied: true }], error: null },
      },
      { fetch: payuAnswering({ mihpayid: "7", status: "success", amt: "1414.82" }) },
    );
    expect((await paymentStatus(context(), PAYMENT, old.d)).status).toBe("success");
    expect(old.calls.filter((c) => c.table === "payments" && c.method === "eq").map((c) => c.args)).toContainEqual(["tenant_id", TENANT]);
  });

  it("does not know another business's payment, or an id that isn't one", async () => {
    await expect(paymentStatus(context(), PAYMENT, deps({ payments: { data: null, error: null } }).d)).rejects.toMatchObject({ code: "not_found" });
    await expect(paymentStatus(context(), "nope", deps({}).d)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("POST /api/billing/change-plan", () => {
  const live = (cycle = "monthly", cancelAt: string | null = null): FakeDbResponse => ({ data: { billing_cycle: cycle, cancel_at: cancelAt }, error: null });
  const change = (action: string, extra: Record<string, unknown> = {}): FakeDbResponse => ({
    data: [{ action, payment_id: null, amount_paise: null, mandate_paise: null, effective_at: "2026-10-28T06:00:00+00:00", ...extra }],
    error: null,
  });
  const tables = (over: Record<string, FakeDbResponse> = {}) => ({ subscriptions: live(), plans: plan("growth", "Growth", 5999, 5000), memberships: ownerPhone, ...over });

  it("upgrades now: the rest of the period's difference on PayU, approving the new full price", async () => {
    const { d, calls } = deps(tables({ "rpc:begin_plan_change": change("upgrade", { payment_id: PAYMENT, amount_paise: 2065_00, mandate_paise: 7078_82 }) }));
    const out = await changePlan(context(), { planKey: "growth" }, d);
    expect(out.action).toBe("upgrade");
    if (out.action !== "upgrade") return;
    expect(rpcArgs(calls, "begin_plan_change")).toMatchObject({ p_tenant_id: TENANT, p_plan_key: "growth", p_created_by: OWNER });
    expect(out.paymentId).toBe(PAYMENT);
    expect(out.payu.fields).toMatchObject({ amount: "2065.00", productinfo: "Spark Agent upgrade to Growth (monthly)", si: "4" });
    expect(JSON.parse(out.payu.fields.si_details)).toMatchObject({ billingAmount: "7078.82", billingCycle: "MONTHLY" });
    expect(out.payu.fields.txnid).toBe(rpcArgs(calls, "begin_plan_change")?.p_txnid);
  });

  it("schedules a downgrade, cancels one, or changes nothing, without needing PayU", async () => {
    const down = deps(tables({ plans: plan("starter", "Starter", 2499, 1500), "rpc:begin_plan_change": change("scheduled") }), { payu: null });
    expect(await changePlan(context(), { planKey: "starter" }, down.d)).toEqual({ action: "scheduled", planKey: "starter", effectiveAt: "2026-10-28T06:00:00.000Z" });
    expect(await changePlan(context(), { planKey: "growth" }, deps(tables({ "rpc:begin_plan_change": change("kept") }), { payu: null }).d)).toEqual({ action: "kept" });
    expect(await changePlan(context(), { planKey: "growth" }, deps(tables({ "rpc:begin_plan_change": change("unchanged") }), { payu: null }).d)).toEqual({ action: "unchanged" });
  });

  it("is for the owner, needs a plan to change, keeps the cycle, and puts a failed renewal first", async () => {
    await expect(changePlan(context("admin"), { planKey: "pro" }, deps(tables()).d)).rejects.toMatchObject({ code: "forbidden" });
    await expect(changePlan(context(), { planKey: "pro" }, deps(tables({ subscriptions: { data: null, error: null } })).d)).rejects.toMatchObject({ code: "conflict" });
    await expect(changePlan(context(), { planKey: "pro", cycle: "yearly" }, deps(tables()).d)).rejects.toMatchObject({ code: "not_available" });
    const cancelled = deps(tables({ subscriptions: live("monthly", "2026-10-28T06:00:00+00:00") }));
    await expect(changePlan(context(), { planKey: "starter" }, cancelled.d)).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("Keep your plan") });
    expect(cancelled.calls.some((c) => c.table === "rpc:begin_plan_change")).toBe(false);
    const behind = deps(tables({ "rpc:begin_plan_change": { data: null, error: { code: "PA428", message: "a renewal is past due" } } }));
    await expect(changePlan(context(), { planKey: "pro" }, behind.d)).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("try it again automatically") });
  });

  it.each([
    ["an upgrade", "plan_change", "upi", "upi_mandate_revoke"],
    ["a past-due plan chosen again", "subscribe", "card", "mandate_revoke"],
  ])("revokes the replaced mandate at PayU once %s is paid", async (_what, kind, method, command) => {
    const { fetch, posted } = payuRevoking();
    const { d } = deps(
      {
        payments: [{ data: { id: PAYMENT, status: "created" }, error: null }, { data: { subscriptions: { replaces_subscription_id: "old-sub" } }, error: null }],
        subscriptions: { data: { mandate_id: "old-m", mandate_method: method }, error: null },
        "rpc:settle_payment": { data: [{ payment_id: PAYMENT, tenant_id: TENANT, kind, status: "success", applied: true }], error: null },
      },
      { fetch },
    );
    expect(await syncPayment("C1abc", d)).toEqual({ paymentId: PAYMENT, status: "success" });
    expect(invalidateFeatureCache).toHaveBeenCalledWith(TENANT);
    expect(posted.map((p) => p.command)).toEqual(["verify_payment", command]);
    expect(JSON.parse(posted[1].var1)).toMatchObject({ authpayuid: "old-m" });
  });
});

/** A PayU that verifies any payment as paid and accepts a mandate revoke; records the commands posted. */
function payuRevoking() {
  const posted: { command: string; var1: string }[] = [];
  const fetch = vi.fn<FetchLike>(async (_url, init) => {
    const body = new URLSearchParams(init.body);
    const command = body.get("command") ?? "";
    const var1 = body.get("var1") ?? "";
    posted.push({ command, var1 });
    const answer = command === "verify_payment" ? { status: 1, transaction_details: { [var1]: { mihpayid: "new-m", status: "success", mode: "CC", amt: "2065.00" } } } : { status: 1, message: "Mandate Revoke request processed successfully" };
    return { ok: true, status: 200, json: async () => answer };
  });
  return { fetch, posted };
}

describe("POST /api/billing/cancel and /resume", () => {
  const outcome = (o: "scheduled" | "ended", mandate: string | null = null, method: string | null = null): FakeDbResponse => ({
    data: [{ outcome: o, ends_at: "2026-10-28T06:00:00+00:00", mandate_id: mandate, mandate_method: method }],
    error: null,
  });

  it("schedules the end of a plan in good standing for its period end, touching nothing at PayU yet", async () => {
    const { fetch, posted } = payuRevoking();
    const { d, calls } = deps({ "rpc:cancel_subscription": outcome("scheduled") }, { fetch });
    expect(await cancelPlan(context(), d)).toEqual({ status: "scheduled", endsAt: "2026-10-28T06:00:00.000Z" });
    expect(rpcArgs(calls, "cancel_subscription")).toEqual({ p_tenant_id: TENANT, p_actor: OWNER });
    expect(posted).toEqual([]);
    expect(invalidateFeatureCache).not.toHaveBeenCalled();
  });

  it("ends a past-due plan now: features refreshed and its mandate revoked at PayU", async () => {
    const { fetch, posted } = payuRevoking();
    const { d } = deps({ "rpc:cancel_subscription": outcome("ended", "m-2", "card") }, { fetch });
    expect(await cancelPlan(context(), d)).toEqual({ status: "ended" });
    expect(invalidateFeatureCache).toHaveBeenCalledWith(TENANT);
    expect(posted.map((p) => p.command)).toEqual(["mandate_revoke"]);
    expect(JSON.parse(posted[0].var1)).toMatchObject({ authpayuid: "m-2" });
  });

  it("still ends the plan when PayU refuses the revoke, and says so in the log", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const refusing = vi.fn<FetchLike>(async () => ({ ok: true, status: 200, json: async () => ({ status: 0, message: "Something went wrong" }) }));
    expect(await cancelPlan(context(), deps({ "rpc:cancel_subscription": outcome("ended", "m-2", "upi") }, { fetch: refusing }).d)).toEqual({ status: "ended" });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("the mandate was not revoked at PayU"));
    error.mockRestore();
  });

  it("is for the owner, and needs a plan to cancel", async () => {
    for (const role of ["admin", "staff"] as const) {
      await expect(cancelPlan(context(role), deps({ "rpc:cancel_subscription": outcome("scheduled") }).d)).rejects.toMatchObject({ code: "forbidden" });
    }
    const none = deps({ "rpc:cancel_subscription": { data: null, error: { code: "PA409", message: "cancel_subscription: the business has no plan" } } });
    await expect(cancelPlan(context(), none.d)).rejects.toMatchObject({ code: "conflict", message: "Your business has no plan to cancel." });
  });

  it("resumes a cancelled plan while its period lasts", async () => {
    const { d, calls } = deps({ "rpc:resume_subscription": { data: "2026-10-28T06:00:00+00:00", error: null } });
    expect(await resumePlan(context(), d)).toEqual({ renewsAt: "2026-10-28T06:00:00.000Z" });
    expect(rpcArgs(calls, "resume_subscription")).toEqual({ p_tenant_id: TENANT, p_actor: OWNER });
    await expect(resumePlan(context("admin"), d)).rejects.toMatchObject({ code: "forbidden" });
    const nothing = deps({ "rpc:resume_subscription": { data: null, error: { code: "PA409", message: "resume_subscription: nothing to resume" } } });
    await expect(resumePlan(context(), nothing.d)).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("Choose a plan in Billing") });
  });
});
