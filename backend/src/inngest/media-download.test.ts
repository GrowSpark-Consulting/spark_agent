import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaRetryError, type DownloadOutcome } from "../media/download";
import { captureLogs, type LogCapture } from "../log-sweep/detect";
import { functions } from "./functions";
import { handleMediaDownload, mediaDownload } from "./media-download";

// media-download (Day 7, PR F): saves a customer's photo or document once the webhook has stored the message. Ids only in the event; one step that does the whole
// download (media/download.ts has the rules and their tests); one log line of words. It sends nothing to the customer.

const TENANT = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const CONV = "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f601";
const MESSAGE = "8e9f0a1b-2c3d-4e5f-8a7b-9c0d1e2f3a4b";
const data = (over: Record<string, unknown> = {}) => ({ tenantId: TENANT, conversationId: CONV, messageId: MESSAGE, ...over });
const stepper = () => {
  const ran: string[] = [];
  return { ran, step: { run: async <T>(id: string, fn: () => Promise<T>) => (ran.push(id), JSON.parse(JSON.stringify((await fn()) ?? null)) as T) } };
};

let capture: LogCapture | undefined;
afterEach(() => {
  capture?.stop();
  capture = undefined;
});

describe("running", () => {
  it("downloads for the ids in the event, in one step, and returns the outcome", async () => {
    const download = vi.fn(async (): Promise<DownloadOutcome> => ({ status: "stored" }));
    const { step, ran } = stepper();
    expect(await handleMediaDownload({ event: { data: data() }, step }, { download })).toEqual({ status: "stored" });
    expect(download).toHaveBeenCalledWith({ tenantId: TENANT, conversationId: CONV, messageId: MESSAGE });
    expect(ran).toEqual(["download"]);
  });

  // Exit test 1 (Day 7; inngest/replay-coverage.test.ts): the download itself finds a saved message done (media/download.test.ts); here, the function passes the same ids.
  it("replay: the same event twice asks for the same message both times, and the second answer is the download's 'done'", async () => {
    const outcomes: DownloadOutcome[] = [{ status: "stored" }, { status: "done" }];
    const download = vi.fn(async () => outcomes.shift() as DownloadOutcome);
    const first = await handleMediaDownload({ event: { data: data() }, step: stepper().step }, { download });
    const second = await handleMediaDownload({ event: { data: data() }, step: stepper().step }, { download });
    expect([first, second]).toEqual([{ status: "stored" }, { status: "done" }]);
    expect(download.mock.calls[0]).toEqual(download.mock.calls[1]);
  });

  it("a failure that may pass is thrown, so Inngest retries the step, and nothing is swallowed", async () => {
    const download = vi.fn(async (): Promise<DownloadOutcome> => Promise.reject(new MediaRetryError("busy")));
    await expect(handleMediaDownload({ event: { data: data() }, step: stepper().step }, { download })).rejects.toBeInstanceOf(MediaRetryError);
  });

  it("an event without the ids is refused and nothing is downloaded", async () => {
    for (const bad of [{}, null, "x", data({ tenantId: "x" }), data({ conversationId: undefined }), data({ messageId: 5 })]) {
      const download = vi.fn(async (): Promise<DownloadOutcome> => ({ status: "stored" }));
      await expect(handleMediaDownload({ event: { data: bad }, step: stepper().step }, { download })).rejects.toThrow();
      expect(download).not.toHaveBeenCalled();
    }
  });
});

describe("what it writes to the log", () => {
  it.each<[DownloadOutcome, string]>([
    [{ status: "stored" }, "[media-download] outcome=stored"],
    [{ status: "done" }, "[media-download] outcome=done"],
    [{ status: "skipped", reason: "too_big" }, "[media-download] outcome=skipped reason=too_big"],
    [{ status: "unavailable", reason: "media_gone" }, "[media-download] outcome=unavailable reason=media_gone"],
  ])("%j is one line of words", async (outcome, line) => {
    capture = captureLogs();
    await handleMediaDownload({ event: { data: data() }, step: stepper().step }, { download: async () => outcome });
    expect(capture.lines()).toEqual([line]);
  });

  it("a retry is logged by its fixed word and rethrown", async () => {
    capture = captureLogs();
    await expect(handleMediaDownload({ event: { data: data() }, step: stepper().step }, { download: async () => Promise.reject(new MediaRetryError("timeout")) })).rejects.toThrow();
    expect(capture.lines()).toEqual(["[media-download] outcome=retry reason=timeout"]);
  });

  it("another kind of failure is logged by its name only: nothing of its message", async () => {
    capture = captureLogs();
    await expect(
      handleMediaDownload({ event: { data: data() }, step: stepper().step }, { download: async () => Promise.reject(new Error("SYNTHETIC +919812345621 https://x.example.test/?token=SECRET")) }),
    ).rejects.toThrow();
    const lines = capture.lines().join("\n");
    expect(lines).toContain("[media-download] outcome=failed");
    expect(lines).not.toMatch(/SYNTHETIC|9198|SECRET|example/);
  });

  it("holds none of the ids", async () => {
    capture = captureLogs();
    await handleMediaDownload({ event: { data: data() }, step: stepper().step }, { download: async () => ({ status: "stored" }) });
    expect(capture.lines().join("\n")).not.toMatch(/5a6b7c8d|3f2a1b4c|8e9f0a1b/);
  });
});

describe("registration", () => {
  it("is served on the whatsapp/media.received event, with a few retries and a small limit on runs at once (a file is held in memory)", () => {
    expect(functions).toContain(mediaDownload);
    expect((mediaDownload as unknown as { opts: unknown }).opts).toMatchObject({ id: "media-download", triggers: [{ event: "whatsapp/media.received" }], retries: 4, concurrency: { limit: 5 } });
  });
});
