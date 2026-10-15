import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { maskPhone } from "../channels/whatsapp/phone";
import { AppError } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase-admin";
import { TimeoutError, withTimeout } from "../lib/timeout";

// The knowledge base's writes and reads of kb_documents and kb_chunks, with the service role. It bypasses
// row-level security, so every query here names its business (`tenant_id`), and the business always comes
// from a verified context (the route's token, the job's event), never from what a customer or the browser
// sent. The one exception is failStaleProcessing, a maintenance sweep across all businesses.
//
// Failures are fixed words: the log line has the Postgres code (or "timed out") and nothing else, and the
// database's own message, which can hold values and hosts, is never copied into an error or a log. Every
// call has a deadline, and the request is aborted when it passes, so a call that gave up cannot land later
// (a late chunk insert would otherwise double a retried step's chunks).

export type KbDocumentStatus = "processing" | "ready" | "failed";

export interface KbDocument {
  id: string;
  title: string | null;
  body: string | null;
  status: KbDocumentStatus;
  sourceType: string;
}

/** A FAQ as the dashboard shows it: the question (`title`), the answer (`body`) and whether it is searchable yet. */
export interface Faq {
  id: string;
  q: string;
  a: string;
  status: KbDocumentStatus;
}

/** An open knowledge-base gap, as the dashboard lists it. `lastAskedBy` is a contact's name or a masked number, or null if the contact was deleted. */
export interface OpenGap {
  id: string;
  question: string;
  askedCount: number;
  lastAskedBy: string | null;
}

export interface KbStore {
  /** A new upload for the business, `processing`, with its text. */
  insertUpload(tenantId: string, input: { title: string; body: string }): Promise<{ id: string; createdAt: string }>;
  /** A web page imported for the business (`website`, from `url`), `processing`, with its text. */
  insertWebsite(tenantId: string, input: { url: string; title: string; body: string }): Promise<{ id: string; createdAt: string }>;
  /** The business's imports of this address, oldest first. Normally one; more only if two imports ran at once. */
  findWebsiteDocuments(tenantId: string, url: string): Promise<{ id: string; status: KbDocumentStatus; createdAt: string }[]>;
  /**
   * Puts a new import of the same address in the document: new title and text, `processing` again, no error. False when it is not the business's, not a web page, or
   * still `processing` (then nothing changes: an import still running would otherwise mark the old text ready and the new text would never be read).
   */
  replaceWebsite(tenantId: string, id: string, input: { title: string; body: string }): Promise<boolean>;
  /** How many web pages the business imported since this time (the audit log's `kb.website_imported` rows). */
  countWebsiteImportsSince(tenantId: string, sinceIso: string): Promise<number>;
  /** How many uploaded or imported documents the business has (FAQs are not counted). */
  countDocuments(tenantId: string): Promise<number>;
  getDocument(tenantId: string, id: string): Promise<KbDocument | null>;
  /** `onlyIf`: change the status only while it is still that one. An error is cut to 200 characters. */
  setStatus(tenantId: string, id: string, status: KbDocumentStatus, error?: string, options?: { onlyIf?: KbDocumentStatus }): Promise<void>;
  /**
   * Replaces all of a document's chunks with these: check, delete, then insert in batches. It is not one
   * transaction, so a failure part-way leaves a partial set; that is harmless because the caller leaves the
   * document `processing` or `failed` until it succeeds, and match_kb_chunks reads only `ready` documents.
   * `document_gone`: the document is not the business's (or was deleted meanwhile), so nothing was written.
   */
  replaceChunks(tenantId: string, id: string, rows: { content: string; embedding: number[] }[]): Promise<"stored" | "document_gone">;
  /** A new FAQ (`manual`), `processing` until its chunks are stored. A question the business already has is a `conflict`. */
  insertFaq(tenantId: string, input: { q: string; a: string }): Promise<{ id: string }>;
  /** A FAQ of the business with this question (ignoring case) that is `failed`: where a second save of the same question picks up. Null when there is none. */
  findFailedFaq(tenantId: string, q: string): Promise<Faq | null>;
  /** The business's FAQ by id (never an upload), or null. */
  getFaq(tenantId: string, id: string): Promise<Faq | null>;
  /** Changes the FAQ's question and/or answer and makes it `processing` again (its chunks are old). Null when there is no such FAQ; a question another FAQ has is a `conflict`. */
  updateFaq(tenantId: string, id: string, changes: { q?: string; a?: string }): Promise<Faq | null>;
  /** Deletes a FAQ of the business (never an upload); its chunks go with it. False when there was none. */
  deleteFaq(tenantId: string, id: string): Promise<boolean>;
  /** The business's open gaps, most asked first (then most recent). */
  listOpenGaps(tenantId: string): Promise<OpenGap[]>;
  /** Closes an open (or already dismissed) gap as dismissed. False when it is not the business's, or was answered. */
  dismissGap(tenantId: string, id: string): Promise<boolean>;
  /**
   * answer_kb_gap (0012): in one transaction the FAQ is written (`processing`) and the gap closed with it. Errors:
   * not_found (not the business's gap), conflict (already answered, or the question duplicates an FAQ),
   * validation_failed (answer empty or too long, unknown user).
   */
  answerGap(tenantId: string, gapId: string, input: { answer: string; answeredBy: string }): Promise<{ faqId: string; question: string; answer: string }>;
  /** Deletes an uploaded or imported document (never an FAQ); its chunks go with it. False when there was none. */
  deleteDocument(tenantId: string, id: string): Promise<boolean>;
  /**
   * Marks uploads that have been `processing` for longer than `olderThanMs` as failed, across all
   * businesses: the ones whose job never started or never finished. Returns how many. FAQs are not swept: they are
   * embedded inside the request that saves them, and `created_at` says nothing about when an edit began.
   */
  failStaleProcessing(olderThanMs: number, error: string): Promise<number>;
}

/** Rows per insert: 100 chunks of 1000 characters and 1024 numbers is about 1 to 2 MB of JSON, within a request. */
export const CHUNK_INSERT_BATCH = 100;
/** One query. Inserts of a batch of vectors get twice as much. A call that has not answered by then is not going to. */
export const KB_DB_TIMEOUT_MS = 10_000;
const ERROR_MAX = 200;
/** The gaps list is a screen, not an export: the most asked hundred. */
export const GAP_LIST_LIMIT = 100;

const DocumentRow = z.object({
  id: z.string(),
  title: z.string().nullable(),
  body: z.string().nullable(),
  status: z.enum(["processing", "ready", "failed"]),
  source_type: z.string(),
});
const InsertedRow = z.object({ id: z.string(), created_at: z.string() });
const FaqRow = z.object({ id: z.string(), title: z.string().nullable(), body: z.string().nullable(), status: z.enum(["processing", "ready", "failed"]) });
const GapRow = z.object({
  id: z.string(),
  question: z.string(),
  asked_count: z.number().int().positive(),
  contact: z.object({ name: z.string().nullable(), phone: z.string() }).nullable(),
});
const AnsweredRow = z.array(z.object({ faq_id: z.string(), question: z.string(), answer: z.string() })).min(1);
const toFaq = (row: z.infer<typeof FaqRow>): Faq => ({ id: row.id, q: row.title ?? "", a: row.body ?? "", status: row.status });
const DUPLICATE_FAQ = "You already have a question like this. Edit the existing one instead.";

type Result = { data: unknown; error: { code?: string; message?: string } | null; count?: number | null };

export function createKbStore(db: SupabaseClient = supabaseAdmin(), { timeoutMs = KB_DB_TIMEOUT_MS }: { timeoutMs?: number } = {}): KbStore {
  /** Runs one query with a deadline, aborting it when the deadline passes. Any failure is the same fixed error. */
  async function run(op: string, query: (signal: AbortSignal) => PromiseLike<Result>, ms = timeoutMs): Promise<Result> {
    try {
      return await withTimeout(query, ms);
    } catch (error) {
      console.error(`[kb] ${op} ${error instanceof TimeoutError ? "timed out" : "threw"}`);
      throw new AppError("upstream_failed", "We couldn't reach the knowledge base just now. Try again in a moment.");
    }
  }
  const fail = (op: string, error: { code?: string }): never => {
    console.error(`[kb] ${op} failed: code ${typeof error.code === "string" ? error.code.slice(0, 16) : "none"}`);
    throw new AppError("upstream_failed", "We couldn't reach the knowledge base just now. Try again in a moment.");
  };

  return {
    async insertUpload(tenantId, { title, body }) {
      const { data, error } = await run("insert document", (signal) =>
        db.from("kb_documents").insert({ tenant_id: tenantId, source_type: "upload", title, body, status: "processing" }).select("id, created_at").abortSignal(signal).single(),
      );
      if (error) fail("insert document", error);
      const row = InsertedRow.parse(data);
      return { id: row.id, createdAt: new Date(row.created_at).toISOString() };
    },

    async insertWebsite(tenantId, { url, title, body }) {
      const { data, error } = await run("insert web page", (signal) =>
        db.from("kb_documents").insert({ tenant_id: tenantId, source_type: "website", source_url: url, title, body, status: "processing" }).select("id, created_at").abortSignal(signal).single(),
      );
      if (error) fail("insert web page", error);
      const row = InsertedRow.parse(data);
      return { id: row.id, createdAt: new Date(row.created_at).toISOString() };
    },

    async findWebsiteDocuments(tenantId, url) {
      const { data, error } = await run("find web page", (signal) =>
        db.from("kb_documents").select("id, status, created_at").eq("tenant_id", tenantId).eq("source_type", "website").eq("source_url", url).order("created_at", { ascending: true }).abortSignal(signal),
      );
      if (error) fail("find web page", error);
      return z
        .array(z.object({ id: z.string(), status: z.enum(["processing", "ready", "failed"]), created_at: z.string() }))
        .parse(data ?? [])
        .map((row) => ({ id: row.id, status: row.status, createdAt: new Date(row.created_at).toISOString() }));
    },

    async replaceWebsite(tenantId, id, { title, body }) {
      const { data, error } = await run("replace web page", (signal) =>
        db
          .from("kb_documents")
          .update({ title, body, status: "processing", error: null })
          .eq("id", id)
          .eq("tenant_id", tenantId)
          .eq("source_type", "website")
          .neq("status", "processing")
          .select("id")
          .abortSignal(signal),
      );
      if (error) fail("replace web page", error);
      return Array.isArray(data) && data.length > 0;
    },

    async countWebsiteImportsSince(tenantId, sinceIso) {
      const { count, error } = await run("count web page imports", (signal) =>
        db.from("audit_logs").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("action", "kb.website_imported").gte("created_at", sinceIso).abortSignal(signal),
      );
      if (error) fail("count web page imports", error);
      return count ?? 0;
    },

    async countDocuments(tenantId) {
      const { count, error } = await run("count documents", (signal) =>
        db.from("kb_documents").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).neq("source_type", "manual").abortSignal(signal),
      );
      if (error) fail("count documents", error);
      return count ?? 0;
    },

    async getDocument(tenantId, id) {
      const { data, error } = await run("read document", (signal) =>
        db.from("kb_documents").select("id, title, body, status, source_type").eq("id", id).eq("tenant_id", tenantId).abortSignal(signal).maybeSingle(),
      );
      if (error) fail("read document", error);
      if (data === null) return null;
      const row = DocumentRow.parse(data);
      return { id: row.id, title: row.title, body: row.body, status: row.status, sourceType: row.source_type };
    },

    async setStatus(tenantId, id, status, error, options) {
      const result = await run("set document status", (signal) => {
        let query = db
          .from("kb_documents")
          .update({ status, error: error === undefined ? null : error.slice(0, ERROR_MAX) })
          .eq("id", id)
          .eq("tenant_id", tenantId);
        if (options?.onlyIf) query = query.eq("status", options.onlyIf);
        return query.abortSignal(signal);
      });
      if (result.error) fail("set document status", result.error);
    },

    async replaceChunks(tenantId, id, rows) {
      // The document must be the business's: the chunks table only has a foreign key on the document's id,
      // so without this check a wrong pair of ids could put one business's chunks under another's document.
      const found = await run("check document", (signal) =>
        db.from("kb_documents").select("id").eq("id", id).eq("tenant_id", tenantId).abortSignal(signal).maybeSingle(),
      );
      if (found.error) fail("check document", found.error);
      if (found.data === null) return "document_gone";

      const removed = await run("delete chunks", (signal) => db.from("kb_chunks").delete().eq("document_id", id).eq("tenant_id", tenantId).abortSignal(signal));
      if (removed.error) fail("delete chunks", removed.error);

      for (let i = 0; i < rows.length; i += CHUNK_INSERT_BATCH) {
        const batch = rows.slice(i, i + CHUNK_INSERT_BATCH).map((row) => ({
          tenant_id: tenantId,
          document_id: id,
          content: row.content,
          embedding: JSON.stringify(row.embedding), // pgvector reads its text form
        }));
        const inserted = await run("insert chunks", (signal) => db.from("kb_chunks").insert(batch).abortSignal(signal), timeoutMs * 2);
        if (inserted.error) {
          // The document was deleted after the check: its chunks are gone with it, and so is the reason to store more.
          if (inserted.error.code === "23503") return "document_gone";
          fail("insert chunks", inserted.error);
        }
      }
      return "stored";
    },

    async insertFaq(tenantId, { q, a }) {
      const { data, error } = await run("insert faq", (signal) =>
        db.from("kb_documents").insert({ tenant_id: tenantId, source_type: "manual", title: q, body: a, status: "processing" }).select("id, created_at").abortSignal(signal).single(),
      );
      if (error?.code === "23505") throw new AppError("conflict", DUPLICATE_FAQ);
      if (error) fail("insert faq", error);
      return { id: InsertedRow.parse(data).id };
    },

    async getFaq(tenantId, id) {
      const { data, error } = await run("read faq", (signal) =>
        db.from("kb_documents").select("id, title, body, status").eq("id", id).eq("tenant_id", tenantId).eq("source_type", "manual").abortSignal(signal).maybeSingle(),
      );
      if (error) fail("read faq", error);
      return data === null ? null : toFaq(FaqRow.parse(data));
    },

    async findFailedFaq(tenantId, q) {
      // ilike with the question's own % _ and \ escaped, so it is an equality that ignores case, as the unique index does
      const pattern = q.replace(/[\\%_]/g, "\\$&");
      const { data, error } = await run("find failed faq", (signal) =>
        db.from("kb_documents").select("id, title, body, status").eq("tenant_id", tenantId).eq("source_type", "manual").eq("status", "failed").ilike("title", pattern).limit(1).abortSignal(signal),
      );
      if (error) fail("find failed faq", error);
      return Array.isArray(data) && data.length > 0 ? toFaq(FaqRow.parse(data[0])) : null;
    },

    async updateFaq(tenantId, id, { q, a }) {
      const { data, error } = await run("update faq", (signal) =>
        db
          .from("kb_documents")
          .update({ ...(q !== undefined && { title: q }), ...(a !== undefined && { body: a }), status: "processing", error: null })
          .eq("id", id)
          .eq("tenant_id", tenantId)
          .eq("source_type", "manual")
          .select("id, title, body, status")
          .abortSignal(signal)
          .maybeSingle(),
      );
      if (error?.code === "23505") throw new AppError("conflict", DUPLICATE_FAQ);
      if (error) fail("update faq", error);
      return data === null ? null : toFaq(FaqRow.parse(data));
    },

    async deleteFaq(tenantId, id) {
      const { data, error } = await run("delete faq", (signal) =>
        db.from("kb_documents").delete().eq("id", id).eq("tenant_id", tenantId).eq("source_type", "manual").select("id").abortSignal(signal),
      );
      if (error) fail("delete faq", error);
      return Array.isArray(data) && data.length > 0;
    },

    async listOpenGaps(tenantId) {
      const { data, error } = await run("list gaps", (signal) =>
        db
          .from("kb_gaps")
          .select("id, question, asked_count, contact:contacts!last_contact_id(name, phone)")
          .eq("tenant_id", tenantId)
          .eq("status", "open")
          .order("asked_count", { ascending: false })
          .order("last_asked_at", { ascending: false })
          .order("id")
          .limit(GAP_LIST_LIMIT)
          .abortSignal(signal),
      );
      if (error) fail("list gaps", error);
      return z.array(GapRow).parse(data ?? []).map((row) => ({
        id: row.id,
        question: row.question,
        askedCount: row.asked_count,
        lastAskedBy: row.contact === null ? null : row.contact.name?.trim() || maskPhone(row.contact.phone),
      }));
    },

    async dismissGap(tenantId, id) {
      const { data, error } = await run("dismiss gap", (signal) =>
        db.from("kb_gaps").update({ status: "dismissed" }).eq("id", id).eq("tenant_id", tenantId).in("status", ["open", "dismissed"]).select("id").abortSignal(signal),
      );
      if (error) fail("dismiss gap", error);
      return Array.isArray(data) && data.length > 0;
    },

    async answerGap(tenantId, gapId, { answer, answeredBy }) {
      const { data, error } = await run("answer gap", (signal) =>
        db.rpc("answer_kb_gap", { p_tenant_id: tenantId, p_gap_id: gapId, p_answer: answer, p_answered_by: answeredBy }).abortSignal(signal),
      );
      if (error) {
        // answer_kb_gap's own codes (0012): PA404 not this business's gap, PA409 already answered, 23505 the question
        // duplicates an FAQ, P0001 the input was refused. The words are fixed: the database's own are never shown.
        if (error.code === "PA404") throw new AppError("not_found", "That question was not found.");
        if (error.code === "PA409") throw new AppError("conflict", "This question was already answered.");
        if (error.code === "23505") throw new AppError("conflict", DUPLICATE_FAQ);
        if (error.code === "P0001") throw new AppError("validation_failed", "Check the answer and try again.", { a: "The answer must be 1 to 2000 characters." });
        fail("answer gap", error);
      }
      const row = AnsweredRow.parse(data)[0];
      return { faqId: row.faq_id, question: row.question, answer: row.answer };
    },

    async deleteDocument(tenantId, id) {
      const { data, error } = await run("delete document", (signal) =>
        db.from("kb_documents").delete().eq("id", id).eq("tenant_id", tenantId).neq("source_type", "manual").select("id").abortSignal(signal),
      );
      if (error) fail("delete document", error);
      return Array.isArray(data) && data.length > 0;
    },

    async failStaleProcessing(olderThanMs, error) {
      const cutoff = new Date(Date.now() - olderThanMs).toISOString();
      const { data, error: failure } = await run("fail stale documents", (signal) =>
        db.from("kb_documents").update({ status: "failed", error: error.slice(0, ERROR_MAX) }).eq("status", "processing").neq("source_type", "manual").lt("created_at", cutoff).select("id").abortSignal(signal),
      );
      if (failure) fail("fail stale documents", failure);
      return Array.isArray(data) ? data.length : 0;
    },
  };
}
