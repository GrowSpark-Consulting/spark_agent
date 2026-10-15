import type { AdminMetrics } from "@pakka/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase-admin";

// The admin view's cost-per-credit and trial-to-paid numbers (Day 8; migration 0051). Dollars become rupees at one stated rate:
// the same assumption as `pnpm cost:per-message` (DEFAULT_USD_INR), against the blueprint's 0.35-rupee-per-credit target.

export const USD_INR = 90;
export const TARGET_INR_PER_CREDIT = 0.35;

export interface MetricsDeps {
  db: SupabaseClient;
  now: () => Date;
}
const defaults = (): MetricsDeps => ({ db: supabaseAdmin(), now: () => new Date() });

const Row = z.object({
  days: z.number().int(),
  credits_spent: z.coerce.number(),
  ai_cost_usd: z.coerce.number(),
  ai_calls: z.coerce.number(),
  trials_started: z.coerce.number(),
  trials_paid: z.coerce.number(),
});

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

export async function adminMetrics(deps: MetricsDeps = defaults()): Promise<AdminMetrics> {
  const now = deps.now();
  const { data, error } = await deps.db.rpc("admin_metrics", { p_now: now.toISOString() });
  if (error) throw new Error(`admin_metrics failed: ${error.message}`);
  return {
    windows: z
      .array(Row)
      .parse(data ?? [])
      .map((r) => {
        const aiCostInr = r.ai_cost_usd * USD_INR;
        return {
          days: r.days,
          creditsSpent: r.credits_spent,
          aiCostUsd: round(r.ai_cost_usd, 4),
          aiCostInr: round(aiCostInr, 2),
          aiCalls: r.ai_calls,
          costPerCreditInr: r.credits_spent > 0 ? round(aiCostInr / r.credits_spent, 3) : null,
          trialsStarted: r.trials_started,
          trialsPaid: r.trials_paid,
          trialToPaidPct: r.trials_started > 0 ? round((r.trials_paid / r.trials_started) * 100, 1) : null,
        };
      }),
    targetCostPerCreditInr: TARGET_INR_PER_CREDIT,
    usdInr: USD_INR,
    asOf: now.toISOString(),
  };
}
