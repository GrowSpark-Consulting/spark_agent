import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEntry } from "../../lib/audit";
import type { SendOutcome } from "../../notify/send";
import { fakePipelineStore, type FakeMessage } from "../../test-support/fake-pipeline-store";
import { LlmError, type LlmClient, type LlmRequest, type LlmResult } from "../llm/anthropic";
import type { SystemNoticePort } from "./ports";
import type { StepRunner, TurnContext } from "./process-message";
import { replyTurn, type ReplyDeps } from "./reply";
import { TURN_HARD_STOP_MS } from "./turn-deadline";
import type { Retrieval, UnderstandResult } from "./understand";

// A retry of the reply step does not ask the reply model again (the step 8 audit's second finding, pinned until now by an `it.fails`). The reply step writes
// the text and sends it; a send that failed in a way waiting can fix makes the step run again, and the retry used to write the text again: another model
// call, more latency, a different text. Now the written reply is kept on the turn's last message (meta.agent.draft: the plan case and the text, the way the
// send marker is kept) BEFORE it is sent, and a retry reuses it. Only a real model answer that passed the post-check is kept; fixed words cost nothing to
// write again, and a fallback after a model failure should give the model another chance. The draft is cleared when the send ends for good.
// Credits are not touched: they are spent and refunded inside notify.send (by reference), and the send keeps its key (`reply:<last message id>`).

const A = "e0000000-0000-0000-0000-00000000000a";
const CONV = "c0000000-0000-0000-0000-00000000000c";
const CONTACT = "b0000000-0000-0000-0000-0000000000b1";
const LEAD = "10000000-0000-0000-0000-0000000000f1";
const M1 = "a0000000-0000-0000-0000-0000000000a1";
const M2 = "a0000000-0000-0000-0000-0000000000a2";
const NOW = Date.now();

const SENT: SendOutcome = { status: "sent", messageId: "m-out", providerMsgId: "wamid.OUT", creditsCharged: 1, usedTemplate: false };
const RETRYABLE: SendOutcome = { status: "failed", error: { code: "rate_limited", message: "x", retryable: true, outcomeUnknown: false } };
const PERMANENT: SendOutcome = { status: "failed", error: { code: "whatsapp_not_connected", message: "x", retryable: false, outcomeUnknown: false } };
const UNKNOWN: SendOutcome = { status: "failed", error: { code: "upstream_failed", message: "x", retryable: true, outcomeUnknown: true } };

const GOOD = "Yes, we do site visits. Shall we plan one?";
const GOOD_AGAIN = "Yes, site visits are free. When would suit you?";
const BAD = "Our 2BHK starts at ₹99 lakh, shall we plan a visit?"; // a price the knowledge base does not hold: the post-check refuses it
const llmResult = (text: string): LlmResult => ({ text, model: "m", requestId: "r", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, latencyMs: 1, attempts: 1 });

/** What Inngest remembers between the attempts of a step: a step that finished is kept, one that threw is not. */
function runner(): StepRunner {
  const memo = new Map<string, unknown>();
  return {
    async run(id, fn) {
      if (memo.has(id)) return memo.get(id) as never;
      const value = await fn();
      memo.set(id, value);
      return value;
    },
  };
}

const found: Retrieval = { outcome: "found", chunks: [{ documentId: "d1", title: "Brochure", content: "Site visits are free. 2BHK starts at ₹78 lakh.", similarity: 0.7 }] };
const understood: UnderstandResult = {
  status: "understood",
  summary: { intent: "question", language: "en", sentiment: "neutral", asksIfHuman: false, notInterested: false, confidence: 0.9, hasQuestion: true, fieldKeys: [] },
  retrieval: found,
};

interface Options {
  /** One item per reply-model call: text, or an Error to throw. */
  script?: (string | Error)[];
  /** One outcome per send attempt; the last one repeats. */
  sends?: SendOutcome[];
  /** Makes a write of agent meta fail (return true to fail it). */
  failSave?: (agent: Record<string, unknown>) => boolean;
  /** The turn is about a later message, with an earlier one before it. */
  laterMessage?: boolean;
}

function world(over: Options = {}) {
  const base = (id: string, at: number, body: string): FakeMessage => ({ id, tenantId: A, conversationId: CONV, direction: "in", sender: "customer", kind: "text", createdAt: new Date(at).toISOString(), body, meta: { agent: { extraction: { question: "Do you do home visits?" } } } } as FakeMessage);
  const messages = over.laterMessage ? [base(M1, NOW - 9000, "price?"), base(M2, NOW - 3000, "and visits?")] : [base(M1, NOW - 3000, "price?")];
  const fake = fakePipelineStore({
    tenants: [{ id: A, vertical: "sample-pack", verticalVersion: 1 }],
    messages,
    conversations: [{ id: CONV, tenantId: A, contactId: CONTACT, mode: "ai" }],
    contacts: [{ id: CONTACT, tenantId: A, language: null, optedOut: false, consentAt: "2026-10-01T00:00:00Z" }],
    leads: [{ id: LEAD, tenantId: A, contactId: CONTACT, stage: "engaged", createdAt: 1, fields: {} }],
    tenantInfo: { [A]: { name: "Skyline Homes", agentSettings: {} } },
  });
  const queue = [...(over.script ?? [GOOD])];
  const complete = vi.fn<(request: LlmRequest) => Promise<LlmResult>>(async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("the model was called more often than the test expected");
    if (next instanceof Error) throw next;
    return llmResult(next);
  });
  const outcomes = over.sends ?? [SENT];
  let sends = 0;
  const send = vi.fn<ReplyDeps["send"]>(async () => outcomes[Math.min(sends++, outcomes.length - 1)]);
  const audits: AuditEntry[] = [];
  const audit = vi.fn(async (entry: AuditEntry) => {
    audits.push(entry);
    if (entry.action === "message.answered" && entry.entityId) fake.answered.set(entry.entityId, Date.now());
  });
  const originalSave = fake.store.saveAgentMeta.bind(fake.store);
  const saves: Record<string, unknown>[] = [];
  fake.store.saveAgentMeta = async (...args) => {
    const agent = args[3];
    saves.push(agent);
    if (over.failSave?.(agent)) throw new Error("the database is down");
    return originalSave(...args);
  };
  const sendEvent = vi.fn<ReplyDeps["sendEvent"]>(async () => undefined);
  const systemNotice = { send: vi.fn(async (): Promise<{ status: "sent" }> => ({ status: "sent" })) };
  const deps: ReplyDeps = { store: fake.store, llm: { complete } as LlmClient, send, audit, sendEvent, systemNotice: systemNotice as unknown as SystemNoticePort, privacyPolicyUrl: "https://example.test/privacy", now: () => Date.now() };
  const last = over.laterMessage ? M2 : M1;
  const turn: TurnContext = { tenantId: A, conversationId: CONV, contactId: CONTACT, leadId: LEAD, leadCreated: false, messageIds: [last], language: null, vertical: "sample-pack", verticalVersion: 1 };
  const draftOn = (id = last) => ((fake.messages.get(id)?.meta?.agent ?? {}) as { draft?: unknown }).draft;
  const sentTexts = () => send.mock.calls.map((call) => (call[2] as { text?: string }).text);
  return { ...fake, complete, send, audit, audits, saves, sendEvent, deps, turn, draftOn, sentTexts, last };
}
type World = ReturnType<typeof world>;

/** One attempt of the step: the outcome, or the error the step threw (which makes Inngest run it again). */
const attempt = (w: World, step: StepRunner, startedAt = Date.now()) => replyTurn(step, w.turn, understood, startedAt, w.deps).then(
  (outcome) => ({ outcome, error: null as Error | null }),
  (error: unknown) => ({ outcome: null, error: error as Error }),
);

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("a send that waiting can fix: the retry reuses the reply already written", () => {
  it.each([1, 2, 3])("%i failure(s) and then it goes: one model call, the same text every time, under the same key, and one reply recorded", async (failures) => {
    const w = world({ script: [GOOD, GOOD_AGAIN, GOOD_AGAIN, GOOD_AGAIN], sends: [...Array.from({ length: failures }, () => RETRYABLE), SENT] });
    const step = runner();
    for (let i = 0; i < failures; i++) expect((await attempt(w, step)).error?.message).toMatch(/could not be sent/);
    const last = await attempt(w, step);
    expect(last.outcome?.reply).toMatchObject({ status: "sent", source: "model" });
    expect(w.complete).toHaveBeenCalledTimes(1);
    expect(w.sentTexts()).toEqual(Array.from({ length: failures + 1 }, () => GOOD));
    expect(new Set(w.send.mock.calls.map((c) => (c[2] as { idempotencyKey?: string }).idempotencyKey))).toEqual(new Set([`reply:${w.last}`]));
    expect(w.audits.filter((a) => a.action === "message.answered")).toHaveLength(1);
  });

  it("keeps the written reply on the turn's last message before the send, as a plan case and the text", async () => {
    const w = world({ sends: [RETRYABLE] });
    await attempt(w, runner());
    expect(w.draftOn()).toEqual({ case: expect.any(String), text: GOOD });
  });

  it("clears the draft in the same write that records the reply as sent", async () => {
    const w = world({ sends: [RETRYABLE, SENT] });
    const step = runner();
    await attempt(w, step);
    await attempt(w, step);
    expect(w.draftOn()).toBeNull();
    const sentWrite = w.saves.find((s) => s.reply !== undefined);
    expect(sentWrite).toMatchObject({ draft: null, reply: { source: "model" } });
  });

  it("when every retry fails, the model was still asked once, and the run gives up as it did (the failure handler sends the safe line)", async () => {
    const w = world({ sends: [RETRYABLE] });
    const step = runner();
    for (let i = 0; i < 4; i++) expect((await attempt(w, step)).error).not.toBeNull();
    expect(w.complete).toHaveBeenCalledTimes(1);
    expect(w.send).toHaveBeenCalledTimes(4);
    expect(w.draftOn()).toEqual({ case: expect.any(String), text: GOOD }); // still there: the reply is unsent and the next run may use it
  });

  it("is used even after the turn's clock has run out: it costs no model call, and beats the generic safe line", async () => {
    const w = world({ sends: [RETRYABLE, SENT] });
    const step = runner();
    await attempt(w, step);
    const late = await attempt(w, step, Date.now() - TURN_HARD_STOP_MS - 5000);
    expect(late.outcome?.reply).toMatchObject({ status: "sent", source: "model" });
    expect(w.sentTexts()).toEqual([GOOD, GOOD]);
    expect(w.complete).toHaveBeenCalledTimes(1);
  });

  it("without a draft, a turn past its clock still gets the safe line and no model call (unchanged)", async () => {
    const w = world();
    const result = await attempt(w, runner(), Date.now() - TURN_HARD_STOP_MS - 5000);
    expect(result.outcome?.reply).toMatchObject({ status: "sent", source: "fixed" });
    expect(w.complete).not.toHaveBeenCalled();
    expect(w.draftOn()).toBeUndefined();
  });
});

describe("the intended regenerate still works, and is counted once", () => {
  it("a reply the post-check refuses is written once more in the same attempt; the second one is kept; a retry makes no further call (two calls in all)", async () => {
    const w = world({ script: [BAD, GOOD], sends: [RETRYABLE, SENT] });
    const step = runner();
    expect((await attempt(w, step)).error).not.toBeNull();
    expect(w.complete).toHaveBeenCalledTimes(2);
    expect(w.draftOn()).toMatchObject({ text: GOOD });
    expect((await attempt(w, step)).outcome?.reply).toMatchObject({ status: "sent", source: "model" });
    expect(w.complete).toHaveBeenCalledTimes(2);
    expect(w.sentTexts()).toEqual([GOOD, GOOD]);
  });

  it("the refused first try is never kept or sent", async () => {
    const w = world({ script: [BAD, GOOD] });
    await attempt(w, runner());
    expect(w.sentTexts()).toEqual([GOOD]);
    expect(JSON.stringify(w.saves)).not.toContain("99 lakh");
  });

  it("a reply refused twice becomes the safe line, which is not kept; a retry asks the model again, as a first attempt would (two calls, then one: three in all)", async () => {
    const w = world({ script: [BAD, BAD, GOOD, GOOD], sends: [RETRYABLE, SENT] });
    const step = runner();
    expect((await attempt(w, step)).error).not.toBeNull();
    expect(w.complete).toHaveBeenCalledTimes(2);
    expect(w.draftOn()).toBeUndefined();
    const second = await attempt(w, step);
    expect(second.outcome?.reply).toMatchObject({ status: "sent", source: "model" });
    expect(w.complete).toHaveBeenCalledTimes(3);
    expect(w.sentTexts()[1]).toBe(GOOD);
  });
});

describe("a model that failed is not remembered", () => {
  it("the safe line after a model error is not kept: a retry gives the model another chance, and a real answer goes out", async () => {
    const w = world({ script: [new LlmError("timeout", undefined, 3), GOOD], sends: [RETRYABLE, SENT] });
    const step = runner();
    expect((await attempt(w, step)).error).not.toBeNull();
    expect(w.draftOn()).toBeUndefined();
    const second = await attempt(w, step);
    expect(second.outcome?.reply).toMatchObject({ status: "sent", source: "model" });
    expect(w.complete).toHaveBeenCalledTimes(2);
    expect(w.sentTexts()[0]).toMatch(/Let me confirm/);
    expect(w.sentTexts()[1]).toBe(GOOD);
  });

  it("fixed words are never kept (they cost nothing to write again)", async () => {
    const w = world({ script: [new LlmError("timeout", undefined, 3)], sends: [SENT] });
    await attempt(w, runner());
    expect(w.draftOn()).toBeUndefined();
    expect(w.saves.some((s) => "draft" in s)).toBe(false);
  });
});

describe("a draft is used only when it still fits", () => {
  const withDraft = async (change: (draft: { case: string; text: string }) => unknown) => {
    const w = world({ script: [GOOD, GOOD_AGAIN], sends: [RETRYABLE, SENT] });
    const step = runner();
    await attempt(w, step);
    const kept = w.draftOn() as { case: string; text: string };
    w.messages.get(w.last)!.meta = { agent: { ...(w.messages.get(w.last)!.meta!.agent as object), draft: change(kept) } };
    return { w, step };
  };

  it("not when it was written for another plan case: the model is asked again", async () => {
    const { w, step } = await withDraft((d) => ({ ...d, case: "some_other_case" }));
    const second = await attempt(w, step);
    expect(second.outcome?.reply).toMatchObject({ status: "sent" });
    expect(w.complete).toHaveBeenCalledTimes(2);
    expect(w.sentTexts()[1]).toBe(GOOD_AGAIN);
  });

  it("not when it no longer passes the post-check against the facts (a price the knowledge base does not hold)", async () => {
    const { w, step } = await withDraft((d) => ({ ...d, text: BAD }));
    await attempt(w, step);
    expect(w.complete).toHaveBeenCalledTimes(2);
    expect(w.sentTexts()[1]).toBe(GOOD_AGAIN);
    expect(w.sentTexts()).not.toContain(BAD);
  });

  it.each([["not an object", "text"], ["no text", { case: "x" }], ["an empty text", { case: "x", text: "" }], ["a text that is not text", { case: "x", text: 5 }], ["null", null]])("not when it is malformed (%s)", async (_name, junk) => {
    const { w, step } = await withDraft(() => junk);
    await attempt(w, step);
    expect(w.complete).toHaveBeenCalledTimes(2);
  });

  it("never one kept for an earlier message: each turn looks only at its own last message", async () => {
    const w = world({ laterMessage: true, script: [GOOD_AGAIN] });
    const earlier = w.messages.get(M1)!;
    earlier.meta = { agent: { ...(earlier.meta!.agent as object), draft: { case: "answer_from_kb", text: GOOD } } };
    await attempt(w, runner());
    expect(w.complete).toHaveBeenCalledTimes(1);
    expect(w.sentTexts()).toEqual([GOOD_AGAIN]);
  });

  it("not for a reply that was already sent: the answered check comes first and nothing is asked or sent", async () => {
    const w = world({ sends: [RETRYABLE] });
    const step = runner();
    await attempt(w, step);
    w.answered.set(w.last, Date.now());
    const again = await attempt(w, runner());
    expect(again.outcome?.reply).toMatchObject({ status: "already_answered" });
    expect(w.complete).toHaveBeenCalledTimes(1);
    expect(w.send).toHaveBeenCalledTimes(1);
  });
});

describe("when the send ends for good, the unused draft is cleared (best effort)", () => {
  it.each([
    ["a send refused for good (not retryable)", [PERMANENT], { status: "not_sent", reason: "send_failed" }],
    ["a send skipped: outside the 24 hours", [{ status: "skipped", reason: "outside_window" } as SendOutcome], { status: "not_sent", reason: "outside_window" }],
    ["a send skipped: the feature is off", [{ status: "skipped", reason: "feature_off" } as SendOutcome], { status: "not_sent", reason: "feature_off" }],
    ["a send skipped: no credits", [{ status: "skipped", reason: "insufficient_credits" } as SendOutcome], { status: "no_credits" }],
    ["a send whose outcome is unknown (it may have gone out)", [UNKNOWN], { status: "sent_unknown" }],
  ])("%s", async (_name, sends, expected) => {
    const w = world({ sends });
    const result = await attempt(w, runner());
    expect(result.error).toBeNull();
    expect(result.outcome?.reply).toMatchObject(expected);
    expect(w.complete).toHaveBeenCalledTimes(1);
    expect(w.send).toHaveBeenCalledTimes(1); // not retried
    expect(w.draftOn()).toBeNull();
  });

  it("when the clearing write fails it is logged without the reply or anything else, and the turn's result is unchanged", async () => {
    const w = world({ sends: [PERMANENT], failSave: (agent) => agent.draft === null });
    const result = await attempt(w, runner());
    expect(result.error).toBeNull();
    expect(result.outcome?.reply).toMatchObject({ status: "not_sent", reason: "send_failed" });
    const lines = errors.mock.calls.map((call: unknown[]) => call.join(" "));
    expect(lines.some((line: string) => /draft could not be cleared/i.test(line))).toBe(true);
    expect(lines.join("\n")).not.toContain("site visits");
    expect(w.draftOn()).toEqual({ case: expect.any(String), text: GOOD }); // left in place: nothing used it
  });

  it("a refusal before the send (the staff took the chat, or the customer opted out) clears it too", async () => {
    const w = world({ sends: [SENT] });
    w.conversations.get(CONV)!.mode = "human";
    const result = await attempt(w, runner());
    expect(result.outcome?.reply).toMatchObject({ status: "not_sent", reason: "not_ai_mode" });
    expect(w.send).not.toHaveBeenCalled();
    expect(w.draftOn()).toBeNull();
  });
});

describe("when a database write fails", () => {
  it("keeping the draft fails: it is logged without the reply, the reply is sent anyway, and the cost is only that a retry would ask the model again", async () => {
    const w = world({ script: [GOOD, GOOD_AGAIN], sends: [RETRYABLE, SENT], failSave: (agent) => "draft" in agent && agent.draft !== null });
    const step = runner();
    expect((await attempt(w, step)).error?.message).toMatch(/could not be sent/);
    expect(w.send).toHaveBeenCalledTimes(1);
    const second = await attempt(w, step);
    expect(second.outcome?.reply).toMatchObject({ status: "sent" });
    expect(w.complete).toHaveBeenCalledTimes(2);
    const lines = errors.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
    expect(lines).toMatch(/written reply could not be kept/i);
    expect(lines).not.toContain("site visits");
  });

  it("the marker or the answered rows fail after the send: absorbed, never a second send (unchanged)", async () => {
    const w = world({ failSave: (agent) => agent.reply !== undefined });
    const result = await attempt(w, runner());
    expect(result.error).toBeNull();
    expect(result.outcome?.reply).toMatchObject({ status: "sent" });
    expect(w.send).toHaveBeenCalledTimes(1);
  });
});

describe("nothing of the reply is written to a log", () => {
  it("across a retry, a regenerate and a failed send, no line holds a word of the reply", async () => {
    const w = world({ script: [BAD, GOOD], sends: [RETRYABLE, SENT] });
    const spies = [errors, vi.spyOn(console, "log"), vi.spyOn(console, "warn")];
    const step = runner();
    await attempt(w, step);
    await attempt(w, step);
    const all = spies.flatMap((s) => s.mock.calls.map((call: unknown[]) => call.join(" "))).join("\n");
    expect(all).not.toMatch(/site visits|99 lakh|Shall we plan/);
  });
});
