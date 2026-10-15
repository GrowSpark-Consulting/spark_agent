import { NonRetriableError } from "inngest";
import { AppError } from "../lib/errors";
import { chunkText } from "./chunk";
import { EMBED_BATCH_SIZE, embedBatch, storeChunks } from "./embed-store";
import { EmbeddingsError, embeddingsClient } from "./embeddings";
import { KbUploadedData } from "./events";
import { createKbStore, type KbStore } from "./store";

// The body of the kb-ingest job (inngest/kb-ingest.ts): turns an uploaded document's text into searchable
// chunks. It is written against a minimal `step.run`, so it is tested without Inngest, and it is the one
// place that knows the order: load, embed in batches (one step each, so a failing batch is retried alone and
// the batches already done are not paid for again), then replace the chunks and mark the document ready.
//
// Idempotent: the same event twice changes nothing (a ready document is left alone; the event's fixed id
// only drops a repeat for a day or so, so this skip is the real guarantee), a run that is repeated after a
// step repeats nothing that finished (Inngest remembers each step's result), and the chunks are replaced,
// never added to. While a document is `processing` or `failed`, match_kb_chunks does not read it, so the
// moment between deleting the old chunks and inserting the new ones is invisible to customers.
//
// What a step returns is kept small: 32 chunks of 1024 numbers is about 300 to 400 KB of JSON per embed step,
// and a 500-chunk document about 6 MB in all, well inside Inngest's limits for a step's output and a run's state.

export interface StepRunner {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

export interface IngestDeps {
  store: KbStore;
  /** Vectors for these texts, in order. */
  embed: (texts: string[]) => Promise<number[][]>;
}

/** Chunks per embed step. The provider takes more, but a step's answer is memoized, so it is kept small. */
export const INGEST_BATCH_SIZE = EMBED_BATCH_SIZE;
/** A document `processing` for longer than this never had a job finish it (the job's own limit is 15 minutes). */
export const STALE_PROCESSING_MS = 30 * 60_000;
export const STALE_PROCESSING_MESSAGE = "This file took too long to process. Upload it again.";

export type IngestFailure = "no_text" | "too_long" | "embeddings_rejected";
export type IngestResult =
  | { status: "ready"; chunks: number }
  | { status: "skipped"; reason: "not_found" | "not_an_upload" | "already_ready" | "document_gone" }
  | { status: "failed"; reason: IngestFailure };

const defaults = (): IngestDeps => ({ store: createKbStore(), embed: (texts) => embeddingsClient().embedDocuments(texts) });

// What the document's `error` column says for each failure the job knows. Fixed words, written to be shown.
const FAILURE_MESSAGE: Record<IngestFailure, string> = {
  no_text: "This document has no text to learn from.",
  too_long: "This file has too much text for the knowledge base. Split it into smaller files.",
  embeddings_rejected: "We couldn't process this file. Try again later, or contact support if it keeps happening.",
};
const GENERIC_FAILURE = "We couldn't process this file. Upload it again.";

// A failure nobody planned for (a step that ran out of retries) reaches the job's body as a plain error. The
// message is shown only when the error says by its name that it is one of ours: AppError (safe to show by
// contract) or EmbeddingsError (fixed words). If a name is lost on the way, the generic message is the result,
// which is safe; the failures that matter most do not depend on this (they are results, above).
const SAFE_NAMES = new Set(["AppError", "EmbeddingsError"]);

/** What the document's `error` column says when the job fails unexpectedly: short, plain, never the raw error. */
export function failureMessage(error: unknown): string {
  if (error instanceof Error && SAFE_NAMES.has(error.name) && error.message) return error.message.slice(0, 200);
  return GENERIC_FAILURE;
}

type Loaded = { skip: Extract<IngestResult, { status: "skipped" }>["reason"] } | { fail: IngestFailure } | { chunks: string[] };
type Embedded = { fail: IngestFailure } | { vectors: number[][] };

/** A provider answer that says our request was wrong (a rejected key or input): trying again cannot help. */
const isRejection = (error: unknown) =>
  error instanceof EmbeddingsError && error.upstreamStatus !== undefined && error.upstreamStatus >= 400 && error.upstreamStatus < 500 && error.upstreamStatus !== 408 && error.upstreamStatus !== 429;

export async function runIngest(step: StepRunner, rawEvent: unknown, deps: IngestDeps = defaults()): Promise<IngestResult> {
  const parsed = KbUploadedData.safeParse(rawEvent);
  if (!parsed.success) throw new NonRetriableError("The ingest event is not valid.");
  const { tenantId, documentId } = parsed.data;
  const { store, embed } = deps;

  /** Records why the job ended on the document, then ends the run. A known reason ends it successfully (nothing to retry). */
  async function recordFailure(message: string): Promise<void> {
    await step.run("mark-failed", () => store.setStatus(tenantId, documentId, "failed", message));
  }
  async function unexpected(error: unknown): Promise<never> {
    const message = failureMessage(error);
    await recordFailure(message);
    throw new NonRetriableError(message); // the run shows as failed: this one is ours to look at
  }

  let loaded: Loaded;
  try {
    loaded = await step.run<Loaded>("load", async () => {
      const doc = await store.getDocument(tenantId, documentId);
      if (!doc) return { skip: "not_found" };
      if (doc.sourceType !== "upload" && doc.sourceType !== "website") return { skip: "not_an_upload" }; // an uploaded file or an imported web page; an FAQ is embedded by its own route
      if (doc.status === "ready") return { skip: "already_ready" };
      if (!doc.body?.trim()) return { fail: "no_text" };
      let chunks: string[];
      try {
        chunks = chunkText(doc.body);
      } catch (error) {
        if (error instanceof AppError) return { fail: "too_long" }; // waiting will not shorten it
        throw error;
      }
      if (doc.status === "failed") await store.setStatus(tenantId, documentId, "processing"); // a document being tried again
      return { chunks };
    });
  } catch (error) {
    return unexpected(error);
  }
  if ("skip" in loaded) return { status: "skipped", reason: loaded.skip };
  if ("fail" in loaded) {
    await recordFailure(FAILURE_MESSAGE[loaded.fail]);
    return { status: "failed", reason: loaded.fail };
  }

  try {
    const texts = loaded.chunks;
    const vectors: number[][] = [];
    for (let start = 0, batch = 0; start < texts.length; start += INGEST_BATCH_SIZE, batch++) {
      const slice = texts.slice(start, start + INGEST_BATCH_SIZE);
      const embedded = await step.run<Embedded>(`embed-${batch}`, async () => {
        try {
          return { vectors: await embedBatch(embed, slice) }; // refuses a wrong-length answer: never saved against the wrong text
        } catch (error) {
          if (isRejection(error)) return { fail: "embeddings_rejected" }; // a rejected key or input: not retried
          throw error; // an outage or rate limit: the step is retried, with Inngest's own spacing
        }
      });
      if ("fail" in embedded) {
        await recordFailure(FAILURE_MESSAGE[embedded.fail]);
        return { status: "failed", reason: embedded.fail };
      }
      vectors.push(...embedded.vectors);
    }

    const stored = await step.run("store", async () => {
      return storeChunks(store, tenantId, documentId, texts, vectors);
    });
    return stored === "stored" ? { status: "ready", chunks: texts.length } : { status: "skipped", reason: "document_gone" };
  } catch (error) {
    return unexpected(error);
  }
}
