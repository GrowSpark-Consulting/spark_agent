import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

// Credit alerts (docs/handover.md, module 7: "Owner alerts at 80% and 100% of plan credits"; 9-day plan, Day 5): after
// credits are spent, the owner hears when the balance is down to a fifth of the plan's monthly credits (80% used) and
// again when it is gone (100%). Each alert goes once per grant: a new month's credits, a top-up or an admin grant starts
// the count again. Free, through notify.send's staff_alert (inngest/credit-alerts.ts sends them).

/** "80% of plan credits used" is a balance at or below this share of the plan's monthly credits. */
export const LOW_SHARE = 0.2;

export type CreditAlertLevel = "low" | "used_up";

/** Which alert the balance calls for, or null. */
export function alertLevel(balance: number, monthlyCredits: number): CreditAlertLevel | null {
  if (balance <= 0) return "used_up";
  if (balance <= Math.floor(monthlyCredits * LOW_SHARE)) return "low";
  return null;
}

export interface CreditState {
  balance: number;
  monthlyCredits: number;
  /** The newest grant (credit_ledger id): an alert is sent once per grant. Null when the business never had credits. */
  grantId: number | null;
}

const TenantPlan = z.object({ plans: z.object({ monthly_credits: z.number().int() }) });
const Balance = z.array(z.object({ total: z.number().int() })).length(1);
const Grant = z.array(z.object({ id: z.number().int() })).max(1);

/** The balance, the plan's monthly credits and the newest grant, read together. Null when the business is gone. */
export async function loadCreditState(tenantId: string, db: SupabaseClient): Promise<CreditState | null> {
  const [tenant, balance, grant] = await Promise.all([
    db.from("tenants").select("plans(monthly_credits)").eq("id", tenantId).maybeSingle(),
    db.rpc("credit_balance", { p_tenant_id: tenantId }),
    db.from("credit_ledger").select("id").eq("tenant_id", tenantId).gt("delta", 0).order("id", { ascending: false }).limit(1),
  ]);
  if (tenant.error) throw new Error(`credit alerts: plan read failed: ${tenant.error.message}`);
  if (balance.error) throw new Error(`credit alerts: balance read failed: ${balance.error.message}`);
  if (grant.error) throw new Error(`credit alerts: grant read failed: ${grant.error.message}`);
  if (!tenant.data) return null;
  const [newest] = Grant.parse(grant.data ?? []);
  return {
    balance: Balance.parse(balance.data)[0].total,
    monthlyCredits: TenantPlan.parse(tenant.data).plans.monthly_credits,
    grantId: newest?.id ?? null,
  };
}
