import { NonRetriableError } from "inngest";
import { describe, expect, it, vi } from "vitest";
import { fakeKbStore } from "../test-support/fake-kb-store";
import { EmbeddingsError } from "./embeddings";
import { failureMessage, INGEST_BATCH_SIZE, runIngest, type IngestDeps, type StepRunner } from "./ingest";

// The body of the kb-ingest job. `step.run` is replaced by a runner that remembers each step's result by
// id and retries a failing step, like Inngest does: a step that finished is not executed again when the job
// is run again, and an error only reaches the body after the step's retries are used up.

const A = "e0000000-0000-0000-0000-00000000000a";
const B = "e0000000-0000-0000-0000-00000000000b";
const DOC = "e2000000-0000-0000-0000-0000000000a1";

function runner(retries = 0) {
  const memo = new Map<string, unknown>();
  const ran: string[] = [];
  const attempts = new Map<string, number>();
  const step: StepRunner = {
    async run(id, fn) {
      if (memo.has(id)) return memo.get(id) as never;
      ran.push(id);
      for (let attempt = 0; ; attempt++) {
        attempts.set(id, attempt + 1);
        try {
          const value = await fn();
          memo.set(id, value);
          return value;
        } catch (error) {
          if (error instanceof NonRetriableError || attempt >= retries) throw error; // used up, or not worth retrying
        }
      }
    },
  };
  return { step, ran, memo, attempts };
}

/** Text that chunks into roughly `n` pieces. */
const textOf = (n: number) => Array.from({ length: n }, (_, i) => `Paragraph ${i} about the project. `.repeat(28)).join("\n\n");
const vectorFor = (text: string) => [text.length, text.charCodeAt(0), 0.5];

function setup(docOver: Record<string, unknown> = {}, overrides: Partial<IngestDeps> = {}) {
  const fake = fakeKbStore([{ id: DOC, tenantId: A, sourceType: "upload", title: "Brochure", body: textOf(3), status: "processing", ...docOver }]);
  const embed = vi.fn(async (texts: string[]) => texts.map(vectorFor));
  const deps: IngestDeps = { store: fake.store, embed, ...overrides };
  return { ...fake, embed, deps };
}
const event = { tenantId: A, documentId: DOC };

describe("runIngest: an imported web page is a document like an upload", () => {
  it("is chunked, embedded and published exactly as an upload is", async () => {
    const s = setup({ sourceType: "website", sourceUrl: "https://www.example.com/about" });
    const result = await runIngest(runner().step, event, s.deps);
    expect(result).toMatchObject({ status: "ready" });
    expect((s.chunks.get(DOC) ?? []).length).toBeGreaterThan(1);
    expect(s.docs.get(DOC)).toMatchObject({ status: "ready", error: null });
  });

  it("a re-import is read again: its text was replaced and it is processing, so the new text is chunked and the old chunks are replaced, never added to", async () => {
    const s = setup({ sourceType: "website", status: "ready", body: textOf(2) });
    s.chunks.set(DOC, [{ content: "OLD CHUNK", embedding: [1, 2, 3] }]);
    const first = await runIngest(runner().step, event, s.deps);
    expect(first).toEqual({ status: "skipped", reason: "already_ready" }); // a repeat of the same event does nothing
    s.docs.get(DOC)!.status = "processing"; // what replacing the page does
    s.docs.get(DOC)!.body = textOf(3);
    const again = await runIngest(runner().step, event, s.deps);
    expect(again).toMatchObject({ status: "ready" });
    const stored = s.chunks.get(DOC) ?? [];
    expect(stored.map((c) => c.content).join(" ")).not.toContain("OLD CHUNK");
    expect(stored.length).toBeGreaterThan(1);
  });

  it("an imported page with no text fails with the plain reason, like an upload", async () => {
    const s = setup({ sourceType: "website", body: "   " });
    expect(await runIngest(runner().step, event, s.deps)).toEqual({ status: "failed", reason: "no_text" });
    expect(s.docs.get(DOC)).toMatchObject({ status: "failed", error: "This document has no text to learn from." });
  });

  it("another business's page is never read or changed", async () => {
    const s = setup({ sourceType: "website" });
    expect(await runIngest(runner().step, { tenantId: B, documentId: DOC }, s.deps)).toEqual({ status: "skipped", reason: "not_found" });
    expect(s.docs.get(DOC)?.status).toBe("processing");
    expect(s.embed).not.toHaveBeenCalled();
  });
});

describe("runIngest", () => {
  it("chunks the text, embeds it, stores the chunks and marks the document ready", async () => {
    const s = setup();
    const { step, ran } = runner();
    const result = await runIngest(step, event, s.deps);
    const stored = s.chunks.get(DOC) ?? [];
    expect(result).toEqual({ status: "ready", chunks: stored.length });
    expect(stored.length).toBeGreaterThan(1);
    for (const chunk of stored) expect(chunk.embedding).toEqual(vectorFor(chunk.content));
    expect(s.docs.get(DOC)).toMatchObject({ status: "ready", error: null });
    expect(ran).toEqual(["load", "embed-0", "store"]);
  });

  it("embeds in batches of 32, each its own step, keeping every chunk with the vector of its own text across the boundary", async () => {
    const s = setup({ body: textOf(INGEST_BATCH_SIZE * 2 + 20) });
    const { step, ran } = runner();
    const result = await runIngest(step, event, s.deps);
    expect(result.status).toBe("ready");
    const total = s.chunks.get(DOC)?.length ?? 0;
    expect(total).toBeGreaterThan(INGEST_BATCH_SIZE * 2);
    const batches = Math.ceil(total / INGEST_BATCH_SIZE);
    expect(ran).toEqual(["load", ...Array.from({ length: batches }, (_, i) => `embed-${i}`), "store"]);
    expect(s.embed.mock.calls.map((c) => c[0].length)).toEqual([
      ...Array.from({ length: batches - 1 }, () => INGEST_BATCH_SIZE),
      total - INGEST_BATCH_SIZE * (batches - 1),
    ]);
    for (const chunk of s.chunks.get(DOC) ?? []) expect(chunk.embedding).toEqual(vectorFor(chunk.content));
  });

  it("retries a failing batch alone: the batches that finished are not embedded again", async () => {
    const s = setup({ body: textOf(INGEST_BATCH_SIZE + 5) });
    let failedOnce = false;
    s.embed.mockImplementation(async (texts: string[]) => {
      // the second batch is the shorter one; it fails once, as a provider hiccup
      if (texts.length < INGEST_BATCH_SIZE && !failedOnce) {
        failedOnce = true;
        throw new EmbeddingsError(503);
      }
      return texts.map(vectorFor);
    });
    const { step, attempts } = runner(3);
    const result = await runIngest(step, event, s.deps);
    expect(result.status).toBe("ready");
    expect(attempts.get("embed-0")).toBe(1);
    expect(attempts.get("embed-1")).toBe(2);
    expect(s.embed).toHaveBeenCalledTimes(3);
  });

  it("does nothing the second time the same event arrives: a ready document is left alone", async () => {
    const s = setup();
    await runIngest(runner().step, event, s.deps);
    const snapshot = JSON.stringify(s.chunks.get(DOC));
    s.embed.mockClear();
    // a new run, as when an event is sent again after the event id's dedupe window: nothing is remembered
    const again = await runIngest(runner().step, event, s.deps);
    expect(again).toEqual({ status: "skipped", reason: "already_ready" });
    expect(s.embed).not.toHaveBeenCalled();
    expect(JSON.stringify(s.chunks.get(DOC))).toBe(snapshot);
  });

  it("replaces the chunks of an earlier attempt instead of adding to them, and shows the document as processing meanwhile", async () => {
    const s = setup({ status: "failed", error: "Something went wrong" });
    s.chunks.set(DOC, [{ content: "old chunk 1", embedding: [1] }, { content: "old chunk 2", embedding: [2] }]);
    let during: string | undefined;
    s.embed.mockImplementation(async (texts: string[]) => {
      during = s.docs.get(DOC)?.status;
      return texts.map(vectorFor);
    });
    await runIngest(runner().step, event, s.deps);
    expect(during).toBe("processing");
    expect((s.chunks.get(DOC) ?? []).some((c) => c.content.startsWith("old"))).toBe(false);
    expect(s.docs.get(DOC)).toMatchObject({ status: "ready", error: null });
  });

  describe("what it skips", () => {
    it("a document that is gone (deleted before the job ran)", async () => {
      const s = setup();
      s.docs.delete(DOC);
      expect(await runIngest(runner().step, event, s.deps)).toEqual({ status: "skipped", reason: "not_found" });
      expect(s.embed).not.toHaveBeenCalled();
    });

    it("another business's document, which it never reads or changes", async () => {
      const s = setup();
      const result = await runIngest(runner().step, { tenantId: B, documentId: DOC }, s.deps);
      expect(result).toEqual({ status: "skipped", reason: "not_found" });
      expect(s.docs.get(DOC)?.status).toBe("processing");
      expect(s.embed).not.toHaveBeenCalled();
      expect(s.chunks.size).toBe(0);
    });

    it("an FAQ, which is embedded where it is saved", async () => {
      const s = setup({ sourceType: "manual" });
      expect(await runIngest(runner().step, event, s.deps)).toEqual({ status: "skipped", reason: "not_an_upload" });
      expect(s.embed).not.toHaveBeenCalled();
    });

    it("a document deleted while the job was embedding: nothing is stored, nothing is marked ready", async () => {
      const s = setup();
      s.embed.mockImplementation(async (texts: string[]) => {
        s.state.gone.add(DOC);
        return texts.map(vectorFor);
      });
      expect(await runIngest(runner().step, event, s.deps)).toEqual({ status: "skipped", reason: "document_gone" });
      expect(s.docs.get(DOC)?.status).toBe("processing");
    });
  });

  describe("failures it knows (the run succeeds: there is nothing to retry)", () => {
    it("a document with no text is marked failed, with a message the person can act on", async () => {
      const s = setup({ body: null });
      expect(await runIngest(runner().step, event, s.deps)).toEqual({ status: "failed", reason: "no_text" });
      expect(s.docs.get(DOC)).toMatchObject({ status: "failed" });
      expect(s.docs.get(DOC)?.error).toMatch(/no text/i);
      expect(s.embed).not.toHaveBeenCalled();
    });

    it("a document with too much text is marked failed", async () => {
      const s = setup({ body: "Sentence about the project. ".repeat(40_000) });
      expect(await runIngest(runner().step, event, s.deps)).toEqual({ status: "failed", reason: "too_long" });
      expect(s.docs.get(DOC)?.error).toMatch(/too much text/i);
    });

    it("the provider refusing the request (a rejected key or input, 4xx) is marked failed at once, not retried", async () => {
      for (const status of [400, 401, 403, 422]) {
        const s = setup({}, { embed: vi.fn(async () => Promise.reject(new EmbeddingsError(status))) });
        const { step, attempts } = runner(3);
        expect(await runIngest(step, event, s.deps)).toEqual({ status: "failed", reason: "embeddings_rejected" });
        expect(attempts.get("embed-0")).toBe(1);
        expect(s.docs.get(DOC)?.status).toBe("failed");
        expect(s.chunks.has(DOC)).toBe(false);
      }
    });

    it("an outage or a rate limit (429, 5xx, no answer) is retried, not treated as a rejection", async () => {
      for (const status of [429, 408, 500, 503, undefined]) {
        const s = setup({}, { embed: vi.fn(async () => Promise.reject(new EmbeddingsError(status))) });
        const { step, attempts } = runner(3);
        await expect(runIngest(step, event, s.deps)).rejects.toBeInstanceOf(NonRetriableError); // after the retries are used up
        expect(attempts.get("embed-0")).toBe(4);
      }
    });
  });

  describe("failures nobody planned for (the run ends as failed, and the document says so in fixed words)", () => {
    const failedWith = async (s: ReturnType<typeof setup>, retries = 0) => {
      const error = await runIngest(runner(retries).step, event, s.deps).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(NonRetriableError);
      return error as Error;
    };

    it("an embeddings outage that outlasts the retries: the document says to try again, and never quotes the provider", async () => {
      const s = setup({}, { embed: async () => Promise.reject(new EmbeddingsError(503)) });
      const error = await failedWith(s);
      expect(s.docs.get(DOC)?.status).toBe("failed");
      expect(s.docs.get(DOC)?.error).toMatch(/try again/i);
      expect(error.message).toBe(s.docs.get(DOC)?.error);
      expect(s.chunks.has(DOC)).toBe(false);
    });

    it("any other surprise: generic words that carry nothing from the error", async () => {
      const s = setup({}, { embed: async () => Promise.reject(new Error("ECONNRESET 10.0.0.5 key=sk-secret body=Paragraph 0")) });
      const error = await failedWith(s);
      const saved = s.docs.get(DOC)?.error ?? "";
      expect(saved).not.toMatch(/10\.0\.0\.5|sk-secret|Paragraph|ECONNRESET/);
      expect(error.message).not.toMatch(/10\.0\.0\.5|sk-secret|Paragraph|ECONNRESET/);
      expect(saved.length).toBeGreaterThan(0);
      expect(saved.length).toBeLessThanOrEqual(200);
    });

    it("a wrong number of vectors from the provider is a failure, not ready", async () => {
      const s = setup({}, { embed: async (texts) => texts.slice(1).map(vectorFor) });
      await failedWith(s);
      expect(s.docs.get(DOC)?.status).toBe("failed");
      expect(s.chunks.has(DOC)).toBe(false);
    });

    it("leaves the old chunks alone when it fails before the store step", async () => {
      const s = setup({ status: "failed" }, { embed: async () => Promise.reject(new EmbeddingsError(500)) });
      s.chunks.set(DOC, [{ content: "old", embedding: [1] }]);
      await failedWith(s);
      expect(s.chunks.get(DOC)).toEqual([{ content: "old", embedding: [1] }]);
    });

    it("chunks that could not be stored even after the retries: failed, not ready", async () => {
      const s = setup();
      s.state.failNext.add("replaceChunks");
      await failedWith(s);
      expect(s.docs.get(DOC)?.status).toBe("failed");
      expect(s.chunks.has(DOC)).toBe(false);
    });

    it("a store that fails while loading ends as failed, in generic words", async () => {
      const s = setup();
      s.state.failNext.add("getDocument");
      await failedWith(s);
      expect(s.docs.get(DOC)?.error).toBe(failureMessage(new Error("x")));
    });

    it("an event whose ids are not ids is refused without touching the store", async () => {
      const s = setup();
      const error = await runIngest(runner().step, { tenantId: "x", documentId: DOC }, s.deps).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(NonRetriableError);
      expect(s.calls).toEqual([]);
    });
  });
});

describe("failureMessage", () => {
  it("shows the message of an error that says by its name it is one of ours, and nothing else", () => {
    expect(failureMessage(new EmbeddingsError(429))).toBe(failureMessage(new EmbeddingsError(500)));
    expect(failureMessage(new EmbeddingsError(500))).toMatch(/try again/i);
    expect(failureMessage(new Error("x"))).not.toBe(failureMessage(new EmbeddingsError(500)));
    for (const message of [failureMessage(new Error("x")), failureMessage(new EmbeddingsError())]) expect(message.length).toBeLessThanOrEqual(200);
  });

  it("falls back to the generic message when the name did not survive the trip through a step", () => {
    const stripped = Object.assign(new Error("We couldn't reach the embeddings service. Try again in a moment."), { name: "Error" });
    expect(failureMessage(stripped)).toBe(failureMessage(new Error("anything")));
    expect(failureMessage("a string")).toBe(failureMessage(new Error("anything")));
    expect(failureMessage(undefined)).toBe(failureMessage(new Error("anything")));
  });

  it("does not trust a message just because it came as a non-retriable error", () => {
    expect(failureMessage(new NonRetriableError("secret internal detail 10.0.0.5"))).not.toContain("10.0.0.5");
  });
});
