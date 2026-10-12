import { AccountStatus, type TenantContext } from "@pakka/types";
import { describe, expect, it } from "vitest";
import { fakeDb, type FakeDbResponse } from "../test-support/fake-db";
import { accountStatus } from "./account-status";

const TENANT = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const NOW = new Date("2026-10-12T06:00:00Z");

const context = (tenant: Partial<TenantContext["tenant"]> = {}): TenantContext => ({
  user: { id: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b", email: null },
  role: "staff",
  tenant: { id: TENANT, name: "Skyline Homes", vertical: "real-estate", timezone: "Asia/Kolkata", status: "active", planKey: "starter", trialEndsAt: null, ...tenant },
});

function deps(over: { balance?: number; grants?: { delta: number; expires_at: string | null }[]; subscription?: unknown[]; plan?: FakeDbResponse; aiAutoReply?: boolean } = {}) {
  const total = over.balance ?? 900;
  const db = fakeDb({
    plans: over.plan ?? { data: { key: "starter", name: "Starter", monthly_credits: 1500 }, error: null },
    "rpc:credit_balance": { data: [{ plan: total - 100 > 0 ? total - 100 : total, topup: total - 100 > 0 ? 100 : 0, total }], error: null },
    credit_ledger: {
      data: over.grants ?? [
        { delta: 1500, expires_at: "2026-11-30T18:30:00Z" },
        { delta: 1500, expires_at: "2026-10-31T18:30:00Z" },
        { delta: 500, expires_at: "2026-10-01T00:00:00Z" },
      ],
      error: null,
    },
    subscriptions: { data: over.subscription ?? [{ status: "active", current_period_end: "2026-10-31T18:30:00+00:00" }], error: null },
  });
  return { d: { db: db.client, now: () => NOW, aiAutoReply: async () => over.aiAutoReply ?? true }, calls: db.calls };
}

describe("GET /api/billing/balance", () => {
  it("gives the balance, the live grants as the meter's denominator, and the renewal date", async () => {
    const { d, calls } = deps();
    const status = AccountStatus.parse(await accountStatus(context(), d));
    expect(status).toEqual({
      status: "active",
      plan: { key: "starter", name: "Starter", monthlyCredits: 1500 },
      credits: { plan: 800, topup: 100, total: 900 },
      // The 500 that expired on 1 Oct is not this cycle's.
      creditsGranted: 3000,
      renewsAt: "2026-10-31T18:30:00.000Z",
      trialEndsAt: null,
      aiPaused: false,
      aiPausedReason: null,
      lowCredits: false,
      aiAutoReply: true,
    });
    expect(calls.find((c) => c.table === "rpc:credit_balance")?.args[0]).toEqual({ p_tenant_id: TENANT });
    expect(calls.filter((c) => c.table === "credit_ledger").map((c) => [c.method, ...c.args])).toContainEqual(["in", "reason", ["plan_grant", "trial_grant", "topup", "admin"]]);
    expect(calls).toContainEqual({ table: "subscriptions", method: "eq", args: ["tenant_id", TENANT] });
  });

  it("says credits are low at a fifth of the month's credits, and paused at none", async () => {
    expect(await accountStatus(context(), deps({ balance: 300 }).d)).toMatchObject({ lowCredits: true, aiPaused: false });
    expect(await accountStatus(context(), deps({ balance: 0 }).d)).toMatchObject({ lowCredits: true, aiPaused: true, aiPausedReason: "no_credits" });
  });

  it("says when a trial ends, and that the assistant has stopped once it has", async () => {
    const live = await accountStatus(context({ status: "trial", planKey: "trial", trialEndsAt: "2026-10-15T06:00:00+00:00" }), deps({ subscription: [] }).d);
    expect(live).toMatchObject({ trialEndsAt: "2026-10-15T06:00:00.000Z", renewsAt: null, aiPaused: false });
    const ended = await accountStatus(context({ status: "trial", planKey: "trial", trialEndsAt: "2026-10-11T06:00:00+00:00" }), deps({ subscription: [] }).d);
    expect(ended).toMatchObject({ aiPaused: true, aiPausedReason: "trial_ended" });
  });

  it("says a paused or cancelled business's assistant is not replying, and reports the AI switch apart", async () => {
    expect(await accountStatus(context({ status: "paused" }), deps().d)).toMatchObject({ aiPaused: true, aiPausedReason: "paused", renewsAt: null });
    expect(await accountStatus(context({ status: "cancelled" }), deps().d)).toMatchObject({ aiPausedReason: "cancelled" });
    // Switching AI replies off is the business's choice, not a pause.
    expect(await accountStatus(context(), deps({ aiAutoReply: false }).d)).toMatchObject({ aiAutoReply: false, aiPaused: false });
  });

  it("fails loudly when the plan is missing from the catalogue", async () => {
    await expect(accountStatus(context(), deps({ plan: { data: null, error: null } }).d)).rejects.toThrow("is not in the catalogue");
  });
});
