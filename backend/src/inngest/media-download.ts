import { errorKind } from "../lib/errors";
import { downloadMessageMedia, MediaRetryError, type DownloadOutcome } from "../media/download";
import { realDownloadDeps } from "../media/db";
import { MEDIA_RECEIVED_EVENT, MediaReceivedEvent } from "../media/event";
import { inngest } from "./client";

// media-download (Day 7, PR F): keeps a customer's photo or document in the private bucket once the webhook has stored the message (media/download.ts has the
// rules). The event holds ids only. One step does the whole download, so a retry repeats it from the top: it is safe, because a message that already has its file
// is left alone and the upload is an overwrite of a fixed path. It sends nothing to the customer and never touches the reply. The log line is words only.

export { MEDIA_RECEIVED_EVENT };

interface Step {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

export interface MediaDownloadDeps {
  download: (ids: MediaReceivedEvent) => Promise<DownloadOutcome>;
}

const defaults = (): MediaDownloadDeps => ({ download: (ids) => downloadMessageMedia(ids, realDownloadDeps()) });

export async function handleMediaDownload({ event, step }: { event: { data: unknown }; step: Step }, deps: MediaDownloadDeps = defaults()): Promise<DownloadOutcome> {
  const ids = MediaReceivedEvent.parse(event.data);
  try {
    const outcome = await step.run("download", () => deps.download(ids));
    console.log(`[media-download] outcome=${outcome.status}${"reason" in outcome ? ` reason=${outcome.reason}` : ""}`);
    return outcome;
  } catch (err) {
    console.log(err instanceof MediaRetryError ? `[media-download] outcome=retry reason=${err.reason}` : `[media-download] outcome=failed kind=${errorKind(err)}`);
    throw err;
  }
}

export const mediaDownload = inngest.createFunction(
  { id: "media-download", triggers: [{ event: MEDIA_RECEIVED_EVENT }], retries: 4, concurrency: { limit: 5 } },
  (ctx) => handleMediaDownload({ event: ctx.event, step: { run: <T>(id: string, fn: () => Promise<T>) => ctx.step.run(id, fn) as unknown as Promise<T> } }),
);
