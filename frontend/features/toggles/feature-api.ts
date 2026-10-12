import { FEATURE_ROW_STATES, FeatureList, FeatureRow, PAID_PLAN_KEYS, type Role } from "@pakka/types";
import { getJson, patchJson } from "@/lib/api/client";
import { isRouteMissing } from "@/lib/api/route-missing";
import { ApiError } from "@/lib/errors";

// The Features screen's two routes (docs/dashboard-screen-contracts.md, "Features"; docs/contracts.md, "Feature toggles"):
//   GET   /api/features        → FeatureList (any member)
//   PATCH /api/features/:key   { enabled?, settings? } → FeatureRow (owner or admin)
// Both shapes come from `@pakka/types` (packages/types/src/features.ts), the backend's own schemas, and every answer is parsed
// before it is used. Nothing here decides what a plan includes: `state` and `requiredPlan` come from the server, and the server
// refuses to switch on a locked feature whatever this file sends (set_tenant_feature, plan_required).

export { PAID_PLAN_KEYS, FEATURE_ROW_STATES, FeatureList, FeatureRow };

/** An answer that is not the contract's shape (a proxy, or a server on another version). Never shown half drawn. */
export class FeatureDataError extends Error {
  constructor() {
    super("The features answer had an unexpected shape.");
    this.name = "FeatureDataError";
  }
}

/** What the screen calls. Injected in tests. */
export interface FeatureService {
  load: (tenantId: string, signal?: AbortSignal) => Promise<FeatureList>;
  update: (tenantId: string, key: string, change: FeatureChange) => Promise<FeatureRow>;
}

export type FeatureChange = { enabled: boolean } | { settings: Record<string, unknown> };

export const featureService: FeatureService = {
  async load(tenantId, signal) {
    const parsed = FeatureList.safeParse(await getJson<unknown>("/api/features", { tenantId, signal }));
    if (!parsed.success) throw new FeatureDataError();
    return parsed.data;
  },
  async update(tenantId, key, change) {
    const parsed = FeatureRow.safeParse(await patchJson<unknown>(`/api/features/${encodeURIComponent(key)}`, change, { tenantId }));
    if (!parsed.success) throw new FeatureDataError();
    return parsed.data;
  },
};

// What a member may do with a row ---------------------------------------------------------------------------

const CAN_CHANGE: readonly Role[] = ["owner", "admin"];

export const canChangeFeatures = (role: Role): boolean => CAN_CHANGE.includes(role);

export type RowControl =
  /** The switch works. `checked` is the business's own switch. */
  | { kind: "interactive"; checked: boolean }
  /** Shown, not usable. `why` says so in plain words. */
  | { kind: "fixed"; checked: boolean; why: string };

/**
 * Whether a row's switch can be used, and why not. A locked row (the plan does not include it) is never interactive:
 * its only action is Upgrade. A row that cannot work right now (disabled) can only be switched off, so a switch that
 * is on can still be turned off but one that is off cannot be turned on. Staff read. The server checks all of it again.
 */
export function rowControl(row: FeatureRow, role: Role): RowControl {
  if (row.state === "locked") return { kind: "fixed", checked: false, why: row.requiredPlan ? `Needs the ${PLAN_NAME[row.requiredPlan]} plan.` : "Not included in your plan." };
  if (!canChangeFeatures(role)) return { kind: "fixed", checked: row.enabled, why: "Only an owner or admin can change this." };
  if (row.state === "disabled" && !row.enabled) return { kind: "fixed", checked: false, why: row.disabledReason ?? "Can't be switched on right now." };
  return { kind: "interactive", checked: row.enabled };
}

const PLAN_NAME: Record<(typeof PAID_PLAN_KEYS)[number], string> = { starter: "Starter", growth: "Growth", pro: "Pro" };

export const planName = (key: (typeof PAID_PLAN_KEYS)[number]): string => PLAN_NAME[key];

/**
 * The request for a change, or null when this row must not be sent at all. A locked row is never switched on from here,
 * whatever called this; the server refuses it too (plan_required). Switching off is always sent.
 */
export function changeFor(row: FeatureRow, role: Role, wantOn: boolean): FeatureChange | null {
  const control = rowControl(row, role);
  if (control.kind === "fixed") return null;
  if (control.checked === wantOn) return null;
  return { enabled: wantOn };
}

// The list after a change ---------------------------------------------------------------------------------------

/** Replaces one row by the server's answer and recomputes the estimate the way the server does: credits of the rows that are on. */
export function withRow(list: FeatureList, row: FeatureRow): FeatureList {
  const groups = list.groups.map((g) => ({ ...g, features: g.features.map((f) => (f.key === row.key ? row : f)) }));
  return { ...list, groups, estimatedCreditsPerMonth: groups.flatMap((g) => g.features).reduce((sum, f) => sum + (f.state === "on" ? (f.creditsPerMonth ?? 0) : 0), 0) };
}

// The reminder's timing ------------------------------------------------------------------------------------------

/** The choices the Features contract names for the 24-hour reminder: 48, 24, 12 and 6 hours before. */
export const TIMING_CHOICES = [
  { minutes: 2880, label: "48 hours before" },
  { minutes: 1440, label: "24 hours before" },
  { minutes: 720, label: "12 hours before" },
  { minutes: 360, label: "6 hours before" },
] as const;

/** `reminder_24h` without a saved offset reminds 1440 minutes before (docs/contracts.md, section 3). */
export const DEFAULT_REMINDER_MINUTES = 1440;

export function savedOffset(row: FeatureRow): number {
  const value = row.settings.offset_minutes;
  return typeof value === "number" && Number.isInteger(value) ? value : DEFAULT_REMINDER_MINUTES;
}

export function offsetLabel(minutes: number): string {
  const known = TIMING_CHOICES.find((c) => c.minutes === minutes);
  if (known) return known.label;
  if (minutes % 60 === 0) return `${minutes / 60} hours before`;
  return `${minutes} minutes before`;
}

// Errors --------------------------------------------------------------------------------------------------------

/** The route is not on the server the browser talks to (the answer is a 404 `not_found` for the list itself). */
export const isFeatureApiMissing = isRouteMissing;

/** A change refused because the plan does not include the feature: the screen opens Upgrade, not a generic error. */
export function isPlanRequired(err: unknown): boolean {
  return err instanceof ApiError && err.body.error.code === "plan_required";
}
