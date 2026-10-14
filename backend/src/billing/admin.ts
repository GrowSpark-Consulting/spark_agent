import {
  AdminFeatureInput,
  AdminPlanInput,
  ExtendTrialInput,
  GrantCreditsInput,
  type AdminFeature,
  type AdminPlan,
  type AdminTenant,
  type RefundCandidate,
} from "@pakka/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { invalidateFeatureCache } from "../features/is-enabled";
import { AppError } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase-admin";

// The admin panel's billing routes (docs/handover.md, "Admin (internal)"; migration 0041). The caller is a platform admin
// (adminRoute checks platform_admins); `actor` is admin:<user id>, recorded on every audit row. Each change and its audit
// row are one database call.

export interface AdminDeps {
  db: SupabaseClient;
  now: () => Date;
  /** After a feature's default changes, so this server stops serving the old states. */
  invalidate: () => void;
}

export const adminDeps = (): AdminDeps => ({ db: supabaseAdmin(), now: () => new Date(), invalidate: () => invalidateFeatureCache() });

type Admin = { actor: string };

const DAY_MS = 86_400_000;
const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);

/** PA404 and PA409 from the 0041 functions, as the panel shows them; anything else is unexpected. */
function fail(what: string, error: { code?: string; message: string }, conflict: string): never {
  if (error.code === "PA404") throw new AppError("not_found", "That business, plan or feature was not found.");
  if (error.code === "PA409") throw new AppError("conflict", conflict);
  if (error.code === "P0001") throw new AppError("validation_failed", error.message.replace(/^admin_[a-z_]+: /, "").replace(/^./, (c) => c.toUpperCase()) + ".");
  throw new Error(`${what} failed: ${error.message}`);
}

const TenantRow = z.object({
  tenant_id: z.string(),
  name: z.string(),
  vertical: z.string(),
  status: z.enum(["trial", "active", "paused", "cancelled"]),
  plan_key: z.string(),
  trial_ends_at: z.string().nullable(),
  created_at: z.string(),
  setup_call_paid_at: z.string().nullable(),
  credits: z.number().int().nullable(),
  subscription_status: z.enum(["active", "past_due"]).nullable(),
  billing_cycle: z.enum(["monthly", "yearly"]).nullable(),
  current_period_end: z.string().nullable(),
  members: z.number().int(),
  active_numbers: z.number().int(),
});

/** Every business, newest first, with what the panel lists. */
export async function listTenants(_admin: Admin, deps: AdminDeps = adminDeps()): Promise<AdminTenant[]> {
  const { data, error } = await deps.db.rpc("admin_tenants");
  if (error) throw new Error(`admin_tenants failed: ${error.message}`);
  return z
    .array(TenantRow)
    .parse(data ?? [])
    .map((r) => ({
      id: r.tenant_id,
      name: r.name,
      vertical: r.vertical,
      status: r.status,
      planKey: r.plan_key,
      trialEndsAt: iso(r.trial_ends_at),
      createdAt: new Date(r.created_at).toISOString(),
      setupCallPaidAt: iso(r.setup_call_paid_at),
      credits: r.credits ?? 0,
      subscription: r.subscription_status && r.billing_cycle ? { status: r.subscription_status, cycle: r.billing_cycle, periodEnd: iso(r.current_period_end) } : null,
      members: r.members,
      activeNumbers: r.active_numbers,
    }));
}

const Id = z.guid();
const notFound = () => new AppError("not_found", "That business was not found.");

export async function extendTrial(admin: Admin, tenantId: string, rawInput: unknown, deps: AdminDeps = adminDeps()): Promise<{ trialEndsAt: string }> {
  if (!Id.safeParse(tenantId).success) throw notFound();
  const input = ExtendTrialInput.parse(rawInput);
  const { data, error } = await deps.db.rpc("admin_extend_trial", { p_tenant_id: tenantId, p_days: input.days, p_actor: admin.actor });
  if (error) fail("admin_extend_trial", error, "This business is not on a trial: it has a plan, or its trial was cancelled.");
  return { trialEndsAt: new Date(z.string().parse(data)).toISOString() };
}

export async function grantCredits(admin: Admin, tenantId: string, rawInput: unknown, deps: AdminDeps = adminDeps()): Promise<{ granted: boolean; credits: number }> {
  if (!Id.safeParse(tenantId).success) throw notFound();
  const input = GrantCreditsInput.parse(rawInput);
  const expiresAt = input.expiresInDays ? new Date(deps.now().getTime() + input.expiresInDays * DAY_MS).toISOString() : null;
  const { data, error } = await deps.db.rpc("admin_grant_credits", {
    p_tenant_id: tenantId,
    p_amount: input.amount,
    p_expires_at: expiresAt,
    p_request_id: input.requestId ?? null,
    p_note: input.note ?? null,
    p_actor: admin.actor,
  });
  if (error) fail("admin_grant_credits", error, "Those credits could not be granted.");
  const balance = await deps.db.rpc("credit_balance", { p_tenant_id: tenantId });
  if (balance.error) throw new Error(`credit_balance failed: ${balance.error.message}`);
  const [row] = z.array(z.object({ total: z.number().int() })).length(1).parse(balance.data);
  return { granted: z.boolean().parse(data), credits: row.total };
}

const PlanRow = z.object({
  key: z.string(),
  name: z.string(),
  price_inr: z.number().int(),
  monthly_credits: z.number().int(),
  seats: z.number().int(),
  whatsapp_numbers: z.number().int(),
  feature_keys: z.array(z.string()),
});

export async function editPlan(admin: Admin, key: string, rawInput: unknown, deps: AdminDeps = adminDeps()): Promise<AdminPlan> {
  const input = AdminPlanInput.parse(rawInput);
  const { data, error } = await deps.db.rpc("admin_update_plan", {
    p_key: key,
    p_name: input.name ?? null,
    p_price_inr: input.priceInr ?? null,
    p_monthly_credits: input.monthlyCredits ?? null,
    p_seats: input.seats ?? null,
    p_whatsapp_numbers: input.whatsappNumbers ?? null,
    p_feature_keys: input.featureKeys ?? null,
    p_actor: admin.actor,
  });
  if (error) {
    fail("admin_update_plan", error, "Businesses are subscribed at this price: their auto-debits were approved for it, so the price can't change while they are.");
  }
  // A plan's features decide what its businesses may switch on.
  deps.invalidate();
  const [p] = z.array(PlanRow).length(1).parse(data);
  return { key: p.key, name: p.name, priceInr: p.price_inr, monthlyCredits: p.monthly_credits, seats: p.seats, whatsappNumbers: p.whatsapp_numbers, featureKeys: p.feature_keys };
}

const FeatureRow = z.object({ key: z.string(), name: z.string(), description: z.string(), default_on: z.boolean() });

export async function editFeature(admin: Admin, key: string, rawInput: unknown, deps: AdminDeps = adminDeps()): Promise<AdminFeature> {
  const input = AdminFeatureInput.parse(rawInput);
  const { data, error } = await deps.db.rpc("admin_update_feature", {
    p_key: key,
    p_name: input.name ?? null,
    p_description: input.description ?? null,
    p_default_on: input.defaultOn ?? null,
    p_actor: admin.actor,
  });
  if (error) fail("admin_update_feature", error, "That feature could not be changed.");
  deps.invalidate();
  const [f] = z.array(FeatureRow).length(1).parse(data);
  return { key: f.key, name: f.name, description: f.description, defaultOn: f.default_on };
}

const RefundRow = z.object({
  payment_id: z.string(),
  tenant_id: z.string(),
  tenant_name: z.string(),
  kind: z.string(),
  amount_paise: z.number().int(),
  provider_payment_id: z.string().nullable(),
  method: z.string().nullable(),
  paid_at: z.string().nullable(),
  flagged_at: z.string(),
});

/** Payments kept but flagged for a refund, newest first. */
export async function refundCandidates(_admin: Admin, deps: AdminDeps = adminDeps()): Promise<RefundCandidate[]> {
  const { data, error } = await deps.db.rpc("admin_refund_candidates");
  if (error) throw new Error(`admin_refund_candidates failed: ${error.message}`);
  return z
    .array(RefundRow)
    .parse(data ?? [])
    .map((r) => ({
      paymentId: r.payment_id,
      tenantId: r.tenant_id,
      tenantName: r.tenant_name,
      kind: r.kind,
      amountInr: r.amount_paise / 100,
      providerPaymentId: r.provider_payment_id,
      method: r.method,
      paidAt: iso(r.paid_at),
      flaggedAt: new Date(r.flagged_at).toISOString(),
    }));
}
