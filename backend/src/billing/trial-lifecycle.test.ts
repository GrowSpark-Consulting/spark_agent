import { describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeDbResponse } from "../test-support/fake-db";
import {
  expireTrials,
  inSendingHours,
  loadTrialFacts,
  recommendPlan,
  sendDueTrialNotices,
  sendTrialNotice,
  trialNoticeMessage,
  type PlanOffer,
  type TrialDeps,
  type TrialFacts,
} from "./trial-lifecycle";

const TENANT = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const OTHER = "6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e";
const APP = "https://app.spark.test";
// 11:00 in India.
const NOW = new Date("2026-10-13T05:30:00Z");

const PLANS: PlanOffer[] = [
  { key: "starter", name: "Starter", priceInr: 2499, monthlyCredits: 1500 },
  { key: "growth", name: "Growth", priceInr: 5999, monthlyCredits: 5000 },
  { key: "pro", name: "Pro", priceInr: 12999, monthlyCredits: 15000 },
];
const facts = (over: Partial<TrialFacts> = {}): TrialFacts => ({
  name: "Skyline Homes",
  routeCode: "TRIAL-7KQ2",
  trialCredits: 300,
  aiReplies: 0,
  leads: 0,
  creditsUsed: 0,
  daysIn: 3,
  plans: PLANS,
  ...over,
});

function deps(tables: Record<string, FakeDbResponse | FakeDbResponse[]>, now = NOW) {
  const db = fakeDb(tables);
  const notify = vi.fn<TrialDeps["notify"]>(async () => ({ recipients: 1, sent: 1, skipped: 0, failed: 0 }));
  const invalidate = vi.fn<TrialDeps["invalidate"]>();
  const d: TrialDeps = { db: db.client, appUrl: APP, now: () => now, notify, invalidate };
  return { d, calls: db.calls, notify, invalidate };
}
const rpcArgs = (calls: ReturnType<typeof deps>["calls"], name: string) => calls.filter((c) => c.table === `rpc:${name}`).map((c) => c.args[0]);

describe("when notices go", () => {
  it("between 09:00 and 20:00 in India only", () => {
    expect(inSendingHours(new Date("2026-10-13T03:29:00Z"))).toBe(false); // 08:59
    expect(inSendingHours(new Date("2026-10-13T03:30:00Z"))).toBe(true); // 09:00
    expect(inSendingHours(new Date("2026-10-13T14:29:00Z"))).toBe(true); // 19:59
    expect(inSendingHours(new Date("2026-10-13T14:30:00Z"))).toBe(false); // 20:00
  });
});

describe("the plan that fits", () => {
  it("scales the credits used so far to a month and takes the cheapest plan that covers it", () => {
    expect(recommendPlan(200, 4, PLANS)).toEqual({ plan: PLANS[0], monthlyEstimate: 1500 });
    expect(recommendPlan(600, 4, PLANS)).toEqual({ plan: PLANS[1], monthlyEstimate: 4500 });
  });

  it("offers the largest when nothing covers it, the cheapest before any use, and nothing without plans", () => {
    expect(recommendPlan(2000, 2, PLANS)?.plan.key).toBe("pro");
    expect(recommendPlan(0, 5, PLANS)).toEqual({ plan: PLANS[0], monthlyEstimate: null });
    expect(recommendPlan(100, 5, [])).toBeNull();
  });
});

describe("what each day says", () => {
  it("day 0 welcomes the business, gives its TRIAL code, and links the dashboard", () => {
    const m = trialNoticeMessage(0, facts(), APP);
    expect(m.templateParams).toEqual(["Welcome to Spark Agent, Skyline Homes! Your 7-day free trial has started with 300 credits.", `${APP}/dashboard`]);
    expect(m.text).toContain("send TRIAL-7KQ2 to the Spark Agent demo number on WhatsApp");
  });

  it("day 3 reports what the assistant did, or how to try it when it has not answered anyone yet", () => {
    expect(trialNoticeMessage(3, facts({ aiReplies: 12, leads: 1 }), APP).templateParams[0]).toBe("Skyline Homes: so far your assistant has sent 12 replies and found 1 lead.");
    const quiet = trialNoticeMessage(3, facts(), APP);
    expect(quiet.templateParams[0]).toBe("Skyline Homes: your assistant hasn't answered a customer yet.");
    expect(quiet.text).toContain("Try it now: send TRIAL-7KQ2");
  });

  it("day 5 suggests the plan that fits the pace, with its price before GST", () => {
    const m = trialNoticeMessage(5, facts({ creditsUsed: 600, daysIn: 4 }), APP);
    expect(m.templateParams).toEqual(["Skyline Homes: 2 days left in your Spark Agent trial.", `${APP}/dashboard/billing`]);
    expect(m.text).toContain("At your pace, about 4,500 credits a month, Growth (5,000 credits a month, ₹5,999 + GST) fits.");
    expect(trialNoticeMessage(5, facts(), APP).text).toContain("Starter (1,500 credits a month, ₹2,499 + GST) is the place to start.");
  });

  it("day 6 says it ends tomorrow, day 7 that it ended and the assistant is paused, both linking Billing", () => {
    expect(trialNoticeMessage(6, facts(), APP).templateParams).toEqual(["Skyline Homes: your Spark Agent trial ends tomorrow.", `${APP}/dashboard/billing`]);
    const end = trialNoticeMessage(7, facts(), APP);
    expect(end.templateParams[0]).toBe("Skyline Homes: your Spark Agent trial has ended and your assistant is paused.");
    expect(end.text).toContain("Your inbox and leads are still there.");
  });

  it("keeps the template's first value on one line and short, whatever the business is called", () => {
    const m = trialNoticeMessage(6, facts({ name: `Very\nLong ${"x".repeat(200)}` }), APP);
    expect(m.templateParams[0]).not.toMatch(/\n/);
    expect(m.templateParams[0].length).toBeLessThanOrEqual(400);
  });
});

describe("loading what a notice says", () => {
  it("counts the assistant's replies and the leads, and the credits used (not grants, not expiries; refunds give back)", async () => {
    const { d, calls } = deps({
      tenants: { data: { name: "Skyline Homes", trial_ends_at: "2026-10-17T05:30:00Z" }, error: null },
      route_codes: { data: [{ code: "TRIAL-7KQ2" }], error: null },
      messages: { data: null, error: null, count: 12 },
      leads: { data: null, error: null, count: 3 },
      credit_ledger: {
        data: [
          { delta: 300, reason: "trial_grant" },
          { delta: -1, reason: "ai_reply" },
          { delta: -1, reason: "ai_reply" },
          { delta: -1, reason: "template_utility" },
          { delta: 1, reason: "refund" },
          { delta: -50, reason: "cycle_reset" },
        ],
        error: null,
      },
      plans: { data: [{ key: "trial", name: "Trial", price_inr: 0, monthly_credits: 300 }, ...PLANS.map((p) => ({ key: p.key, name: p.name, price_inr: p.priceInr, monthly_credits: p.monthlyCredits }))], error: null },
    });
    expect(await loadTrialFacts(TENANT, d)).toEqual({ name: "Skyline Homes", routeCode: "TRIAL-7KQ2", trialCredits: 300, aiReplies: 12, leads: 3, creditsUsed: 2, daysIn: 3, plans: PLANS });
    expect(calls).toContainEqual({ table: "messages", method: "eq", args: ["sender", "ai"] });
    expect(calls).toContainEqual({ table: "route_codes", method: "eq", args: ["kind", "trial"] });
  });
});

describe("sending one day's notice", () => {
  const tables = (claim: string): Record<string, FakeDbResponse> => ({
    "rpc:claim_trial_notice": { data: claim, error: null },
    tenants: { data: { name: "Skyline Homes", trial_ends_at: "2026-10-17T05:30:00Z" }, error: null },
    route_codes: { data: [{ code: "TRIAL-7KQ2" }], error: null },
    messages: { data: null, error: null, count: 0 },
    leads: { data: null, error: null, count: 0 },
    credit_ledger: { data: [], error: null },
    plans: { data: [], error: null },
  });

  it("claims it for this run, then sends it to the owners under a key per business and day", async () => {
    const { d, calls, notify } = deps(tables("claimed"));
    expect(await sendTrialNotice(TENANT, 6, "run-1", d)).toEqual({ status: "sent", counts: { recipients: 1, sent: 1, skipped: 0, failed: 0 } });
    expect(rpcArgs(calls, "claim_trial_notice")).toEqual([{ p_tenant_id: TENANT, p_day: 6, p_claimed_by: "run-1", p_now: NOW.toISOString() }]);
    expect(notify).toHaveBeenCalledWith(TENANT, expect.objectContaining({ templateParams: ["Skyline Homes: your Spark Agent trial ends tomorrow.", `${APP}/dashboard/billing`] }), `trial_notice:${TENANT}:6`);
  });

  it("sends nothing another run already sent, a day overtaken by a later one, or to a business no longer eligible", async () => {
    for (const claim of ["already", "superseded", "not_eligible"] as const) {
      const { d, notify, calls } = deps(tables(claim));
      expect(await sendTrialNotice(TENANT, 5, "run-2", d)).toEqual({ status: claim });
      expect(notify).not.toHaveBeenCalled();
      expect(calls.some((c) => c.table === "tenants")).toBe(false);
    }
  });
});

describe("the hourly sweep", () => {
  it("pauses ended trials and refreshes their features at once", async () => {
    const { d, invalidate } = deps({ "rpc:pause_expired_trials": { data: [{ tenant_id: TENANT }, { tenant_id: OTHER }], error: null } });
    expect(await expireTrials(d)).toEqual({ paused: [TENANT, OTHER] });
    expect(invalidate.mock.calls).toEqual([[TENANT], [OTHER]]);
  });

  it("sends the notices due, each claimed for this run", async () => {
    const { d, calls, notify } = deps({
      "rpc:trial_notices_due": { data: [{ tenant_id: TENANT, day: 3 }, { tenant_id: OTHER, day: 7 }], error: null },
      "rpc:claim_trial_notice": [{ data: "claimed", error: null }, { data: "already", error: null }],
      tenants: { data: { name: "Skyline Homes", trial_ends_at: "2026-10-17T05:30:00Z" }, error: null },
      route_codes: { data: [], error: null },
      messages: { data: null, error: null, count: 0 },
      leads: { data: null, error: null, count: 0 },
      credit_ledger: { data: [], error: null },
      plans: { data: [], error: null },
    });
    expect(await sendDueTrialNotices(d, "run-9")).toEqual({ due: 2, sent: 1, notSent: 1, outsideHours: false });
    expect(rpcArgs(calls, "claim_trial_notice").map((a) => [(a as { p_day: number }).p_day, (a as { p_claimed_by: string }).p_claimed_by])).toEqual([[3, "run-9"], [7, "run-9"]]);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("sends nothing outside 09:00 to 20:00 in India", async () => {
    const { d, calls } = deps({}, new Date("2026-10-13T16:00:00Z")); // 21:30
    expect(await sendDueTrialNotices(d, "run-9")).toEqual({ due: 0, sent: 0, notSent: 0, outsideHours: true });
    expect(calls).toHaveLength(0);
  });
});
