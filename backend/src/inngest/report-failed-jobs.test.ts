import { describe, expect, it, vi } from "vitest";
import { handleFailedJob } from "./report-failed-jobs";

const step = { run: async <T>(_id: string, fn: () => Promise<T>) => fn() };

describe("report-failed-jobs", () => {
  it("reports a failed job by function and run id only, grouped per function and keyed by the run", async () => {
    const report = vi.fn(async () => true);
    const out = await handleFailedJob({ event: { data: { function_id: "pakka-agent-process-message", run_id: "01RUN", error: { message: "+919812345621 said hi" } } }, step }, report);
    expect(out).toEqual({ reported: true });
    expect(report).toHaveBeenCalledWith("Job pakka-agent-process-message failed after its retries", {
      kind: "job_failed",
      tags: { function: "pakka-agent-process-message", run: "01RUN" },
      fingerprint: ["job_failed", "pakka-agent-process-message"],
      eventKey: "job_failed:01RUN",
    });
    expect(JSON.stringify(report.mock.calls)).not.toContain("9812345621");
  });

  it("skips its own failure (no loop) and an unreadable event", async () => {
    const report = vi.fn(async () => true);
    expect(await handleFailedJob({ event: { data: { function_id: "pakka-agent-report-failed-jobs", run_id: "r" } }, step }, report)).toMatchObject({ reason: "self" });
    expect(await handleFailedJob({ event: { data: { nope: 1 } }, step }, report)).toMatchObject({ reason: "unreadable" });
    expect(report).not.toHaveBeenCalled();
  });
});
