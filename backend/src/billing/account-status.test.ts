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

function deps(
  over: { balance?: number; grants?: { delta: number; expires_at: string | null }[]; subscription?: unknown[]; plan?: FakeDbResponse; aiAutoReply?: boolean; numbers?: FakeDbResponse } = {},
) {
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
    subscriptions: { data: over.subscription ?? [{ status: "active", current_period_end: "2026-10-31T18:30:00+00:00", cancel_at: null }], error: null },
    // Active WhatsApp numbers, counted.
    whatsapp_connections: over.numbers ?? { data: null, error: null, count: 1 },
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
      endsAt: null,
      trialEndsAt: null,
      aiPaused: false,
      aiPausedReason: null,
      lowCredits: false,
      aiAutoReply: true,
    });
    expect(calls.find((c) => c.table === "rpc:credit_balance")?.args[0]).toEqual({ p_tenant_id: TENANT });
    expect(calls.filter((c) => c.table === "credit_ledger").map((c) => [c.method, ...c.args])).toContainEqual(["in", "reason", ["plan_grant", "trial_grant", "topup", "admin"]]);
    expect(calls).toContainEqual({ table: "subscriptions", method: "eq", args: ["tenant_id", TENANT] });
    // Only the live plan: a pending checkout or upgrade has no period yet, and a descending sort puts its empty one first.
    expect(calls).toContainEqual({ table: "subscriptions", method: "in", args: ["status", ["active", "past_due"]] });
  });

  it("gives a cancelled plan's end instead of a renewal date", async () => {
    const cancelled = [{ status: "active", current_period_end: "2026-10-31T18:30:00+00:00", cancel_at: "2026-10-31T18:30:00+00:00" }];
    expect(await accountStatus(context(), deps({ subscription: cancelled }).d)).toMatchObject({ renewsAt: null, endsAt: "2026-10-31T18:30:00.000Z", aiPaused: false });
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

  it("says a paying business with no active WhatsApp number is not replying, before credits", async () => {
    const { d, calls } = deps({ numbers: { data: null, error: null, count: 0 }, balance: 0 });
    expect(await accountStatus(context(), d)).toMatchObject({ aiPaused: true, aiPausedReason: "whatsapp_not_connected" });
    expect(calls.filter((c) => c.table === "whatsapp_connections" && c.method === "eq").map((c) => c.args)).toEqual([
      ["tenant_id", TENANT],
      ["status", "active"],
    ]);
  });

  it("does not ask a trial, or a paused business, for its own number", async () => {
    // A live trial replies through the shared demo number its TRIAL code routes to.
    const trial = deps({ subscription: [], numbers: { data: null, error: null, count: 0 } });
    expect(await accountStatus(context({ status: "trial", planKey: "trial", trialEndsAt: "2026-10-15T06:00:00+00:00" }), trial.d)).toMatchObject({
      aiPaused: false,
      aiPausedReason: null,
    });
    expect(trial.calls.some((c) => c.table === "whatsapp_connections")).toBe(false);
    const paused = deps({ numbers: { data: null, error: null, count: 0 } });
    expect(await accountStatus(context({ status: "paused" }), paused.d)).toMatchObject({ aiPausedReason: "paused" });
    expect(paused.calls.some((c) => c.table === "whatsapp_connections")).toBe(false);
  });

  it("fails loudly when the connection count cannot be read", async () => {
    await expect(accountStatus(context(), deps({ numbers: { data: null, error: { message: "timeout" } } }).d)).rejects.toThrow("WhatsApp connection read failed");
  });

  it("reads a trial paused at its end as an ended trial, and a paid plan paused as paused", async () => {
    expect(await accountStatus(context({ status: "paused", planKey: "trial", trialEndsAt: "2026-10-11T06:00:00+00:00" }), deps({ subscription: [] }).d)).toMatchObject({
      aiPaused: true,
      aiPausedReason: "trial_ended",
    });
    expect(await accountStatus(context({ status: "paused", planKey: "starter" }), deps().d)).toMatchObject({ aiPausedReason: "paused" });
  });

  it("fails loudly when the plan is missing from the catalogue", async () => {
    await expect(accountStatus(context(), deps({ plan: { data: null, error: null } }).d)).rejects.toThrow("is not in the catalogue");
  });
});
