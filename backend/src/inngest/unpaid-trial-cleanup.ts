import { deleteUnpaidTrial, listUnpaidTrials, removeTenantMedia, unpaidTrialDeps, warnUnpaidTrial, type UnpaidTrialDeps } from "../billing/unpaid-trials";
import { inngest } from "./client";

// unpaid-trial-cleanup (Day 7; billing/unpaid-trials.ts, migration 0048): once a day at 03:30 in India, one run at a time. The
// businesses whose trial ended unpaid 23 days ago or more: a warning to the owners of those not due yet, then, for each one due
// (30 days), its deletion and then its media files. Each business is a step of its own, so a retry repeats only what failed, and
// every step is safe to repeat: the warning is keyed, the deletion answers "gone" the second time, and the media listing finds
// only what is left.

interface Step {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

export async function handleUnpaidTrialCleanup({ step }: { step: Step }, deps: () => UnpaidTrialDeps = unpaidTrialDeps) {
  const trials = await step.run("list", () => listUnpaidTrials(deps()));
  let warned = 0;
  for (const trial of trials.filter((t) => !t.due)) {
    const counts = await step.run(`warn-${trial.tenantId}`, () => warnUnpaidTrial(trial, deps()));
    if (counts.sent > 0) warned++;
  }
  const outcomes = { deleted: 0, notEligible: 0, mediaRemoved: 0 };
  for (const trial of trials.filter((t) => t.due)) {
    const { outcome } = await step.run(`delete-${trial.tenantId}`, () => deleteUnpaidTrial(trial.tenantId, deps()));
    if (outcome === "not_eligible") {
      outcomes.notEligible++;
      continue;
    }
    if (outcome === "deleted") outcomes.deleted++;
    const media = await step.run(`media-${trial.tenantId}`, () => removeTenantMedia(trial.tenantId, deps()));
    outcomes.mediaRemoved += media.removed;
  }
  return { listed: trials.length, warned, ...outcomes };
}

export const unpaidTrialCleanup = inngest.createFunction(
  { id: "unpaid-trial-cleanup", triggers: [{ cron: "TZ=Asia/Kolkata 30 3 * * *" }], concurrency: { limit: 1 } },
  (ctx) => handleUnpaidTrialCleanup({ step: { run: <T>(id: string, fn: () => Promise<T>) => ctx.step.run(id, fn) as unknown as Promise<T> } }),
);
