import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getJson = vi.fn();
vi.mock("@/lib/api/client", () => ({ getJson: (...args: unknown[]) => getJson(...args) }));

const { BillingDataError, fetchAccountStatus, fetchCreditHistory, fetchPlans, HISTORY_PAGE, planRelation, reasonLabel } = await import("./billing-data");

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
