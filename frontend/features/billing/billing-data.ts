import { AccountStatus, CancelPlanResult, ChangePlanInput, ChangePlanResult, CheckoutInput, OneTimePaymentInput, PayuCheckout, PaymentView, ResumePlanResult } from "@pakka/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getJson, postJson } from "@/lib/api/client";

// The Billing screen's calls (docs/contracts.md, "PayU billing", decision 20; shapes from @pakka/types billing.ts):
//   GET  /api/billing/balance          → AccountStatus     (backend/src/billing/account-status.ts)
//   credit_ledger                      → the credit history, read under RLS (members read their own business's rows, 0001)
//   plans                              → the plans on offer, read under RLS (a catalogue every signed-in user reads, 0001)
//   POST /api/billing/checkout         { planKey, cycle, phone? } → PayuCheckout        owner only
//   POST /api/billing/topup            { phone? } or no body      → PayuCheckout        owner only
//   POST /api/billing/setup-fee        { phone? } or no body      → PayuCheckout        owner only
//   POST /api/billing/change-plan      { planKey, cycle?, phone? } → ChangePlanResult   owner only
//   POST /api/billing/cancel           (no body) → CancelPlanResult: scheduled { endsAt } | ended          owner only
//   POST /api/billing/resume           (no body) → ResumePlanResult { renewsAt }                         owner only
//   GET  /api/billing/payments/:id     → PaymentView (created | pending | success | failed); any member
// The server decides every amount; the browser sends no price. A PayuCheckout is not a payment: it is the form to POST to PayU
// (payu-form.ts). Only GET /api/billing/payments/:id says whether a payment went through (payment-poll.ts).

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

// Paying -----------------------------------------------------------------------------------------------------------

/** A payment id as the API makes it (a uuid). PayU sends the payer back with ?payment=unknown when the transaction isn't ours. */
export const isPaymentId = (text: string): boolean => z.guid().safeParse(text).success;

/** Reads an answer with its shared schema; the message never carries the answer itself (it can hold PayU's signed fields). */
function parseAnswer<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new BillingDataError(what);
  return parsed.data;
}

/** The plan's first payment and its auto-debit approval. Input is checked before it is sent (a bad phone throws a ZodError). */
export async function startCheckout(tenantId: string, input: CheckoutInput): Promise<PayuCheckout> {
  const body = CheckoutInput.parse(input);
  return parseAnswer(PayuCheckout, await postJson<unknown>("/api/billing/checkout", body, { tenantId }), "checkout");
}

/** One top-up pack. `phone` only when the server asked for it; without it the request has no body. */
export async function startTopup(tenantId: string, input: OneTimePaymentInput = {}): Promise<PayuCheckout> {
  const body = OneTimePaymentInput.parse(input);
  return parseAnswer(PayuCheckout, await postJson<unknown>("/api/billing/topup", body.phone ? body : undefined, { tenantId }), "top-up");
}

/** The assisted-onboarding setup fee. Same body rule as the top-up. */
export async function startSetupFee(tenantId: string, input: OneTimePaymentInput = {}): Promise<PayuCheckout> {
  const body = OneTimePaymentInput.parse(input);
  return parseAnswer(PayuCheckout, await postJson<unknown>("/api/billing/setup-fee", body.phone ? body : undefined, { tenantId }), "setup fee");
}

/** upgrade → pay on PayU; scheduled, kept and unchanged are done and need no payment. */
export async function changePlan(tenantId: string, input: ChangePlanInput): Promise<ChangePlanResult> {
  const body = ChangePlanInput.parse(input);
  return parseAnswer(ChangePlanResult, await postJson<unknown>("/api/billing/change-plan", body, { tenantId }), "plan change");
}

/** Stops the plan renewing (it ends with the period already paid), or ends a past-due plan now. No money moves, so there is no PayU step. */
export async function cancelPlan(tenantId: string): Promise<CancelPlanResult> {
  return parseAnswer(CancelPlanResult, await postJson<unknown>("/api/billing/cancel", undefined, { tenantId }), "cancel");
}

/** Keeps a cancelled plan: it renews again while its period lasts. */
export async function resumePlan(tenantId: string): Promise<ResumePlanResult> {
  return parseAnswer(ResumePlanResult, await postJson<unknown>("/api/billing/resume", undefined, { tenantId }), "resume");
}

/** One payment of this business. The answer must be for the payment asked about. */
export async function fetchPayment(tenantId: string, id: string, signal?: AbortSignal): Promise<PaymentView> {
  const payment = parseAnswer(PaymentView, await getJson<unknown>(`/api/billing/payments/${encodeURIComponent(id)}`, { tenantId, signal }), "payment");
  if (payment.id !== id) throw new BillingDataError("payment");
  return payment;
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
