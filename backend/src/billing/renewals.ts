import { redactSecrets } from "@pakka/types";
import { z } from "zod";
import { sendToAdmins, type AlertCounts, type AlertMessage } from "../channels/whatsapp/connect/health-alert";
import { invalidateFeatureCache } from "../features/is-enabled";
import { send } from "../notify/send";
import { staffAlertRecipients } from "../notify/staff-alerts";
import { billingDeps, syncPayment, type BillingDeps } from "./checkout";
import { chargeMandate, indiaDate, newTxnid, preDebit, PayuError, type VerifiedPayment } from "./payu";

// Renewing plans by PayU auto-debit (decision 20; migration 0037), for the billing-renewals job (inngest/billing-renewals.ts),
// which runs these once a day at 06:00 in India (NPCI asks for UPI debits outside 10:00-13:00 and 17:00-21:30):
//   1. notices: each mandate whose period ends within 4 days gets its renewal payment and PayU's pre-debit notice
//      (cards and UPI; RBI), announcing the job's first run at least 48 hours away and not before the period ends.
//   2. charges: at that run the mandate is charged. The payment is marked pending before PayU is asked, so a crash or
//      timeout never charges twice: step 3 asks PayU what happened. A failure alerts the owners; retries come 2 days
//      apart, 3 attempts a period.
//   3. pending: charges still pending after 10 minutes are verified with PayU; one PayU has no record of after an hour
//      is failed, so it can be retried.
//   4. annual months: an annual plan's credits arrive month by month.
//   5. lapse: a mandate still unpaid 7 days after its period ended is cancelled and the business paused (owners told).
// Each step is safe to run again: the database decides what is due, and every payment applies once (settle_payment).
//
// UNVERIFIED against a real PayU account: whether a retry of a card or UPI debit needs a fresh pre-debit notice (PayU's
// UPI mandateSeqNo). Until the test merchant key arrives, a retry reuses the period's invoice number and notice.

export interface RenewalDeps extends BillingDeps {
  alert: (tenantId: string, message: AlertMessage, key: string) => Promise<AlertCounts>;
}

export function renewalDeps(): RenewalDeps {
  return {
    ...billingDeps(),
    alert: (tenantId, message, key) => sendToAdmins(tenantId, message, key, { recipients: (id) => staffAlertRecipients(id), send: (id, kind, payload) => send(id, kind, payload) }),
  };
}

/** The job's daily run, 06:00 in India (00:30 UTC). */
const RUN_UTC_MINUTES = 30;
const HOUR = 3_600_000;
/** PayU: the notice goes at least 48 hours before the debit. */
const NOTICE_LEAD_MS = 48 * HOUR;
/** A charge still pending this long is asked about; one PayU never saw this long is failed. */
const PENDING_RECHECK_MS = 10 * 60_000;
const PENDING_GIVE_UP_MS = HOUR;

/** The first daily run (00:30 UTC) at or after `at`: the debit time a notice announces. */
export function nextRunAt(at: Date): Date {
  const run = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), 0, RUN_UTC_MINUTES));
  return run.getTime() >= at.getTime() ? run : new Date(run.getTime() + 24 * HOUR);
}

/** One number per subscription and period, sent with the notice and every charge of it (PayU's invoiceDisplayNumber). */
export function invoiceNumber(subscriptionId: string, periodEnd: Date): string {
  return `I${subscriptionId.replace(/-/g, "").slice(0, 12)}${indiaDate(periodEnd).replace(/-/g, "")}`;
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const billingLink = (appUrl: string) => `${appUrl.replace(/\/$/, "")}/dashboard/billing`;

/** A renewal that did not go through: how much, and where to change how they pay. Placeholder wording until Raja's. */
export function renewalFailedMessage(amountPaise: number, appUrl: string): AlertMessage {
  const headline = `Your Spark Agent plan payment of ${rupees(amountPaise)} didn't go through. We'll try again in 2 days.`;
  const link = billingLink(appUrl);
  return { text: `${headline}\nTo pay another way, open Billing.\n${link}`, templateParams: [headline, link] };
}

/** A plan that lapsed: the assistant is paused until a plan is chosen again. */
export function lapsedMessage(appUrl: string): AlertMessage {
  const headline = "Spark Agent is paused: your plan payment didn't go through for 7 days. Your inbox is still there.";
  const link = billingLink(appUrl);
  return { text: `${headline}\nChoose a plan in Billing to switch the assistant back on.\n${link}`, templateParams: [headline, link] };
}

const errorText = (e: unknown) => redactSecrets(e instanceof Error ? e.message : String(e));

const Renewal = z.object({ payment_id: z.string(), txnid: z.string(), amount_paise: z.number().int(), period_end: z.string(), status: z.string(), created: z.boolean() });
type Renewal = z.infer<typeof Renewal>;

async function beginRenewal(deps: RenewalDeps, subscriptionId: string): Promise<Renewal | null> {
  const { data, error } = await deps.db.rpc("begin_renewal", { p_subscription_id: subscriptionId, p_txnid: newTxnid("renewal") });
  if (error) {
    // Cancelled or lapsed since it was listed: nothing to renew.
    if (error.code === "PA409") return null;
    throw new Error(`begin_renewal failed: ${error.message}`);
  }
  return z.array(Renewal).length(1).parse(data)[0];
}

const Settled = z.array(z.object({ payment_id: z.string(), tenant_id: z.string(), kind: z.string(), status: z.string(), applied: z.boolean() })).length(1);

async function settle(deps: RenewalDeps, txnid: string, result: Pick<VerifiedPayment, "state" | "providerPaymentId" | "method" | "amountPaise" | "reason">) {
  const { data, error } = await deps.db.rpc("settle_payment", {
    p_txnid: txnid,
    p_state: result.state,
    p_provider_payment_id: result.providerPaymentId,
    p_method: result.method,
    p_amount_paise: result.state === "success" ? result.amountPaise : null,
    p_reason: result.reason,
  });
  if (error) throw new Error(`settle_payment failed: ${error.message}`);
  return Settled.parse(data)[0];
}

/** After a renewal is applied: a failure tells the owners; a success may have changed the plan (a downgrade). */
async function afterSettle(deps: RenewalDeps, row: z.infer<typeof Settled>[number], amountPaise: number): Promise<"success" | "failed" | "pending"> {
  if (row.applied && row.status === "failed") await deps.alert(row.tenant_id, renewalFailedMessage(amountPaise, deps.appUrl), `renewal_failed:${row.payment_id}`);
  if (row.applied && row.status === "success") invalidateFeatureCache(row.tenant_id);
  return row.status === "success" || row.status === "failed" ? row.status : "pending";
}

const ToNotify = z.array(z.object({ subscription_id: z.string(), tenant_id: z.string(), mandate_id: z.string(), mandate_method: z.string().nullable(), period_end: z.string() }));

/** Step 1: the renewal payments and pre-debit notices due. */
export async function sendRenewalNotices(deps: RenewalDeps): Promise<{ due: number; sent: number; failed: number }> {
  const counts = { due: 0, sent: 0, failed: 0 };
  if (!deps.payu) return counts;
  const now = deps.now();
  const { data, error } = await deps.db.rpc("renewals_to_notify", { p_now: now.toISOString() });
  if (error) throw new Error(`renewals_to_notify failed: ${error.message}`);
  const due = ToNotify.parse(data ?? []);
  counts.due = due.length;
  for (const row of due) {
    const periodEnd = new Date(row.period_end);
    const renewal = await beginRenewal(deps, row.subscription_id);
    if (!renewal) continue;
    const debitAt = nextRunAt(new Date(Math.max(periodEnd.getTime(), now.getTime() + NOTICE_LEAD_MS)));
    if (row.mandate_method !== "enach" && renewal.status === "created") {
      try {
        await preDebit(
          deps.payu,
          { mandateId: row.mandate_id, requestId: newTxnid("renewal"), debitDate: indiaDate(debitAt), amountPaise: renewal.amount_paise, invoiceDisplayNumber: invoiceNumber(row.subscription_id, periodEnd) },
          deps.fetch,
        );
      } catch (e) {
        // A notice already sent (a repeat run) is fine.
        if (!(e instanceof PayuError && /already/i.test(e.message))) {
          counts.failed++;
          if (e instanceof PayuError && !e.retryable) {
            // The mandate is revoked or inactive: this period cannot be charged.
            const row2 = await settle(deps, renewal.txnid, { state: "failed", providerPaymentId: null, method: null, amountPaise: null, reason: e.message.replace(/^PayU pre_debit_SI: /, "") });
            await afterSettle(deps, row2, renewal.amount_paise);
          } else {
            console.error(`[billing] renewal notice for subscription ${row.subscription_id} not sent yet: ${errorText(e)}`);
          }
          continue;
        }
      }
    }
    const { error: stampError } = await deps.db
      .from("subscriptions")
      .update({ pre_debit_for: periodEnd.toISOString(), pre_debit_at: debitAt.toISOString() })
      .eq("id", row.subscription_id)
      .eq("current_period_end", row.period_end);
    if (stampError) throw new Error(`billing: notice stamp failed: ${stampError.message}`);
    counts.sent++;
  }
  return counts;
}

const ToCharge = z.array(z.object({ subscription_id: z.string(), tenant_id: z.string(), mandate_id: z.string(), period_end: z.string() }));

/** Step 2: charge the mandates whose announced debit time has come. */
export async function chargeDueRenewals(deps: RenewalDeps): Promise<{ due: number; success: number; pending: number; failed: number }> {
  const counts = { due: 0, success: 0, pending: 0, failed: 0 };
  if (!deps.payu) return counts;
  const { data, error } = await deps.db.rpc("renewals_to_charge", { p_now: deps.now().toISOString() });
  if (error) throw new Error(`renewals_to_charge failed: ${error.message}`);
  const due = ToCharge.parse(data ?? []);
  counts.due = due.length;
  for (const row of due) {
    const renewal = await beginRenewal(deps, row.subscription_id);
    if (!renewal || renewal.status !== "created") continue;
    // Pending before PayU is asked: if this run dies after PayU charged, step 3 finds out, and nothing charges again.
    await settle(deps, renewal.txnid, { state: "pending", providerPaymentId: null, method: null, amountPaise: null, reason: null });
    let result: VerifiedPayment;
    try {
      result = await chargeMandate(
        deps.payu,
        { mandateId: row.mandate_id, txnid: renewal.txnid, amountPaise: renewal.amount_paise, invoiceDisplayNumber: invoiceNumber(row.subscription_id, new Date(row.period_end)) },
        deps.fetch,
      );
    } catch (e) {
      if (e instanceof PayuError && e.code === "rejected") {
        result = { state: "failed", providerPaymentId: null, method: null, amountPaise: null, reason: e.message.replace(/^PayU si_transaction: /, "") };
      } else {
        // No answer: the charge may or may not have happened. Step 3 asks PayU.
        console.error(`[billing] renewal charge for subscription ${row.subscription_id}: ${errorText(e)}`);
        counts.pending++;
        continue;
      }
    }
    const outcome = await afterSettle(deps, await settle(deps, renewal.txnid, result), renewal.amount_paise);
    counts[outcome]++;
  }
  return counts;
}

const PendingRow = z.array(z.object({ id: z.string(), txnid: z.string(), tenant_id: z.string(), amount_paise: z.number().int(), updated_at: z.string() }));

/** Step 3: renewals still pending: what PayU says now. */
export async function resolvePendingRenewals(deps: RenewalDeps): Promise<{ checked: number; settled: number }> {
  const counts = { checked: 0, settled: 0 };
  if (!deps.payu) return counts;
  const now = deps.now().getTime();
  const { data, error } = await deps.db
    .from("payments")
    .select("id, txnid, tenant_id, amount_paise, updated_at")
    .eq("kind", "renewal")
    .eq("status", "pending")
    .lt("updated_at", new Date(now - PENDING_RECHECK_MS).toISOString())
    .limit(200);
  if (error) throw new Error(`billing: pending renewals read failed: ${error.message}`);
  for (const p of PendingRow.parse(data ?? [])) {
    counts.checked++;
    try {
      const synced = await syncPayment(p.txnid, deps);
      if (synced?.status === "success" || synced?.status === "failed") {
        counts.settled++;
        // syncPayment applied it; the owners hear about a failure here.
        if (synced.status === "failed") await deps.alert(p.tenant_id, renewalFailedMessage(p.amount_paise, deps.appUrl), `renewal_failed:${p.id}`);
        continue;
      }
      // PayU still has no record an hour on: the charge never reached it, so the period can be tried again.
      if (now - Date.parse(p.updated_at) >= PENDING_GIVE_UP_MS) {
        const row = await settle(deps, p.txnid, { state: "failed", providerPaymentId: null, method: null, amountPaise: null, reason: "PayU has no record of the charge" });
        if (row.applied) counts.settled++;
      }
    } catch (e) {
      console.error(`[billing] pending renewal ${p.id}: ${errorText(e)}`);
    }
  }
  return counts;
}

/** Step 4: an annual plan's monthly credits. */
export async function grantAnnualMonths(deps: RenewalDeps): Promise<{ granted: number }> {
  const { data, error } = await deps.db.rpc("grant_annual_credit_months", { p_now: deps.now().toISOString() });
  if (error) throw new Error(`grant_annual_credit_months failed: ${error.message}`);
  return { granted: z.number().int().parse(data) };
}

/** Step 5: plans unpaid 7 days after their period ended: cancelled, the business paused, the owners told. */
export async function lapseOverdue(deps: RenewalDeps): Promise<{ lapsed: number }> {
  const { data, error } = await deps.db.rpc("lapse_overdue_subscriptions", { p_now: deps.now().toISOString() });
  if (error) throw new Error(`lapse_overdue_subscriptions failed: ${error.message}`);
  const lapsed = z.array(z.object({ tenant_id: z.string(), subscription_id: z.string() })).parse(data ?? []);
  for (const row of lapsed) {
    invalidateFeatureCache(row.tenant_id);
    await deps.alert(row.tenant_id, lapsedMessage(deps.appUrl), `subscription_lapsed:${row.subscription_id}`);
  }
  return { lapsed: lapsed.length };
}
