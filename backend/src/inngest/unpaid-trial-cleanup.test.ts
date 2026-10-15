import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UnpaidTrial, UnpaidTrialDeps } from "../billing/unpaid-trials";

type Outcome = { outcome: "deleted" | "gone" | "not_eligible"; counts: Record<string, number> };
const list = vi.fn<() => Promise<UnpaidTrial[]>>();
const warn = vi.fn<(trial: UnpaidTrial) => Promise<{ recipients: number; sent: number; skipped: number; failed: number }>>(async () => ({ recipients: 1, sent: 1, skipped: 0, failed: 0 }));
const remove = vi.fn<(tenantId: string) => Promise<Outcome>>();
const media = vi.fn<(tenantId: string) => Promise<{ removed: number }>>(async () => ({ removed: 2 }));
vi.mock("../billing/unpaid-trials", () => ({
  listUnpaidTrials: () => list(),
  warnUnpaidTrial: (trial: UnpaidTrial) => warn(trial),
  deleteUnpaidTrial: (tenantId: string) => remove(tenantId),
  removeTenantMedia: (tenantId: string) => media(tenantId),
  unpaidTrialDeps: () => ({}),
}));

const { handleUnpaidTrialCleanup, unpaidTrialCleanup } = await import("./unpaid-trial-cleanup");
const { functions } = await import("./functions");

const trial = (tenantId: string, due: boolean): UnpaidTrial => ({ tenantId, trialEndedAt: "2026-09-10T06:00:00.000Z", deletesOn: "2026-10-10T06:00:00.000Z", due });
const stepper = () => {
  const ran: string[] = [];
  return { ran, step: { run: async <T>(id: string, fn: () => Promise<T>) => (ran.push(id), JSON.parse(JSON.stringify(await fn())) as T) } };
};
const deps = () => ({}) as UnpaidTrialDeps;

beforeEach(() => {
  for (const m of [list, warn, remove, media]) m.mockClear();
  list.mockResolvedValue([trial("t-warn", false), trial("t-due", true), trial("t-paid", true), trial("t-gone", true)]);
  remove.mockImplementation(async (tenantId: string): Promise<Outcome> =>
    tenantId === "t-paid" ? { outcome: "not_eligible", counts: {} } : tenantId === "t-gone" ? { outcome: "gone", counts: {} } : { outcome: "deleted", counts: { messages: 3 } },
  );
});

describe("unpaid-trial-cleanup", () => {
  it("warns those not due, then deletes each one due and removes its files, one step each", async () => {
    const s = stepper();
    expect(await handleUnpaidTrialCleanup({ step: s.step }, deps)).toEqual({ listed: 4, warned: 1, deleted: 1, notEligible: 1, mediaRemoved: 4 });
    expect(s.ran).toEqual(["list", "warn-t-warn", "delete-t-due", "media-t-due", "delete-t-paid", "delete-t-gone", "media-t-gone"]);
  });

  it("never touches the files of a business that paid or was extended since it was listed", async () => {
    await handleUnpaidTrialCleanup({ step: stepper().step }, deps);
    expect(media.mock.calls.map(([id]) => id)).toEqual(["t-due", "t-gone"]);
  });

  it("lets a step's failure through, so Inngest retries that step", async () => {
    media.mockRejectedValueOnce(new Error("unpaid trials: 2 media file(s) were not removed; retrying"));
    await expect(handleUnpaidTrialCleanup({ step: stepper().step }, deps)).rejects.toThrow("retrying");
  });

  // Exit test 1 (Day 7; inngest/replay-coverage.test.ts): the warning is keyed by business and date (notify.send keeps one per key), the
  // deletion answers "gone" the second time (unpaid_trial_deletion.test.sql), and the media listing finds only what is left.
  it("replay: the same tick twice warns under the same keys and finds the deleted business gone, deleting nothing twice", async () => {
    await handleUnpaidTrialCleanup({ step: stepper().step }, deps);
    remove.mockImplementation(async (tenantId: string): Promise<Outcome> => (tenantId === "t-paid" ? { outcome: "not_eligible", counts: {} } : { outcome: "gone", counts: {} }));
    media.mockResolvedValue({ removed: 0 });
    expect(await handleUnpaidTrialCleanup({ step: stepper().step }, deps)).toMatchObject({ deleted: 0, mediaRemoved: 0 });
    expect(warn.mock.calls.map(([t]) => t)).toEqual([trial("t-warn", false), trial("t-warn", false)]);
  });

  it("is served once a day at 03:30 in India, one run at a time", () => {
    expect(functions).toContain(unpaidTrialCleanup);
    expect((unpaidTrialCleanup as unknown as { opts: unknown }).opts).toMatchObject({
      id: "unpaid-trial-cleanup",
      triggers: [{ cron: "TZ=Asia/Kolkata 30 3 * * *" }],
      concurrency: { limit: 1 },
    });
  });
});
