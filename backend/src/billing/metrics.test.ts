import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { adminMetrics } from "./metrics";

const NOW = new Date("2026-10-15T06:00:00Z");
const deps = (data: unknown, error: { message: string } | null = null) => {
  const rpc = vi.fn(async () => ({ data, error }));
  return { rpc, d: { db: { rpc } as unknown as SupabaseClient, now: () => NOW } };
};

describe("adminMetrics", () => {
  it("turns the model cost into rupees, and works out cost per credit and trial-to-paid", async () => {
    const { rpc, d } = deps([
      { days: 7, credits_spent: "40", ai_cost_usd: "0.40", ai_calls: "8", trials_started: "4", trials_paid: "1" },
      { days: 30, credits_spent: 1000, ai_cost_usd: 3.5, ai_calls: 400, trials_started: 10, trials_paid: 3 },
    ]);
    const m = await adminMetrics(d);
    expect(rpc).toHaveBeenCalledWith("admin_metrics", { p_now: NOW.toISOString() });
    expect(m).toMatchObject({ targetCostPerCreditInr: 0.35, usdInr: 90, asOf: NOW.toISOString() });
    expect(m.windows[0]).toEqual({ days: 7, creditsSpent: 40, aiCostUsd: 0.4, aiCostInr: 36, aiCalls: 8, costPerCreditInr: 0.9, trialsStarted: 4, trialsPaid: 1, trialToPaidPct: 25 });
    expect(m.windows[1]).toMatchObject({ aiCostInr: 315, costPerCreditInr: 0.315, trialToPaidPct: 30 });
  });

  it("has no ratio, rather than dividing by zero", async () => {
    const m = await adminMetrics(deps([{ days: 7, credits_spent: 0, ai_cost_usd: 0.2, ai_calls: 3, trials_started: 0, trials_paid: 0 }]).d);
    expect(m.windows[0]).toMatchObject({ costPerCreditInr: null, trialToPaidPct: null, aiCostInr: 18 });
  });

  it("throws when the database fails", async () => {
    await expect(adminMetrics(deps(null, { message: "boom" }).d)).rejects.toThrow("admin_metrics failed");
  });
});
