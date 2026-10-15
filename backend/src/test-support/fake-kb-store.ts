import { AppError } from "../lib/errors";
import type { Faq, KbDocument, KbDocumentStatus, KbStore, OpenGap } from "../kb/store";

// An in-memory KbStore for tests. It enforces the same tenant filtering the real store does, so a service
// that forgets to pass the tenant (or passes another one) shows up as a missing or untouched document.

export interface FakeDoc {
  id: string;
  tenantId: string;
  sourceType: string;
  title: string;
  body: string | null;
  status: KbDocumentStatus;
  error: string | null;
  createdAt: string;
  /** The address a web page was imported from. */
  sourceUrl: string | null;
}
export interface FakeGap {
  id: string;
  tenantId: string;
  question: string;
  askedCount: number;
  status: "open" | "answered" | "dismissed";
  lastAskedBy: string | null;
  lastAskedAt: number;
  answeredFaqId?: string;
}
export interface FakeChunk {
  content: string;
  embedding: number[];
}

export function fakeKbStore(seed: Partial<FakeDoc>[] = [], gapSeed: Partial<FakeGap>[] = []) {
  const docs = new Map<string, FakeDoc>();
  const chunks = new Map<string, FakeChunk[]>();
  const calls: string[] = [];
  const state = { failNext: new Set<keyof KbStore>(), counter: 0, gone: new Set<string>(), now: () => Date.now(), recentImports: 0 };
  /** Every counting of a business's recent web page imports, with the business and the time it was asked from. */
  const importCounts: { tenantId: string; since: string }[] = [];
  /** Every business any call named, so a test can say 'this call was for this business only'. */
  const seenTenants = new Set<string>();

  const add = (partial: Partial<FakeDoc>): FakeDoc => {
    const doc: FakeDoc = {
      id: partial.id ?? `00000000-0000-0000-0000-${String(++state.counter).padStart(12, "0")}`,
      tenantId: partial.tenantId ?? "t-default",
      sourceType: partial.sourceType ?? "upload",
      title: partial.title ?? "Doc",
      body: partial.body === undefined ? "text" : partial.body,
      status: partial.status ?? "processing",
      error: partial.error ?? null,
      createdAt: partial.createdAt ?? new Date(1_700_000_000_000 + state.counter * 1000).toISOString(),
      sourceUrl: partial.sourceUrl ?? null,
    };
    docs.set(doc.id, doc);
    return doc;
  };
  seed.forEach(add);
  const gaps = new Map<string, FakeGap>();
  for (const g of gapSeed) {
    const gap: FakeGap = {
      id: g.id ?? `10000000-0000-0000-0000-${String(++state.counter).padStart(12, "0")}`,
      tenantId: g.tenantId ?? "t-default",
      question: g.question ?? "A question?",
      askedCount: g.askedCount ?? 1,
      status: g.status ?? "open",
      lastAskedBy: g.lastAskedBy === undefined ? "Priya" : g.lastAskedBy,
      lastAskedAt: g.lastAskedAt ?? 0,
      answeredFaqId: g.answeredFaqId,
    };
    gaps.set(gap.id, gap);
  }
  const sameQuestion = (tenantId: string, q: string) =>
    [...docs.values()].some((d) => d.tenantId === tenantId && d.sourceType === "manual" && d.title.trim().toLowerCase() === q.trim().toLowerCase());
  const DUPLICATE = "You already have a question like this. Edit the existing one instead.";

  const mine = (tenantId: string, id: string) => {
    const doc = docs.get(id);
    return doc && doc.tenantId === tenantId ? doc : undefined;
  };
  const maybeFail = (op: keyof KbStore) => {
    if (state.failNext.delete(op)) throw new Error(`${op} failed (simulated)`);
  };

  const store: KbStore = {
    async insertUpload(tenantId, { title, body }) {
      calls.push("insertUpload");
      maybeFail("insertUpload");
      const doc = add({ tenantId, title, body, sourceType: "upload", status: "processing" });
      return { id: doc.id, createdAt: doc.createdAt };
    },
    async insertWebsite(tenantId, { url, title, body }) {
      calls.push("insertWebsite");
      maybeFail("insertWebsite");
      const doc = add({ tenantId, title, body, sourceType: "website", sourceUrl: url, status: "processing" });
      return { id: doc.id, createdAt: doc.createdAt };
    },
    async findWebsiteDocuments(tenantId, url) {
      calls.push("findWebsiteDocuments");
      maybeFail("findWebsiteDocuments");
      return [...docs.values()]
        .filter((d) => d.tenantId === tenantId && d.sourceType === "website" && d.sourceUrl === url)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
        .map((d) => ({ id: d.id, status: d.status, createdAt: d.createdAt }));
    },
    async replaceWebsite(tenantId, id, { title, body }) {
      calls.push("replaceWebsite");
      maybeFail("replaceWebsite");
      const doc = mine(tenantId, id);
      if (!doc || doc.sourceType !== "website" || doc.status === "processing") return false;
      Object.assign(doc, { title, body, status: "processing", error: null });
      return true;
    },
    async countWebsiteImportsSince(tenantId, sinceIso) {
      calls.push("countWebsiteImportsSince");
      maybeFail("countWebsiteImportsSince");
      importCounts.push({ tenantId, since: sinceIso });
      return state.recentImports;
    },
    async countDocuments(tenantId) {
      calls.push("countDocuments");
      maybeFail("countDocuments");
      return [...docs.values()].filter((d) => d.tenantId === tenantId && d.sourceType !== "manual").length;
    },
    async getDocument(tenantId, id): Promise<KbDocument | null> {
      calls.push("getDocument");
      maybeFail("getDocument");
      const doc = mine(tenantId, id);
      return doc ? { id: doc.id, title: doc.title, body: doc.body, status: doc.status, sourceType: doc.sourceType } : null;
    },
    async setStatus(tenantId, id, status, error, options) {
      calls.push("setStatus");
      maybeFail("setStatus");
      const doc = mine(tenantId, id);
      if (!doc || (options?.onlyIf && doc.status !== options.onlyIf)) return;
      doc.status = status;
      doc.error = error ?? null;
    },
    async replaceChunks(tenantId, id, rows) {
      calls.push("replaceChunks");
      maybeFail("replaceChunks");
      if (!mine(tenantId, id) || state.gone.has(id)) return "document_gone";
      chunks.set(id, rows.map((r) => ({ content: r.content, embedding: r.embedding })));
      return "stored";
    },
    async failStaleProcessing(olderThanMs, error) {
      calls.push("failStaleProcessing");
      maybeFail("failStaleProcessing");
      const cutoff = state.now() - olderThanMs;
      let failed = 0;
      for (const doc of docs.values()) {
        if (doc.status === "processing" && Date.parse(doc.createdAt) < cutoff) {
          doc.status = "failed";
          doc.error = error;
          failed++;
        }
      }
      return failed;
    },
    async insertFaq(tenantId, { q, a }) {
      calls.push("insertFaq");
      maybeFail("insertFaq");
      if (sameQuestion(tenantId, q)) throw new AppError("conflict", DUPLICATE);
      const doc = add({ tenantId, title: q, body: a, sourceType: "manual", status: "processing" });
      return { id: doc.id };
    },
    async findFailedFaq(tenantId, q): Promise<Faq | null> {
      calls.push("findFailedFaq");
      maybeFail("findFailedFaq");
      const doc = [...docs.values()].find((d) => d.tenantId === tenantId && d.sourceType === "manual" && d.status === "failed" && d.title.toLowerCase() === q.toLowerCase());
      return doc ? { id: doc.id, q: doc.title, a: doc.body ?? "", status: doc.status } : null;
    },
    async getFaq(tenantId, id): Promise<Faq | null> {
      calls.push("getFaq");
      maybeFail("getFaq");
      const doc = mine(tenantId, id);
      return doc && doc.sourceType === "manual" ? { id: doc.id, q: doc.title, a: doc.body ?? "", status: doc.status } : null;
    },
    async updateFaq(tenantId, id, { q, a }): Promise<Faq | null> {
      calls.push("updateFaq");
      maybeFail("updateFaq");
      const doc = mine(tenantId, id);
      if (!doc || doc.sourceType !== "manual") return null;
      if (q !== undefined && q.trim().toLowerCase() !== doc.title.trim().toLowerCase() && sameQuestion(tenantId, q)) throw new AppError("conflict", DUPLICATE);
      if (q !== undefined) doc.title = q;
      if (a !== undefined) doc.body = a;
      doc.status = "processing";
      doc.error = null;
      return { id: doc.id, q: doc.title, a: doc.body ?? "", status: doc.status };
    },
    async deleteFaq(tenantId, id) {
      calls.push("deleteFaq");
      maybeFail("deleteFaq");
      const doc = mine(tenantId, id);
      if (!doc || doc.sourceType !== "manual") return false;
      docs.delete(id);
      chunks.delete(id);
      return true;
    },
    async listOpenGaps(tenantId): Promise<OpenGap[]> {
      calls.push("listOpenGaps");
      maybeFail("listOpenGaps");
      return [...gaps.values()]
        .filter((g) => g.tenantId === tenantId && g.status === "open")
        .sort((x, y) => y.askedCount - x.askedCount || y.lastAskedAt - x.lastAskedAt)
        .map((g) => ({ id: g.id, question: g.question, askedCount: g.askedCount, lastAskedBy: g.lastAskedBy }));
    },
    async dismissGap(tenantId, id) {
      calls.push("dismissGap");
      maybeFail("dismissGap");
      const gap = gaps.get(id);
      if (!gap || gap.tenantId !== tenantId || gap.status === "answered") return false;
      gap.status = "dismissed";
      return true;
    },
    async answerGap(tenantId, gapId, { answer }) {
      calls.push("answerGap");
      maybeFail("answerGap");
      const gap = gaps.get(gapId);
      if (!gap || gap.tenantId !== tenantId) throw new AppError("not_found", "That question was not found.");
      if (gap.status === "answered") throw new AppError("conflict", "This question was already answered.");
      if (!answer.trim() || answer.trim().length > 2000) throw new AppError("validation_failed", "Check the answer and try again.");
      if (sameQuestion(tenantId, gap.question)) throw new AppError("conflict", DUPLICATE); // nothing changes: the gap stays open
      const doc = add({ tenantId, title: gap.question, body: answer.trim(), sourceType: "manual", status: "processing" });
      gap.status = "answered";
      gap.answeredFaqId = doc.id;
      return { faqId: doc.id, question: gap.question, answer: answer.trim() };
    },
    async deleteDocument(tenantId, id) {
      calls.push("deleteDocument");
      maybeFail("deleteDocument");
      const doc = mine(tenantId, id);
      if (!doc || doc.sourceType === "manual") return false;
      docs.delete(id);
      chunks.delete(id); // cascade
      return true;
    },
  };

  // Every call that names a business records it.
  for (const name of Object.keys(store) as (keyof KbStore)[]) {
    const original = store[name] as (...args: unknown[]) => unknown;
    (store as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      if (typeof args[0] === "string") seenTenants.add(args[0]);
      return original(...args);
    };
  }

  return { store, docs, chunks, gaps, calls, state, add, importCounts, tenantsSeen: () => new Set(seenTenants) };
}
