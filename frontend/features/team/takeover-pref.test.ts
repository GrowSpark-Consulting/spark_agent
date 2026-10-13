import type { FeatureList } from "@pakka/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { fetchTakeoverPref, ownNumberAccess, ownNumberRow, saveTakeoverPref, takeoverOptions } from "./takeover-pref";

const TENANT = "10000000-0000-4000-8000-000000000001";
const USER = "30000000-0000-4000-8000-000000000001";

const row = (over: Record<string, unknown> = {}) => ({
  key: "handoff_own_number",
  name: "Reply from your own number",
  description: "d",
  state: "on",
  enabled: true,
  requiredPlan: null,
  disabledReason: null,
  creditsPerMonth: null,
  creditNote: "No extra credits",
  settings: {},
  control: "switch",
  ...over,
});
const list = (...rows: Record<string, unknown>[]) =>
  ({ plan: { key: "starter", name: "Starter", monthlyCredits: 1500 }, estimatedCreditsPerMonth: 0, groups: [{ name: "Team alerts", features: rows }] }) as unknown as FeatureList;

/** A query builder that answers the awaited call from `result` and records the update. */
function fakeClient(result: { data: unknown; error: unknown }) {
  const calls: [string, unknown[]][] = [];
  const builder: Record<string, unknown> = {};
  for (const name of ["select", "update", "eq", "limit"]) {
    builder[name] = (...args: unknown[]) => {
      calls.push([name, args]);
      return builder;
    };
  }
  builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return { client: { from: () => builder } as unknown as SupabaseClient, calls };
}

describe("ownNumberAccess: only what the features answer says", () => {
  it.each([
    ["on", { state: "on" }, { kind: "available" }],
    ["off", { state: "off", enabled: false }, { kind: "off" }],
    ["locked with a plan", { state: "locked", enabled: false, requiredPlan: "growth" }, { kind: "locked", requiredPlan: "growth" }],
    ["locked with no plan", { state: "locked", enabled: false, requiredPlan: null }, { kind: "locked", requiredPlan: null }],
    ["disabled", { state: "disabled", enabled: false, disabledReason: "Connect a number." }, { kind: "disabled", reason: "Connect a number." }],
  ])("%s", (_name, over, expected) => {
    expect(ownNumberAccess(list(row(over)))).toEqual(expected);
  });

  it("is unknown when the row is missing, and finds the row in any group", () => {
    expect(ownNumberAccess(list(row({ key: "something_else" })))).toEqual({ kind: "unknown" });
    expect(ownNumberAccess(list())).toEqual({ kind: "unknown" });
    const twoGroups = { ...list(row({ key: "a" })), groups: [{ name: "A", features: [row({ key: "a" })] }, { name: "B", features: [row({ state: "locked", requiredPlan: "pro" })] }] } as unknown as FeatureList;
    expect(ownNumberRow(twoGroups)?.state).toBe("locked");
  });

  it("does not look at the plan's name or key: the same row gives the same answer on any plan", () => {
    const starter = list(row({ state: "locked", requiredPlan: "growth" }));
    const pro = { ...starter, plan: { key: "pro", name: "Pro", monthlyCredits: 9000 } } as FeatureList;
    expect(ownNumberAccess(pro)).toEqual(ownNumberAccess(starter));
  });
});

describe("takeoverOptions", () => {
  const byValue = (access: Parameters<typeof takeoverOptions>[0], hasNumber = true) => Object.fromEntries(takeoverOptions(access, hasNumber).map((o) => [o.value, o.unavailable]));

  it("always allows the inbox", () => {
    for (const access of [{ kind: "available" }, { kind: "locked", requiredPlan: "growth" }, { kind: "off" }, { kind: "disabled", reason: null }, { kind: "unknown" }] as const) {
      expect(byValue(access).inbox).toBeNull();
    }
  });

  it("allows own number and ask when the feature is available and an alert number is set", () => {
    expect(byValue({ kind: "available" })).toEqual({ inbox: null, own_number: null, ask: null });
  });

  it("needs the alert number for own number only", () => {
    expect(byValue({ kind: "available" }, false)).toEqual({ inbox: null, own_number: "Add your WhatsApp number above first.", ask: null });
  });

  it.each([
    [{ kind: "locked", requiredPlan: "growth" }, "Not available on your current plan."],
    [{ kind: "locked", requiredPlan: null }, "Not included in your plan."],
    [{ kind: "off" }, "Switched off for your business. An owner or admin can switch it on under Features."],
    [{ kind: "disabled", reason: "Connect a number." }, "Connect a number."],
    [{ kind: "disabled", reason: null }, "Can't be used right now."],
    [{ kind: "unknown" }, "Couldn't tell whether your plan includes this."],
  ] as const)("blocks both own-number choices with the reason for %j", (access, reason) => {
    expect(byValue(access)).toEqual({ inbox: null, own_number: reason, ask: reason });
  });
});

describe("the member's own takeover choice (memberships.takeover_pref)", () => {
  it("reads it for this business and member, null when none is set", async () => {
    const c = fakeClient({ data: [{ tenant_id: TENANT, user_id: USER, takeover_pref: "own_number" }], error: null });
    expect(await fetchTakeoverPref(c.client, TENANT, USER)).toBe("own_number");
    expect(c.calls).toContainEqual(["eq", ["tenant_id", TENANT]]);
    expect(c.calls).toContainEqual(["eq", ["user_id", USER]]);
    expect(await fetchTakeoverPref(fakeClient({ data: [{ tenant_id: TENANT, user_id: USER, takeover_pref: null }], error: null }).client, TENANT, USER)).toBeNull();
  });

  it("fails on a missing row, a value outside the contract and a read error", async () => {
    await expect(fetchTakeoverPref(fakeClient({ data: [], error: null }).client, TENANT, USER)).rejects.toMatchObject({ reason: "not_found" });
    await expect(fetchTakeoverPref(fakeClient({ data: [{ tenant_id: TENANT, user_id: USER, takeover_pref: "always" }], error: null }).client, TENANT, USER)).rejects.toMatchObject({ reason: "invalid_response" });
    const boom = new Error("boom");
    await expect(fetchTakeoverPref(fakeClient({ data: null, error: boom }).client, TENANT, USER)).rejects.toBe(boom);
  });

  it("writes only takeover_pref and returns what is stored", async () => {
    const c = fakeClient({ data: [{ tenant_id: TENANT, user_id: USER, takeover_pref: "ask" }], error: null });
    expect(await saveTakeoverPref(c.client, TENANT, USER, "ask")).toBe("ask");
    expect(c.calls).toContainEqual(["update", [{ takeover_pref: "ask" }]]);
  });

  it("treats no row back (RLS refused) as not saved, and a different value back as a mismatch", async () => {
    await expect(saveTakeoverPref(fakeClient({ data: [], error: null }).client, TENANT, USER, "inbox")).rejects.toMatchObject({ reason: "not_found" });
    await expect(saveTakeoverPref(fakeClient({ data: [{ tenant_id: TENANT, user_id: USER, takeover_pref: "inbox" }], error: null }).client, TENANT, USER, "ask")).rejects.toMatchObject({ reason: "invalid_response" });
  });
});
