import Anthropic from "@anthropic-ai/sdk";
import { NonRetriableError } from "inngest";
import { describe, expect, it, vi } from "vitest";
import type { KbMatch } from "../../kb/retrieve";
import { fakePipelineStore, HIDDEN, type FakeLead, type FakeMessage } from "../../test-support/fake-pipeline-store";
import { LlmError, type LlmClient, type LlmRequest, type LlmResult } from "../llm/anthropic";
import { samplePack } from "../packs/test-packs";
import type { StepRunner, TurnContext } from "./process-message";
import { BATCH_TEXT_MAX_CHARS, RETRIEVAL_INTENTS, understandTurn, type UnderstandDeps } from "./understand";

// Step 4 of the pipeline: understand the customer's message. The model is told what the pack asks about and
// returns one JSON object; code validates it, keeps the pack's own fields on the lead, and searches the
// knowledge base. Step results stay small (Inngest keeps them): the customer's words and details are kept in the
// database, on the message's meta, and read from there by the steps that need them.

const A = "e0000000-0000-0000-0000-00000000000a";
const B = "e0000000-0000-0000-0000-00000000000b";
const CONV = "c0000000-0000-0000-0000-00000000000c";
const CONTACT = "b0000000-0000-0000-0000-0000000000b1";
const LEAD = "10000000-0000-0000-0000-0000000000f1";
const M0 = "a0000000-0000-0000-0000-0000000000a0";
const M1 = "a0000000-0000-0000-0000-0000000000a1";
const M2 = "a0000000-0000-0000-0000-0000000000a2";
const T0 = Date.parse("2026-10-08T10:00:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const SECRET_QUESTION = "What is the price of a 2BHK in Velachery?";
const good = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    language: "ta-en",
    intent: "question",
    fields: { area: "Velachery", size: "medium", budget: "80L", timeline: "now" },
    question: SECRET_QUESTION,
    preferredTime: null,
    sentiment: "neutral",
    asksIfHuman: false,
    confidence: 0.9,
    ...over,
  });

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
          if (error instanceof NonRetriableError || attempt >= retries) throw error;
        }
      }
    },
  };
  return { step, ran, memo, attempts };
}

const llmResult = (text: string): LlmResult => ({ text, model: "claude-haiku-4-5-20251001", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.002, latencyMs: 900, attempts: 1, requestId: null });
const sdkError = (status: number) => Anthropic.APIError.generate(status, { type: "error", error: { type: "x", message: "m" } }, "m", new Headers());

type Script = (string | LlmError | Error)[];
function fakeLlm(script: Script) {
  const queue = [...script];
  const complete = vi.fn<(request: LlmRequest) => Promise<LlmResult>>(async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("the model was called more often than the test expected");
    if (typeof next === "string") return llmResult(next);
    throw next;
  });
  const client: LlmClient = { complete };
  return { client, complete };
}

const chunk = (content: string): KbMatch => ({ chunkId: "ch1", documentId: "doc1", title: "Brochure", content, similarity: 0.7 });

function world(over: { script?: Script; messages?: FakeMessage[]; lead?: Partial<FakeLead>; retrieve?: UnderstandDeps["retrieve"]; packOverrides?: unknown; pack?: unknown | null } = {}) {
  const messages = over.messages ?? [
    { id: M1, tenantId: A, conversationId: CONV, direction: "in" as const, sender: "customer" as const, kind: "text", createdAt: at(0), body: "2BHK price enna? 80L budget, now" },
  ];
  const fake = fakePipelineStore({
    tenants: [{ id: A, vertical: "sample-pack", verticalVersion: 1 }],
    messages,
    leads: [{ id: LEAD, tenantId: A, contactId: CONTACT, stage: "new", createdAt: 1, fields: {}, ...over.lead }],
    packOverrides: over.packOverrides === undefined ? undefined : { [A]: over.packOverrides },
  });
  const llm = fakeLlm(over.script ?? [good()]);
  const loadPackDefinition = vi.fn(async (key: string, version: number) => (key === "sample-pack" && version === 1 ? (over.pack === undefined ? samplePack() : over.pack) : null));
  const retrieve = vi.fn<UnderstandDeps["retrieve"]>(over.retrieve ?? (async () => [chunk("2BHK of 950 sq ft starts at 78 lakh.")]));
  const deps: UnderstandDeps = { store: fake.store, llm: llm.client, loadPackDefinition, retrieve };
  const turn: TurnContext = {
    tenantId: A,
    conversationId: CONV,
    contactId: CONTACT,
    leadId: LEAD,
    leadCreated: false,
    messageIds: messages.map((m) => m.id).slice(-1),
    language: null,
    vertical: "sample-pack",
    verticalVersion: 1,
  };
  return { ...fake, ...llm, loadPackDefinition, retrieve, deps, turn };
}

describe("a message that is understood", () => {
  it("is extracted, its fields kept on the lead, the lead engaged, and the knowledge base searched", async () => {
    const w = world();
    const { step, ran } = runner();
    const result = await understandTurn(step, w.turn, w.deps);
    expect(result).toEqual({
      status: "understood",
      summary: { intent: "question", language: "ta-en", sentiment: "neutral", asksIfHuman: false, notInterested: false, confidence: 0.9, hasQuestion: true, fieldKeys: ["area", "size", "budget", "timeline"] },
      retrieval: { outcome: "found", chunks: [{ documentId: "doc1", title: "Brochure", content: "2BHK of 950 sq ft starts at 78 lakh.", similarity: 0.7 }] },
    });
    expect(ran).toEqual(["extract", "save-fields", "retrieve"]);
    const lead = w.leads.get(LEAD);
    expect(lead?.fields).toEqual({ area: "Velachery", size: "medium", budget: "80L", timeline: "now" });
    expect(lead?.stage).toBe("engaged");
    expect(w.retrieve).toHaveBeenCalledWith(A, SECRET_QUESTION);
  });

  it("keeps the extraction on the newest message's meta, where the next steps read it (not in the step results)", async () => {
    const w = world();
    await understandTurn(runner().step, w.turn, w.deps);
    const agent = w.messages.get(M1)?.meta?.agent as { extraction: { question: string; intent: string }; droppedFields: unknown };
    expect(agent.extraction).toMatchObject({ intent: "question", question: SECRET_QUESTION, language: "ta-en" });
    expect(agent.droppedFields).toEqual({ unknownKeys: 0, invalidValues: 0 });
  });

  it("sends the model the pack's fields, the customer's words and what is known, as a request for this business", async () => {
    const w = world({ lead: { fields: { notes: "has a dog" } } });
    await understandTurn(runner().step, w.turn, w.deps);
    expect(w.complete).toHaveBeenCalledOnce();
    const request = w.complete.mock.calls[0][0];
    expect(request).toMatchObject({ role: "extraction", tenantId: A, conversationId: CONV, prompt: { name: "extraction", version: 4 } });
    const system = request.system.map((b) => b.text).join("\n");
    for (const key of ["budget", "area", "size", "timeline", "party", "notes"]) expect(system).toContain(`"${key}"`);
    const user = request.messages[0].content;
    expect(user).toContain("2BHK price enna? 80L budget, now");
    expect(user).toContain("has a dog"); // already collected
  });

  it("gives the model the last four messages before the burst as context, whoever wrote them", async () => {
    const earlier = (id: string, sender: "customer" | "ai" | "staff", s: number, body: string): FakeMessage => ({ id, tenantId: A, conversationId: CONV, direction: sender === "customer" ? "in" : "out", sender, kind: "text", createdAt: at(s), body });
    const ids = ["a0000000-0000-0000-0000-0000000000c1", "a0000000-0000-0000-0000-0000000000c2", "a0000000-0000-0000-0000-0000000000c3", "a0000000-0000-0000-0000-0000000000c4", "a0000000-0000-0000-0000-0000000000c5"];
    const w = world({
      messages: [
        earlier(ids[0], "customer", -50, "OLDEST"),
        earlier(ids[1], "ai", -40, "second"),
        earlier(ids[2], "customer", -30, "third"),
        earlier(ids[3], "staff", -20, "fourth"),
        earlier(ids[4], "ai", -10, "fifth"),
        { id: M1, tenantId: A, conversationId: CONV, direction: "in", sender: "customer", kind: "text", createdAt: at(0), body: "yes" },
      ],
    });
    await understandTurn(runner().step, w.turn, w.deps);
    const user = w.complete.mock.calls[0][0].messages[0].content;
    expect(user).not.toContain("OLDEST");
    for (const word of ["second", "third", "fourth", "fifth"]) expect(user).toContain(word);
    expect(user).toContain('<message from="team_member">fourth</message>');
  });

  it("answers a burst together: the texts of all the batch's messages, oldest first", async () => {
    const m = (id: string, s: number, body: string): FakeMessage => ({ id, tenantId: A, conversationId: CONV, direction: "in", sender: "customer", kind: "text", createdAt: at(s), body });
    const w = world({ messages: [m(M0, -3, "hello"), m(M1, -1, "2BHK price?"), m(M2, 0, "budget 80L")] });
    w.turn.messageIds = [M0, M1, M2];
    await understandTurn(runner().step, w.turn, w.deps);
    const user = w.complete.mock.calls[0][0].messages[0].content;
    expect(user.indexOf("hello")).toBeLessThan(user.indexOf("2BHK price?"));
    expect(user.indexOf("2BHK price?")).toBeLessThan(user.indexOf("budget 80L"));
    // the extraction is kept on the newest message of the batch
    expect(w.messages.get(M2)?.meta?.agent).toBeDefined();
    expect(w.messages.get(M0)?.meta?.agent).toBeUndefined();
  });

  it("passes the turn's own deadline on to the model", async () => {
    const w = world();
    const controller = new AbortController();
    await understandTurn(runner().step, w.turn, { ...w.deps, signal: controller.signal });
    expect(w.complete.mock.calls[0][0].signal).toBe(controller.signal);
  });
});

describe("what the steps remember", () => {
  it("is small facts only: not the customer's words, not the question, not the details they gave (Inngest keeps every step's result)", async () => {
    const w = world();
    const r = runner();
    await understandTurn(r.step, w.turn, w.deps);
    const remembered = JSON.stringify([...r.memo.values()]);
    for (const secret of [SECRET_QUESTION, "2BHK price enna", "Velachery", "80L", ...Object.values(HIDDEN)]) expect(remembered, secret).not.toContain(secret);
    expect(remembered).toContain("fieldKeys");
  });
});

describe("the details kept on the lead", () => {
  it("only the pack's own fields, each as the pack's type for it: others are dropped and counted, never kept", async () => {
    const w = world({ script: [good({ fields: { area: "OMR", pets_allowed: true, size: "gigantic", party: "3" } })] });
    await understandTurn(runner().step, w.turn, w.deps);
    expect(w.leads.get(LEAD)?.fields).toEqual({ area: "OMR", party: 3 });
    expect((w.messages.get(M1)?.meta?.agent as { droppedFields: unknown }).droppedFields).toEqual({ unknownKeys: 1, invalidValues: 1 });
  });

  it("adds to what the lead already has, and a newer answer replaces an older one", async () => {
    const w = world({ lead: { fields: { area: "Tambaram", notes: "has a dog" } }, script: [good({ fields: { area: "Velachery" } })] });
    await understandTurn(runner().step, w.turn, w.deps);
    expect(w.leads.get(LEAD)?.fields).toEqual({ area: "Velachery", notes: "has a dog" });
  });

  it("keeps a field it does not know that is already there (an older pack version's), and never writes one itself", async () => {
    const w = world({ lead: { fields: { legacy_field: "kept" } }, script: [good({ fields: { area: "OMR" } })] });
    await understandTurn(runner().step, w.turn, w.deps);
    expect(w.leads.get(LEAD)?.fields).toEqual({ legacy_field: "kept", area: "OMR" });
  });

  it("writes nothing but the stage when the customer gave no details", async () => {
    const w = world({ script: [good({ fields: {} })] });
    const merge = vi.spyOn(w.store, "mergeLeadFields");
    await understandTurn(runner().step, w.turn, w.deps);
    expect(merge).toHaveBeenCalledWith(A, LEAD, {}, true);
    expect(w.leads.get(LEAD)).toMatchObject({ stage: "engaged", fields: {} });
  });

  it("sends only what changed: an answer the lead already has is not written again", async () => {
    const w = world({ lead: { fields: { area: "Velachery", notes: "has a dog" } }, script: [good({ fields: { area: "Velachery", budget: "80L" } })] });
    const merge = vi.spyOn(w.store, "mergeLeadFields");
    await understandTurn(runner().step, w.turn, w.deps);
    expect(merge).toHaveBeenCalledWith(A, LEAD, { budget: "80L" }, true);
  });

  it("a doubtful reading (low confidence) fills a gap but never replaces an answer the lead has", async () => {
    const w = world({ lead: { fields: { area: "Tambaram", notes: "" } }, script: [good({ confidence: 0.3, fields: { area: "Velachery", notes: "has a cat", budget: "80L" } })] });
    await understandTurn(runner().step, w.turn, w.deps);
    expect(w.leads.get(LEAD)?.fields).toEqual({ area: "Tambaram", notes: "has a cat", budget: "80L" });
  });

  it("a customer who is leaving (opt_out) is not engaged and nothing they said is kept as a detail", async () => {
    const w = world({ script: [good({ intent: "opt_out", question: null, fields: { area: "OMR" } })] });
    const merge = vi.spyOn(w.store, "mergeLeadFields");
    const r = runner();
    expect((await understandTurn(r.step, w.turn, w.deps)).status).toBe("understood");
    expect(merge).not.toHaveBeenCalled();
    expect(w.leads.get(LEAD)).toMatchObject({ stage: "new", fields: {} });
    // and the saved extraction does not keep their details or question either
    expect(w.messages.get(M1)?.meta?.agent).toMatchObject({ extraction: { intent: "opt_out", fields: {}, question: null } });
  });

  it("a customer who may be leaving (unclear_exit) is treated the same: not engaged, no details or question kept", async () => {
    const w = world({ script: [good({ intent: "unclear_exit", question: "price?", fields: { area: "OMR" } })] });
    const merge = vi.spyOn(w.store, "mergeLeadFields");
    const result = await understandTurn(runner().step, w.turn, w.deps);
    expect(result).toMatchObject({ status: "understood", summary: { intent: "unclear_exit" }, retrieval: { outcome: "skipped" } });
    expect(merge).not.toHaveBeenCalled();
    expect(w.messages.get(M1)?.meta?.agent).toMatchObject({ extraction: { intent: "unclear_exit", fields: {}, question: null } });
  });

  describe("an unclear_exit the model is not sure of (below 0.5) is read as what the message otherwise is", () => {
    it("keeps a question and the details given with it: nothing is lost, and the knowledge base is searched", async () => {
      const w = world({ script: [good({ intent: "unclear_exit", confidence: 0.4 })] });
      const result = await understandTurn(runner().step, w.turn, w.deps);
      expect(result).toMatchObject({ status: "understood", summary: { intent: "question" }, retrieval: { outcome: "found" } });
      expect(w.retrieve).toHaveBeenCalledOnce();
      expect(w.leads.get(LEAD)?.fields).toMatchObject({ area: "Velachery" });
      expect(w.leads.get(LEAD)?.stage).toBe("engaged");
    });

    it("keeps details given without a question as details (give_details)", async () => {
      const w = world({ script: [good({ intent: "unclear_exit", confidence: 0.3, question: null })] });
      expect(await understandTurn(runner().step, w.turn, w.deps)).toMatchObject({ summary: { intent: "give_details" }, retrieval: { outcome: "skipped" } });
      expect(w.leads.get(LEAD)?.fields).toMatchObject({ area: "Velachery" });
    });

    it("a stray character with nothing in it is a greeting (nothing to look up, nothing kept)", async () => {
      const w = world({ script: [good({ intent: "unclear_exit", confidence: 0.3, question: null, fields: {} })] });
      expect(await understandTurn(runner().step, w.turn, w.deps)).toMatchObject({ summary: { intent: "greeting", hasQuestion: false, fieldKeys: [] } });
      expect(w.retrieve).not.toHaveBeenCalled();
    });

    it("at 0.5 and above it is still an unclear_exit: no details, no question kept", async () => {
      const w = world({ script: [good({ intent: "unclear_exit", confidence: 0.5 })] });
      expect(await understandTurn(runner().step, w.turn, w.deps)).toMatchObject({ summary: { intent: "unclear_exit", fieldKeys: [], hasQuestion: false } });
      expect(w.leads.get(LEAD)?.fields).toEqual({});
    });
  });

  it("reports notInterested only with an opt-out (a model that sets it on another intent is not believed)", async () => {
    const optOut = world({ script: [good({ intent: "opt_out", notInterested: true, question: null, fields: {} })] });
    expect(await understandTurn(runner().step, optOut.turn, optOut.deps)).toMatchObject({ summary: { intent: "opt_out", notInterested: true } });
    const other = world({ script: [good({ intent: "question", notInterested: true })] });
    expect(await understandTurn(runner().step, other.turn, other.deps)).toMatchObject({ summary: { intent: "question", notInterested: false } });
    const missing = world({ script: [good({ intent: "opt_out", question: null, fields: {} })] });
    expect(await understandTurn(runner().step, missing.turn, missing.deps)).toMatchObject({ summary: { notInterested: false } });
  });

  it("checks the details again against the pack as it is when they are saved: a field hidden in between is not written", async () => {
    const w = world({ script: [good({ fields: { notes: "x", area: "OMR" } })] });
    const r = runner();
    // the business hides "notes" after the model has answered: the first read of the overrides (extract) sees none, the next (save-fields) sees the change
    let reads = 0;
    w.store.getPackOverrides = async () => (++reads === 1 ? {} : { hideFields: ["notes"] });
    await understandTurn(r.step, w.turn, w.deps);
    expect(w.leads.get(LEAD)?.fields).toEqual({ area: "OMR" });
  });

  it("does not show the model a detail the pack no longer asks about", async () => {
    const w = world({ lead: { fields: { legacy_field: "OLD-PACK-SECRET", area: "OMR" } } });
    await understandTurn(runner().step, w.turn, w.deps);
    const user = w.complete.mock.calls[0][0].messages[0].content;
    expect(user).not.toContain("OLD-PACK-SECRET");
    expect(user).toContain("OMR");
  });

  it.each(["qualified", "booked", "visited", "human", "nurture", "engaged"])("does not move a lead that is already at stage %s", async (stage) => {
    const w = world({ lead: { stage } });
    await understandTurn(runner().step, w.turn, w.deps);
    expect(w.leads.get(LEAD)?.stage).toBe(stage);
  });

  it("applies the business's own overrides: a hidden field is not accepted, an added one is", async () => {
    const w = world({ packOverrides: { hideFields: ["notes"], addFields: [{ key: "pets", label: "Pets", type: "boolean" }] }, script: [good({ fields: { notes: "x", pets: "true", area: "OMR" } })] });
    await understandTurn(runner().step, w.turn, w.deps);
    expect(w.leads.get(LEAD)?.fields).toEqual({ area: "OMR", pets: true });
    expect(w.complete.mock.calls[0][0].system.map((b) => b.text).join("\n")).toContain('"pets"');
  });

  it("does not touch a lead that is gone, and does not fail", async () => {
    const w = world();
    w.leads.delete(LEAD);
    const result = await understandTurn(runner().step, w.turn, w.deps);
    expect(result.status).toBe("understood");
  });
});

describe("a model answer that is not good", () => {
  it("is asked for again once, with the reason, and the second answer is used", async () => {
    const w = world({ script: ["Sorry, I cannot do that.", good()] });
    const result = await understandTurn(runner().step, w.turn, w.deps);
    expect(result.status).toBe("understood");
    expect(w.complete).toHaveBeenCalledTimes(2);
    const second = w.complete.mock.calls[1][0].messages;
    expect(second.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(second[2].content).toMatch(/not a valid JSON object/i);
    expect(second[1].content).toBe("Sorry, I cannot do that.");
  });

  it("falls back to a clarifying question when the second answer is no better, and records that nothing was understood", async () => {
    const w = world({ script: ["nope", '{"intent":"question"}'] });
    const { step, ran } = runner();
    const result = await understandTurn(step, w.turn, w.deps);
    expect(result).toEqual({ status: "fallback", reason: "invalid_output" });
    expect(w.complete).toHaveBeenCalledTimes(2); // one retry, never more
    expect(ran).toEqual(["extract"]); // nothing is saved, nothing is searched
    expect(w.leads.get(LEAD)).toMatchObject({ stage: "new", fields: {} });
    expect(w.retrieve).not.toHaveBeenCalled();
    expect((w.messages.get(M1)?.meta?.agent as { extractionFailed: string }).extractionFailed).toBe("invalid_output");
  });

  it("an answer cut off or empty is asked for again the same way, with nothing added", async () => {
    for (const code of ["truncated", "empty"] as const) {
      const w = world({ script: [new LlmError(code, undefined, 1), good()] });
      expect((await understandTurn(runner().step, w.turn, w.deps)).status).toBe("understood");
      expect(w.complete.mock.calls[1][0].messages).toHaveLength(1);
    }
  });

  it("a refusal is not asked again: a clarifying question", async () => {
    const w = world({ script: [new LlmError("refusal", undefined, 1)] });
    expect(await understandTurn(runner().step, w.turn, w.deps)).toEqual({ status: "fallback", reason: "model_declined" });
    expect(w.complete).toHaveBeenCalledOnce();
  });
});

describe("when the model cannot be reached", () => {
  it.each([
    ["unavailable", 503],
    ["rate_limited", 429],
    ["timeout", undefined],
  ] as const)("(%s) the client has already retried it, so the step does not: the turn says so and understands nothing", async (code, status) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const w = world({ script: [new LlmError(code, status, 3), good()] });
    const r = runner(2);
    const result = await understandTurn(r.step, w.turn, w.deps);
    expect(result).toEqual({ status: "model_unavailable" });
    expect(r.attempts.get("extract")).toBe(1); // a step retry would pay for the same calls again
    expect(w.complete).toHaveBeenCalledOnce();
    expect(w.leads.get(LEAD)?.stage).toBe("new");
    expect(w.retrieve).not.toHaveBeenCalled();
    expect((w.messages.get(M1)?.meta?.agent as { extractionFailed: string }).extractionFailed).toBe("model_unavailable");
  });

  it("says where in the log (ids), never what the customer wrote", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const w = world({ script: [new LlmError("unavailable", 503, 3)] });
    await understandTurn(runner().step, w.turn, w.deps);
    const logged = log.mock.calls.flat().join("\n");
    expect(logged).toContain(A);
    expect(logged).toContain(CONV);
    expect(logged).not.toContain("2BHK price enna");
  });

  it("the turn's time being up is reported, not retried: the reply step sends the safe line", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const w = world({ script: [new LlmError("aborted", undefined, 1), good()] });
    const r = runner(2);
    const result = await understandTurn(r.step, w.turn, { ...w.deps, signal: AbortSignal.abort() });
    expect(result).toEqual({ status: "model_unavailable" });
    expect(r.attempts.get("extract")).toBe(1);
    expect((w.messages.get(M1)?.meta?.agent as { extractionFailed: string }).extractionFailed).toBe("model_unavailable");
  });

  it("the turn's own deadline passing is retried as a step, under a new one", async () => {
    const w = world({ script: [new LlmError("aborted", undefined, 1), good()] });
    const r = runner(2);
    expect((await understandTurn(r.step, w.turn, w.deps)).status).toBe("understood");
    expect(r.attempts.get("extract")).toBe(2);
  });

  it("a request or a key the provider rejects is a bug to look at, not retried and not hidden", async () => {
    const w = world({ script: [new LlmError("rejected", 401, 1)] });
    const r = runner(2);
    await expect(understandTurn(r.step, w.turn, w.deps)).rejects.toBeInstanceOf(NonRetriableError);
    expect(r.attempts.get("extract")).toBe(1);
  });

  it("an error nobody planned for is not hidden either", async () => {
    const w = world({ script: [new Error("something odd")] });
    await expect(understandTurn(runner(0).step, w.turn, w.deps)).rejects.toThrow(/something odd/);
  });

  it("an SDK error that escapes the client is treated like any other surprise", async () => {
    const w = world({ script: [sdkError(500) as unknown as Error] });
    await expect(understandTurn(runner(0).step, w.turn, w.deps)).rejects.toBeDefined();
  });
});

describe("a message with nothing to read", () => {
  it("is a clarifying question, and the model is not called", async () => {
    for (const body of [null, "", "   \n "]) {
      const w = world({ messages: [{ id: M1, tenantId: A, conversationId: CONV, direction: "in", sender: "customer", kind: "text", createdAt: at(0), body }] });
      expect(await understandTurn(runner().step, w.turn, w.deps)).toEqual({ status: "fallback", reason: "no_text" });
      expect(w.complete).not.toHaveBeenCalled();
    }
  });

  it("reads only the end of a very long burst, so one customer cannot make an expensive request", async () => {
    const w = world({ messages: [{ id: M1, tenantId: A, conversationId: CONV, direction: "in", sender: "customer", kind: "text", createdAt: at(0), body: `START-MARKER ${"x".repeat(BATCH_TEXT_MAX_CHARS * 2)} END-MARKER` }] });
    await understandTurn(runner().step, w.turn, w.deps);
    const user = w.complete.mock.calls[0][0].messages[0].content;
    expect(user).toContain("END-MARKER");
    expect(user).not.toContain("START-MARKER");
    expect(user.length).toBeLessThan(BATCH_TEXT_MAX_CHARS + 3000);
  });

  it("reads the words of a tapped list or button reply", async () => {
    const w = world({ messages: [{ id: M1, tenantId: A, conversationId: CONV, direction: "in", sender: "customer", kind: "interactive", createdAt: at(0), body: "Sat 10 Oct, 5:00 pm" }] });
    await understandTurn(runner().step, w.turn, w.deps);
    expect(w.complete.mock.calls[0][0].messages[0].content).toContain("Sat 10 Oct, 5:00 pm");
  });
});

describe("the pack", () => {
  it("is loaded for the business's own key and version", async () => {
    const w = world();
    await understandTurn(runner().step, w.turn, w.deps);
    expect(w.loadPackDefinition).toHaveBeenCalledWith("sample-pack", 1);
  });

  it("a pack that is missing or invalid stops the turn before the model is called", async () => {
    for (const pack of [null, { key: "sample-pack", version: 1 }]) {
      const w = world({ pack });
      expect(await understandTurn(runner().step, w.turn, w.deps)).toEqual({ status: "no_pack" });
      expect(w.complete).not.toHaveBeenCalled();
    }
  });

  it("a pack store that cannot be reached is retried, not mistaken for a missing pack", async () => {
    const w = world();
    w.deps.loadPackDefinition = vi.fn().mockRejectedValueOnce(new Error("store down")).mockResolvedValue(samplePack());
    expect((await understandTurn(runner(2).step, w.turn, w.deps)).status).toBe("understood");
  });
});

describe("the knowledge base search", () => {
  const retrieval = async (script: string, retrieve?: UnderstandDeps["retrieve"]) => {
    const w = world({ script: [script], retrieve });
    const result = await understandTurn(runner().step, w.turn, w.deps);
    return { w, result };
  };

  it.each(["question", "give_details", "book"])("is done for intent %s when there is a question", async (intent) => {
    const { w, result } = await retrieval(good({ intent }));
    expect(w.retrieve).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ retrieval: { outcome: "found" } });
  });

  it.each(["greeting", "reschedule", "cancel", "talk_to_human", "complaint", "price_negotiation", "off_topic", "opt_out"])("is not done for intent %s: nothing in the knowledge base answers it", async (intent) => {
    const { w, result } = await retrieval(good({ intent }));
    expect(w.retrieve).not.toHaveBeenCalled();
    expect(result).toMatchObject({ retrieval: { outcome: "skipped" } });
  });

  it("the intents it is done for are exactly those", () => {
    expect([...RETRIEVAL_INTENTS].sort()).toEqual(["book", "give_details", "question"]);
  });

  it("is not done when there is no question", async () => {
    const { w, result } = await retrieval(good({ question: null }));
    expect(w.retrieve).not.toHaveBeenCalled();
    expect(result).toMatchObject({ retrieval: { outcome: "skipped" } });
  });

  it("finding nothing above the threshold is its own answer: none", async () => {
    const { result } = await retrieval(good(), async () => []);
    expect(result).toMatchObject({ retrieval: { outcome: "none" } });
  });

  it("a search that fails is its own answer, unavailable, and does not fail the turn (an outage is not a gap in the knowledge base)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = await retrieval(good(), async () => Promise.reject(new Error("embeddings down for 10.0.0.5")));
    expect(result).toMatchObject({ status: "understood", retrieval: { outcome: "unavailable" } });
    expect(spy.mock.calls.map((c) => c.join(" ")).join("\n")).not.toMatch(/10\.0\.0\.5|embeddings down|Velachery/);
    spy.mockRestore();
  });

  it("asks for the question as it was normalised to English, for this business only", async () => {
    const { w } = await retrieval(good({ question: "  What is the price?  " }));
    expect(w.retrieve).toHaveBeenCalledWith(A, "What is the price?");
  });
});

describe("running it again", () => {
  it("a fresh run for a message whose extraction is already saved uses it: the model is not called again", async () => {
    const w = world({ script: [good(), good()] });
    await understandTurn(runner().step, w.turn, w.deps);
    const again = await understandTurn(runner().step, w.turn, w.deps); // a new run: no memoised steps
    expect(w.complete).toHaveBeenCalledOnce();
    expect(again).toMatchObject({ status: "understood", summary: { intent: "question", fieldKeys: ["area", "size", "budget", "timeline"] } });
  });

  it("a failed extraction is tried again by a later run, and the failure is cleared when it works", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const w = world({ script: [new LlmError("unavailable", 503, 3), good()] });
    expect((await understandTurn(runner().step, w.turn, w.deps)).status).toBe("model_unavailable");
    expect((await understandTurn(runner().step, w.turn, w.deps)).status).toBe("understood");
    const agent = w.messages.get(M1)?.meta?.agent as Record<string, unknown>;
    expect(agent.extractionFailed).toBeNull();
    expect(agent.extraction).toMatchObject({ intent: "question" });
  });

  it("a failure written over a good extraction clears it, so the two never sit side by side", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // an earlier attempt left something under `extraction` that no longer reads as a valid extraction, then this run fails
    const w2 = world({ script: ["nope", "nope"] });
    w2.messages.get(M1)!.meta = { buttonId: "b1", agent: { extraction: { stale: true } } };
    await understandTurn(runner().step, w2.turn, w2.deps);
    const agent = w2.messages.get(M1)?.meta?.agent as Record<string, unknown>;
    expect(w2.messages.get(M1)?.meta?.buttonId).toBe("b1");
    expect(agent).toMatchObject({ extractionFailed: "invalid_output", extraction: null, droppedFields: null });
  });

  it("a database blip when keeping the answer is retried at once, without asking the model again", async () => {
    const w = world({ script: [good(), good()] });
    w.state.failNext.add("saveAgentMeta");
    const r = runner();
    expect((await understandTurn(r.step, w.turn, w.deps)).status).toBe("understood");
    expect(w.complete).toHaveBeenCalledOnce();
    expect(r.attempts.get("extract")).toBe(1);
  });

  it("a message that cannot be found is a bug, not retried and not reported as understood", async () => {
    const w = world();
    w.messages.delete(M1);
    const r = runner(2);
    await expect(understandTurn(r.step, w.turn, w.deps)).rejects.toBeInstanceOf(NonRetriableError);
    expect(r.attempts.get("extract")).toBe(1);
  });

  it("does not repeat a step that finished within a run", async () => {
    const w = world();
    const r = runner();
    await understandTurn(r.step, w.turn, w.deps);
    await understandTurn(r.step, w.turn, w.deps);
    expect(r.ran).toEqual(["extract", "save-fields", "retrieve"]);
    expect(w.complete).toHaveBeenCalledOnce();
  });

  it("a new run for the same turn works from the same lead: the same details end up on it", async () => {
    const w = world({ script: [good(), good()] });
    await understandTurn(runner().step, w.turn, w.deps);
    await understandTurn(runner().step, w.turn, w.deps);
    expect(w.leads.get(LEAD)?.fields).toEqual({ area: "Velachery", size: "medium", budget: "80L", timeline: "now" });
  });
});

describe("another business", () => {
  it("never reads or writes another business's messages or lead, even given their ids", async () => {
    const w = world();
    const result = understandTurn(runner().step, { ...w.turn, tenantId: B }, w.deps);
    // B has no such message: nothing to read, and nothing can be written to it (a bug, so the run stops)
    await expect(result).rejects.toBeInstanceOf(NonRetriableError);
    expect(w.messages.get(M1)?.meta?.agent).toBeUndefined();
    expect(w.leads.get(LEAD)).toMatchObject({ stage: "new", fields: {} });
    expect(w.complete).not.toHaveBeenCalled();
  });
});
