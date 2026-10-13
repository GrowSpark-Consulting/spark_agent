import { z } from "zod";
import { expireTrials, sendDueTrialNotices, sendTrialNotice, trialDeps, type TrialDeps } from "../billing/trial-lifecycle";
import { inngest } from "./client";

// trial-lifecycle (docs/handover.md, module 8; billing/trial-lifecycle.ts). Two functions:
//   * trial-lifecycle: tenant.trial_started (sent at signup with the id trial_started:<tenantId>, so a repeat signup
//     starts nothing new) → the day-0 welcome, at once.
//   * trial-lifecycle-sweep: every hour at :15, one run at a time. First the end of each trial that has run out with no
//     plan (paused at any hour), then the notices due now (days 3, 5, 6 and 7, between 09:00 and 20:00 in India).
// The run id claims each notice (0039): Inngest retrying a step resends nothing that already went, and another run never
// sends the same notice again.

export const TRIAL_STARTED_EVENT = "tenant.trial_started";

const TrialStarted = z.object({ tenantId: z.guid() });

interface Step {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

export async function handleTrialStarted({ event, runId, step }: { event: { data: unknown }; runId: string; step: Step }, deps: () => TrialDeps = trialDeps) {
  const { tenantId } = TrialStarted.parse(event.data);
  return step.run("welcome", () => sendTrialNotice(tenantId, 0, runId, deps()));
}

export async function handleTrialSweep({ runId, step }: { runId: string; step: Step }, deps: () => TrialDeps = trialDeps) {
  const expired = await step.run("expire", () => expireTrials(deps()));
  const notices = await step.run("notices", () => sendDueTrialNotices(deps(), runId));
  return { expired, notices };
}

const stepOf = (ctx: { step: { run: (id: string, fn: () => Promise<unknown>) => unknown } }): Step => ({
  run: <T>(id: string, fn: () => Promise<T>) => ctx.step.run(id, fn) as unknown as Promise<T>,
});

export const trialLifecycle = inngest.createFunction({ id: "trial-lifecycle", triggers: [{ event: TRIAL_STARTED_EVENT }] }, (ctx) =>
  handleTrialStarted({ event: ctx.event, runId: ctx.runId, step: stepOf(ctx) }),
);

export const trialLifecycleSweep = inngest.createFunction(
  { id: "trial-lifecycle-sweep", triggers: [{ cron: "TZ=Asia/Kolkata 15 * * * *" }], concurrency: { limit: 1 } },
  (ctx) => handleTrialSweep({ runId: ctx.runId, step: stepOf(ctx) }),
);
