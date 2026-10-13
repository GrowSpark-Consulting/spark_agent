import type { AccountStatus, TenantContext } from "@pakka/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { isEnabled } from "../features/is-enabled";
import { supabaseAdmin } from "../lib/supabase-admin";
import { alertLevel } from "./credit-alerts";

// GET /api/billing/balance (docs/dashboard-screen-contracts.md, "Shell": AccountStatus): the credits pill and meter, the
// trial banner and whether the assistant is replying. Decided here, never in the browser: the balance (credit_balance),
// the meter's denominator, the renewal date, and why the assistant is paused. Any member may read it.
//
// A paying business with no active WhatsApp number (never connected, or its connection failed) cannot reply, so that is a
// pause too: its alerts cannot reach the owner over that number, and this is where the dashboard learns of it. A trial
// replies through the shared demo number its TRIAL code routes to, so it never needs its own.

export interface AccountStatusDeps {
  db: SupabaseClient;
  now: () => Date;
  aiAutoReply: (tenantId: string) => Promise<boolean>;
}

const defaults = (): AccountStatusDeps => ({
  db: supabaseAdmin(),
  now: () => new Date(),
  aiAutoReply: (tenantId) => isEnabled(tenantId, "ai_auto_reply"),
});

/** Ledger reasons that grant credits (a refund puts spent credits back, so it is not a grant). */
const GRANT_REASONS = ["plan_grant", "trial_grant", "topup", "admin"];

const Plan = z.object({ key: z.string(), name: z.string(), monthly_credits: z.number().int() });
const Balance = z.array(z.object({ plan: z.number().int(), topup: z.number().int(), total: z.number().int() })).length(1);
const Grant = z.object({ delta: z.number().int(), expires_at: z.string().nullable() });
const Subscription = z.object({ status: z.string(), current_period_end: z.string().nullable() });

function failed(what: string, error: { message: string } | null): void {
  if (error) throw new Error(`account status: ${what} read failed: ${error.message}`);
}

export async function accountStatus(context: TenantContext, deps: AccountStatusDeps = defaults()): Promise<AccountStatus> {
  const tenantId = context.tenant.id;
  const now = deps.now();
  const { status, trialEndsAt } = context.tenant;
  const [plan, balance, grants, subscription, aiAutoReply, numbers] = await Promise.all([
    deps.db.from("plans").select("key, name, monthly_credits").eq("key", context.tenant.planKey).maybeSingle(),
    deps.db.rpc("credit_balance", { p_tenant_id: tenantId }),
    deps.db.from("credit_ledger").select("delta, expires_at").eq("tenant_id", tenantId).gt("delta", 0).in("reason", GRANT_REASONS),
    // The live plan only: a pending checkout or upgrade (no period yet) or a cancelled one says nothing about renewal, and
    // a descending sort would put a pending row's empty period first.
    deps.db.from("subscriptions").select("status, current_period_end").eq("tenant_id", tenantId).in("status", ["active", "past_due"]).order("current_period_end", { ascending: false }).limit(1),
    deps.aiAutoReply(tenantId),
    status === "active"
      ? deps.db.from("whatsapp_connections").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("status", "active")
      : null,
  ]);
  failed("plan", plan.error);
  failed("balance", balance.error);
  failed("grants", grants.error);
  failed("subscription", subscription.error);
  failed("WhatsApp connection", numbers?.error ?? null);
  if (!plan.data) throw new Error(`account status: the business's plan ${context.tenant.planKey} is not in the catalogue`);
  const p = Plan.parse(plan.data);
  const credits = Balance.parse(balance.data)[0];
  const creditsGranted = z
    .array(Grant)
    .parse(grants.data ?? [])
    .filter((g) => g.expires_at === null || Date.parse(g.expires_at) > now.getTime())
    .reduce((sum, g) => sum + g.delta, 0);
  const [sub] = z.array(Subscription).parse(subscription.data ?? []);

  const trialEnded = status === "trial" && trialEndsAt !== null && Date.parse(trialEndsAt) <= now.getTime();
  const noNumber = numbers !== null && !numbers.count;
  // Without a number nothing goes out at all, so that comes before credits. A trial paused at its end (trial-lifecycle)
  // still reads as an ended trial.
  const aiPausedReason =
    status === "paused" ? (context.tenant.planKey === "trial" ? "trial_ended" : "paused")
    : status === "cancelled" ? "cancelled"
    : trialEnded ? "trial_ended"
    : noNumber ? "whatsapp_not_connected"
    : credits.total <= 0 ? "no_credits"
    : null;

  return {
    status,
    plan: { key: p.key, name: p.name, monthlyCredits: p.monthly_credits },
    credits,
    creditsGranted,
    renewsAt: status === "active" && sub?.current_period_end ? new Date(sub.current_period_end).toISOString() : null,
    trialEndsAt: status === "trial" && trialEndsAt ? new Date(trialEndsAt).toISOString() : null,
    aiPaused: aiPausedReason !== null,
    aiPausedReason,
    lowCredits: alertLevel(credits.total, p.monthly_credits) !== null,
    aiAutoReply,
  };
}
