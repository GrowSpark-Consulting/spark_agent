import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../lib/errors";
import { CHUNK_INSERT_BATCH, createKbStore } from "./store";

// The service-role queries of the knowledge base. The client is a recorder that answers with what each
// test says, so what is sent can be checked without a database: every query names its business, errors
// carry nothing the database said, and a call that never answers ends.

const A = "e0000000-0000-0000-0000-00000000000a";
const DOC = "e2000000-0000-0000-0000-0000000000a1";
const FAQ_ID = "f0000000-0000-0000-0000-0000000000f2";

type Answer = { data?: unknown; error?: { code?: string; message: string } | null; count?: number };
interface Call {
  table: string;
  op: "select" | "insert" | "update" | "delete" | "rpc";
  /** rpc: the function and its arguments */
  fn?: string;
  args?: Record<string, unknown>;
  order?: [string, boolean][];
  limit?: number;
  payload?: unknown;
  returning?: string;
  filters: [string, "eq" | "neq" | "lt" | "gte" | "in" | "ilike", unknown][];
  terminal?: string;
  /** The signal the query was given, if any: the store must pass one so a call that gave up can be cancelled. */
  signal?: AbortSignal;
  selectOptions?: unknown;
}

function fakeDb(answer: (call: Call) => Answer | Promise<Answer>) {
  const calls: Call[] = [];
  const db = {
    rpc(fn: string, args: Record<string, unknown>) {
      const call: Call = { table: "", op: "rpc", filters: [], fn, args };
      const builder: Record<string, unknown> = {
        abortSignal: (signal: AbortSignal) => ((call.signal = signal), builder),
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
          calls.push(call);
          return Promise.resolve(answer(call)).then((a) => ({ data: a.data ?? null, error: a.error ?? null, count: a.count ?? null }), reject).then(resolve, reject);
        },
      };
      return builder;
    },
    from(table: string) {
      const call: Call = { table, op: "select", filters: [] };
      let opSet = false;
      const setOp = (op: Call["op"], payload?: unknown) => {
        if (!opSet) {
          call.op = op;
          call.payload = payload;
          opSet = true;
        }
      };
      const builder: Record<string, unknown> = {
        select: (columns?: string, options?: unknown) => ((call.returning = columns ?? "*"), (call.selectOptions = options), (opSet ||= (setOp("select"), true)), builder),
        abortSignal: (signal: AbortSignal) => ((call.signal = signal), builder),
        lt: (column: string, value: unknown) => (call.filters.push([column, "lt", value]), builder),
        gte: (column: string, value: unknown) => (call.filters.push([column, "gte", value]), builder),
        insert: (payload: unknown) => (setOp("insert", payload), builder),
        update: (payload: unknown) => (setOp("update", payload), builder),
        delete: () => (setOp("delete"), builder),
        eq: (column: string, value: unknown) => (call.filters.push([column, "eq", value]), builder),
        neq: (column: string, value: unknown) => (call.filters.push([column, "neq", value]), builder),
        in: (column: string, value: unknown) => (call.filters.push([column, "in", value]), builder),
        ilike: (column: string, value: unknown) => (call.filters.push([column, "ilike", value]), builder),
        order: (column: string, options?: { ascending?: boolean }) => ((call.order = [...(call.order ?? []), [column, options?.ascending ?? true]]), builder),
        limit: (n: number) => ((call.limit = n), builder),
        single: () => ((call.terminal = "single"), builder),
        maybeSingle: () => ((call.terminal = "maybeSingle"), builder),
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
          calls.push(call);
          return Promise.resolve(answer(call)).then((a) => ({ data: a.data ?? null, error: a.error ?? null, count: a.count ?? null }), reject).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return { db: db as unknown as SupabaseClient, calls };
}

const filterOf = (call: Call, column: string) => call.filters.find(([c]) => c === column);
const expectTenantFilter = (call: Call) => expect(filterOf(call, "tenant_id"), `${call.op} on ${call.table} filters by tenant`).toEqual(["tenant_id", "eq", A]);

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("insertUpload", () => {
  it("makes a processing upload for the business and gives back its id and time", async () => {
    const { db, calls } = fakeDb(() => ({ data: { id: DOC, created_at: "2026-10-08T10:00:00+00:00" } }));
    const result = await createKbStore(db).insertUpload(A, { title: "Brochure", body: "Some text" });
    expect(result).toEqual({ id: DOC, createdAt: "2026-10-08T10:00:00.000Z" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      table: "kb_documents",
      op: "insert",
      payload: { tenant_id: A, source_type: "upload", title: "Brochure", body: "Some text", status: "processing" },
      terminal: "single",
    });
  });

  it("fails in fixed words, logging the code only, when the database refuses", async () => {
    const { db } = fakeDb(() => ({ error: { code: "23505", message: 'duplicate key value violates "kb_documents_pkey" (title=Brochure secret)' } }));
    const error = (await createKbStore(db).insertUpload(A, { title: "Brochure", body: "x" }).catch((e: unknown) => e)) as AppError;
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("upstream_failed");
    expect(error.message).not.toMatch(/duplicate|pkey|secret/);
    const logged = vi.mocked(console.error).mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("23505");
    expect(logged).not.toMatch(/duplicate|pkey|Brochure|secret/);
  });

  it("refuses an answer that is not a row", async () => {
    const { db } = fakeDb(() => ({ data: { id: "nope" } }));
    await expect(createKbStore(db).insertUpload(A, { title: "t", body: "b" })).rejects.toThrow();
  });
});

describe("web pages", () => {
  const URL_A = "https://www.example.com/about";

  it("insertWebsite makes a processing web page for the business, with its address, title and text, and gives back its id and time", async () => {
    const { db, calls } = fakeDb(() => ({ data: { id: DOC, created_at: "2026-10-15T10:00:00+00:00" } }));
    expect(await createKbStore(db).insertWebsite(A, { url: URL_A, title: "About us", body: "Some words" })).toEqual({ id: DOC, createdAt: "2026-10-15T10:00:00.000Z" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      table: "kb_documents",
      op: "insert",
      payload: { tenant_id: A, source_type: "website", source_url: URL_A, title: "About us", body: "Some words", status: "processing" },
      terminal: "single",
    });
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("findWebsiteDocuments reads the business's imports of one address, oldest first, and only web pages", async () => {
    const { db, calls } = fakeDb(() => ({
      data: [
        { id: DOC, status: "ready", created_at: "2026-10-01T10:00:00+00:00" },
        { id: FAQ_ID, status: "processing", created_at: "2026-10-02T10:00:00+00:00" },
      ],
    }));
    expect(await createKbStore(db).findWebsiteDocuments(A, URL_A)).toEqual([
      { id: DOC, status: "ready", createdAt: "2026-10-01T10:00:00.000Z" },
      { id: FAQ_ID, status: "processing", createdAt: "2026-10-02T10:00:00.000Z" },
    ]);
    expect(calls[0]).toMatchObject({ table: "kb_documents", op: "select", order: [["created_at", true]] });
    expectTenantFilter(calls[0]);
    expect(filterOf(calls[0], "source_type")).toEqual(["source_type", "eq", "website"]);
    expect(filterOf(calls[0], "source_url")).toEqual(["source_url", "eq", URL_A]);
  });

  it("findWebsiteDocuments is an empty list when there is none, and refuses an answer that is not rows", async () => {
    expect(await createKbStore(fakeDb(() => ({ data: [] })).db).findWebsiteDocuments(A, URL_A)).toEqual([]);
    expect(await createKbStore(fakeDb(() => ({})).db).findWebsiteDocuments(A, URL_A)).toEqual([]);
    await expect(createKbStore(fakeDb(() => ({ data: [{ id: 5 }] })).db).findWebsiteDocuments(A, URL_A)).rejects.toThrow();
  });

  it("replaceWebsite puts the new title and text in the business's web page, processing again with no error, only if it is not processing now, and says so", async () => {
    const { db, calls } = fakeDb(() => ({ data: [{ id: DOC }] }));
    expect(await createKbStore(db).replaceWebsite(A, DOC, { title: "New", body: "New words" })).toBe(true);
    expect(calls[0]).toMatchObject({ table: "kb_documents", op: "update", payload: { title: "New", body: "New words", status: "processing", error: null }, returning: "id" });
    expect(filterOf(calls[0], "id")).toEqual(["id", "eq", DOC]);
    expect(filterOf(calls[0], "source_type")).toEqual(["source_type", "eq", "website"]);
    expect(filterOf(calls[0], "status")).toEqual(["status", "neq", "processing"]);
    expectTenantFilter(calls[0]);
  });

  it("replaceWebsite says false when nothing matched (another business's, not a web page, or still processing)", async () => {
    expect(await createKbStore(fakeDb(() => ({ data: [] })).db).replaceWebsite(A, DOC, { title: "t", body: "b" })).toBe(false);
    expect(await createKbStore(fakeDb(() => ({})).db).replaceWebsite(A, DOC, { title: "t", body: "b" })).toBe(false);
  });

  it("countWebsiteImportsSince counts the business's kb.website_imported audit rows from a time, without reading them", async () => {
    const { db, calls } = fakeDb(() => ({ count: 4 }));
    expect(await createKbStore(db).countWebsiteImportsSince(A, "2026-10-15T09:00:00.000Z")).toBe(4);
    expect(calls[0]).toMatchObject({ table: "audit_logs", op: "select", selectOptions: { count: "exact", head: true } });
    expectTenantFilter(calls[0]);
    expect(filterOf(calls[0], "action")).toEqual(["action", "eq", "kb.website_imported"]);
    expect(filterOf(calls[0], "created_at")).toEqual(["created_at", "gte", "2026-10-15T09:00:00.000Z"]);
    expect(await createKbStore(fakeDb(() => ({})).db).countWebsiteImportsSince(A, "x")).toBe(0);
  });

  it.each([
    ["insertWebsite", (store: ReturnType<typeof createKbStore>) => store.insertWebsite(A, { url: URL_A, title: "t", body: "b" })],
    ["findWebsiteDocuments", (store: ReturnType<typeof createKbStore>) => store.findWebsiteDocuments(A, URL_A)],
    ["replaceWebsite", (store: ReturnType<typeof createKbStore>) => store.replaceWebsite(A, DOC, { title: "t", body: "b" })],
    ["countWebsiteImportsSince", (store: ReturnType<typeof createKbStore>) => store.countWebsiteImportsSince(A, "2026-10-15T09:00:00.000Z")],
  ])("%s fails in fixed words, logging the code only, when the database refuses", async (_name, call) => {
    const { db } = fakeDb(() => ({ error: { code: "57014", message: "canceling statement for https://secret.example/page?token=abc" } }));
    const error = (await call(createKbStore(db)).catch((e: unknown) => e)) as AppError;
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("upstream_failed");
    expect(error.message).not.toMatch(/canceling|secret|token/);
    const logged = vi.mocked(console.error).mock.calls.map((c) => String(c[0])).join(" | ");
    expect(logged).toContain("57014");
    expect(logged).not.toMatch(/canceling|secret|token/);
  });
});

describe("getDocument", () => {
  const row = { id: DOC, title: "Brochure", body: "text", status: "processing", source_type: "upload" };

  it("reads one document of the business by id, with its status and text", async () => {
    const { db, calls } = fakeDb(() => ({ data: row }));
    expect(await createKbStore(db).getDocument(A, DOC)).toEqual({ id: DOC, title: "Brochure", body: "text", status: "processing", sourceType: "upload" });
    expect(calls[0]).toMatchObject({ table: "kb_documents", op: "select", terminal: "maybeSingle" });
    expect(filterOf(calls[0], "id")).toEqual(["id", "eq", DOC]);
    expectTenantFilter(calls[0]);
  });

  it("answers null when there is no such document for the business", async () => {
    const { db } = fakeDb(() => ({ data: null }));
    expect(await createKbStore(db).getDocument(A, DOC)).toBeNull();
  });

  it("refuses a row with a status it does not know", async () => {
    const { db } = fakeDb(() => ({ data: { ...row, status: "done" } }));
    await expect(createKbStore(db).getDocument(A, DOC)).rejects.toThrow();
  });
});

describe("setStatus", () => {
  it("updates the status and error of one document of the business", async () => {
    const { db, calls } = fakeDb(() => ({}));
    await createKbStore(db).setStatus(A, DOC, "failed", "It broke");
    expect(calls[0]).toMatchObject({ table: "kb_documents", op: "update", payload: { status: "failed", error: "It broke" } });
    expect(filterOf(calls[0], "id")).toEqual(["id", "eq", DOC]);
    expectTenantFilter(calls[0]);
  });

  it("clears the error when the document becomes ready", async () => {
    const { db, calls } = fakeDb(() => ({}));
    await createKbStore(db).setStatus(A, DOC, "ready");
    expect(calls[0].payload).toEqual({ status: "ready", error: null });
  });

  it("can be limited to a document that is still in the status the caller expects", async () => {
    const { db, calls } = fakeDb(() => ({}));
    await createKbStore(db).setStatus(A, DOC, "failed", "x", { onlyIf: "processing" });
    expect(filterOf(calls[0], "status")).toEqual(["status", "eq", "processing"]);
  });

  it("cuts an error to 200 characters", async () => {
    const { db, calls } = fakeDb(() => ({}));
    await createKbStore(db).setStatus(A, DOC, "failed", "x".repeat(500));
    expect((calls[0].payload as { error: string }).error).toHaveLength(200);
  });
});

describe("replaceChunks", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ content: `chunk ${i}`, embedding: [i, 0.5, -1] }));
  const present = (call: Call) => (call.table === "kb_documents" ? { data: { id: DOC } } : {});

  it("checks the document belongs to the business, deletes its old chunks, then inserts the new ones with vectors as text", async () => {
    const { db, calls } = fakeDb(present);
    expect(await createKbStore(db).replaceChunks(A, DOC, rows(2))).toBe("stored");
    expect(calls.map((c) => `${c.op} ${c.table}`)).toEqual(["select kb_documents", "delete kb_chunks", "insert kb_chunks"]);
    for (const call of calls.filter((c) => c.op !== "insert")) expectTenantFilter(call); // an insert names its business in each row, below
    expect(filterOf(calls[1], "document_id")).toEqual(["document_id", "eq", DOC]);
    expect(calls[2].payload).toEqual([
      { tenant_id: A, document_id: DOC, content: "chunk 0", embedding: "[0,0.5,-1]" },
      { tenant_id: A, document_id: DOC, content: "chunk 1", embedding: "[1,0.5,-1]" },
    ]);
  });

  it("inserts in batches", async () => {
    const { db, calls } = fakeDb(present);
    await createKbStore(db).replaceChunks(A, DOC, rows(CHUNK_INSERT_BATCH * 2 + 5));
    const inserts = calls.filter((c) => c.op === "insert");
    expect(inserts.map((c) => (c.payload as unknown[]).length)).toEqual([CHUNK_INSERT_BATCH, CHUNK_INSERT_BATCH, 5]);
  });

  it("does nothing when the document is not the business's (or is gone): no delete, no insert", async () => {
    const { db, calls } = fakeDb((call) => (call.table === "kb_documents" ? { data: null } : {}));
    expect(await createKbStore(db).replaceChunks(A, DOC, rows(3))).toBe("document_gone");
    expect(calls.map((c) => c.op)).toEqual(["select"]);
  });

  it("says the document is gone when it is deleted between the check and the insert", async () => {
    const { db } = fakeDb((call) => (call.op === "insert" ? { error: { code: "23503", message: "violates foreign key kb_chunks_document_id_fkey" } } : present(call)));
    expect(await createKbStore(db).replaceChunks(A, DOC, rows(2))).toBe("document_gone");
  });

  it("fails in fixed words on any other database error", async () => {
    const { db } = fakeDb((call) => (call.op === "insert" ? { error: { code: "22000", message: "vector must have 1024 dimensions, got 3" } } : present(call)));
    const error = (await createKbStore(db).replaceChunks(A, DOC, rows(1)).catch((e: unknown) => e)) as AppError;
    expect(error).toBeInstanceOf(AppError);
    expect(error.message).not.toMatch(/1024|dimensions/);
  });
});

describe("deleteDocument", () => {
  it("deletes one upload of the business, never an FAQ, and says whether there was one", async () => {
    const { db, calls } = fakeDb(() => ({ data: [{ id: DOC }] }));
    expect(await createKbStore(db).deleteDocument(A, DOC)).toBe(true);
    expect(calls[0]).toMatchObject({ table: "kb_documents", op: "delete", returning: "id" });
    expect(filterOf(calls[0], "id")).toEqual(["id", "eq", DOC]);
    expect(filterOf(calls[0], "source_type")).toEqual(["source_type", "neq", "manual"]);
    expectTenantFilter(calls[0]);
  });

  it("says false when nothing matched", async () => {
    const { db } = fakeDb(() => ({ data: [] }));
    expect(await createKbStore(db).deleteDocument(A, DOC)).toBe(false);
  });
});

describe("countDocuments", () => {
  it("counts the business's uploaded and imported documents, never its FAQs, without reading any rows", async () => {
    const { db, calls } = fakeDb(() => ({ count: 7 }));
    expect(await createKbStore(db).countDocuments(A)).toBe(7);
    expect(calls[0]).toMatchObject({ table: "kb_documents", op: "select", selectOptions: { count: "exact", head: true } });
    expectTenantFilter(calls[0]);
    expect(filterOf(calls[0], "source_type")).toEqual(["source_type", "neq", "manual"]);
  });

  it("is 0 when the database gives no count", async () => {
    const { db } = fakeDb(() => ({}));
    expect(await createKbStore(db).countDocuments(A)).toBe(0);
  });
});

describe("failStaleProcessing", () => {
  it("fails the documents still processing after the cutoff, across businesses, and says how many", async () => {
    const { db, calls } = fakeDb(() => ({ data: [{ id: "a" }, { id: "b" }] }));
    const before = Date.now();
    expect(await createKbStore(db).failStaleProcessing(30 * 60_000, "Took too long")).toBe(2);
    expect(calls[0]).toMatchObject({ table: "kb_documents", op: "update", payload: { status: "failed", error: "Took too long" }, returning: "id" });
    expect(filterOf(calls[0], "status")).toEqual(["status", "eq", "processing"]);
    expect(filterOf(calls[0], "source_type")).toEqual(["source_type", "neq", "manual"]); // FAQs are embedded in their request: never swept
    const cutoff = Date.parse(String(filterOf(calls[0], "created_at")?.[2]));
    expect(cutoff).toBeLessThanOrEqual(before - 30 * 60_000 + 1000);
    expect(cutoff).toBeGreaterThan(before - 30 * 60_000 - 5000);
    expect(filterOf(calls[0], "tenant_id")).toBeUndefined(); // the one sweep that is not for one business
  });
});

describe("every call can be cancelled", () => {
  it("passes an abort signal to each query, and aborts it when the deadline passes", async () => {
    let seen: AbortSignal | undefined;
    const { db } = fakeDb((call) => {
      seen = call.signal;
      return new Promise<never>(() => undefined);
    });
    await createKbStore(db, { timeoutMs: 20 }).getDocument(A, DOC).catch(() => undefined);
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(true);
  });

  it("does so for every kind of query", async () => {
    const { db, calls } = fakeDb((call) => (call.table === "kb_documents" && call.op === "select" && call.terminal ? { data: { id: DOC } } : { data: [{ id: DOC }], count: 1 }));
    const store = createKbStore(db);
    await store.insertUpload(A, { title: "t", body: "b" }).catch(() => undefined);
    await store.countDocuments(A);
    await store.setStatus(A, DOC, "ready");
    await store.replaceChunks(A, DOC, [{ content: "c", embedding: [1] }]);
    await store.deleteDocument(A, DOC);
    await store.failStaleProcessing(1000, "x");
    expect(calls.length).toBeGreaterThanOrEqual(8);
    for (const call of calls) expect(call.signal, `${call.op} ${call.table}`).toBeInstanceOf(AbortSignal);
  });
});

describe("a call that never answers", () => {
  it("ends with a fixed upstream_failed instead of hanging the request or the job", async () => {
    const { db } = fakeDb(() => new Promise<never>(() => undefined));
    const error = (await createKbStore(db, { timeoutMs: 20 }).getDocument(A, DOC).catch((e: unknown) => e)) as AppError;
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("upstream_failed");
    expect(String(vi.mocked(console.error).mock.calls.at(-1)?.[0])).toMatch(/timed out/);
  });
});

describe("FAQs", () => {
  const FAQ = "f0000000-0000-0000-0000-0000000000f1";
  const faqRow = { id: FAQ, title: "Is there parking?", body: "Yes", status: "ready" };

  it("insertFaq makes a manual, processing document for the business", async () => {
    const { db, calls } = fakeDb(() => ({ data: { id: FAQ, created_at: "2026-10-09T10:00:00+00:00" } }));
    expect(await createKbStore(db).insertFaq(A, { q: "Is there parking?", a: "Yes" })).toEqual({ id: FAQ });
    expect(calls[0]).toMatchObject({ table: "kb_documents", op: "insert", payload: { tenant_id: A, source_type: "manual", title: "Is there parking?", body: "Yes", status: "processing" } });
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("insertFaq answers conflict for a question the business already has (23505), in fixed words", async () => {
    const { db } = fakeDb(() => ({ error: { code: "23505", message: 'duplicate key value violates "kb_documents_faq_question_idx" (Is there parking?)' } }));
    const error = (await createKbStore(db).insertFaq(A, { q: "Is there parking?", a: "Yes" }).catch((e: unknown) => e)) as AppError;
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("conflict");
    expect(error.message).not.toMatch(/duplicate|idx|parking/i);
  });

  it("insertFaq fails with fixed upstream_failed words for any other error", async () => {
    const { db } = fakeDb(() => ({ error: { code: "XX000", message: "secret" } }));
    const error = (await createKbStore(db).insertFaq(A, { q: "Q", a: "A" }).catch((e: unknown) => e)) as AppError;
    expect(error.code).toBe("upstream_failed");
    expect(error.message).not.toMatch(/secret/);
  });

  it("findFailedFaq finds a failed FAQ of the business by its question, ignoring case, with LIKE characters escaped", async () => {
    const { db, calls } = fakeDb(() => ({ data: [{ ...faqRow, status: "failed" }] }));
    expect(await createKbStore(db).findFailedFaq(A, "100% sure_thing?")).toEqual({ id: FAQ, q: "Is there parking?", a: "Yes", status: "failed" });
    expectTenantFilter(calls[0]);
    expect(filterOf(calls[0], "status")).toEqual(["status", "eq", "failed"]);
    expect(filterOf(calls[0], "source_type")).toEqual(["source_type", "eq", "manual"]);
    expect(calls[0].filters).toContainEqual(["title", "ilike", "100\\% sure\\_thing?"]);
    expect(await createKbStore(fakeDb(() => ({ data: [] })).db).findFailedFaq(A, "x")).toBeNull();
  });

  it("getFaq reads one manual document of the business", async () => {
    const { db, calls } = fakeDb(() => ({ data: faqRow }));
    expect(await createKbStore(db).getFaq(A, FAQ)).toEqual({ id: FAQ, q: "Is there parking?", a: "Yes", status: "ready" });
    expectTenantFilter(calls[0]);
    expect(filterOf(calls[0], "id")).toEqual(["id", "eq", FAQ]);
    expect(filterOf(calls[0], "source_type")).toEqual(["source_type", "eq", "manual"]);
  });

  it("getFaq answers null when there is none", async () => {
    expect(await createKbStore(fakeDb(() => ({ data: null })).db).getFaq(A, FAQ)).toBeNull();
  });

  it("updateFaq writes only what changed, makes the FAQ processing again, and filters by business, id and manual", async () => {
    const { db, calls } = fakeDb(() => ({ data: { ...faqRow, body: "No", status: "processing" } }));
    expect(await createKbStore(db).updateFaq(A, FAQ, { a: "No" })).toEqual({ id: FAQ, q: "Is there parking?", a: "No", status: "processing" });
    expect(calls[0]).toMatchObject({ op: "update", payload: { body: "No", status: "processing", error: null } });
    expect(calls[0].payload).not.toHaveProperty("title");
    expectTenantFilter(calls[0]);
    expect(filterOf(calls[0], "id")).toEqual(["id", "eq", FAQ]);
    expect(filterOf(calls[0], "source_type")).toEqual(["source_type", "eq", "manual"]);
  });

  it("updateFaq answers null for no such FAQ, and conflict for a question another FAQ has", async () => {
    expect(await createKbStore(fakeDb(() => ({ data: null })).db).updateFaq(A, FAQ, { q: "x" })).toBeNull();
    const { db } = fakeDb(() => ({ error: { code: "23505", message: "dup" } }));
    expect(((await createKbStore(db).updateFaq(A, FAQ, { q: "x" }).catch((e: unknown) => e)) as AppError).code).toBe("conflict");
  });

  it("deleteFaq deletes only a manual document of the business, and says whether there was one", async () => {
    const { db, calls } = fakeDb(() => ({ data: [{ id: FAQ }] }));
    expect(await createKbStore(db).deleteFaq(A, FAQ)).toBe(true);
    expect(calls[0].op).toBe("delete");
    expectTenantFilter(calls[0]);
    expect(filterOf(calls[0], "source_type")).toEqual(["source_type", "eq", "manual"]);
    expect(await createKbStore(fakeDb(() => ({ data: [] })).db).deleteFaq(A, FAQ)).toBe(false);
  });
});

describe("gaps", () => {
  const GAP = "a0000000-0000-0000-0000-0000000000a1";
  const USER = "00000000-0000-0000-0000-0000000000a1";

  it("listOpenGaps reads the business's open gaps, most asked first, at most 100", async () => {
    const { db, calls } = fakeDb(() => ({ data: [] }));
    expect(await createKbStore(db).listOpenGaps(A)).toEqual([]);
    expectTenantFilter(calls[0]);
    expect(filterOf(calls[0], "status")).toEqual(["status", "eq", "open"]);
    expect(calls[0].order).toEqual([["asked_count", false], ["last_asked_at", false], ["id", true]]);
    expect(calls[0].limit).toBe(100);
    expect(calls[0].returning).toContain("contacts!last_contact_id");
  });

  it("listOpenGaps shows the contact's name, else a masked number, else null; never a full number", async () => {
    const { db } = fakeDb(() => ({
      data: [
        { id: "g1", question: "Q1", asked_count: 4, contact: { name: "Priya", phone: "+919812345621" } },
        { id: "g2", question: "Q2", asked_count: 2, contact: { name: null, phone: "+919812345621" } },
        { id: "g3", question: "Q3", asked_count: 2, contact: { name: "   ", phone: "+919812345621" } },
        { id: "g4", question: "Q4", asked_count: 1, contact: null },
      ],
    }));
    const gaps = await createKbStore(db).listOpenGaps(A);
    expect(gaps.map((g) => g.lastAskedBy)).toEqual(["Priya", "+9198xxxxxx21", "+9198xxxxxx21", null]);
    expect(JSON.stringify(gaps)).not.toContain("919812345621");
    expect(gaps[0]).toEqual({ id: "g1", question: "Q1", askedCount: 4, lastAskedBy: "Priya" });
  });

  it("listOpenGaps refuses a row that is not a gap", async () => {
    const { db } = fakeDb(() => ({ data: [{ id: "g1", question: "Q", asked_count: 0, contact: null }] }));
    await expect(createKbStore(db).listOpenGaps(A)).rejects.toThrow();
  });

  it("dismissGap updates only this business's open or dismissed gap, never an answered one", async () => {
    const { db, calls } = fakeDb(() => ({ data: [{ id: GAP }] }));
    expect(await createKbStore(db).dismissGap(A, GAP)).toBe(true);
    expect(calls[0]).toMatchObject({ table: "kb_gaps", op: "update", payload: { status: "dismissed" } });
    expectTenantFilter(calls[0]);
    expect(filterOf(calls[0], "id")).toEqual(["id", "eq", GAP]);
    expect(filterOf(calls[0], "status")).toEqual(["status", "in", ["open", "dismissed"]]);
    expect(await createKbStore(fakeDb(() => ({ data: [] })).db).dismissGap(A, GAP)).toBe(false);
  });

  it("answerGap calls answer_kb_gap for this business with the caller's user id", async () => {
    const { db, calls } = fakeDb(() => ({ data: [{ faq_id: FAQ_ID, question: "Home visits?", answer: "Yes" }] }));
    expect(await createKbStore(db).answerGap(A, GAP, { answer: "Yes", answeredBy: USER })).toEqual({ faqId: FAQ_ID, question: "Home visits?", answer: "Yes" });
    expect(calls[0]).toMatchObject({ op: "rpc", fn: "answer_kb_gap", args: { p_tenant_id: A, p_gap_id: GAP, p_answer: "Yes", p_answered_by: USER } });
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["PA404", "not_found"],
    ["PA409", "conflict"],
    ["23505", "conflict"],
    ["P0001", "validation_failed"],
    ["57014", "upstream_failed"],
  ])("answerGap maps the database's %s to %s, in fixed words", async (code, expected) => {
    const { db } = fakeDb(() => ({ error: { code, message: "answer_kb_gap: secret detail from the database" } }));
    const error = (await createKbStore(db).answerGap(A, GAP, { answer: "Yes", answeredBy: USER }).catch((e: unknown) => e)) as AppError;
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe(expected);
    expect(error.message).not.toMatch(/secret|answer_kb_gap/);
  });
});
