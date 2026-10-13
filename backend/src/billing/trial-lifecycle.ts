import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { invalidateFeatureCache } from "../features/is-enabled";
import { serverEnv } from "../lib/env";
import { supabaseAdmin } from "../lib/supabase-admin";
import { sendAccountNotice, type NoticeCounts, type NoticeMessage } from "../notify/account-notices";

// The 7-day trial's messages and its end (docs/handover.md, module 8: the trial-lifecycle job; migration 0039), for the
// jobs in inngest/trial-lifecycle.ts:
//   * day 0, as the trial starts (tenant.trial_started): welcome, the TRIAL code to try the assistant, the dashboard;
//   * days 3, 5 and 6, an hourly sweep between 09:00 and 20:00 in India: what the assistant did so far, a plan that fits
//     the business's pace, and that the trial ends tomorrow;
//   * the end: the sweep pauses each ended trial with no plan (at any hour; the inbox stays readable), then sends day 7
//     (choose a plan) in sending hours.
// Each notice goes to the owners with an alert number as an account notice (free, still sent once the trial has ended,
// not sent if the business switched staff alerts off), claimed in the database first so it goes once (0039). Wording is
// fixed text with a dashboard link, placeholder until Raja's, like the staff alerts.
//
// KNOWN LIMIT. A notice reaches an owner only through their alert number (set on the Team screen; onboarding does not ask
// for it yet), and outside their 24-hour window only once the staff_alert template is approved. The pause itself does
// not depend on either.

export const TRIAL_NOTICE_DAYS = [0, 3, 5, 6, 7] as const;
export type TrialNoticeDay = (typeof TRIAL_NOTICE_DAYS)[number];

export interface TrialDeps {
  db: SupabaseClient;
  appUrl: string;
  now: () => Date;
  notify: (tenantId: string, message: NoticeMessage, key: string) => Promise<NoticeCounts>;
  invalidate: (tenantId: string) => void;
}

export function trialDeps(): TrialDeps {
  return {
    db: supabaseAdmin(),
    appUrl: serverEnv().NEXT_PUBLIC_APP_URL,
    now: () => new Date(),
    notify: (tenantId, message, key) => sendAccountNotice(tenantId, message, key),
    invalidate: (tenantId) => invalidateFeatureCache(tenantId),
  };
}

const DAY_MS = 86_400_000;
const TRIAL_DAYS = 7;
/** Notices go between 09:00 and 20:00 in India; the end of a trial is applied at any hour. */
const SEND_FROM_HOUR = 9;
const SEND_UNTIL_HOUR = 20;
/** Ledger reasons that add credits, and the reset that only expires them: neither is credits the business used. */
const NOT_USE = new Set(["trial_grant", "plan_grant", "topup", "admin", "cycle_reset"]);

/** Whether it is between 09:00 and 20:00 in India. */
export function inSendingHours(at: Date): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hourCycle: "h23" }).format(at));
  return hour >= SEND_FROM_HOUR && hour < SEND_UNTIL_HOUR;
}

export interface PlanOffer {
  key: string;
  name: string;
  priceInr: number;
  monthlyCredits: number;
}

/** What a notice says: the business, its TRIAL code, and what it has done so far. */
export interface TrialFacts {
  name: string;
  routeCode: string | null;
  trialCredits: number;
  aiReplies: number;
  leads: number;
  creditsUsed: number;
  /** Days since the trial started, at least 1. */
  daysIn: number;
  /** The plans a business can buy, cheapest first. */
  plans: PlanOffer[];
}

const Tenant = z.object({ name: z.string(), trial_ends_at: z.string().nullable() });
const Plan = z.object({ key: z.string(), name: z.string(), price_inr: z.number().int(), monthly_credits: z.number().int() });

function failed(what: string, error: { message: string } | null): void {
  if (error) throw new Error(`trial lifecycle: ${what} read failed: ${error.message}`);
}

export async function loadTrialFacts(tenantId: string, deps: TrialDeps): Promise<TrialFacts> {
  const db = deps.db;
  const [tenant, code, replies, leads, ledger, plans] = await Promise.all([
    db.from("tenants").select("name, trial_ends_at").eq("id", tenantId).maybeSingle(),
    db.from("route_codes").select("code").eq("tenant_id", tenantId).eq("kind", "trial").limit(1),
    db.from("messages").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("sender", "ai"),
    db.from("leads").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId),
    db.from("credit_ledger").select("delta, reason").eq("tenant_id", tenantId),
    db.from("plans").select("key, name, price_inr, monthly_credits").order("price_inr", { ascending: true }),
  ]);
  failed("business", tenant.error);
  failed("route code", code.error);
  failed("replies", replies.error);
  failed("leads", leads.error);
  failed("credits", ledger.error);
  failed("plans", plans.error);
  if (!tenant.data) throw new Error(`trial lifecycle: business ${tenantId} not found`);
  const t = Tenant.parse(tenant.data);
  const allPlans = z.array(Plan).parse(plans.data ?? []);
  const used = z
    .array(z.object({ delta: z.number().int(), reason: z.string() }))
    .parse(ledger.data ?? [])
    .filter((row) => !NOT_USE.has(row.reason))
    .reduce((sum, row) => sum - row.delta, 0);
  const start = t.trial_ends_at ? Date.parse(t.trial_ends_at) - TRIAL_DAYS * DAY_MS : deps.now().getTime();
  return {
    name: t.name,
    routeCode: z.array(z.object({ code: z.string() })).parse(code.data ?? [])[0]?.code ?? null,
    trialCredits: allPlans.find((p) => p.key === "trial")?.monthly_credits ?? 300,
    aiReplies: replies.count ?? 0,
    leads: leads.count ?? 0,
    creditsUsed: Math.max(0, used),
    daysIn: Math.max(1, Math.floor((deps.now().getTime() - start) / DAY_MS)),
    plans: allPlans.filter((p) => p.price_inr > 0).map((p) => ({ key: p.key, name: p.name, priceInr: p.price_inr, monthlyCredits: p.monthly_credits })),
  };
}

/**
 * The plan that fits the trial's pace: the credits used so far, scaled to 30 days, against each plan's monthly credits;
 * the cheapest that covers it, else the largest. Null when no plan is on offer; no estimate before any credit is used.
 */
export function recommendPlan(creditsUsed: number, daysIn: number, plans: PlanOffer[]): { plan: PlanOffer; monthlyEstimate: number | null } | null {
  const paid = [...plans].sort((a, b) => a.priceInr - b.priceInr);
  if (paid.length === 0) return null;
  if (creditsUsed <= 0) return { plan: paid[0], monthlyEstimate: null };
  const monthlyEstimate = Math.ceil((creditsUsed / Math.max(daysIn, 1)) * 30);
  return { plan: paid.find((p) => p.monthlyCredits >= monthlyEstimate) ?? paid[paid.length - 1], monthlyEstimate };
}

const number = (n: number) => n.toLocaleString("en-IN");
const plural = (n: number, one: string, many: string) => `${number(n)} ${n === 1 ? one : many}`;
/** Meta's template variables hold no line break and no long text. */
const oneLine = (text: string, max = 400) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const dashboard = (appUrl: string, path = "") => `${appUrl.replace(/\/$/, "")}/dashboard${path}`;

/** The notice for a day: a one-line headline (the template's {{1}}), a line of what to do, and the link ({{2}}). */
export function trialNoticeMessage(day: TrialNoticeDay, f: TrialFacts, appUrl: string): NoticeMessage {
  const name = oneLine(f.name, 60);
  const tryIt = f.routeCode ? `send ${f.routeCode} to the Spark Agent demo number on WhatsApp` : null;
  let headline: string;
  let next: string;
  let link = dashboard(appUrl, "/billing");
  switch (day) {
    case 0:
      headline = `Welcome to Spark Agent, ${name}! Your ${TRIAL_DAYS}-day free trial has started with ${number(f.trialCredits)} credits.`;
      next = tryIt ? `To try your assistant, ${tryIt}. Then finish setting up in your dashboard.` : "Finish setting up your assistant in your dashboard.";
      link = dashboard(appUrl);
      break;
    case 3:
      headline =
        f.aiReplies > 0
          ? `${name}: so far your assistant has sent ${plural(f.aiReplies, "reply", "replies")} and found ${plural(f.leads, "lead", "leads")}.`
          : `${name}: your assistant hasn't answered a customer yet.`;
      next = f.aiReplies > 0 ? "See the chats and leads in your dashboard." : tryIt ? `Try it now: ${tryIt}.` : "Share your WhatsApp number with customers to see it work.";
      link = dashboard(appUrl);
      break;
    case 5: {
      headline = `${name}: 2 days left in your Spark Agent trial.`;
      const fit = recommendPlan(f.creditsUsed, f.daysIn, f.plans);
      const offer = fit ? `${fit.plan.name} (${number(fit.plan.monthlyCredits)} credits a month, ₹${number(fit.plan.priceInr)} + GST)` : null;
      next = !fit
        ? "Choose a plan to keep your assistant replying."
        : fit.monthlyEstimate === null
          ? `${offer} is the place to start. Choose a plan to keep your assistant replying.`
          : `At your pace, about ${number(fit.monthlyEstimate)} credits a month, ${offer} fits. Choose a plan to keep your assistant replying.`;
      break;
    }
    case 6:
      headline = `${name}: your Spark Agent trial ends tomorrow.`;
      next = "Choose a plan today so your assistant keeps replying to your customers.";
      break;
    case 7:
      headline = `${name}: your Spark Agent trial has ended and your assistant is paused.`;
      next = "Your inbox and leads are still there. Choose a plan to switch it back on.";
      break;
  }
  return { text: `${headline}\n${next}\n${link}`, templateParams: [oneLine(headline), link] };
}

const Claim = z.enum(["claimed", "already", "superseded", "not_eligible"]);
export type TrialNoticeResult = { status: "sent"; counts: NoticeCounts } | { status: Exclude<z.infer<typeof Claim>, "claimed"> };

/**
 * Sends one day's notice to the owners, once: claim_trial_notice rechecks the business (a trial still running, or for day
 * 7 one paused at its end; never a business with a plan) and records the claim before anything is sent. `claimedBy` is
 * the job run: a retry of the same run sends again, and notify.send's idempotency key drops what already went.
 */
export async function sendTrialNotice(tenantId: string, day: TrialNoticeDay, claimedBy: string, deps: TrialDeps): Promise<TrialNoticeResult> {
  const { data, error } = await deps.db.rpc("claim_trial_notice", { p_tenant_id: tenantId, p_day: day, p_claimed_by: claimedBy, p_now: deps.now().toISOString() });
  if (error) throw new Error(`claim_trial_notice failed: ${error.message}`);
  const claim = Claim.parse(data);
  if (claim !== "claimed") return { status: claim };
  const facts = await loadTrialFacts(tenantId, deps);
  const counts = await deps.notify(tenantId, trialNoticeMessage(day, facts, deps.appUrl), `trial_notice:${tenantId}:${day}`);
  return { status: "sent", counts };
}

/** The end of each trial that has run out with no plan: paused, and its features off at once on this server. */
export async function expireTrials(deps: TrialDeps): Promise<{ paused: string[] }> {
  const { data, error } = await deps.db.rpc("pause_expired_trials", { p_now: deps.now().toISOString() });
  if (error) throw new Error(`pause_expired_trials failed: ${error.message}`);
  const paused = z.array(z.object({ tenant_id: z.string() })).parse(data ?? []).map((r) => r.tenant_id);
  for (const tenantId of paused) deps.invalidate(tenantId);
  return { paused };
}

const Due = z.array(z.object({ tenant_id: z.string(), day: z.union([z.literal(3), z.literal(5), z.literal(6), z.literal(7)]) }));

/** The notices due now (the latest day for each trial), in sending hours only. */
export async function sendDueTrialNotices(deps: TrialDeps, claimedBy: string): Promise<{ due: number; sent: number; notSent: number; outsideHours: boolean }> {
  if (!inSendingHours(deps.now())) return { due: 0, sent: 0, notSent: 0, outsideHours: true };
  const { data, error } = await deps.db.rpc("trial_notices_due", { p_now: deps.now().toISOString() });
  if (error) throw new Error(`trial_notices_due failed: ${error.message}`);
  const due = Due.parse(data ?? []);
  const counts = { due: due.length, sent: 0, notSent: 0, outsideHours: false };
  for (const row of due) {
    const result = await sendTrialNotice(row.tenant_id, row.day, claimedBy, deps);
    if (result.status === "sent") counts.sent++;
    else counts.notSent++;
  }
  return counts;
}
