import {
  ChangePlanInput,
  CheckoutInput,
  OneTimePaymentInput,
  SETUP_FEE_INR,
  TOPUP_PACK,
  redactSecrets,
  type ChangePlanResult,
  type PaymentView,
  type PayuCheckout,
  type TenantContext,
} from "@pakka/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { invalidateFeatureCache } from "../features/is-enabled";
import { serverEnv } from "../lib/env";
import { AppError } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase-admin";
import { indiaDate, newTxnid, payuConfig, paymentRequest, PayuError, revokeMandate, verifyPayment, withGst, type FetchLike, type PayuConfig } from "./payu";

// Paying Spark Agent through PayU (decision 20; migrations 0035 and 0036). The owner starts a payment here, the browser
// POSTs the returned fields to PayU's hosted checkout, and PayU sends the payer back to our return URL. Whatever PayU
// or the browser says about the outcome, the server asks PayU (verifyPayment) and applies only that, through
// settle_payment, which applies each payment once however many of the return URL, the webhook and polling ask.
//
//   POST /api/billing/checkout   { planKey, cycle, phone? } → PayuCheckout: the plan, its first payment and the auto-debit
//   POST /api/billing/topup      { phone? } → PayuCheckout: 1,000 credits (a business on a paid plan)
//   POST /api/billing/setup-fee  { phone? } → PayuCheckout: the assisted-onboarding setup fee, once
//   POST /api/billing/change-plan { planKey, cycle?, phone? } → ChangePlanResult: an upgrade now (prorated, new mandate),
//                                a downgrade at the next renewal
//   GET  /api/billing/payments/:id → PaymentView (any member; asks PayU again while it is not final)
//   POST /api/billing/payu/return  PayU's surl and furl: verifies, then redirects to /dashboard/billing?payment=<id>
//   POST /api/webhooks/payu        PayU's webhook: verifies, answers 200

export interface BillingDeps {
  db: SupabaseClient;
  payu: PayuConfig | null;
  /** The API's own address, for PayU's return URLs. */
  apiPublicUrl: string | undefined;
  /** The dashboard's address, to send the payer back to. */
  appUrl: string;
  now: () => Date;
  fetch?: FetchLike;
}

export function billingDeps(): BillingDeps {
  const env = serverEnv();
  return { db: supabaseAdmin(), payu: payuConfig(env), apiPublicUrl: env.API_PUBLIC_URL, appUrl: env.NEXT_PUBLIC_APP_URL, now: () => new Date() };
}

/** Where PayU sends the payer back (both outcomes): the server verifies, then redirects to the dashboard. */
export const PAYU_RETURN_PATH = "/api/billing/payu/return";
/** The Billing screen, which polls the payment it is given. */
export const BILLING_RETURN_PATH = "/dashboard/billing";

const NOT_SWITCHED_ON = "Payments aren't switched on yet. Try again later.";
/** How long a mandate is approved for. */
const MANDATE_YEARS = 10;
/** Polling asks PayU again at most this often for one payment. */
const RECHECK_AFTER_MS = 5_000;

function ready(deps: BillingDeps): { payu: PayuConfig; returnUrl: string } {
  if (!deps.payu || !deps.apiPublicUrl) throw new AppError("not_available", NOT_SWITCHED_ON);
  return { payu: deps.payu, returnUrl: `${deps.apiPublicUrl}${PAYU_RETURN_PATH}` };
}

function requireOwner(context: TenantContext, action: string): void {
  if (context.role !== "owner") throw new AppError("forbidden", `Only the business owner can ${action}.`);
}

/** PayU needs a name, an email and a phone: the business name, the owner's login email, and their phone. */
async function payer(context: TenantContext, deps: BillingDeps, phone: string | undefined) {
  if (!context.user.email) throw new AppError("validation_failed", "Your account has no email address for the receipt.", { email: "Add an email address to your account" });
  let number = phone;
  if (!number) {
    const { data, error } = await deps.db.from("memberships").select("whatsapp_phone").eq("tenant_id", context.tenant.id).eq("user_id", context.user.id).maybeSingle();
    if (error) throw new Error(`billing: owner phone read failed: ${error.message}`);
    number = z.object({ whatsapp_phone: z.string().nullable() }).nullable().parse(data)?.whatsapp_phone ?? undefined;
  }
  if (!number) throw new AppError("validation_failed", "Enter a phone number for the payment.", { phone: "Enter the number with country code, like +919840012345" });
  return { firstname: context.tenant.name, email: context.user.email, phone: number };
}

async function begin(deps: BillingDeps, args: Record<string, unknown>, refusal: string): Promise<string> {
  const { data, error } = await deps.db.rpc("begin_payment", args);
  if (error) {
    if (error.code === "PA409") throw new AppError("conflict", refusal);
    throw new Error(`begin_payment failed: ${error.message}`);
  }
  return z.string().parse(data);
}

const Plan = z.object({ key: z.string(), name: z.string(), price_inr: z.number().int(), monthly_credits: z.number().int() });

export async function startCheckout(context: TenantContext, rawInput: unknown, deps: BillingDeps = billingDeps()): Promise<PayuCheckout> {
  const { payu, returnUrl } = ready(deps);
  requireOwner(context, "choose a plan");
  const input = CheckoutInput.parse(rawInput);
  const { data, error } = await deps.db.from("plans").select("key, name, price_inr, monthly_credits").eq("key", input.planKey).maybeSingle();
  if (error) throw new Error(`billing: plan read failed: ${error.message}`);
  if (!data) throw new AppError("not_found", "That plan isn't available.");
  const plan = Plan.parse(data);

  // Annual is ten months' price for twelve (docs/handover.md, module 8).
  const amounts = withGst(plan.price_inr * 100 * (input.cycle === "yearly" ? 10 : 1));
  const who = await payer(context, deps, input.phone);
  const txnid = newTxnid("subscribe");
  const paymentId = await begin(
    deps,
    {
      p_tenant_id: context.tenant.id,
      p_kind: "subscribe",
      p_txnid: txnid,
      p_base_paise: amounts.basePaise,
      p_gst_paise: amounts.gstPaise,
      p_credits: plan.monthly_credits,
      p_plan_key: plan.key,
      p_billing_cycle: input.cycle,
      p_created_by: context.user.id,
    },
    "Your business already has a plan. Change it from Billing instead.",
  );
  const now = deps.now();
  const until = new Date(now);
  until.setFullYear(until.getFullYear() + MANDATE_YEARS);
  return {
    paymentId,
    payu: paymentRequest(payu, {
      txnid,
      amountPaise: amounts.amountPaise,
      productinfo: `Spark Agent ${plan.name} plan (${input.cycle})`,
      ...who,
      surl: returnUrl,
      furl: returnUrl,
      mandate: { amountPaise: amounts.amountPaise, cycle: input.cycle, startDate: indiaDate(now), endDate: indiaDate(until) },
    }),
  };
}

async function startOneTime(
  context: TenantContext,
  rawInput: unknown,
  deps: BillingDeps,
  item: { kind: "topup" | "setup_fee"; priceInr: number; credits: number | null; productinfo: string; refusal: string },
): Promise<PayuCheckout> {
  const { payu, returnUrl } = ready(deps);
  requireOwner(context, "make a payment");
  const input = OneTimePaymentInput.parse(rawInput ?? {});
  const amounts = withGst(item.priceInr * 100);
  const who = await payer(context, deps, input.phone);
  const txnid = newTxnid(item.kind);
  const paymentId = await begin(
    deps,
    {
      p_tenant_id: context.tenant.id,
      p_kind: item.kind,
      p_txnid: txnid,
      p_base_paise: amounts.basePaise,
      p_gst_paise: amounts.gstPaise,
      p_credits: item.credits,
      p_created_by: context.user.id,
    },
    item.refusal,
  );
  return { paymentId, payu: paymentRequest(payu, { txnid, amountPaise: amounts.amountPaise, productinfo: item.productinfo, ...who, surl: returnUrl, furl: returnUrl }) };
}

export function startTopup(context: TenantContext, rawInput: unknown, deps: BillingDeps = billingDeps()): Promise<PayuCheckout> {
  return startOneTime(context, rawInput, deps, {
    kind: "topup",
    priceInr: TOPUP_PACK.priceInr,
    credits: TOPUP_PACK.credits,
    productinfo: `Spark Agent top-up: ${TOPUP_PACK.credits.toLocaleString("en-IN")} credits`,
    refusal: "Top-ups are for businesses on a paid plan. Choose a plan first.",
  });
}

export function startSetupFee(context: TenantContext, rawInput: unknown, deps: BillingDeps = billingDeps()): Promise<PayuCheckout> {
  return startOneTime(context, rawInput, deps, {
    kind: "setup_fee",
    priceInr: SETUP_FEE_INR,
    credits: null,
    productinfo: "Spark Agent assisted setup",
    refusal: "The setup fee is already paid. We'll call you to set things up.",
  });
}

/**
 * Changing plan (0038). A dearer plan is an upgrade now: the owner pays the price difference for the rest of the period on
 * PayU, which also approves a new auto-debit at the new price; the plan changes once PayU confirms it (settle_payment),
 * and the old mandate is then revoked. A cheaper plan starts at the next renewal. Owner only. Switching between monthly
 * and yearly needs a mandate with another cycle and isn't offered yet.
 */
export async function changePlan(context: TenantContext, rawInput: unknown, deps: BillingDeps = billingDeps()): Promise<ChangePlanResult> {
  requireOwner(context, "change the plan");
  const input = ChangePlanInput.parse(rawInput);
  const current = await deps.db.from("subscriptions").select("billing_cycle").eq("tenant_id", context.tenant.id).in("status", ["active", "past_due"]).maybeSingle();
  if (current.error) throw new Error(`billing: plan read failed: ${current.error.message}`);
  if (!current.data) throw new AppError("conflict", "Your business has no plan to change yet. Choose a plan first.");
  const cycle = z.object({ billing_cycle: z.enum(["monthly", "yearly"]) }).parse(current.data).billing_cycle;
  if (input.cycle && input.cycle !== cycle) throw new AppError("not_available", "Switching between monthly and yearly billing isn't available yet.");
  const planRead = await deps.db.from("plans").select("key, name, price_inr, monthly_credits").eq("key", input.planKey).maybeSingle();
  if (planRead.error) throw new Error(`billing: plan read failed: ${planRead.error.message}`);
  if (!planRead.data) throw new AppError("not_found", "That plan isn't available.");
  const plan = Plan.parse(planRead.data);

  const txnid = newTxnid("plan_change");
  const { data, error } = await deps.db.rpc("begin_plan_change", { p_tenant_id: context.tenant.id, p_plan_key: plan.key, p_txnid: txnid, p_created_by: context.user.id });
  if (error) {
    if (error.code === "PA409") throw new AppError("conflict", "Your business has no plan to change yet. Choose a plan first.");
    if (error.code === "PA428") throw new AppError("conflict", "Your last plan payment didn't go through. Pay it first, then change plan.");
    throw new Error(`begin_plan_change failed: ${error.message}`);
  }
  const [change] = z
    .array(z.object({ action: z.enum(["upgrade", "scheduled", "kept", "unchanged"]), payment_id: z.string().nullable(), amount_paise: z.number().int().nullable(), mandate_paise: z.number().int().nullable(), effective_at: z.string() }))
    .length(1)
    .parse(data);
  if (change.action === "scheduled") return { action: "scheduled", planKey: input.planKey, effectiveAt: new Date(change.effective_at).toISOString() };
  if (change.action !== "upgrade") return { action: change.action };

  // The upgrade's payment is recorded; only now is PayU needed.
  const { payu, returnUrl } = ready(deps);
  if (!change.payment_id || change.amount_paise === null || change.mandate_paise === null) throw new Error("begin_plan_change: an upgrade without its payment");
  const who = await payer(context, deps, input.phone);
  const now = deps.now();
  const until = new Date(now);
  until.setFullYear(until.getFullYear() + MANDATE_YEARS);
  return {
    action: "upgrade",
    paymentId: change.payment_id,
    payu: paymentRequest(payu, {
      txnid,
      amountPaise: change.amount_paise,
      productinfo: `Spark Agent upgrade to ${plan.name} (${cycle})`,
      ...who,
      surl: returnUrl,
      furl: returnUrl,
      mandate: { amountPaise: change.mandate_paise, cycle, startDate: indiaDate(now), endDate: indiaDate(until) },
    }),
  };
}

/** After a paid upgrade: the mandate of the plan it replaced is revoked at PayU, so it can never charge again. Logged, not thrown. */
async function revokeReplacedMandate(paymentId: string, deps: BillingDeps): Promise<void> {
  if (!deps.payu) return;
  try {
    const { data, error } = await deps.db.from("payments").select("subscriptions(replaces_subscription_id)").eq("id", paymentId).maybeSingle();
    if (error) throw new Error(error.message);
    const replaced = z.object({ subscriptions: z.object({ replaces_subscription_id: z.string().nullable() }).nullable() }).nullable().parse(data)?.subscriptions?.replaces_subscription_id;
    if (!replaced) return;
    const old = await deps.db.from("subscriptions").select("mandate_id, mandate_method").eq("id", replaced).maybeSingle();
    if (old.error) throw new Error(old.error.message);
    const mandate = z.object({ mandate_id: z.string().nullable(), mandate_method: z.string().nullable() }).nullable().parse(old.data);
    if (!mandate?.mandate_id) return;
    await revokeMandate(deps.payu, { mandateId: mandate.mandate_id, method: mandate.mandate_method, requestId: newTxnid("plan_change") }, deps.fetch);
  } catch (e) {
    // The old subscription is cancelled, so the renewal job never charges it; revoking at PayU can be done by hand.
    console.error(`[billing] payment ${paymentId}: the replaced mandate was not revoked at PayU: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
  }
}

const Settled = z.array(z.object({ payment_id: z.string(), tenant_id: z.string(), kind: z.string(), status: z.string(), applied: z.boolean() })).length(1);
export type SyncResult = { paymentId: string; status: string } | null;

/**
 * Asks PayU what happened to one of our payments and applies it. Null for a txnid that isn't ours. A PayU outage is
 * thrown (PayuError, retryable) so the caller can retry; an amount that does not match is logged and applies nothing.
 */
export async function syncPayment(txnid: string, deps: BillingDeps): Promise<SyncResult> {
  if (!deps.payu) throw new AppError("not_available", NOT_SWITCHED_ON);
  if (!/^[A-Za-z0-9]{1,25}$/.test(txnid)) return null;
  const known = await deps.db.from("payments").select("id, status").eq("txnid", txnid).maybeSingle();
  if (known.error) throw new Error(`billing: payment read failed: ${known.error.message}`);
  if (!known.data) return null;
  const payment = z.object({ id: z.string(), status: z.string() }).parse(known.data);
  if (payment.status === "success" || payment.status === "failed") return { paymentId: payment.id, status: payment.status };

  const result = await verifyPayment(deps.payu, txnid, deps.fetch);
  const { data, error } = await deps.db.rpc("settle_payment", {
    p_txnid: txnid,
    p_state: result.state,
    p_provider_payment_id: result.providerPaymentId,
    p_method: result.method,
    p_amount_paise: result.state === "success" ? result.amountPaise : null,
    p_reason: result.reason,
  });
  if (error) {
    if (error.code === "PA422") {
      console.error(`[billing] payment ${payment.id}: PayU's amount does not match ours; nothing applied (${redactSecrets(error.message)})`);
      return { paymentId: payment.id, status: payment.status };
    }
    throw new Error(`settle_payment failed: ${error.message}`);
  }
  const [row] = Settled.parse(data);
  // A new plan changes which features are on; an upgrade also ends the old mandate at PayU.
  if (row.applied && row.status === "success" && (row.kind === "subscribe" || row.kind === "plan_change")) invalidateFeatureCache(row.tenant_id);
  if (row.applied && row.status === "success" && row.kind === "plan_change") await revokeReplacedMandate(row.payment_id, deps);
  return { paymentId: row.payment_id, status: row.status };
}

/** The txnid PayU posts back, from a form (the return URL and the webhook) or JSON (the webhook). */
async function postedTxnid(request: Request): Promise<string | null> {
  const type = request.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) {
      const body = (await request.json()) as unknown;
      const txnid = typeof body === "object" && body !== null ? (body as { txnid?: unknown }).txnid : undefined;
      return typeof txnid === "string" ? txnid : null;
    }
    const value = new URLSearchParams(await request.text()).get("txnid");
    return value && value.length <= 25 ? value : null;
  } catch {
    return null;
  }
}

/** PayU's surl and furl. Never trusts what is posted: verifies with PayU, then sends the payer to the Billing screen. */
export async function handlePayuReturn(request: Request, deps: BillingDeps = billingDeps()): Promise<Response> {
  const back = new URL(BILLING_RETURN_PATH, deps.appUrl);
  const txnid = await postedTxnid(request);
  let paymentId: string | null = null;
  if (txnid && deps.payu) {
    try {
      paymentId = (await syncPayment(txnid, deps))?.paymentId ?? null;
    } catch (e) {
      // PayU is slow to answer: the Billing screen polls, and polling asks PayU again.
      console.error(`[billing] return: could not verify a payment yet: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
      const known = await deps.db.from("payments").select("id").eq("txnid", txnid).maybeSingle();
      paymentId = known.data ? z.object({ id: z.string() }).parse(known.data).id : null;
    }
  }
  back.searchParams.set("payment", paymentId ?? "unknown");
  return Response.redirect(back.toString(), 303);
}

/** PayU's webhook: same verification. 200 for anything handled or not ours; 503 while PayU can't be asked, so it retries. */
export async function handlePayuWebhook(request: Request, deps: BillingDeps = billingDeps()): Promise<Response> {
  const txnid = await postedTxnid(request);
  if (!txnid || !deps.payu) return Response.json({ ok: true });
  try {
    await syncPayment(txnid, deps);
    return Response.json({ ok: true });
  } catch (e) {
    console.error(`[billing] webhook: could not verify a payment yet: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
    return Response.json({ ok: false }, { status: e instanceof PayuError ? 503 : 500 });
  }
}

const PaymentRow = z.object({
  id: z.string(),
  txnid: z.string(),
  kind: z.enum(["subscribe", "renewal", "plan_change", "topup", "setup_fee"]),
  status: z.enum(["created", "pending", "success", "failed"]),
  amount_paise: z.number().int(),
  failure_reason: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
const PAYMENT_COLUMNS = "id, txnid, kind, status, amount_paise, failure_reason, created_at, updated_at";

async function readPayment(context: TenantContext, id: string, deps: BillingDeps) {
  const { data, error } = await deps.db.from("payments").select(PAYMENT_COLUMNS).eq("tenant_id", context.tenant.id).eq("id", id).maybeSingle();
  if (error) throw new Error(`billing: payment read failed: ${error.message}`);
  if (!data) throw new AppError("not_found", "That payment was not found.");
  return PaymentRow.parse(data);
}

/** One payment of the business, for the Billing screen after PayU sends the payer back. Any member. */
export async function paymentStatus(context: TenantContext, id: string, deps: BillingDeps = billingDeps()): Promise<PaymentView> {
  if (!z.guid().safeParse(id).success) throw new AppError("not_found", "That payment was not found.");
  let row = await readPayment(context, id, deps);
  const open = row.status === "created" || row.status === "pending";
  if (open && deps.payu && deps.now().getTime() - Date.parse(row.updated_at) >= RECHECK_AFTER_MS) {
    try {
      await syncPayment(row.txnid, deps);
      row = await readPayment(context, id, deps);
    } catch (e) {
      console.error(`[billing] status: could not verify payment ${id} yet: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
    }
  }
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    amountInr: row.amount_paise / 100,
    failureReason: row.failure_reason,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
