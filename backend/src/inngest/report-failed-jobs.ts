import { z } from "zod";
import { reportProblem } from "../lib/report";
import { inngest } from "./client";

// A job that failed for good (all retries used) is sent to Sentry once, by function id and run id only: Inngest sends
// inngest/function.failed itself; the error text it carries is never read. Replays of the event report one Sentry event
// (the event key is the run id). Its own failure is not reported (that would loop).

const Failed = z.object({ function_id: z.string().max(200), run_id: z.string().max(100) });

export async function handleFailedJob({ event, step }: { event: { data: unknown }; step: { run<T>(id: string, fn: () => Promise<T>): Promise<T> } }, report: typeof reportProblem = reportProblem) {
  const parsed = Failed.safeParse(event.data);
  if (!parsed.success) return { reported: false as const, reason: "unreadable" as const };
  const { function_id: fn, run_id: run } = parsed.data;
  if (fn.endsWith("report-failed-jobs")) return { reported: false as const, reason: "self" as const };
  const sent = await step.run("report", () =>
    report(`Job ${fn} failed after its retries`, { kind: "job_failed", tags: { function: fn, run }, fingerprint: ["job_failed", fn], eventKey: `job_failed:${run}` }),
  );
  return { reported: sent };
}

export const reportFailedJobs = inngest.createFunction(
  { id: "report-failed-jobs", triggers: [{ event: "inngest/function.failed" }] },
  (ctx) => handleFailedJob({ event: ctx.event, step: { run: <T>(id: string, fn: () => Promise<T>) => ctx.step.run(id, fn) as unknown as Promise<T> } }),
);
