import { describe, expect, it, vi } from "vitest";
import type { TrialDeps } from "../billing/trial-lifecycle";
import { fakeDb, type FakeDbResponse } from "../test-support/fake-db";
import { functions } from "./functions";
import { handleTrialStarted, handleTrialSweep, TRIAL_STARTED_EVENT, trialLifecycle, trialLifecycleSweep } from "./trial-lifecycle";

const TENANT = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const NOW = new Date("2026-10-13T05:30:00Z"); // 11:00 in India

function deps(tables: Record<string, FakeDbResponse | FakeDbResponse[]>) {
  const db = fakeDb(tables);
  const notify = vi.fn<TrialDeps["notify"]>(async () => ({ recipients: 1, sent: 1, skipped: 0, failed: 0 }));
  const d: TrialDeps = { db: db.client, appUrl: "https://app.spark.test", now: () => NOW, notify, invalidate: vi.fn() };
  return { d, calls: db.calls, notify };
}

function stepper() {
  const ids: string[] = [];
  return { ids, step: { run: async <T>(id: string, fn: () => Promise<T>) => (ids.push(id), fn()) } };
}

const facts: Record<string, FakeDbResponse> = {
  tenants: { data: { name: "Skyline Homes", trial_ends_at: "2026-10-20T05:30:00Z" }, error: null },
  route_codes: { data: [{ code: "TRIAL-7KQ2" }], error: null },
  messages: { data: null, error: null, count: 0 },
  leads: { data: null, error: null, count: 0 },
  credit_ledger: { data: [], error: null },
  plans: { data: [{ key: "trial", name: "Trial", price_inr: 0, monthly_credits: 300 }], error: null },
};

describe("trial-lifecycle: the welcome", () => {
  it("claims day 0 for this run and welcomes the owners at once", async () => {
    const { d, calls, notify } = deps({ "rpc:claim_trial_notice": { data: "claimed", error: null }, ...facts });
    const { ids, step } = stepper();
    expect(await handleTrialStarted({ event: { data: { tenantId: TENANT } }, runId: "run-0", step }, () => d)).toMatchObject({ status: "sent" });
    expect(ids).toEqual(["welcome"]);
    expect(calls.find((c) => c.table === "rpc:claim_trial_notice")?.args[0]).toMatchObject({ p_tenant_id: TENANT, p_day: 0, p_claimed_by: "run-0" });
    expect(notify).toHaveBeenCalledWith(TENANT, expect.objectContaining({ text: expect.stringContaining("TRIAL-7KQ2") }), `trial_notice:${TENANT}:0`);
  });

  // Exit test 1 (Day 7; inngest/replay-coverage.test.ts): day 0 is claimed by the first run (claim_trial_notice, 0039), so a replay is another
  // run that finds it taken.
  it("replay: the same event in another run finds day 0 claimed and sends nothing", async () => {
    const { d, notify } = deps({ "rpc:claim_trial_notice": { data: "already", error: null }, ...facts });
    expect(await handleTrialStarted({ event: { data: { tenantId: TENANT } }, runId: "run-1", step: stepper().step }, () => d)).toMatchObject({ status: "already" });
    expect(notify).not.toHaveBeenCalled();
  });

  it("refuses an event without a business", async () => {
    await expect(handleTrialStarted({ event: { data: {} }, runId: "run-0", step: stepper().step }, () => deps({}).d)).rejects.toThrow();
  });
});

describe("trial-lifecycle-sweep", () => {
  it("ends expired trials first, then sends what is due, under this run's claims", async () => {
    const { d, calls } = deps({
      "rpc:pause_expired_trials": { data: [{ tenant_id: TENANT }], error: null },
      "rpc:trial_notices_due": { data: [{ tenant_id: TENANT, day: 7 }], error: null },
      "rpc:claim_trial_notice": { data: "claimed", error: null },
      ...facts,
    });
    const { ids, step } = stepper();
    const out = await handleTrialSweep({ runId: "run-5", step }, () => d);
    expect(ids).toEqual(["expire", "notices"]);
    expect(out).toEqual({ expired: { paused: [TENANT] }, notices: { due: 1, sent: 1, notSent: 0, outsideHours: false } });
    expect(calls.find((c) => c.table === "rpc:claim_trial_notice")?.args[0]).toMatchObject({ p_day: 7, p_claimed_by: "run-5" });
  });

  it("a repeat run sends nothing another run already claimed", async () => {
    const { d, notify } = deps({
      "rpc:pause_expired_trials": { data: [], error: null },
      "rpc:trial_notices_due": { data: [{ tenant_id: TENANT, day: 6 }], error: null },
      "rpc:claim_trial_notice": { data: "already", error: null },
    });
    expect((await handleTrialSweep({ runId: "run-6", step: stepper().step }, () => d)).notices).toEqual({ due: 1, sent: 0, notSent: 1, outsideHours: false });
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("registration", () => {
  const opts = (fn: unknown) => (fn as { opts: unknown }).opts;

  it("starts on tenant.trial_started, and sweeps every two hours at :15 in India, one run at a time", () => {
    expect(functions).toContain(trialLifecycle);
    expect(functions).toContain(trialLifecycleSweep);
    expect(opts(trialLifecycle)).toMatchObject({ id: "trial-lifecycle", triggers: [{ event: TRIAL_STARTED_EVENT }] });
    expect(TRIAL_STARTED_EVENT).toBe("tenant.trial_started");
    expect(opts(trialLifecycleSweep)).toMatchObject({ id: "trial-lifecycle-sweep", triggers: [{ cron: "TZ=Asia/Kolkata 15 */2 * * *" }], concurrency: { limit: 1 } });
  });
});
