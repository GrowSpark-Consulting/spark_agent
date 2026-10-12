import { PAID_PLAN_KEYS, UpdateFeatureInput, type FeatureList, type FeatureRow, type TenantContext } from "@pakka/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { ReviewSettings } from "../booking/post-visit";
import { AppError, zodFieldErrors } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase-admin";
import { requireRole } from "../lib/tenant";
import { KINDS } from "../notify/kinds";
import { invalidateFeatureCache } from "./is-enabled";
import { mergeSettings } from "./settings";

// The Features screen's two routes (docs/dashboard-screen-contracts.md, "Features"; 9-day plan, Day 5): every feature
// with what the plan includes, the business's switch and settings, and the credits it spent in the last 30 days; and
// the change of one switch or its settings. What the plan includes is decided here, never in the browser. The change
// itself is set_tenant_feature (0025): the plan check, the write and the audit row in one transaction, so no path can
// switch on a feature the plan does not include.

/** The screen's groups, in order: the prototype's, then the features it shows on other screens. */
export const FEATURE_GROUPS: readonly { name: string; keys: readonly string[] }[] = [
  { name: "Conversations", keys: ["ai_auto_reply", "working_hours_mode", "lead_qualification"] },
  { name: "Booking", keys: ["booking", "booking_confirmation"] },
  { name: "Reminders", keys: ["reminder_24h", "reminder_2h"] },
  { name: "Follow-up and feedback", keys: ["followup_nudges", "noshow_rebooking", "feedback_request", "review_request"] },
  { name: "Team alerts", keys: ["staff_alerts", "daily_agenda", "outbound_webhooks"] },
  { name: "Billing", keys: ["auto_topup"] },
  { name: "Handover", keys: ["handoff_triggers", "handoff_own_number"] },
  { name: "Agent", keys: ["custom_scoring"] },
  { name: "Quotes and trips", keys: ["quote_auto_send", "quote_followup", "pretrip_info"] },
];

/**
 * Switches with no code behind them yet. They show as disabled ("Not available yet") and cannot be switched on, so a
 * switch never pretends to do something. Remove a key in the change that ships its feature.
 */
export const NOT_AVAILABLE_YET: ReadonlySet<string> = new Set([
  "working_hours_mode",
  "booking_confirmation", // the assistant confirms a booking in its own reply (Dev 1's Day 3 note); a separate message is not sent
  "auto_topup",
  "outbound_webhooks",
  "quote_auto_send",
  "quote_followup",
  "pretrip_info",
]);

const PART_OF_REPLIES = new Set(["lead_qualification", "booking"]);
const ONLY_WHEN_USED = new Set(["auto_topup"]);
const CONTROLS: Readonly<Record<string, FeatureRow["control"]>> = { working_hours_mode: "segmented", reminder_24h: "timing" };
const USAGE_DAYS = 30;

export interface FeatureDeps {
  db: SupabaseClient;
  now: () => Date;
  /** Drops this server's cached feature states for the business (other servers catch up within 60 seconds). */
  invalidate: (tenantId: string) => void;
}

const defaults = (): FeatureDeps => ({ db: supabaseAdmin(), now: () => new Date(), invalidate: (tenantId) => invalidateFeatureCache(tenantId) });

const FeatureDef = z.object({ key: z.string(), name: z.string(), description: z.string(), default_on: z.boolean(), credit_cost: z.number().int() });
type FeatureDef = z.infer<typeof FeatureDef>;
const PlanDef = z.object({ key: z.string(), name: z.string(), monthly_credits: z.number().int(), feature_keys: z.array(z.string()) });
type PlanDef = z.infer<typeof PlanDef>;
const Settings = z.record(z.string(), z.unknown());
const Toggle = z.object({ feature_key: z.string(), enabled: z.boolean(), settings: Settings.catch({}) });
const Saved = z.object({ changed: z.boolean(), enabled: z.boolean(), settings: Settings });

interface Snapshot {
  plan: PlanDef;
  plans: PlanDef[];
  features: FeatureDef[];
  toggles: Map<string, { enabled: boolean; settings: Record<string, unknown> }>;
  /** Roles of the members who set an alert number. */
  alertRoles: Set<string>;
  hasService: boolean;
  /** Messages sent per feature in the last 30 days (their `<kind>.sent` audit rows). */
  sends: Map<string, number>;
}

// The kinds that cost credits, and the feature each one belongs to.
const METERED = Object.entries(KINDS).flatMap(([kind, config]) => (config.charged && config.feature ? [{ kind, feature: config.feature }] : []));

function readOrThrow<T>(what: string, result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) throw new Error(`features: ${what} read failed: ${result.error.message}`);
  return result.data as T;
}

function countOrThrow(what: string, result: { count: number | null; error: { message: string } | null }): number {
  if (result.error) throw new Error(`features: ${what} count failed: ${result.error.message}`);
  return result.count ?? 0;
}

async function loadSnapshot(tenantId: string, planKey: string, deps: FeatureDeps): Promise<Snapshot> {
  const { db } = deps;
  const since = new Date(deps.now().getTime() - USAGE_DAYS * 24 * 60 * 60_000).toISOString();
  const [[features, plans, toggles, members, services], counts] = await Promise.all([
    Promise.all([
      db.from("features").select("key, name, description, default_on, credit_cost"),
      db.from("plans").select("key, name, monthly_credits, feature_keys"),
      db.from("tenant_features").select("feature_key, enabled, settings").eq("tenant_id", tenantId),
      db.from("memberships").select("role").eq("tenant_id", tenantId).not("whatsapp_phone", "is", null),
      db.from("services").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("active", true),
    ]),
    Promise.all(
      METERED.map((m) =>
        db.from("audit_logs").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("action", `${m.kind}.sent`).gte("created_at", since),
      ),
    ),
  ]);

  const allPlans = z.array(PlanDef).parse(readOrThrow("plans", plans) ?? []);
  const plan = allPlans.find((p) => p.key === planKey);
  if (!plan) throw new Error(`features: the business's plan ${planKey} is not in the catalogue`);
  const sends = new Map<string, number>();
  METERED.forEach((m, i) => sends.set(m.feature, (sends.get(m.feature) ?? 0) + countOrThrow(`${m.kind} sends`, counts[i])));
  return {
    plan,
    plans: allPlans,
    features: z.array(FeatureDef).parse(readOrThrow("features", features) ?? []),
    toggles: new Map(z.array(Toggle).parse(readOrThrow("toggles", toggles) ?? []).map((t) => [t.feature_key, { enabled: t.enabled, settings: t.settings }])),
    alertRoles: new Set(z.array(z.object({ role: z.string() })).parse(readOrThrow("alert numbers", members) ?? []).map((m) => m.role)),
    hasService: countOrThrow("services", services) > 0,
    sends,
  };
}

/** Why a feature the plan includes cannot work right now, in plain words, or null. */
function dependencyReason(key: string, settings: Record<string, unknown>, snapshot: Snapshot): string | null {
  if (NOT_AVAILABLE_YET.has(key)) return "Not available yet.";
  if (key === "review_request" && !ReviewSettings.safeParse(settings).success) return "Add your review link to send it.";
  if (key === "staff_alerts" && !snapshot.alertRoles.has("owner") && !snapshot.alertRoles.has("admin")) {
    return "Add a WhatsApp number on the Team screen to get alerts.";
  }
  if (key === "daily_agenda" && !snapshot.alertRoles.has("owner")) return "Add your WhatsApp number on the Team screen to get the agenda.";
  if (key === "booking" && !snapshot.hasService) return "Add a service first.";
  return null;
}

function rowFor(def: FeatureDef, snapshot: Snapshot): FeatureRow {
  const inPlan = snapshot.plan.feature_keys.includes(def.key);
  const saved = snapshot.toggles.get(def.key);
  const enabled = saved?.enabled ?? def.default_on;
  const settings = saved?.settings ?? {};
  const reason = inPlan ? dependencyReason(def.key, settings, snapshot) : null;
  const metered = def.credit_cost > 0;
  return {
    key: def.key,
    name: def.name,
    description: def.description,
    state: !inPlan ? "locked" : reason ? "disabled" : enabled ? "on" : "off",
    enabled,
    requiredPlan: inPlan ? null : (PAID_PLAN_KEYS.find((k) => snapshot.plans.find((p) => p.key === k)?.feature_keys.includes(def.key)) ?? null),
    disabledReason: reason,
    creditsPerMonth: metered ? (snapshot.sends.get(def.key) ?? 0) * def.credit_cost : null,
    creditNote: metered ? null : PART_OF_REPLIES.has(def.key) ? "Part of replies" : ONLY_WHEN_USED.has(def.key) ? "Only when used" : "No extra credits",
    settings,
    control: CONTROLS[def.key] ?? "switch",
  };
}

/** GET /api/features: every feature, grouped for the screen. Any member may read it. */
export async function listFeatures(context: TenantContext, deps: FeatureDeps = defaults()): Promise<FeatureList> {
  const snapshot = await loadSnapshot(context.tenant.id, context.tenant.planKey, deps);
  const rows = new Map(snapshot.features.map((def) => [def.key, rowFor(def, snapshot)]));
  const groups = FEATURE_GROUPS.map((g) => ({ name: g.name, features: g.keys.flatMap((k) => rows.get(k) ?? []) })).filter((g) => g.features.length > 0);
  const grouped = new Set(FEATURE_GROUPS.flatMap((g) => g.keys));
  const other = [...rows.values()].filter((r) => !grouped.has(r.key));
  if (other.length > 0) groups.push({ name: "Other", features: other });
  return {
    plan: { key: snapshot.plan.key, name: snapshot.plan.name, monthlyCredits: snapshot.plan.monthly_credits },
    estimatedCreditsPerMonth: [...rows.values()].reduce((sum, r) => sum + (r.state === "on" ? (r.creditsPerMonth ?? 0) : 0), 0),
    groups,
  };
}

/**
 * PATCH /api/features/:key: switch a feature on or off, or change its settings. Owner or admin. A feature the plan does
 * not include cannot be switched on and its settings cannot change (plan_required); switching it off is allowed. A
 * feature that is not available yet cannot be switched on. Answers the feature as it now stands.
 */
export async function updateFeature(context: TenantContext, key: string, body: unknown, deps: FeatureDeps = defaults()): Promise<FeatureRow> {
  requireRole(context, ["owner", "admin"], "change features");
  const parsed = UpdateFeatureInput.safeParse(body);
  if (!parsed.success) throw new AppError("validation_failed", "Check the fields and try again.", zodFieldErrors(parsed.error));
  const input = parsed.data;

  const snapshot = await loadSnapshot(context.tenant.id, context.tenant.planKey, deps);
  const def = snapshot.features.find((f) => f.key === key);
  if (!def) throw new AppError("not_found", "That feature doesn't exist.");
  const current = rowFor(def, snapshot);
  const switchingOn = input.enabled === true && !current.enabled;
  if (current.state === "locked" && (switchingOn || input.settings !== undefined)) {
    const planName = snapshot.plans.find((p) => p.key === current.requiredPlan)?.name;
    throw new AppError("plan_required", planName ? `${def.name} needs the ${planName} plan. Upgrade to switch it on.` : `${def.name} isn't included in your plan.`);
  }
  if (switchingOn && NOT_AVAILABLE_YET.has(key)) throw new AppError("not_available", `${def.name} isn't available yet.`);
  const settings = input.settings === undefined ? null : mergeSettings(key, current.settings, input.settings);

  const { data, error } = await deps.db.rpc("set_tenant_feature", {
    p_tenant_id: context.tenant.id,
    p_feature_key: key,
    p_enabled: input.enabled ?? null,
    p_settings: settings,
    p_actor: context.user.id,
  });
  if (error) {
    // The plan changed between the read above and the write: the database had the last word.
    if (error.code === "PA403") throw new AppError("plan_required", `${def.name} isn't included in your plan.`);
    if (error.code === "PA404") throw new AppError("not_found", "That feature doesn't exist.");
    throw new Error(`set_tenant_feature failed: ${error.message}`);
  }
  const saved = Saved.parse(data);
  if (saved.changed) deps.invalidate(context.tenant.id);
  snapshot.toggles.set(key, { enabled: saved.enabled, settings: saved.settings });
  return rowFor(def, snapshot);
}
