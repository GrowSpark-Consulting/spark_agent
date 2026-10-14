import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeDbResponse } from "../test-support/fake-db";
import type { FetchLike, PayuConfig } from "./payu";

const invalidateFeatureCache = vi.fn<(tenantId?: string) => void>();
vi.mock("../features/is-enabled", () => ({ invalidateFeatureCache }));

const {
  chargeDueRenewals,
  endCancelledPlans,
  grantAnnualMonths,
  invoiceNumber,
  lapseOverdue,
  lapsedMessage,
  nextRunAt,
  planEndedMessage,
  renewalFailedMessage,
  resolvePendingRenewals,
  sendRenewalNotices,
} = await import("./renewals");
const { handleBillingRenewals, billingRenewals } = await import("../inngest/billing-renewals");
const { functions } = await import("../inngest/functions");
type Deps = Parameters<typeof sendRenewalNotices>[0];

const TENANT = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const SUB = "0d200000-0000-4000-8000-000000000001";
const PAYMENT = "8e9f0a1b-2c3d-4e5f-8a7b-9c0d1e2f3a4b";
const NOW = new Date("2026-10-13T00:30:00Z"); // the job's run: 06:00 in India
const payu: PayuConfig = { key: "testkey", salt: "testsalt", mode: "test" };

/** A PayU that answers each command; records what was posted. */
function fakePayu(answers: Partial<Record<"pre_debit_SI" | "si_transaction" | "verify_payment", (var1: string) => unknown>>) {
  const posted: { command: string; var1: string }[] = [];
  const impl = vi.fn<FetchLike>(async (_url, init) => {
    const body = new URLSearchParams(init.body);
    const command = body.get("command") as keyof typeof answers;
    const var1 = body.get("var1") ?? "";
    posted.push({ command, var1 });
    const answer = answers[command];
    if (!answer) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => answer(var1) };
  });
  return { impl, posted };
}

const renewal = (status = "created", txnid = "Rone"): FakeDbResponse => ({
  data: [{ payment_id: PAYMENT, txnid, amount_paise: 2948_82, period_end: "2026-10-16T09:00:00+00:00", status, created: status === "created" }],
  error: null,
});
const settled = (status: string, applied = true): FakeDbResponse => ({ data: [{ payment_id: PAYMENT, tenant_id: TENANT, kind: "renewal", status, applied }], error: null });

function deps(tables: Record<string, FakeDbResponse | FakeDbResponse[]>, over: Partial<Deps> = {}) {
  const db = fakeDb(tables);
  const alert = vi.fn<Deps["alert"]>(async () => ({ recipients: 1, sent: 1, skipped: 0, failed: 0 }));
  const d: Deps = { db: db.client, payu, apiPublicUrl: "https://api.spark.test", appUrl: "https://app.spark.test", now: () => NOW, alert, ...over };
  return { d, calls: db.calls, alert };
}
const rpcCalls = (calls: ReturnType<typeof deps>["calls"], name: string) => calls.filter((c) => c.table === `rpc:${name}`).map((c) => c.args[0] as Record<string, unknown>);

beforeEach(() => invalidateFeatureCache.mockReset());

describe("dates and words", () => {
  it("announces debits for the job's own run, 00:30 UTC (06:00 in India)", () => {
    expect(nextRunAt(new Date("2026-10-15T00:29:00Z")).toISOString()).toBe("2026-10-15T00:30:00.000Z");
    expect(nextRunAt(new Date("2026-10-15T00:30:00Z")).toISOString()).toBe("2026-10-15T00:30:00.000Z");
    expect(nextRunAt(new Date("2026-10-15T09:00:00Z")).toISOString()).toBe("2026-10-16T00:30:00.000Z");
  });

  it("numbers each period's invoice the same way every time, as PayU allows", () => {
    expect(invoiceNumber(SUB, new Date("2026-10-16T09:00:00Z"))).toBe("I0d2000000000" + "20261016");
    expect(invoiceNumber(SUB, new Date("2026-10-16T09:00:00Z"))).toMatch(/^[A-Za-z0-9]{1,25}$/);
  });

  it("tells the owners what failed, what happens next, and where to pay another way", () => {
    const retry = renewalFailedMessage(2948_82, "https://app.spark.test");
    expect(retry.text).toContain("₹2,948.82 didn't go through. We'll try again in 2 days.");
    expect(retry.text).toContain("choose your plan again in Billing");
    expect(retry.templateParams[1]).toBe("https://app.spark.test/dashboard/billing");
    const last = renewalFailedMessage(2948_82, "https://app.spark.test", new Date("2026-10-24T00:30:00Z"));
    expect(last.templateParams[0]).toBe("Your Spark Agent plan payment of ₹2,948.82 didn't go through and won't be tried again.");
    expect(last.text).toContain("pauses on 24 Oct 2026 unless you choose your plan again in Billing");
    expect(lapsedMessage("https://app.spark.test").text).toContain("Choose a plan in Billing");
    expect(planEndedMessage("https://app.spark.test").templateParams[0]).toContain("has ended as you asked");
  });
});

describe("step 1: pre-debit notices", () => {
  const due = (method: string | null): FakeDbResponse => ({
    data: [{ subscription_id: SUB, tenant_id: TENANT, mandate_id: "m-1", mandate_method: method, period_end: "2026-10-16T09:00:00+00:00" }],
    error: null,
  });

  it("records the renewal, sends PayU's notice for the first run after the period ends, and stamps it", async () => {
    const payuFake = fakePayu({ pre_debit_SI: () => ({ status: 1, message: "Pre-debit notification triggered" }) });
    const { d, calls } = deps({ "rpc:renewals_to_notify": due("upi"), "rpc:begin_renewal": renewal(), subscriptions: { data: null, error: null } }, { fetch: payuFake.impl });
    expect(await sendRenewalNotices(d)).toEqual({ due: 1, sent: 1, failed: 0 });
    expect(rpcCalls(calls, "begin_renewal")[0]).toMatchObject({ p_subscription_id: SUB });
    expect(JSON.parse(payuFake.posted[0].var1)).toMatchObject({ authpayuid: "m-1", debitDate: "2026-10-17", amount: "2948.82", invoiceDisplayNumber: invoiceNumber(SUB, new Date("2026-10-16T09:00:00Z")) });
    expect(calls.find((c) => c.table === "subscriptions" && c.method === "update")?.args[0]).toEqual({ pre_debit_for: "2026-10-16T09:00:00.000Z", pre_debit_at: "2026-10-17T00:30:00.000Z" });
  });

  it("gives at least 48 hours' notice when the period ends sooner", async () => {
    const soon: FakeDbResponse = { data: [{ subscription_id: SUB, tenant_id: TENANT, mandate_id: "m-1", mandate_method: "card", period_end: "2026-10-13T12:00:00+00:00" }], error: null };
    const payuFake = fakePayu({ pre_debit_SI: () => ({ status: 1 }) });
    const { d, calls } = deps({ "rpc:renewals_to_notify": soon, "rpc:begin_renewal": renewal(), subscriptions: { data: null, error: null } }, { fetch: payuFake.impl });
    await sendRenewalNotices(d);
    expect(JSON.parse(payuFake.posted[0].var1).debitDate).toBe("2026-10-15");
    expect((calls.find((c) => c.table === "subscriptions" && c.method === "update")?.args[0] as { pre_debit_at: string }).pre_debit_at).toBe("2026-10-15T00:30:00.000Z");
  });

  it("sends no notice for e-NACH, but still schedules the debit", async () => {
    const payuFake = fakePayu({});
    const { d, calls } = deps({ "rpc:renewals_to_notify": due("enach"), "rpc:begin_renewal": renewal(), subscriptions: { data: null, error: null } }, { fetch: payuFake.impl });
    expect((await sendRenewalNotices(d)).sent).toBe(1);
    expect(payuFake.impl).not.toHaveBeenCalled();
    expect(calls.some((c) => c.table === "subscriptions" && c.method === "update")).toBe(true);
  });

  it("fails the period and tells the owners when the mandate is no longer active; tries again tomorrow on a passing error", async () => {
    const revoked = fakePayu({ pre_debit_SI: () => ({ status: 0, message: "Mandate is not active" }) });
    const one = deps({ "rpc:renewals_to_notify": due("upi"), "rpc:begin_renewal": renewal(), "rpc:settle_payment": settled("failed") }, { fetch: revoked.impl });
    expect(await sendRenewalNotices(one.d)).toEqual({ due: 1, sent: 0, failed: 1 });
    expect(rpcCalls(one.calls, "settle_payment")[0]).toMatchObject({ p_txnid: "Rone", p_state: "failed", p_reason: "Mandate is not active" });
    expect(one.alert).toHaveBeenCalledWith(TENANT, expect.objectContaining({ text: expect.stringContaining("pauses on 24 Oct 2026") }), `renewal_failed:${PAYMENT}`);

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const busy = fakePayu({ pre_debit_SI: () => ({ status: 0, message: "Please try again" }) });
    const two = deps({ "rpc:renewals_to_notify": due("upi"), "rpc:begin_renewal": renewal() }, { fetch: busy.impl });
    expect(await sendRenewalNotices(two.d)).toEqual({ due: 1, sent: 0, failed: 1 });
    expect(two.calls.some((c) => c.table === "subscriptions" || c.table === "rpc:settle_payment")).toBe(false);
    error.mockRestore();
  });

  it("does nothing until PayU is configured", async () => {
    const { d, calls } = deps({}, { payu: null });
    expect(await sendRenewalNotices(d)).toEqual({ due: 0, sent: 0, failed: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe("step 2: charges", () => {
  const due: FakeDbResponse = { data: [{ subscription_id: SUB, tenant_id: TENANT, mandate_id: "m-1", period_end: "2026-10-16T09:00:00+00:00" }], error: null };

  it("marks the renewal pending before PayU is asked, then applies PayU's answer", async () => {
    const payuFake = fakePayu({ si_transaction: (var1) => ({ status: 1, details: { [JSON.parse(var1).txnid]: { status: "captured", mihpayid: "999", amount: "2948.82" } } }) });
    const { d, calls } = deps({ "rpc:renewals_to_charge": due, "rpc:begin_renewal": renewal(), "rpc:settle_payment": [settled("pending", false), settled("success")] }, { fetch: payuFake.impl });
    expect(await chargeDueRenewals(d)).toEqual({ due: 1, success: 1, pending: 0, failed: 0 });
    expect(rpcCalls(calls, "settle_payment").map((a) => a.p_state)).toEqual(["pending", "success"]);
    expect(JSON.parse(payuFake.posted[0].var1)).toEqual({ authpayuid: "m-1", amount: "2948.82", txnid: "Rone", invoiceDisplayNumber: invoiceNumber(SUB, new Date("2026-10-16T09:00:00Z")) });
    expect(invalidateFeatureCache).toHaveBeenCalledWith(TENANT);
  });

  it("tells the owners when the debit fails, and on the last attempt that it pauses unless paid another way", async () => {
    const payuFake = fakePayu({ si_transaction: (var1) => ({ status: 1, details: { [JSON.parse(var1).txnid]: { status: "failed", field9: "Insufficient balance" } } }) });
    const tables = (failedSoFar: number) => ({
      "rpc:renewals_to_charge": due,
      "rpc:begin_renewal": renewal(),
      "rpc:settle_payment": [settled("pending", false), settled("failed")],
      payments: { data: null, error: null, count: failedSoFar },
    });
    const first = deps(tables(1), { fetch: payuFake.impl });
    expect((await chargeDueRenewals(first.d)).failed).toBe(1);
    expect(rpcCalls(first.calls, "settle_payment")[1]).toMatchObject({ p_state: "failed", p_reason: "Insufficient balance" });
    expect(first.alert).toHaveBeenCalledTimes(1);
    expect(first.alert.mock.calls[0][1].text).toContain("We'll try again in 2 days");
    expect(first.calls.filter((c) => c.table === "payments" && c.method === "eq").map((c) => c.args)).toEqual([
      ["subscription_id", SUB],
      ["kind", "renewal"],
      ["for_period_end", "2026-10-16T09:00:00+00:00"],
      ["status", "failed"],
    ]);

    // The period ended 16 Oct 09:00 UTC: 7 days later is 23 Oct 14:30 in India, so the 06:00 run on 24 Oct pauses it.
    const last = deps(tables(3), { fetch: payuFake.impl });
    await chargeDueRenewals(last.d);
    expect(last.alert.mock.calls[0][1].text).toContain("won't be tried again");
    expect(last.alert.mock.calls[0][1].text).toContain("pauses on 24 Oct 2026");
  });

  it("leaves a charge PayU did not answer pending, for step 3, and never charges a renewal already in flight", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const silent = fakePayu({});
    const one = deps({ "rpc:renewals_to_charge": due, "rpc:begin_renewal": renewal(), "rpc:settle_payment": settled("pending", false) }, { fetch: silent.impl });
    expect(await chargeDueRenewals(one.d)).toEqual({ due: 1, success: 0, pending: 1, failed: 0 });
    expect(rpcCalls(one.calls, "settle_payment")).toHaveLength(1);
    error.mockRestore();

    const fetch = fakePayu({ si_transaction: () => ({ status: 1 }) });
    const two = deps({ "rpc:renewals_to_charge": due, "rpc:begin_renewal": renewal("pending") }, { fetch: fetch.impl });
    await chargeDueRenewals(two.d);
    expect(fetch.impl).not.toHaveBeenCalled();
  });
});

describe("step 3: pending renewals", () => {
  const pending = (updatedAt: string): FakeDbResponse => ({
    data: [{ id: PAYMENT, txnid: "Rone", tenant_id: TENANT, subscription_id: SUB, for_period_end: "2026-10-16T09:00:00+00:00", amount_paise: 2948_82, updated_at: updatedAt }],
    error: null,
  });

  it("applies what PayU says now", async () => {
    const payuFake = fakePayu({ verify_payment: (txnid) => ({ status: 1, transaction_details: { [txnid]: { mihpayid: "999", status: "success", amt: "2948.82" } } }) });
    const { d } = deps(
      { payments: [pending("2026-10-13T00:00:00Z"), { data: { id: PAYMENT, status: "pending" }, error: null }], "rpc:settle_payment": settled("success") },
      { fetch: payuFake.impl },
    );
    expect(await resolvePendingRenewals(d)).toEqual({ checked: 1, settled: 1 });
  });

  it("fails a charge PayU has no record of after an hour, so the period can be tried again, telling the owners only on the last", async () => {
    const payuFake = fakePayu({ verify_payment: (txnid) => ({ status: 0, transaction_details: { [txnid]: { status: "Not Found" } } }) });
    const run = (failedSoFar: number) =>
      deps(
        {
          payments: [pending("2026-10-12T23:00:00Z"), { data: { id: PAYMENT, status: "pending" }, error: null }, { data: null, error: null, count: failedSoFar }],
          "rpc:settle_payment": [settled("pending", false), settled("failed")],
        },
        { fetch: payuFake.impl },
      );
    const first = run(1);
    expect(await resolvePendingRenewals(first.d)).toEqual({ checked: 1, settled: 1 });
    expect(rpcCalls(first.calls, "settle_payment").map((a) => a.p_state)).toEqual(["not_found", "failed"]);
    expect(first.alert).not.toHaveBeenCalled();

    const last = run(3);
    await resolvePendingRenewals(last.d);
    expect(last.alert).toHaveBeenCalledWith(TENANT, expect.objectContaining({ text: expect.stringContaining("pauses on 24 Oct 2026") }), `renewal_failed:${PAYMENT}`);
  });

  it("never fails a pending charge while PayU refuses our key and salt", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const refusing = fakePayu({ verify_payment: () => ({ status: 0, msg: "Invalid Hash." }) });
    const { d, calls, alert } = deps({ payments: [pending("2026-10-12T23:00:00Z"), { data: { id: PAYMENT, status: "pending" }, error: null }] }, { fetch: refusing.impl });
    expect(await resolvePendingRenewals(d)).toEqual({ checked: 1, settled: 0 });
    expect(calls.some((c) => c.table === "rpc:settle_payment")).toBe(false);
    expect(alert).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Invalid Hash. (check PAYU_MERCHANT_KEY"));
    error.mockRestore();
  });

  it("tells the owners about a failure PayU reports for a pending charge", async () => {
    const payuFake = fakePayu({ verify_payment: (txnid) => ({ status: 1, transaction_details: { [txnid]: { mihpayid: "999", status: "failure", error_Message: "Insufficient balance" } } }) });
    const { d, alert } = deps(
      {
        payments: [pending("2026-10-13T00:00:00Z"), { data: { id: PAYMENT, status: "pending" }, error: null }, { data: null, error: null, count: 1 }],
        "rpc:settle_payment": settled("failed"),
      },
      { fetch: payuFake.impl },
    );
    expect(await resolvePendingRenewals(d)).toEqual({ checked: 1, settled: 1 });
    expect(alert).toHaveBeenCalledWith(TENANT, expect.objectContaining({ text: expect.stringContaining("We'll try again in 2 days") }), `renewal_failed:${PAYMENT}`);
  });
});

describe("steps 4 to 6: annual months, cancelled plans and lapses", () => {
  it("grants annual plans their month", async () => {
    expect(await grantAnnualMonths(deps({ "rpc:grant_annual_credit_months": { data: 2, error: null } }).d)).toEqual({ granted: 2 });
  });

  it("ends plans their owner cancelled: revokes the mandate at PayU and tells the owners, even when PayU refuses", async () => {
    const posted: string[] = [];
    const fetch = vi.fn<FetchLike>(async (_url, init) => {
      posted.push(new URLSearchParams(init.body).get("command") ?? "");
      return { ok: true, status: 200, json: async () => ({ status: 0, message: "Something went wrong" }) };
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const ended: FakeDbResponse = {
      data: [
        { tenant_id: TENANT, subscription_id: SUB, mandate_id: "m-1", mandate_method: "upi" },
        { tenant_id: TENANT, subscription_id: "0d200000-0000-4000-8000-000000000002", mandate_id: null, mandate_method: null },
      ],
      error: null,
    };
    const { d, calls, alert } = deps({ "rpc:end_cancelled_subscriptions": ended }, { fetch });
    expect(await endCancelledPlans(d)).toEqual({ ended: 2 });
    expect(rpcCalls(calls, "end_cancelled_subscriptions")[0]).toEqual({ p_now: NOW.toISOString() });
    expect(posted).toEqual(["upi_mandate_revoke"]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("the mandate was not revoked at PayU"));
    expect(invalidateFeatureCache).toHaveBeenCalledWith(TENANT);
    expect(alert).toHaveBeenCalledWith(TENANT, expect.objectContaining({ text: expect.stringContaining("has ended as you asked") }), `subscription_ended:${SUB}`);
    expect(alert).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it("pauses unpaid plans, refreshes their features, and tells the owners once", async () => {
    const { d, alert } = deps({ "rpc:lapse_overdue_subscriptions": { data: [{ tenant_id: TENANT, subscription_id: SUB }], error: null } });
    expect(await lapseOverdue(d)).toEqual({ lapsed: 1 });
    expect(invalidateFeatureCache).toHaveBeenCalledWith(TENANT);
    expect(alert).toHaveBeenCalledWith(TENANT, expect.objectContaining({ text: expect.stringContaining("paused") }), `subscription_lapsed:${SUB}`);
  });
});

describe("the job", () => {
  it("runs the six steps in order, each its own step", async () => {
    const ids: string[] = [];
    const { d } = deps(
      { "rpc:grant_annual_credit_months": { data: 0, error: null }, "rpc:end_cancelled_subscriptions": { data: [], error: null }, "rpc:lapse_overdue_subscriptions": { data: [], error: null } },
      { payu: null },
    );
    const out = await handleBillingRenewals({ step: { run: async (id, fn) => (ids.push(id), fn()) } }, () => d);
    expect(ids).toEqual(["notices", "charges", "pending", "annual-months", "ended", "lapse"]);
    expect(out.annual).toEqual({ granted: 0 });
    expect(out.ended).toEqual({ ended: 0 });
  });

  it("is served, once a day at 06:00 in India", () => {
    expect(functions).toContain(billingRenewals);
    expect((billingRenewals as unknown as { opts: unknown }).opts).toMatchObject({ id: "billing-renewals", triggers: [{ cron: "TZ=Asia/Kolkata 0 6 * * *" }] });
  });
});
