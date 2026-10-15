import { AdminMetrics } from "@pakka/types";
import { getJson } from "@/lib/api/client";
import { AdminDataError } from "@/lib/admin/billing";

// The admin view's business numbers (docs/contracts.md, "Admin panel"; backend/src/billing/metrics.ts, migration 0051).
//   GET /api/admin/metrics → AdminMetrics { windows: [7 days, 30 days], targetCostPerCreditInr, usdInr, asOf }
// Platform admins only: the server answers `forbidden` to anyone else and that is the only check that counts. Like the other admin routes it
// names no business, so no X-Pakka-Tenant header is sent. Nothing is calculated here except the comparison with the target, from two fields
// the answer carries.

export async function fetchAdminMetrics(signal?: AbortSignal): Promise<AdminMetrics> {
  const parsed = AdminMetrics.safeParse(await getJson<unknown>("/api/admin/metrics", { signal }));
  if (!parsed.success) throw new AdminDataError("metrics");
  return parsed.data;
}

const rupees = (digits: { min: number; max: number }) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: digits.min, maximumFractionDigits: digits.max });

const whole = new Intl.NumberFormat("en-IN");
const inr2 = rupees({ min: 2, max: 2 });
const inr3 = rupees({ min: 3, max: 3 });
const usd4 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });
const percent1 = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const formatCount = (n: number) => whole.format(n);
/** Rupees to 2 places: the cost over a window. */
export const formatInr = (n: number) => inr2.format(n);
/** Rupees to 3 places: the backend rounds cost per credit to 3, and the target is two places, so a rounded figure would hide the gap. */
export const formatInrPerCredit = (n: number) => inr3.format(n);
export const formatUsd = (n: number) => usd4.format(n);
/** The answer's percentage already is a percentage (to 1 place). */
export const formatPercent = (n: number) => `${percent1.format(n)}%`;

export type TargetComparison = { kind: "no_credits" } | { kind: "within"; gapInr: number } | { kind: "above"; gapInr: number };

/** Cost per credit against what one credit may cost. `null` cost (no credits spent) is not compared: there is nothing to compare. */
export function compareToTarget(costPerCreditInr: number | null, targetInr: number): TargetComparison {
  if (costPerCreditInr === null) return { kind: "no_credits" };
  const gapInr = Math.round(Math.abs(costPerCreditInr - targetInr) * 1000) / 1000;
  return costPerCreditInr <= targetInr ? { kind: "within", gapInr } : { kind: "above", gapInr };
}

export const windowLabel = (days: number) => `Last ${days} days`;

export function formatAsOf(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "an unknown time";
  return at.toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}
