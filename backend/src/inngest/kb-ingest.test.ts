import type { KbStore } from "../kb/store";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The wiring of the kb-ingest job and the kb-sweep job: that they are registered, what starts it, that two events for one document
// never run together, and the last-resort handler. What the job does is tested in kb/ingest.test.ts.

const setStatus = vi.fn(async () => undefined);
const failStaleProcessing = vi.fn<KbStore["failStaleProcessing"]>(async () => 2);
vi.mock("../kb/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../kb/store")>()),
  createKbStore: () => ({ setStatus, failStaleProcessing }),
}));

const { kbIngest } = await import("./kb-ingest");
const { kbSweep, sweepStaleDocuments } = await import("./kb-sweep");
const { functions } = await import("./functions");

const A = "e0000000-0000-0000-0000-00000000000a";
const DOC = "e2000000-0000-0000-0000-0000000000a1";

beforeEach(() => setStatus.mockClear());

describe("kb-ingest", () => {
  it("is registered with the one Inngest endpoint, with the sweep", () => {
    expect(functions).toContain(kbIngest);
    expect(functions).toContain(kbSweep);
  });

  it("starts on kb/document.uploaded, one run at a time per document, with 3 retries", () => {
    const opts = kbIngest.opts as unknown as Record<string, unknown>;
    expect(opts.id).toBe("kb-ingest");
    expect(opts.triggers).toEqual([{ event: "kb/document.uploaded" }]);
    // one run per document at a time, and at most 5 documents at once in all
    expect(opts.concurrency).toEqual([{ key: "event.data.documentId", limit: 1 }, { limit: 5 }]);
    expect(opts.timeouts).toEqual({ finish: "15m" });
    expect(opts.retries).toBe(3);
  });

  describe("when a run ends in a way the body did not handle", () => {
    const onFailure = () => (kbIngest.opts as unknown as { onFailure: (args: unknown) => Promise<void> }).onFailure;
    const failureEvent = (data: unknown) => ({ event: { data: { event: { name: "kb/document.uploaded", data } } }, error: new Error("boom 10.0.0.5 sk-secret") });

    it("marks a document that is still processing as failed, in fixed words", async () => {
      await onFailure()(failureEvent({ tenantId: A, documentId: DOC }));
      expect(setStatus).toHaveBeenCalledOnce();
      const [tenantId, documentId, status, message, options] = setStatus.mock.calls[0] as unknown as [string, string, string, string, unknown];
      expect([tenantId, documentId, status]).toEqual([A, DOC, "failed"]);
      expect(message).not.toMatch(/10\.0\.0\.5|sk-secret|boom/);
      expect(options).toEqual({ onlyIf: "processing" });
    });

    it("does nothing for an event it cannot read", async () => {
      await onFailure()(failureEvent({ tenantId: "x", documentId: DOC }));
      await onFailure()(failureEvent(undefined));
      expect(setStatus).not.toHaveBeenCalled();
    });
  });
});

describe("kb-sweep", () => {
  it("runs hourly (the Inngest free plan's idle budget, docs/job-schedules.md)", () => {
    expect((kbSweep.opts as unknown as { triggers: unknown }).triggers).toEqual([{ cron: "0 * * * *" }]);
  });

  it("fails documents that have been processing for over 30 minutes, with a plain message, and says how many", async () => {
    failStaleProcessing.mockClear();
    const result = await sweepStaleDocuments();
    expect(result).toEqual({ failed: 2 });
    expect(failStaleProcessing).toHaveBeenCalledOnce();
    const [olderThanMs, message] = failStaleProcessing.mock.calls[0];
    expect(olderThanMs).toBe(30 * 60_000);
    expect(olderThanMs).toBeGreaterThan(15 * 60_000); // longer than the ingest job's own limit, so a running job is never swept
    expect(message).toMatch(/upload it again/i);
  });
});
