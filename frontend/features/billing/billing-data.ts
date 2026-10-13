import { AccountStatus } from "@pakka/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getJson } from "@/lib/api/client";

// The Billing screen's reads (docs/dashboard-screen-contracts.md, "Billing & credits"):
//   GET /api/billing/balance → AccountStatus     (backend/src/billing/account-status.ts; shape from @pakka/types)
//   credit_ledger            → the credit history, read under RLS (members read their own business's rows, 0001)
//   plans                    → the plans on offer, read under RLS (a catalogue every signed-in user reads, 0001)
// Paying is NOT here: POST /api/billing/checkout, /topup and /change-plan, the Razorpay webhook and invoices are Dev 2's and are not on the
// API yet (backend/src/server/routes.ts), so this file has no call for them and the screen has no button for them.

export class BillingDataError extends Error {
  constructor(what: string) {
    super(`The ${what} answer had an unexpected shape.`);
    this.name = "BillingDataError";
  }
}

export async function fetchAccountStatus(tenantId: string, signal?: AbortSignal): Promise<AccountStatus> {
  const parsed = AccountStatus.safeParse(await getJson<unknown>("/api/billing/balance", { tenantId, signal }));
  if (!parsed.success) throw new BillingDataError("balance");
  return parsed.data;
}

// Plans ------------------------------------------------------------------------------------------------------------

const PlanRow = z.object({
  key: z.string(),
  name: z.string(),
  price_inr: z.number().int().nonnegative(),
  monthly_credits: z.number().int().nonnegative(),
  seats: z.number().int(),
  whatsapp_numbers: z.number().int(),
});

export interface PlanOption {
  key: string;
  name: string;
  priceInr: number;
  monthlyCredits: number;
  seats: number;
  whatsappNumbers: number;
}

/** The plans a business can buy, cheapest first. The trial is not one of them. */
export async function fetchPlans(client: SupabaseClient): Promise<PlanOption[]> {
  const { data, error } = await client.from("plans").select("key, name, price_inr, monthly_credits, seats, whatsapp_numbers").order("price_inr", { ascending: true });
  if (error) throw error;
  const parsed = z.array(PlanRow).safeParse(data ?? []);
  if (!parsed.success) throw new BillingDataError("plans");
  return parsed.data
    .filter((p) => p.key !== "trial")
    .map((p) => ({ key: p.key, name: p.name, priceInr: p.price_inr, monthlyCredits: p.monthly_credits, seats: p.seats, whatsappNumbers: p.whatsapp_numbers }));
}

export type PlanRelation = "current" | "upgrade" | "downgrade";

/** How a plan compares with the one the business is on, by price: the catalogue's own order, not a list of names. */
export function planRelation(plan: PlanOption, current: { key: string } | null, plans: readonly PlanOption[]): PlanRelation {
  if (current && plan.key === current.key) return "current";
  const now = current ? plans.find((p) => p.key === current.key) : undefined;
  // A trial (or a plan not in the catalogue) is below every paid plan.
  return !now || plan.priceInr > now.priceInr ? "upgrade" : "downgrade";
}

// Credit history ---------------------------------------------------------------------------------------------------

export const HISTORY_PAGE = 50;

const LedgerRow = z.object({
  id: z.union([z.number(), z.string()]).transform(String),
  tenant_id: z.guid(),
  delta: z.number().int(),
  reason: z.string(),
  expires_at: z.string().nullable(),
  created_at: z.string(),
});

export interface LedgerEntry {
  id: string;
  at: string;
  delta: number;
  reason: string;
  label: string;
  expiresAt: string | null;
}

const REASON_LABELS: Record<string, string> = {
  plan_grant: "Monthly plan credits",
  trial_grant: "Free trial credits",
  topup: "Credit top-up",
  ai_reply: "AI reply",
  template_utility: "Template message (utility)",
  template_marketing: "Template message (marketing)",
  staff_alert: "Staff alert",
  cycle_reset: "Credits renewed for the new cycle",
  admin: "Added by Spark Agent",
};

/** Words for a ledger reason; a reason this screen doesn't know is shown humanised, never hidden. */
export function reasonLabel(reason: string): string {
  const known = REASON_LABELS[reason];
  if (known) return known;
  const spaced = reason.replace(/[_-]+/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : "Other";
}

/** The newest `limit` ledger rows of this business, newest first. */
export async function fetchCreditHistory(client: SupabaseClient, tenantId: string, limit = HISTORY_PAGE): Promise<LedgerEntry[]> {
  const { data, error } = await client
    .from("credit_ledger")
    .select("id, tenant_id, delta, reason, expires_at, created_at")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const parsed = z.array(LedgerRow).safeParse(data ?? []);
  if (!parsed.success) throw new BillingDataError("credit history");
  return parsed.data
    .filter((r) => r.tenant_id === tenantId)
    .map((r) => ({ id: r.id, at: r.created_at, delta: r.delta, reason: r.reason, label: reasonLabel(r.reason), expiresAt: r.expires_at }));
}
