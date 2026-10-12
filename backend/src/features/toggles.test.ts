import type { TenantContext } from "@pakka/types";
import { FeatureList, FeatureRow } from "@pakka/types";
import { describe, expect, it, vi } from "vitest";
import { FEATURE_CREDIT_COST } from "../billing/credit-costs";
import { KINDS } from "../notify/kinds";
import { fakeDb, type FakeDbResponse } from "../test-support/fake-db";
import { FEATURE_GROUPS, listFeatures, NOT_AVAILABLE_YET, updateFeature, type FeatureDeps } from "./toggles";

const TENANT = "5b0e3c9a-1d2f-4e6a-8b7c-9d0e1f2a3b4c";
const USER = "7c1f4d0b-2e3a-4f5b-9c8d-0e1f2a3b4c5d";

const context = (planKey: string, role: TenantContext["role"] = "owner"): TenantContext => ({
  user: { id: USER, email: "owner@example.com" },
  role,
  tenant: { id: TENANT, name: "Skyline Homes", vertical: "real-estate", timezone: "Asia/Kolkata", status: "active", planKey, trialEndsAt: null },
});

const feature = (key: string, name: string, defaultOn: boolean, cost = FEATURE_CREDIT_COST[key as keyof typeof FEATURE_CREDIT_COST] ?? 0) => ({
  key,
  name,
  description: `${name}.`,
  default_on: defaultOn,
  credit_cost: cost,
});
const FEATURES = [
  feature("ai_auto_reply", "AI replies", true),
  feature("working_hours_mode", "Working-hours mode", false),
  feature("lead_qualification", "Lead qualification", true),
  feature("booking", "Booking in chat", true),
  feature("reminder_24h", "Day-before reminder", true),
  feature("staff_alerts", "Staff alerts", true),
  feature("daily_agenda", "Daily agenda", true),
  feature("followup_nudges", "Follow-up nudges", true),
  feature("review_request", "Review request", true),
  feature("outbound_webhooks", "Outbound webhooks", false),
  feature("auto_topup", "Auto top-up", false),
];
const STARTER = ["ai_auto_reply", "working_hours_mode", "lead_qualification", "booking", "reminder_24h", "staff_alerts", "auto_topup"];
const GROWTH = [...STARTER, "daily_agenda", "followup_nudges", "review_request"];
const PLANS = [
  { key: "starter", name: "Starter", monthly_credits: 1500, feature_keys: STARTER },
  { key: "growth", name: "Growth", monthly_credits: 5000, feature_keys: GROWTH },
  { key: "pro", name: "Pro", monthly_credits: 15000, feature_keys: [...GROWTH, "outbound_webhooks"] },
  { key: "trial", name: "Trial", monthly_credits: 300, feature_keys: GROWTH },
];

// The last 30 days' sends per kind, answered in the order the module asks (KINDS order).
const METERED_KINDS = Object.entries(KINDS).flatMap(([kind, c]) => (c.charged && c.feature ? [kind] : []));
const sends = (counts: Record<string, number>): FakeDbResponse[] => METERED_KINDS.map((kind) => ({ data: null, error: null, count: counts[kind] ?? 0 }));

function deps(options: {
  toggles?: { feature_key: string; enabled: boolean; settings: Record<string, unknown> }[];
  alertRoles?: string[];
  services?: number;
  counts?: Record<string, number>;
  rpc?: FakeDbResponse;
} = {}) {
  const db = fakeDb({
    features: { data: FEATURES, error: null },
    plans: { data: PLANS, error: null },
    tenant_features: { data: options.toggles ?? [], error: null },
    memberships: { data: (options.alertRoles ?? ["owner"]).map((role) => ({ role })), error: null },
    services: { data: null, error: null, count: options.services ?? 1 },
    audit_logs: sends(options.counts ?? {}),
    "rpc:set_tenant_feature": options.rpc ?? { data: { changed: true, enabled: true, settings: {} }, error: null },
  });
  const invalidate = vi.fn();
  const featureDeps: FeatureDeps = { db: db.client, now: () => new Date("2026-10-12T06:00:00Z"), invalidate };
  return { featureDeps, calls: db.calls, invalidate };
}

const rows = (list: FeatureList) => new Map(list.groups.flatMap((g) => g.features).map((f) => [f.key, f]));

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (e) {
    return e as { code: string; message: string; fields?: Record<string, string> };
  }
  throw new Error("expected a refusal");
}

describe("GET /api/features", () => {
  it("shows each feature's state on the business's plan, with the plan that unlocks a locked one", async () => {
    const { featureDeps } = deps({ toggles: [{ feature_key: "reminder_24h", enabled: false, settings: { offset_minutes: 720 } }] });
    const list = FeatureList.parse(await listFeatures(context("starter"), featureDeps));
    const byKey = rows(list);

    expect(list.plan).toEqual({ key: "starter", name: "Starter", monthlyCredits: 1500 });
    expect(byKey.get("ai_auto_reply")).toMatchObject({ state: "on", enabled: true, requiredPlan: null });
    expect(byKey.get("reminder_24h")).toMatchObject({ state: "off", enabled: false, settings: { offset_minutes: 720 }, control: "timing" });
    expect(byKey.get("followup_nudges")).toMatchObject({ state: "locked", enabled: true, requiredPlan: "growth", disabledReason: null });
    expect(byKey.get("outbound_webhooks")).toMatchObject({ state: "locked", requiredPlan: "pro" });
    expect(byKey.get("working_hours_mode")).toMatchObject({ state: "disabled", disabledReason: "Not available yet.", control: "segmented" });
    expect(byKey.get("auto_topup")).toMatchObject({ state: "disabled", creditsPerMonth: null, creditNote: "Only when used" });
  });

  it("counts each metered feature's credits from its last 30 days of sends, and estimates the month from the features that are on", async () => {
    const { featureDeps, calls } = deps({ counts: { ai_reply: 120, reminder_24h: 30, followup_nudge: 9 } });
    const list = await listFeatures(context("growth"), featureDeps);
    const byKey = rows(list);

    expect(byKey.get("ai_auto_reply")).toMatchObject({ creditsPerMonth: 120, creditNote: null });
    expect(byKey.get("reminder_24h")).toMatchObject({ creditsPerMonth: 30 });
    expect(byKey.get("followup_nudges")).toMatchObject({ creditsPerMonth: 9 });
    expect(byKey.get("lead_qualification")).toMatchObject({ creditsPerMonth: null, creditNote: "Part of replies" });
    expect(byKey.get("staff_alerts")).toMatchObject({ creditsPerMonth: null, creditNote: "No extra credits" });
    // review_request is on but has no review link, so it is disabled and not counted.
    expect(list.estimatedCreditsPerMonth).toBe(120 + 30 + 9);
    // Counted from the business's own audit rows, from 30 days back.
    const since = calls.filter((c) => c.table === "audit_logs" && c.method === "gte");
    expect(since).toHaveLength(METERED_KINDS.length);
    expect(since[0].args).toEqual(["created_at", "2026-09-12T06:00:00.000Z"]);
    expect(calls.filter((c) => c.table === "audit_logs" && c.method === "eq" && c.args[0] === "tenant_id")).toHaveLength(METERED_KINDS.length);
  });

  it("says why a feature in the plan cannot work yet", async () => {
    const { featureDeps } = deps({ alertRoles: ["admin"], services: 0 });
    const byKey = rows(await listFeatures(context("growth"), featureDeps));
    expect(byKey.get("review_request")).toMatchObject({ state: "disabled", disabledReason: "Add your review link to send it." });
    expect(byKey.get("daily_agenda")).toMatchObject({ state: "disabled", disabledReason: "Add your WhatsApp number on the Team screen to get the agenda." });
    // An admin's number is enough for staff alerts.
    expect(byKey.get("staff_alerts")).toMatchObject({ state: "on" });
    expect(byKey.get("booking")).toMatchObject({ state: "disabled", disabledReason: "Add a service first." });

    const none = rows(await listFeatures(context("growth"), deps({ alertRoles: [] }).featureDeps));
    expect(none.get("staff_alerts")).toMatchObject({ state: "disabled", disabledReason: "Add a WhatsApp number on the Team screen to get alerts." });

    const ready = rows(
      await listFeatures(context("growth"), deps({ toggles: [{ feature_key: "review_request", enabled: true, settings: { review_url: "https://g.page/r/abc" } }] }).featureDeps),
    );
    expect(ready.get("review_request")).toMatchObject({ state: "on", disabledReason: null });
  });

  it("puts every feature in exactly one group", async () => {
    const keys = FEATURE_GROUPS.flatMap((g) => g.keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(Object.keys(FEATURE_CREDIT_COST).sort());
    for (const key of NOT_AVAILABLE_YET) expect(keys).toContain(key);
    // A feature the code does not know yet still shows, under Other.
    const { featureDeps } = deps();
    const db = featureDeps.db as unknown as { from: (t: string) => unknown };
    const original = db.from.bind(db);
    db.from = (table: string) => (table === "features" ? fakeDb({ features: { data: [...FEATURES, feature("new_thing", "New thing", true, 0)], error: null } }).client.from("features") : original(table));
    const list = await listFeatures(context("starter"), featureDeps);
    expect(list.groups.at(-1)).toMatchObject({ name: "Other", features: [{ key: "new_thing", state: "locked", requiredPlan: null }] });
  });
});

describe("PATCH /api/features/:key", () => {
  it("is for owners and admins", async () => {
    const { featureDeps, calls } = deps();
    expect((await refusal(updateFeature(context("starter", "staff"), "reminder_24h", { enabled: false }, featureDeps))).code).toBe("forbidden");
    expect(calls).toHaveLength(0);
  });

  it("refuses a body that changes nothing or has other fields", async () => {
    const { featureDeps } = deps();
    expect((await refusal(updateFeature(context("starter"), "reminder_24h", {}, featureDeps))).code).toBe("validation_failed");
    expect((await refusal(updateFeature(context("starter"), "reminder_24h", { enabled: "yes" }, featureDeps))).code).toBe("validation_failed");
    expect((await refusal(updateFeature(context("starter"), "reminder_24h", { enabled: true, plan: "pro" }, featureDeps))).code).toBe("validation_failed");
  });

  it("does not know a feature that does not exist", async () => {
    expect((await refusal(updateFeature(context("starter"), "teleport", { enabled: true }, deps().featureDeps))).code).toBe("not_found");
  });

  it("will not switch on, or change the settings of, a feature the plan does not include", async () => {
    const { featureDeps, calls } = deps();
    const locked = await refusal(updateFeature(context("starter"), "outbound_webhooks", { enabled: true }, featureDeps));
    expect(locked).toMatchObject({ code: "plan_required", message: "Outbound webhooks needs the Pro plan. Upgrade to switch it on." });
    const settings = await refusal(updateFeature(context("starter"), "followup_nudges", { settings: { nurture_after_minutes: 1440 } }, featureDeps));
    expect(settings).toMatchObject({ code: "plan_required", message: "Follow-up nudges needs the Growth plan. Upgrade to switch it on." });
    expect(calls.filter((c) => c.table.startsWith("rpc:"))).toHaveLength(0);
  });

  it("lets a locked feature be switched off", async () => {
    const { featureDeps, calls } = deps({ rpc: { data: { changed: true, enabled: false, settings: {} }, error: null } });
    const row = FeatureRow.parse(await updateFeature(context("starter"), "followup_nudges", { enabled: false }, featureDeps));
    expect(row).toMatchObject({ state: "locked", enabled: false });
    expect(calls.find((c) => c.table === "rpc:set_tenant_feature")?.args[0]).toMatchObject({ p_feature_key: "followup_nudges", p_enabled: false, p_settings: null });
  });

  it("will not switch on a feature that is not available yet", async () => {
    const refused = await refusal(updateFeature(context("starter"), "working_hours_mode", { enabled: true }, deps().featureDeps));
    expect(refused).toMatchObject({ code: "not_available", message: "Working-hours mode isn't available yet." });
  });

  it("saves a switch through set_tenant_feature as the member, and answers the feature as it now stands", async () => {
    const { featureDeps, calls, invalidate } = deps({ rpc: { data: { changed: true, enabled: false, settings: {} }, error: null } });
    const row = await updateFeature(context("starter"), "reminder_24h", { enabled: false }, featureDeps);
    expect(calls.find((c) => c.table === "rpc:set_tenant_feature")?.args[0]).toEqual({
      p_tenant_id: TENANT,
      p_feature_key: "reminder_24h",
      p_enabled: false,
      p_settings: null,
      p_actor: USER,
    });
    expect(row).toMatchObject({ key: "reminder_24h", state: "off", enabled: false });
    expect(invalidate).toHaveBeenCalledWith(TENANT);
  });

  it("merges and checks settings before saving them", async () => {
    const { featureDeps, calls } = deps({
      toggles: [{ feature_key: "reminder_24h", enabled: true, settings: { offset_minutes: 1440 } }],
      rpc: { data: { changed: true, enabled: true, settings: { offset_minutes: 720 } }, error: null },
    });
    const row = await updateFeature(context("starter"), "reminder_24h", { settings: { offset_minutes: 720 } }, featureDeps);
    expect(calls.find((c) => c.table === "rpc:set_tenant_feature")?.args[0]).toMatchObject({ p_enabled: null, p_settings: { offset_minutes: 720 } });
    expect(row.settings).toEqual({ offset_minutes: 720 });

    const bad = await refusal(updateFeature(context("starter"), "reminder_24h", { settings: { offset_minutes: 0 } }, deps().featureDeps));
    expect(bad).toMatchObject({ code: "validation_failed", fields: { settings: expect.stringMatching(/from 1 to 10080/) } });
  });

  it("does not drop the cache when nothing changed", async () => {
    const { featureDeps, invalidate } = deps({ rpc: { data: { changed: false, enabled: true, settings: {} }, error: null } });
    await updateFeature(context("starter"), "ai_auto_reply", { enabled: true }, featureDeps);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("gives the database the last word when the plan changed in between", async () => {
    const { featureDeps } = deps({ rpc: { data: null, error: { code: "PA403", message: "set_tenant_feature: reminder_24h is not in this business's plan" } } });
    expect(await refusal(updateFeature(context("starter"), "reminder_24h", { enabled: false }, featureDeps))).toMatchObject({
      code: "plan_required",
      message: "Day-before reminder isn't included in your plan.",
    });
  });
});
