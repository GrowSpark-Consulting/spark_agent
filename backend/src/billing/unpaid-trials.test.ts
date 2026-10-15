import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { deleteUnpaidTrial, deletionWarning, listUnpaidTrials, MAX_PER_RUN, removeTenantMedia, warnUnpaidTrial, type UnpaidTrialDeps } from "./unpaid-trials";

const TENANT = "0f800000-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-15T22:00:00Z"); // 03:30 on 16 Oct in India
const row = (over: Record<string, unknown> = {}) => ({
  tenant_id: TENANT,
  trial_ended_at: "2026-09-14T06:00:00+00:00",
  deletes_on: "2026-10-14T06:00:00+00:00",
  due: true,
  ...over,
});

function deps(rpcs: Record<string, { data: unknown; error: { message: string } | null }>, storage: { names?: string[]; failRemove?: boolean } = {}) {
  const rpc = vi.fn(async (name: string) => (name === "media_object_names" ? { data: storage.names ?? [], error: null } : rpcs[name]));
  const remove = vi.fn(async () => ({ data: null, error: storage.failRemove ? { message: "down" } : null }));
  const notify = vi.fn<UnpaidTrialDeps["notify"]>(async () => ({ recipients: 1, sent: 1, skipped: 0, failed: 0 }));
  const d: UnpaidTrialDeps = { db: { rpc, storage: { from: () => ({ remove }) } } as unknown as SupabaseClient, appUrl: "https://app.spark.test/", now: () => NOW, notify };
  return { d, rpc, remove, notify };
}

describe("the businesses to clean up", () => {
  it("lists them with their dates, as of now", async () => {
    const { d, rpc } = deps({ unpaid_trials_for_cleanup: { data: [row(), row({ tenant_id: "t2", due: false, deletes_on: "2026-10-20T06:00:00Z" })], error: null } });
    expect(await listUnpaidTrials(d)).toEqual([
      { tenantId: TENANT, trialEndedAt: "2026-09-14T06:00:00.000Z", deletesOn: "2026-10-14T06:00:00.000Z", due: true },
      { tenantId: "t2", trialEndedAt: "2026-09-14T06:00:00.000Z", deletesOn: "2026-10-20T06:00:00.000Z", due: false },
    ]);
    expect(rpc).toHaveBeenCalledWith("unpaid_trials_for_cleanup", { p_now: NOW.toISOString() });
  });

  it(`takes at most ${MAX_PER_RUN} a run, and fails in fixed words`, async () => {
    const many = Array.from({ length: MAX_PER_RUN + 5 }, (_, i) => row({ tenant_id: `t${i}` }));
    expect(await listUnpaidTrials(deps({ unpaid_trials_for_cleanup: { data: many, error: null } }).d)).toHaveLength(MAX_PER_RUN);
    const failing = deps({ unpaid_trials_for_cleanup: { data: null, error: { message: "timeout at 10.0.0.5" } } });
    await expect(listUnpaidTrials(failing.d)).rejects.toThrow(/^unpaid trials: listing failed$/);
  });
});

describe("the warning, 7 days before", () => {
  const trial = { tenantId: TENANT, trialEndedAt: "2026-09-20T06:00:00Z", deletesOn: "2026-10-20T06:00:00Z", due: false };

  it("says when the trial ended, when the data goes, and how to keep it", () => {
    const message = deletionWarning(trial, "https://app.spark.test/");
    expect(message.templateParams).toEqual([
      "Your Spark Agent trial ended on 20 Sept 2026. Your chats, leads and settings will be deleted on 20 Oct 2026.",
      "https://app.spark.test/dashboard/billing",
    ]);
    expect(message.text).toContain("Choose a plan in Billing to keep them.");
  });

  it("goes once per business and date (India's), so a trial extended later is warned again", async () => {
    const { d, notify } = deps({});
    await warnUnpaidTrial(trial, d);
    expect(notify).toHaveBeenCalledWith(TENANT, expect.objectContaining({ templateParams: expect.any(Array) }), `unpaid_trial_warning:${TENANT}:2026-10-20`);
  });
});

describe("the deletion and the files", () => {
  it("passes on what the database decided", async () => {
    for (const outcome of ["deleted", "gone", "not_eligible"] as const) {
      const { d, rpc } = deps({ delete_unpaid_trial: { data: [{ outcome, counts: outcome === "deleted" ? { messages: 4 } : {} }], error: null } });
      expect((await deleteUnpaidTrial(TENANT, d)).outcome).toBe(outcome);
      expect(rpc).toHaveBeenCalledWith("delete_unpaid_trial", { p_tenant_id: TENANT, p_now: NOW.toISOString() });
    }
    await expect(deleteUnpaidTrial(TENANT, deps({ delete_unpaid_trial: { data: null, error: { message: "lock timeout" } } }).d)).rejects.toThrow(/^unpaid trials: deleting failed$/);
  });

  it("removes every file of the business, and throws while any is left so the step is retried", async () => {
    const names = [`${TENANT}/c1/m1.jpg`, `${TENANT}/c2/m2.pdf`];
    const ok = deps({}, { names });
    expect(await removeTenantMedia(TENANT, ok.d)).toEqual({ removed: 2 });
    expect(ok.rpc).toHaveBeenCalledWith("media_object_names", { p_tenant_id: TENANT, p_conversation_ids: null });
    expect(ok.remove).toHaveBeenCalledWith(names);

    await expect(removeTenantMedia(TENANT, deps({}, { names, failRemove: true }).d)).rejects.toThrow("2 media file(s) were not removed");
    expect(await removeTenantMedia(TENANT, deps({}, { names: [] }).d)).toEqual({ removed: 0 });
  });
});
