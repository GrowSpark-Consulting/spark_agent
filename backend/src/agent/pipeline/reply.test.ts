import { NonRetriableError } from "inngest";
import { describe, expect, it, vi } from "vitest";
import type { AuditEntry } from "../../lib/audit";
import type { SendOutcome } from "../../notify/send";
import { fakePipelineStore, HIDDEN, type FakeMessage } from "../../test-support/fake-pipeline-store";
import { LlmError, type LlmClient, type LlmRequest, type LlmResult } from "../llm/anthropic";
import { consentNotice, fixedText } from "./fixed-texts";
import type { SystemNoticePort } from "./ports";
import type { StepRunner, TurnContext } from "./process-message";
import { answerAfterFailure, replyTurn, type ReplyDeps } from "./reply";
import type { Retrieval, UnderstandResult } from "./understand";

// Step 7 and the send: the plan's reply is written (the model for an answer, fixed words for the rest), checked,
// sent through notify.send, and recorded as answered, in one step; a handover follows when the plan or the credits
// say so. The store, the model, notify.send, the audit and the queue are fakes; plan.ts has its own table of cases.

const A = "e0000000-0000-0000-0000-00000000000a";
const CONV = "c0000000-0000-0000-0000-00000000000c";
const CONTACT = "b0000000-0000-0000-0000-0000000000b1";
const LEAD = "10000000-0000-0000-0000-0000000000f1";
const M0 = "a0000000-0000-0000-0000-0000000000a0";
const M1 = "a0000000-0000-0000-0000-0000000000a1";
const M2 = "a0000000-0000-0000-0000-0000000000a2";
const NOW = Date.now();
const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();
const QUESTION = "Do you do home visits?";
const CUSTOMER_WORDS = "home visits pannuveengala";

const PRIVACY_URL = "https://example.test/privacy";
const SENT: SendOutcome = { status: "sent", messageId: "m-out", providerMsgId: "wamid.OUT", creditsCharged: 1, usedTemplate: false };
const llmResult = (text: string): LlmResult => ({ text, model: "claude-sonnet-5-5", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.01, latencyMs: 2000, attempts: 1, requestId: null });

function runner() {
  const memo = new Map<string, unknown>();
  const ran: string[] = [];
  const attempts = new Map<string, number>();
  const step: StepRunner = {
    async run(id, fn) {
      if (memo.has(id)) return memo.get(id) as never;
      ran.push(id);
      attempts.set(id, (attempts.get(id) ?? 0) + 1);
      const value = await fn();
      memo.set(id, value);
      return value;
    },
  };
  return { step, ran, memo, attempts };
}

const found: Retrieval = { outcome: "found", chunks: [{ documentId: "d1", title: "Brochure", content: "Site visits are free, Fri 9 Oct 5:00 pm. 2BHK starts at ₹78 lakh.", similarity: 0.7 }] };
const understood = (retrieval: Retrieval, over: Record<string, unknown> = {}): UnderstandResult => ({
  status: "understood",
  summary: { intent: "question", language: "en", sentiment: "neutral", asksIfHuman: false, notInterested: false, confidence: 0.9, hasQuestion: true, fieldKeys: [], ...over },
  retrieval,
});

interface WorldOptions {
  script?: (string | Error)[];
  send?: (n: number) => SendOutcome | Promise<SendOutcome>;
  messages?: FakeMessage[];
  mode?: "ai" | "human" | "external";
  optedOut?: boolean;
  language?: string | null;
  /** When the notice was first shown to the contact; the default is "long ago", so most tests are about a contact who has seen it. */
  consentAt?: string | null;
  agentSettings?: unknown;
  businessName?: string;
  question?: string | null;
  answered?: boolean;
  auditFailures?: number;
  prior?: { misses: number }[]; // earlier customer messages, oldest first, each with the count its turn left
}

function world(over: WorldOptions = {}) {
  const customer = (id: string, secondsAgo: number, meta: Record<string, unknown> = {}, body: string | null = CUSTOMER_WORDS): FakeMessage => ({
    id, tenantId: A, conversationId: CONV, direction: "in", sender: "customer", kind: "text", createdAt: at(secondsAgo), body, meta,
  });
  const question = over.question === undefined ? QUESTION : over.question;
  const prior = (over.prior ?? []).map((p, i) => customer(`a0000000-0000-0000-0000-00000000010${i}`, 600 - i * 60, { agent: { kbMisses: p.misses } }, `earlier ${i}`));
  const messages = over.messages ?? [...prior, customer(M1, 3, { agent: { extraction: { question } } })];
  const fake = fakePipelineStore({
    tenants: [{ id: A, vertical: "sample-pack", verticalVersion: 1 }],
    messages,
    conversations: [{ id: CONV, tenantId: A, contactId: CONTACT, mode: over.mode ?? "ai" }],
    contacts: [{ id: CONTACT, tenantId: A, language: over.language === undefined ? null : over.language, optedOut: over.optedOut ?? false, consentAt: over.consentAt === undefined ? "2026-10-01T00:00:00Z" : over.consentAt }],
    leads: [{ id: LEAD, tenantId: A, contactId: CONTACT, stage: "engaged", createdAt: 1, fields: {} }],
    tenantInfo: { [A]: { name: over.businessName ?? "Skyline Homes", agentSettings: over.agentSettings ?? {} } },
    answered: over.answered ? [M1] : [],
  });
  const queue = [...(over.script ?? ["Yes, we do site visits. Shall we plan one?"])];
  const complete = vi.fn<(request: LlmRequest) => Promise<LlmResult>>(async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("the model was called more often than the test expected");
    if (typeof next === "string") return llmResult(next);
    throw next;
  });
  const llm: LlmClient = { complete };
  let sends = 0;
  const send = vi.fn<ReplyDeps["send"]>(async () => (over.send ? over.send(++sends) : SENT));
  const audits: AuditEntry[] = [];
  let auditFailures = over.auditFailures ?? 0;
  const audit = vi.fn(async (entry: AuditEntry) => {
    if (auditFailures > 0) {
      auditFailures--;
      throw new Error("audit down");
    }
    audits.push(entry);
    if (entry.action === "message.answered" && entry.entityId) fake.answered.set(entry.entityId, Date.now());
  });
  const sendEvent = vi.fn<ReplyDeps["sendEvent"]>(async () => undefined);
  const systemNotice = { send: vi.fn(async (): Promise<{ status: "awaiting_notify_kind" }> => ({ status: "awaiting_notify_kind" })) };
  const deps: ReplyDeps = { store: fake.store, llm, send, audit, sendEvent, systemNotice: systemNotice as SystemNoticePort, privacyPolicyUrl: PRIVACY_URL, now: () => Date.now() };
  const turn: TurnContext = {
    tenantId: A, conversationId: CONV, contactId: CONTACT, leadId: LEAD, leadCreated: false,
    messageIds: over.messages ? over.messages.map((m) => m.id).filter((id) => !id.startsWith("a0000000-0000-0000-0000-00000000010")) : [M1],
    language: null, vertical: "sample-pack", verticalVersion: 1,
  };
  return { ...fake, complete, send, audit, audits, sendEvent, systemNotice, deps, turn };
}

/** Staff are told once, by Dev 2's handoff-alert job, from ONE handoff.opened event (id handoff_opened:<handoffId>). The pipeline has no alert call of its own. */
function expectOneAlertEvent(w: ReturnType<typeof world>): void {
  expect(w.deps).not.toHaveProperty("staffAlert");
  expect(w.handoffs).toHaveLength(1);
  const opened = w.sendEvent.mock.calls.filter(([event]) => event.name === "handoff.opened");
  expect(opened).toHaveLength(1);
  expect(opened[0][0]).toEqual({ id: `handoff_opened:${w.handoffs[0].id}`, name: "handoff.opened", data: { tenantId: A, conversationId: CONV, handoffId: w.handoffs[0].id } });
}

const sentText = (w: ReturnType<typeof world>, n = 0) => w.send.mock.calls[n][2].text;

describe("an answer from the knowledge base", () => {
  it("is written by the model from the facts, sent through notify.send as an ai_reply into this chat, and recorded as answered", async () => {
    const w = world();
    const r = runner();
    const out = await replyTurn(r.step, w.turn, understood(found), Date.now(), w.deps);
    expect(out).toMatchObject({ case: "answered_from_kb", reply: { status: "sent", source: "model" }, handoff: null });
    expect(w.send).toHaveBeenCalledOnce();
    expect(w.send).toHaveBeenCalledWith(A, "ai_reply", { conversationId: CONV, text: "Yes, we do site visits. Shall we plan one?", idempotencyKey: `reply:${M1}` });
    expect(w.audits).toEqual([{ tenantId: A, actor: "ai", action: "message.answered", entity: "message", entityId: M1 }]);
    expect(r.ran).toEqual(["plan", "reply"]);
  });

  it("asks the strong model with the business's name, the facts, the conversation and the customer's language, under the turn's deadline", async () => {
    const w = world({ agentSettings: { persona: "Maya", tone: "formal" } });
    await replyTurn(runner().step, w.turn, understood(found, { language: "ta-en" }), Date.now(), w.deps);
    const request = w.complete.mock.calls[0][0];
    expect(request).toMatchObject({ role: "reply", tenantId: A, conversationId: CONV, prompt: { name: "reply", version: 2 } });
    const system = request.system.map((b) => b.text).join("\n");
    expect(system).toContain("Skyline Homes");
    expect(system).toContain("Maya");
    expect(system).toMatch(/formal/i);
    const user = request.messages[0].content;
    expect(user).toContain(CUSTOMER_WORDS); // the conversation
    expect(user).toContain("2BHK starts at ₹78 lakh"); // the facts
    expect(user).toMatch(/Tanglish|English letters/);
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it("is 'the assistant of {business}' when the business has chosen no persona", async () => {
    const w = world({ businessName: "Skyline Homes" });
    await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    const system = w.complete.mock.calls[0][0].system.map((b) => b.text).join("\n");
    expect(system).toMatch(/the assistant of Skyline Homes/);
  });

  it("ignores an agent_settings it cannot read, and still answers", async () => {
    const w = world({ agentSettings: { persona: { x: 1 }, tone: 42 } });
    expect((await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps)).reply.status).toBe("sent");
  });

  it("writes the answered row for every message of the turn", async () => {
    const mk = (id: string, s: number): FakeMessage => ({ id, tenantId: A, conversationId: CONV, direction: "in", sender: "customer", kind: "text", createdAt: at(s), body: "x", meta: id === M2 ? { agent: { extraction: { question: QUESTION } } } : {} });
    const w = world({ messages: [mk(M0, 6), mk(M1, 4), mk(M2, 2)] });
    await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    expect(w.audits.map((a) => a.entityId)).toEqual([M0, M1, M2]);
    expect(w.send).toHaveBeenCalledOnce(); // one reply for the whole burst
  });
});

describe("the post-check", () => {
  it("passes an amount that is in the facts, written another way (numeric value)", async () => {
    const w = world({ script: ["A 2BHK starts at ₹78,00,000."] });
    const out = await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    expect(out.reply).toMatchObject({ status: "sent", source: "model" });
    expect(w.complete).toHaveBeenCalledOnce();
  });

  it("regenerates once, with the reason, when the reply has a price that is not in the facts, and sends the second if it is good", async () => {
    const w = world({ script: ["A 2BHK starts at ₹65 lakh.", "A 2BHK starts at ₹78 lakh."] });
    const out = await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    expect(out.reply).toMatchObject({ status: "sent", source: "model" });
    expect(w.complete).toHaveBeenCalledTimes(2);
    const second = w.complete.mock.calls[1][0].messages;
    expect(second.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(second[2].content).toMatch(/amounts, dates and times/);
    expect(sentText(w)).toBe("A 2BHK starts at ₹78 lakh.");
  });

  it("sends exactly 'Let me confirm that with the team' when the second reply is no better, and never asks a third time", async () => {
    const w = world({ script: ["₹65 lakh", "₹60 lakh", "never asked"] });
    const out = await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    expect(out.reply).toMatchObject({ status: "sent", source: "fixed" });
    expect(sentText(w)).toBe("Let me confirm that with the team");
    expect(w.complete).toHaveBeenCalledTimes(2);
  });

  it("catches a date, a time, a reply over 600 characters and one with three questions, the same way", async () => {
    for (const bad of ["Come on 12 Oct.", "Come at 6 pm.", "x".repeat(601), "Budget? Area? Timeline?"]) {
      const w = world({ script: [bad, bad] });
      await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
      expect(sentText(w)).toBe("Let me confirm that with the team");
    }
  });

  it("says the safe line in the customer's language: Tamil script, Tanglish, Hindi", async () => {
    for (const language of ["ta", "ta-en", "hi"] as const) {
      const w = world({ script: ["₹1", "₹2"] });
      await replyTurn(runner().step, w.turn, understood(found, { language }), Date.now(), w.deps);
      expect(sentText(w)).toBe(fixedText("fallback", language));
    }
  });
});

describe("the language model fails", () => {
  it.each(["rate_limited", "unavailable", "timeout", "aborted", "rejected", "refusal", "truncated", "empty", "invalid_request"] as const)("(%s) the customer still gets the safe line", async (code) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const w = world({ script: [new LlmError(code, 500, 3)] });
    const out = await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    expect(out.reply).toMatchObject({ status: "sent", source: "fixed" });
    expect(sentText(w)).toBe("Let me confirm that with the team");
    expect(w.audits).toHaveLength(1);
  });

  it("an unexpected error does too, and its words are not logged", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const w = world({ script: [new Error("secret provider detail")] });
    expect((await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps)).reply.status).toBe("sent");
    expect(log.mock.calls.flat().join(" ")).not.toContain("secret provider detail");
  });
});

describe("the turn's deadline", () => {
  it("past the hard stop, no model is called: the safe line goes out", async () => {
    const w = world();
    const out = await replyTurn(runner().step, w.turn, understood(found), Date.now() - 26_000, w.deps);
    expect(out).toMatchObject({ case: "deadline", reply: { status: "sent", source: "fixed" } });
    expect(w.complete).not.toHaveBeenCalled();
    expect(sentText(w)).toBe("Let me confirm that with the team");
  });

  it("when the time runs out between the plan and the reply, the safe line goes out instead of a model call", async () => {
    const w = world();
    let clockCalls = 0;
    w.deps.now = () => (++clockCalls < 2 ? Date.now() : Date.now() + 30_000); // the plan step sees time left, the reply step none
    const out = await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    expect(out.reply).toMatchObject({ status: "sent", source: "fixed" });
    expect(w.complete).not.toHaveBeenCalled();
  });
});

describe("every way step 4 ends has an answer", () => {
  const cases: [string, UnderstandResult, string][] = [
    ["a fallback (the answer was not usable)", { status: "fallback", reason: "invalid_output" }, "clarify"],
    ["a fallback (no text)", { status: "fallback", reason: "no_text" }, "clarify"],
    ["a fallback (the model declined)", { status: "fallback", reason: "model_declined" }, "clarify"],
    ["the language model could not be reached", { status: "model_unavailable" }, "fallback"],
    ["no usable pack", { status: "no_pack" }, "fallback"],
    ["a search that could not run", understood({ outcome: "unavailable" }), "fallback"],
    ["a search with no answer", understood({ outcome: "none" }), "fallback"],
    ["a message that may be about leaving", understood({ outcome: "skipped" }, { intent: "unclear_exit" }), "exit_question"],
    ["a doubtful opt-out (below 0.8)", understood({ outcome: "skipped" }, { intent: "opt_out", confidence: 0.79 }), "exit_question"],
  ];

  it.each(cases)("%s: exactly one reply is sent, in fixed words, and recorded", async (_name, result, key) => {
    const w = world();
    const out = await replyTurn(runner().step, w.turn, result, Date.now(), w.deps);
    expect(w.send).toHaveBeenCalledOnce();
    expect(w.complete).not.toHaveBeenCalled(); // no model call: nothing to be steered, nothing that can fail
    // the exit question goes as reply buttons: its text is the short line with the STOP hint
    const payload = w.send.mock.calls[0][2];
    expect(key === "exit_question" ? payload.interactive?.body : payload.text).toBe(fixedText(key === "exit_question" ? "exit_prompt" : (key as "fallback"), "en"));
    expect(out.reply).toMatchObject({ status: "sent", source: "fixed" });
    expect(w.audits.filter((a) => a.action === "message.answered")).toHaveLength(1);
  });

  it.each([
    ["off topic", understood({ outcome: "skipped" }, { intent: "off_topic" })],
    ["a greeting", understood({ outcome: "skipped" }, { intent: "greeting", hasQuestion: false })],
    ["details given", understood({ outcome: "skipped" }, { intent: "give_details", hasQuestion: false })],
  ])("%s: one reply written by the model and sent", async (_name, result) => {
    const w = world({ script: ["Happy to help with our homes."] });
    await replyTurn(runner().step, w.turn, result, Date.now(), w.deps);
    expect(w.complete).toHaveBeenCalledOnce();
    expect(w.send).toHaveBeenCalledOnce();
  });

  it("no usable pack also opens a handover (stuck) so a person looks at the setup", async () => {
    const w = world();
    const out = await replyTurn(runner().step, w.turn, { status: "no_pack" }, Date.now(), w.deps);
    expect(out.handoff).toMatchObject({ trigger: "stuck", opened: true, switched: true });
    expect(w.handoffs[0]).toMatchObject({ trigger: "stuck", priority: "normal" });
    expectOneAlertEvent(w); // the owner is told by the handoff-alert job from handoff.opened, not by the pipeline
  });
});

describe("a question the knowledge base cannot answer", () => {
  const none = understood({ outcome: "none" });

  it("is recorded as a gap once, under its normalised form, for this business and contact", async () => {
    const w = world();
    await replyTurn(runner().step, w.turn, none, Date.now(), w.deps);
    expect([...w.gaps.values()]).toEqual([expect.objectContaining({ tenantId: A, norm: "do you do home visits", question: QUESTION, contactId: CONTACT, askedCount: 1 })]);
  });

  it("is not counted twice when the plan step is retried or the event repeats", async () => {
    const w = world();
    await replyTurn(runner().step, w.turn, none, Date.now(), w.deps);
    await replyTurn(runner().step, w.turn, none, Date.now(), w.deps); // a new run for the same turn
    expect([...w.gaps.values()][0].askedCount).toBe(1);
    expect(w.send).toHaveBeenCalledOnce(); // and the customer got one reply
  });

  it("keeps the chat's count of misses on the message, and is no handover on the first", async () => {
    const w = world();
    const out = await replyTurn(runner().step, w.turn, none, Date.now(), w.deps);
    expect(out.handoff).toBeNull();
    expect(w.messages.get(M1)?.meta?.agent).toMatchObject({ kbMisses: 1, gapRecorded: true, planCase: "kb_miss" });
  });

  it("records nothing for a question that has no words to count (only punctuation)", async () => {
    const w = world({ question: "???" });
    await replyTurn(runner().step, w.turn, none, Date.now(), w.deps);
    expect(w.gaps.size).toBe(0);
    expect(w.send).toHaveBeenCalledOnce();
  });

  it("two misses in a row in one chat is a handover: the handover line, a kb_gap handoff, the chat to a person, the event", async () => {
    const w = world({ prior: [{ misses: 1 }] });
    const out = await replyTurn(runner().step, w.turn, none, Date.now(), w.deps);
    expect(out.case).toBe("kb_miss_handoff");
    expect(sentText(w)).toBe(fixedText("handoff", "en"));
    expect(out.handoff).toMatchObject({ trigger: "kb_gap", opened: true, switched: true });
    expect(w.handoffs).toEqual([expect.objectContaining({ trigger: "kb_gap", priority: "normal", resolved: false })]);
    expect(w.conversations.get(CONV)?.mode).toBe("human");
    expect(w.sendEvent).toHaveBeenCalledWith({ id: `handoff_opened:${w.handoffs[0].id}`, name: "handoff.opened", data: { tenantId: A, conversationId: CONV, handoffId: w.handoffs[0].id } });
    expect(w.audits.map((a) => a.action)).toEqual(["message.answered", "handoff.opened"]);
    expectOneAlertEvent(w);
  });

  it("a miss, an answered turn, then a miss is no handover", async () => {
    const w = world({ prior: [{ misses: 1 }, { misses: 0 }] });
    const out = await replyTurn(runner().step, w.turn, none, Date.now(), w.deps);
    expect(out.handoff).toBeNull();
    expect(w.conversations.get(CONV)?.mode).toBe("ai");
  });

  it("the same question from another customer is no handover: a gap's business-wide count is not a chat's misses", async () => {
    const first = world();
    await replyTurn(runner().step, first.turn, none, Date.now(), first.deps);
    const second = world();
    // the other customer's chat; the business already has this gap with a count of 5 from everyone together
    await second.store.recordKbGap(A, { question: QUESTION, questionNorm: "do you do home visits", contactId: CONTACT });
    for (let i = 0; i < 4; i++) await second.store.recordKbGap(A, { question: QUESTION, questionNorm: "do you do home visits", contactId: CONTACT });
    const out = await replyTurn(runner().step, second.turn, none, Date.now(), second.deps);
    expect(out.handoff).toBeNull();
    expect(sentText(second)).toBe(fixedText("fallback", "en"));
  });

  it("is no handover when the business turned that trigger off, and the customer still gets the safe line", async () => {
    const w = world({ prior: [{ misses: 1 }], agentSettings: { handoffTriggers: [{ key: "kb_gap", enabled: false }] } });
    const out = await replyTurn(runner().step, w.turn, none, Date.now(), w.deps);
    expect(out.handoff).toBeNull();
    expect(sentText(w)).toBe(fixedText("fallback", "en"));
  });
});

describe("when the business is out of credits", () => {
  const broke = () => world({ send: () => ({ status: "skipped", reason: "insufficient_credits" }), language: "ta" });

  it("sends no AI reply and records nothing as answered: the chat goes to a person, with a credits_exhausted handoff and the event", async () => {
    const w = broke();
    const out = await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    expect(out.reply).toEqual({ status: "no_credits" });
    expect(w.audits.filter((a) => a.action === "message.answered")).toEqual([]);
    expect(out.handoff).toMatchObject({ trigger: "credits_exhausted", opened: true, switched: true });
    expect(w.handoffs[0]).toMatchObject({ trigger: "credits_exhausted", priority: "high" });
    expect(w.conversations.get(CONV)?.mode).toBe("human");
    expect(w.sendEvent).toHaveBeenCalledOnce();
  });

  it("sends the holding line through the system notice, and the owner alert is only the handoff.opened event", async () => {
    const w = broke();
    const out = await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    expect(w.systemNotice.send).toHaveBeenCalledWith({ tenantId: A, conversationId: CONV, kind: "credits_holding", text: fixedText("credits_holding", "ta") });
    expectOneAlertEvent(w);
    expect(out.handoff).toMatchObject({ trigger: "credits_exhausted", holding: "awaiting_notify_kind" });
  });

  it("opens one handoff however often the turn runs, and sends the event once", async () => {
    const w = broke();
    await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    expect(w.handoffs).toHaveLength(1);
    expect(w.sendEvent).toHaveBeenCalledOnce(); // the second run found the handoff open and sent nothing more
    expect(w.systemNotice.send).toHaveBeenCalledOnce(); // a real message now: one holding line, not one per run
  });

  it("a holding line that fails does not fail the handover", async () => {
    const w = broke();
    w.systemNotice.send.mockRejectedValue(new Error("down"));
    const out = await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    expect(out.handoff).toMatchObject({ opened: true, holding: "failed" });
  });
});

describe("right before it sends", () => {
  it("does not send into a chat a person has taken over", async () => {
    for (const mode of ["human", "external"] as const) {
      const w = world({ mode });
      const out = await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
      expect(out.reply).toEqual({ status: "not_sent", reason: "not_ai_mode" });
      expect(w.send).not.toHaveBeenCalled();
      expect(w.audits).toEqual([]);
    }
  });

  // The race the AI/Human switch creates: the model takes seconds, and a person may take the chat over meanwhile.
  // The gate looked at the start (mode was ai); the reply step looks again after the text is written.
  it("does not send a reply that was being written when a person took over the chat", async () => {
    const w = world();
    w.complete.mockImplementationOnce(async () => {
      w.conversations.get(CONV)!.mode = "human"; // the takeover lands while the model is answering
      return llmResult("Yes, we do site visits. Shall we plan one?");
    });
    const out = await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    expect(w.complete).toHaveBeenCalledOnce(); // it really was mid-answer
    expect(out.reply).toEqual({ status: "not_sent", reason: "not_ai_mode" });
    expect(w.send).not.toHaveBeenCalled();
    expect(w.audits).toEqual([]);
  });

  it("does not send to a customer who has opted out", async () => {
    const w = world({ optedOut: true });
    expect((await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps)).reply).toEqual({ status: "not_sent", reason: "opted_out" });
    expect(w.send).not.toHaveBeenCalled();
  });

  it("does nothing for a handover when the reply was not sent", async () => {
    const w = world({ mode: "human", prior: [{ misses: 1 }] });
    const out = await replyTurn(runner().step, w.turn, understood({ outcome: "none" }), Date.now(), w.deps);
    expect(out.handoff).toBeNull();
    expect(w.handoffs).toEqual([]);
  });
});

describe("never two replies", () => {
  it("a turn whose last message has been answered sends nothing and calls no model", async () => {
    const w = world({ answered: true });
    const out = await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    expect(out.reply).toEqual({ status: "already_answered" });
    expect(w.send).not.toHaveBeenCalled();
    expect(w.complete).not.toHaveBeenCalled();
  });

  it("a second run of the same turn is the first's answer: one send", async () => {
    const w = world({ script: ["Yes!", "Yes again!"] });
    await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    const second = await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    expect(second.reply).toEqual({ status: "already_answered" });
    expect(w.send).toHaveBeenCalledOnce();
  });

  it("a send whose outcome is unknown counts as answered and is never sent again", async () => {
    const w = world({ send: () => ({ status: "failed", error: { code: "upstream_failed", message: "x", retryable: true, outcomeUnknown: true } }) });
    const out = await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    expect(out.reply).toEqual({ status: "sent_unknown" });
    expect(w.audits.filter((a) => a.action === "message.answered")).toHaveLength(1);
    await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    expect(w.send).toHaveBeenCalledOnce();
  });

  it("a send that failed in a way waiting can fix throws, so the step is tried again, and records nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const w = world({ send: () => ({ status: "failed", error: { code: "rate_limited", message: "x", retryable: true, outcomeUnknown: false } }) });
    await expect(replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps)).rejects.toThrow(/could not be sent/);
    expect(w.audits).toEqual([]);
  });

  it("a send that failed for good is not retried: not_sent, nothing recorded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const w = world({ send: () => ({ status: "failed", error: { code: "whatsapp_not_connected", message: "x", retryable: false, outcomeUnknown: false } }) });
    expect((await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps)).reply).toEqual({ status: "not_sent", reason: "send_failed" });
    expect(w.audits).toEqual([]);
  });

  it("the other refusals of notify.send send nothing and record nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const reason of ["feature_off", "opted_out", "outside_window"] as const) {
      const w = world({ send: () => ({ status: "skipped", reason }) });
      expect((await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps)).reply).toEqual({ status: "not_sent", reason });
      expect(w.audits).toEqual([]);
    }
  });

  it("the answered rows are tried again when the audit blips, and a failure there never throws (that would send the reply twice)", async () => {
    const blip = world({ auditFailures: 2 });
    await replyTurn(runner().step, blip.turn, understood(found), Date.now(), blip.deps);
    expect(blip.audits).toHaveLength(1);

    vi.spyOn(console, "error").mockImplementation(() => {});
    const down = world({ auditFailures: 99 });
    const out = await replyTurn(runner().step, down.turn, understood(found), Date.now(), down.deps);
    expect(out.reply.status).toBe("sent");
    expect(down.send).toHaveBeenCalledOnce();
  });
});

describe("the reply goes out under a key that names the turn (notify.send dedupes on it: a retry after Meta accepted the reply cannot send it twice)", () => {
  /** What notify.send does with a key: the first send is delivered, a repeat of the key returns that first outcome and delivers nothing. */
  function dedupe(w: ReturnType<typeof world>) {
    const delivered = new Map<string, SendOutcome>();
    w.send.mockImplementation(async (_tenant, _kind, payload) => {
      const key = payload.idempotencyKey as string;
      const earlier = delivered.get(key);
      if (earlier) return earlier;
      delivered.set(key, SENT);
      return SENT;
    });
    return delivered;
  }

  it("is named by the turn's last message, and is a legal notify.send key (1 to 200 characters)", async () => {
    const w = world();
    await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    const key = w.send.mock.calls[0][2].idempotencyKey;
    expect(key).toBe(`reply:${M1}`);
    expect(key?.length).toBeGreaterThan(0);
    expect(key?.length).toBeLessThanOrEqual(200);
  });

  it("is a different key for a different turn: a later message is a new reply", async () => {
    const later: FakeMessage = { id: M2, tenantId: A, conversationId: CONV, direction: "in", sender: "customer", kind: "text", createdAt: at(3), body: CUSTOMER_WORDS, meta: { agent: { extraction: { question: QUESTION } } } };
    const w = world({ messages: [later] });
    await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    expect(w.send.mock.calls[0][2].idempotencyKey).toBe(`reply:${M2}`);
  });

  it("is the same on every attempt: a retry after a send that waiting can fix sends under the key of the first", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const w = world({ script: ["Yes!", "Yes again!"], send: (n) => (n === 1 ? { status: "failed", error: { code: "rate_limited", message: "x", retryable: true, outcomeUnknown: false } } : SENT) });
    const r = runner();
    await expect(replyTurn(r.step, w.turn, understood(found), Date.now(), w.deps)).rejects.toThrow(/could not be sent/);
    await replyTurn(r.step, w.turn, understood(found), Date.now(), w.deps);
    expect(w.send.mock.calls.map((c) => c[2].idempotencyKey)).toEqual([`reply:${M1}`, `reply:${M1}`]);
  });

  it("a run that died after the send was accepted, with the marker and the answered rows lost, delivers the reply once when it runs again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const w = world({ script: ["Yes, we do site visits.", "Yes, we do site visits, shall we plan one?"], auditFailures: 99 });
    const delivered = dedupe(w);
    const original = w.store.saveAgentMeta.bind(w.store);
    w.store.saveAgentMeta = async (...args) => {
      if ((args[3] as { reply?: unknown }).reply !== undefined) throw new Error("the marker could not be written");
      return original(...args);
    };
    await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps); // delivered; nothing could be recorded
    const again = await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps); // the retry: nothing says it was answered
    expect(again.reply.status).toBe("sent");
    expect(w.send).toHaveBeenCalledTimes(2);
    expect([...delivered.keys()]).toEqual([`reply:${M1}`]); // one message reached the customer
  });

  it("the buttons refused and the plain-text line delivered, then a replay that lost its records: one message reaches the customer (the replay's buttons find the text under the shared key)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const unclear = () => understood({ outcome: "skipped" }, { intent: "unclear_exit", confidence: 0.7 });
    const refused: SendOutcome = { status: "failed", error: { code: "validation_failed", message: "x", retryable: false, outcomeUnknown: false } };
    const w = world({ auditFailures: 99 });
    const recorded = new Set<string>();
    let delivered = 0;
    w.send.mockImplementation(async (_tenant, _kind, payload) => {
      const key = payload.idempotencyKey as string;
      if (recorded.has(key)) return SENT; // notify.send: an earlier send of this key is returned, nothing is sent
      if (payload.interactive) return refused; // never recorded: nothing went out
      recorded.add(key);
      delivered++;
      return SENT;
    });
    const original = w.store.saveAgentMeta.bind(w.store);
    w.store.saveAgentMeta = async (...args) => {
      if ((args[3] as { reply?: unknown }).reply !== undefined) throw new Error("the marker could not be written");
      return original(...args);
    };
    await replyTurn(runner().step, w.turn, unclear(), Date.now(), w.deps); // buttons refused, text delivered, nothing recorded
    expect(w.send).toHaveBeenCalledTimes(2);
    await replyTurn(runner().step, w.turn, unclear(), Date.now(), w.deps); // the retry starts with the buttons again
    expect(w.send.mock.calls.map((c) => c[2].idempotencyKey)).toEqual([`reply:${M1}`, `reply:${M1}`, `reply:${M1}`]);
    expect(w.send).toHaveBeenCalledTimes(3); // the buttons, found as sent: no text is sent again
    expect(delivered).toBe(1);
  });

  it("the safe line after a run gave up has a key of its own, named by the message that started the run: it never shares a reply's name, whatever else is waiting", async () => {
    const image: FakeMessage = { id: M2, tenantId: A, conversationId: CONV, direction: "in", sender: "customer", kind: "image", createdAt: at(1), body: null, meta: {} };
    const text: FakeMessage = { id: M1, tenantId: A, conversationId: CONV, direction: "in", sender: "customer", kind: "text", createdAt: at(3), body: "price?", meta: {} };
    const w = world({ messages: [text, image] });
    expect(await answerAfterFailure({ tenantId: A, conversationId: CONV, messageId: M1 }, 15_000, w.deps)).toBe("sent");
    expect(w.send.mock.calls[0][2].idempotencyKey).toBe(`gave_up:${M1}`);
  });

  it("the safe line is sent under the same key if the failure handler runs twice for the same message", async () => {
    const w = world();
    const delivered = dedupe(w);
    const ids = { tenantId: A, conversationId: CONV, messageId: M1 };
    await answerAfterFailure(ids, 15_000, w.deps);
    w.answered.clear(); // as if the answered rows had not been written
    await answerAfterFailure(ids, 15_000, w.deps);
    expect(w.send.mock.calls.map((c) => c[2].idempotencyKey)).toEqual([`gave_up:${M1}`, `gave_up:${M1}`]);
    expect([...delivered.keys()]).toEqual([`gave_up:${M1}`]);
  });
});

describe("the privacy notice is a per-business setting, off by default (Raja, 9 Oct)", () => {
  it("is not added to the first reply, and notice_shown is never logged, when the setting is missing or false", async () => {
    for (const agentSettings of [undefined, {}, { privacyNotice: false }, { privacyNotice: "yes" }]) {
      const w = world({ consentAt: null, agentSettings });
      await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
      expect(sentText(w)).toBe("Yes, we do site visits. Shall we plan one?");
      expect(w.consentLogs).toEqual([]);
      expect(w.contacts.get(CONTACT)?.consentAt ?? null).toBeNull();
    }
  });

  it("is added once when the business turned it on: the first reply carries it, the second does not", async () => {
    const w = world({ consentAt: null, agentSettings: { privacyNotice: true }, script: ["First answer.", "Second answer."] });
    await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    expect(sentText(w, 0)).toContain(consentNotice("en", PRIVACY_URL));
    expect(w.consentLogs).toHaveLength(1);
  });
});

describe("the privacy notice on a contact's first AI reply (setting on)", () => {
  const first = (over: WorldOptions = {}) => world({ consentAt: null, agentSettings: { privacyNotice: true }, ...over });

  it("is added to the first reply, after a blank line, as one line with the policy link last", async () => {
    const w = first();
    await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    const text = sentText(w)!;
    expect(text).toBe(`Yes, we do site visits. Shall we plan one?\n\n${consentNotice("en", PRIVACY_URL)}`);
    expect(text.endsWith(PRIVACY_URL)).toBe(true);
    expect(text.split("\n\n")[1]).not.toContain("\n"); // one line
    expect(text).toContain("STOP");
  });

  it("is in the customer's language", async () => {
    for (const language of ["ta", "ta-en", "hi"] as const) {
      const w = first({ script: ["₹1", "₹2"] });
      await replyTurn(runner().step, w.turn, understood(found, { language }), Date.now(), w.deps);
      expect(sentText(w)).toBe(`${fixedText("fallback", language)}\n\n${consentNotice(language, PRIVACY_URL)}`);
    }
  });

  it("goes on a fixed line too (a clarifying question, the safe fallback, the handover line): it is the first AI reply whatever it says", async () => {
    for (const result of [{ status: "fallback", reason: "no_text" }, { status: "model_unavailable" }, understood({ outcome: "none" })] as UnderstandResult[]) {
      const w = first();
      await replyTurn(runner().step, w.turn, result, Date.now(), w.deps);
      expect(sentText(w)).toContain(consentNotice("en", PRIVACY_URL));
    }
  });

  it("is logged as notice_shown once, with the message that carried it, and sets consent_at", async () => {
    const w = first();
    await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    expect(w.consentLogs).toEqual([{ tenantId: A, contactId: CONTACT, event: "notice_shown", source: "first_message", messageId: "m-out" }]);
    expect(w.contacts.get(CONTACT)?.consentAt).toBeTruthy();
  });

  it("is not on the second reply: the contact has seen it", async () => {
    const w = first({ script: ["First reply.", "Second reply."] });
    await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    // the next turn of the same chat
    const next: FakeMessage = { id: M2, tenantId: A, conversationId: CONV, direction: "in", sender: "customer", kind: "text", createdAt: at(1), body: "another question", meta: { agent: { extraction: { question: "Another?" } } } };
    w.messages.set(M2, next);
    await replyTurn(runner().step, { ...w.turn, messageIds: [M2] }, understood(found), Date.now(), w.deps);
    expect(sentText(w, 1)).toBe("Second reply.");
    expect(w.consentLogs).toHaveLength(1);
  });

  it("is not recorded when nothing was sent: a chat a person has, an opt-out, no credits", async () => {
    for (const over of [{ mode: "human" as const }, { optedOut: true }, { send: () => ({ status: "skipped", reason: "insufficient_credits" }) as SendOutcome }]) {
      const w = first(over);
      await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
      expect(w.consentLogs).toEqual([]);
      expect(w.contacts.get(CONTACT)?.consentAt ?? null).toBeNull();
    }
  });

  it("is NOT recorded as shown when the send's outcome is unknown: the log must not say 'shown' for a message that may not have arrived; the next reply carries it again", async () => {
    const w = first({ send: () => ({ status: "failed", error: { code: "upstream_failed", message: "x", retryable: true, outcomeUnknown: true } }) });
    const out = await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    expect(out.reply).toEqual({ status: "sent_unknown" });
    expect(w.consentLogs).toEqual([]);
    expect(w.contacts.get(CONTACT)?.consentAt ?? null).toBeNull();
  });

  it("is not recorded, and not sent, when the customer sends STOP while the reply is being written", async () => {
    const w = first();
    w.complete.mockImplementationOnce(async () => {
      w.contacts.get(CONTACT)!.optedOut = true; // the STOP lands while the model works
      return llmResult("Yes, site visits are free.");
    });
    const out = await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    expect(out.reply).toEqual({ status: "not_sent", reason: "opted_out" });
    expect(w.send).not.toHaveBeenCalled();
    expect(w.consentLogs).toEqual([]);
  });

  it("is never logged twice: a repeated run finds the message answered", async () => {
    const w = first();
    await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    expect(w.send).toHaveBeenCalledOnce();
    expect(w.consentLogs).toHaveLength(1);
  });

  it("is not a reason to fail: if recording it fails the reply stays sent, and the next reply carries the notice again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const w = first({ script: ["First.", "Second."] });
    w.state.failNext.add("recordNoticeShown");
    const out = await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    expect(out.reply.status).toBe("sent");
    expect(w.send).toHaveBeenCalledOnce();
    w.messages.set(M2, { id: M2, tenantId: A, conversationId: CONV, direction: "in", sender: "customer", kind: "text", createdAt: at(1), body: "more", meta: { agent: { extraction: { question: "More?" } } } });
    await replyTurn(runner().step, { ...w.turn, messageIds: [M2] }, understood(found), Date.now(), w.deps);
    expect(sentText(w, 1)).toContain(consentNotice("en", PRIVACY_URL));
  });

  it("is not part of what the post-check reads or of the 600 characters: a full reply still gets it", async () => {
    const long = `${"a".repeat(590)} site visits are free`.slice(0, 600);
    const w = first({ script: [long] });
    await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    expect(sentText(w)!.startsWith(long)).toBe(true);
    expect(sentText(w)!.length).toBeGreaterThan(600);
    expect(w.complete).toHaveBeenCalledOnce(); // not regenerated for being long with the notice
  });

  it("is on the safe line sent after a run gave up too", async () => {
    const w = first({ language: "ta" });
    await answerAfterFailure({ tenantId: A, conversationId: CONV, messageId: M1 }, 15_000, w.deps);
    expect(sentText(w)).toBe(`${fixedText("fallback", "ta")}\n\n${consentNotice("ta", PRIVACY_URL)}`);
    expect(w.consentLogs).toHaveLength(1);
  });

  it("a STOP there opens the opt_out handoff and sends the event", async () => {
    const w = world({ messages: [{ id: M1, tenantId: A, conversationId: CONV, direction: "in", sender: "customer", kind: "text", createdAt: at(3), body: "STOP", meta: {} }] });
    await answerAfterFailure({ tenantId: A, conversationId: CONV, messageId: M1 }, 15_000, w.deps);
    expect(w.handoffs).toEqual([expect.objectContaining({ trigger: "opt_out", priority: "high" })]);
    expect(w.sendEvent).toHaveBeenCalledOnce();
  });

  it("still sends the safe line, without the notice, when the business's settings cannot be read", async () => {
    const w = first({ language: "ta" });
    w.state.failNext.add("getTenantReplyInfo");
    expect(await answerAfterFailure({ tenantId: A, conversationId: CONV, messageId: M1 }, 15_000, w.deps)).toBe("sent");
    expect(sentText(w)).toBe(fixedText("fallback", "ta"));
  });

  it("is not on the safe line when the setting is off (the default)", async () => {
    const w = world({ consentAt: null, language: "ta" });
    await answerAfterFailure({ tenantId: A, conversationId: CONV, messageId: M1 }, 15_000, w.deps);
    expect(sentText(w)).toBe(fixedText("fallback", "ta"));
    expect(w.consentLogs).toEqual([]);
  });

  it("but not when that send's outcome is unknown", async () => {
    const w = first({ send: () => ({ status: "failed", error: { code: "upstream_failed", message: "x", retryable: true, outcomeUnknown: true } }) });
    expect(await answerAfterFailure({ tenantId: A, conversationId: CONV, messageId: M1 }, 15_000, w.deps)).toBe("sent");
    expect(w.consentLogs).toEqual([]);
  });
});

describe("failures between the steps of a handover", () => {
  it("a handover whose switch to a person failed is finished by the retry, and the event is sent again (its id makes it one event)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const w = world({ prior: [{ misses: 1 }] });
    w.state.failNext.add("setConversationMode");
    const r = runner(); // the same runner: the steps that finished are not run again, as in Inngest
    await expect(replyTurn(r.step, w.turn, understood({ outcome: "none" }), Date.now(), w.deps)).rejects.toThrow(/setConversationMode failed/);
    expect(w.handoffs).toHaveLength(1); // the row was made
    const out = await replyTurn(r.step, w.turn, understood({ outcome: "none" }), Date.now(), w.deps);
    expect(out.handoff).toMatchObject({ trigger: "kb_gap", opened: false, switched: true });
    expect(w.handoffs).toHaveLength(1);
    expect(w.conversations.get(CONV)?.mode).toBe("human");
    const events = w.sendEvent.mock.calls.map(([e]) => e);
    expect(events.length).toBe(2);
    expect(new Set(events.map((e) => e.id)).size).toBe(1);
    expect(w.send).toHaveBeenCalledOnce(); // and the customer was answered once
  });

  it("a handover whose event could not be sent is retried, so staff are told", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const w = world({ send: () => ({ status: "skipped", reason: "insufficient_credits" }) });
    w.sendEvent.mockRejectedValueOnce(new Error("queue down"));
    const r = runner();
    await expect(replyTurn(r.step, w.turn, understood(found), Date.now(), w.deps)).rejects.toThrow(/queue down/);
    const out = await replyTurn(r.step, w.turn, understood(found), Date.now(), w.deps);
    expect(out.handoff).toMatchObject({ trigger: "credits_exhausted", switched: true });
    expect(w.sendEvent).toHaveBeenCalledTimes(2);
  });
});

describe("never two replies, even when the record of the first is missing", () => {
  it("the marker on the message stops a second reply when the answered rows could not be written, and the rows are written by the next run", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const w = world({ auditFailures: 3 }); // every try for the first message fails
    await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    expect(w.audits).toEqual([]);
    expect(w.send).toHaveBeenCalledOnce();
    const again = await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps); // a new run for the same turn
    expect(again.reply).toEqual({ status: "already_answered" });
    expect(w.send).toHaveBeenCalledOnce();
    expect(w.audits.map((a) => a.entityId)).toEqual([M1]); // the missing row is written now
  });

  it("looks once more right before the send: a run that answered while the model was thinking wins", async () => {
    const w = world();
    w.complete.mockImplementationOnce(async () => {
      w.answered.set(M1, Date.now()); // another run finishes while this one waits for the model
      return llmResult("Yes, site visits are free.");
    });
    const out = await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    expect(out.reply).toEqual({ status: "already_answered" });
    expect(w.send).not.toHaveBeenCalled();
  });
});

describe("the conversation the model sees", () => {
  it("ends with the turn's newest message: one that arrived after it is for the next turn", async () => {
    const later: FakeMessage = { id: "a0000000-0000-0000-0000-0000000000f9", tenantId: A, conversationId: CONV, direction: "in", sender: "customer", kind: "text", createdAt: at(1), body: "LATER MESSAGE", meta: {} };
    const w = world({ messages: [{ id: M1, tenantId: A, conversationId: CONV, direction: "in", sender: "customer", kind: "text", createdAt: at(3), body: CUSTOMER_WORDS, meta: { agent: { extraction: { question: QUESTION } } } }, later] });
    w.turn.messageIds = [M1];
    await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    const user = w.complete.mock.calls[0][0].messages[0].content;
    expect(user).toContain(CUSTOMER_WORDS);
    expect(user).not.toContain("LATER MESSAGE");
  });
});

describe("what the steps remember", () => {
  it("is case names, flags and ids: not the customer's words, the question, the reply or the facts (Inngest keeps every step's result)", async () => {
    const w = world({ prior: [{ misses: 1 }] });
    const r = runner();
    await replyTurn(r.step, w.turn, understood({ outcome: "none" }), Date.now(), w.deps);
    const remembered = JSON.stringify([...r.memo.values()]);
    for (const secret of [QUESTION, CUSTOMER_WORDS, "home visits", ...Object.values(HIDDEN), fixedText("handoff", "en"), fixedText("fallback", "en")]) expect(remembered, secret).not.toContain(secret);
    const answered = world();
    const r2 = runner();
    await replyTurn(r2.step, answered.turn, understood(found), Date.now(), answered.deps);
    const remembered2 = JSON.stringify([...r2.memo.values()]);
    for (const secret of [QUESTION, "2BHK starts", "site visits", "Shall we plan one"]) expect(remembered2, secret).not.toContain(secret);
  });

  it("never logs the customer's words, the reply or a phone number", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const w = world({ script: ["₹1 for you", "₹2 for you"] });
    await replyTurn(runner().step, w.turn, understood(found), Date.now(), w.deps);
    const logged = [...log.mock.calls, ...out.mock.calls].flat().join("\n");
    for (const secret of [CUSTOMER_WORDS, "₹1 for you", "for you", HIDDEN.phone, QUESTION]) expect(logged).not.toContain(secret);
  });
});

describe("another business", () => {
  it("never reads or answers a chat of another business, even with its ids", async () => {
    const w = world();
    const turn = { ...w.turn, tenantId: "e0000000-0000-0000-0000-00000000000b" };
    const out = await replyTurn(runner().step, turn, understood(found), Date.now(), w.deps).catch((e: unknown) => e);
    // the other business has no such message: the step cannot keep anything on it and stops
    expect(out).toBeInstanceOf(NonRetriableError);
    expect(w.send).not.toHaveBeenCalled();
  });
});

describe("answerAfterFailure: when a run gave up", () => {
  const ids = { tenantId: A, conversationId: CONV, messageId: M1 };

  it("sends the safe line once, in the customer's language, and marks the messages answered", async () => {
    const w = world({ language: "ta" });
    expect(await answerAfterFailure(ids, 15_000, w.deps)).toBe("sent");
    expect(sentText(w)).toBe(fixedText("fallback", "ta"));
    expect(w.audits.filter((a) => a.action === "message.answered").map((a) => a.entityId)).toEqual([M1]);
    expect(await answerAfterFailure(ids, 15_000, w.deps)).toBe("nothing_to_do"); // safe to call twice
    expect(w.send).toHaveBeenCalledOnce();
  });

  it("a run that died before its STOP check: the customer who sent STOP is opted out and gets no reply and no notice", async () => {
    const w = world({ consentAt: null, messages: [{ id: M1, tenantId: A, conversationId: CONV, direction: "in", sender: "customer", kind: "text", createdAt: at(3), body: "STOP", meta: {} }] });
    expect(await answerAfterFailure(ids, 15_000, w.deps)).toBe("opted_out");
    expect(w.send).not.toHaveBeenCalled();
    expect(w.contacts.get(CONTACT)?.optedOut).toBe(true);
    expect(w.consentLogs).toEqual([expect.objectContaining({ event: "opted_out", source: "stop_keyword" })]);
    expect(w.systemNotice.send).toHaveBeenCalledWith(expect.objectContaining({ kind: "opt_out_confirmation" }));
    expect(w.audits.filter((a) => a.action === "message.answered").map((a) => a.entityId)).toEqual([M1]);
  });

  it("the same, in a chat a person has", async () => {
    const w = world({ mode: "human", messages: [{ id: M1, tenantId: A, conversationId: CONV, direction: "in", sender: "customer", kind: "text", createdAt: at(3), body: "மெசேஜ் அனுப்பாதீர்கள்", meta: {} }] });
    expect(await answerAfterFailure(ids, 15_000, w.deps)).toBe("opted_out");
    expect(w.contacts.get(CONTACT)?.optedOut).toBe(true);
  });

  it("does nothing for a message that was answered, a chat a person has, or a customer who opted out", async () => {
    expect(await answerAfterFailure(ids, 15_000, world({ answered: true }).deps)).toBe("nothing_to_do");
    expect(await answerAfterFailure(ids, 15_000, world({ mode: "human" }).deps)).toBe("nothing_to_do");
    expect(await answerAfterFailure(ids, 15_000, world({ optedOut: true }).deps)).toBe("nothing_to_do");
  });

  it("does nothing for a message that is not there or not the customer's, and never throws", async () => {
    const w = world();
    expect(await answerAfterFailure({ ...ids, messageId: "a0000000-0000-0000-0000-0000000000ff" }, 15_000, w.deps)).toBe("nothing_to_do");
    w.state.failNext.add("recentUnanswered");
    expect(await answerAfterFailure(ids, 15_000, w.deps)).toBe("not_sent");
  });

  it("does not mark anything answered when the send was refused (out of credits)", async () => {
    const w = world({ send: () => ({ status: "skipped", reason: "insufficient_credits" }) });
    expect(await answerAfterFailure(ids, 15_000, w.deps)).toBe("not_sent");
    expect(w.audits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Raja's decisions of 9 Oct: a person for an angry or asking customer, an opt-out the model read, and the unclear question.

describe("a customer who wants a person, or is unhappy or angry", () => {
  it.each([
    ["wants a person", { intent: "talk_to_human" }, "asked_human"],
    ["has a complaint", { intent: "complaint" }, "complaint"],
    ["is angry", { intent: "question", sentiment: "angry" }, "complaint"],
  ])("%s: the handover line, the chat goes to a person, a high-priority handover and the event", async (_name, over, trigger) => {
    const w = world();
    const out = await replyTurn(runner().step, w.turn, understood({ outcome: "skipped" }, over), Date.now(), w.deps);
    expect(sentText(w)).toBe(fixedText(trigger === "complaint" ? "handoff_sorry" : "handoff", "en")); // an angry or complaining customer gets one short sorry first
    expect(w.complete).not.toHaveBeenCalled(); // plain code decided; no model wrote anything
    expect(out.handoff).toMatchObject({ trigger, opened: true, switched: true });
    expect(w.handoffs).toEqual([expect.objectContaining({ trigger, priority: "high" })]);
    expect(w.conversations.get(CONV)?.mode).toBe("human");
    expect(w.sendEvent).toHaveBeenCalledWith(expect.objectContaining({ name: "handoff.opened", id: `handoff_opened:${w.handoffs[0].id}` }));
  });

  it("asking only whether it is a bot is answered like any question, with no handover", async () => {
    const w = world();
    await replyTurn(runner().step, w.turn, understood(found, { asksIfHuman: true }), Date.now(), w.deps);
    expect(w.handoffs).toEqual([]);
    expect(w.conversations.get(CONV)?.mode).toBe("ai");
  });

  it("a business that switched the handover off gets the message answered normally", async () => {
    const w = world({ agentSettings: { handoffTriggers: [{ key: "complaint", enabled: false }] } });
    await replyTurn(runner().step, w.turn, understood(found, { intent: "complaint" }), Date.now(), w.deps);
    expect(w.handoffs).toEqual([]);
    expect(w.complete).toHaveBeenCalledOnce();
  });
});

describe("a clear request to stop that the model read (model_intent)", () => {
  const leaving = (over: Record<string, unknown> = {}) => understood({ outcome: "skipped" }, { intent: "opt_out", confidence: 0.9, ...over });
  const lead = (w: ReturnType<typeof world>) => w.leads.get(LEAD)!;

  it("opts the contact out like a STOP: logged as model_intent with the message, one confirmation, an opt_out handover, nothing else sent", async () => {
    const w = world({ language: "ta" });
    const out = await replyTurn(runner().step, w.turn, leaving({ language: "ta" }), Date.now(), w.deps);
    expect(out.reply).toEqual({ status: "opted_out", confirmation: "awaiting_notify_kind" });
    expect(w.send).not.toHaveBeenCalled(); // no ai_reply: no credit is spent
    expect(w.complete).not.toHaveBeenCalled();
    expect(w.contacts.get(CONTACT)?.optedOut).toBe(true);
    expect(w.consentLogs).toEqual([{ tenantId: A, contactId: CONTACT, event: "opted_out", source: "model_intent", messageId: M1 }]);
    expect(w.systemNotice.send).toHaveBeenCalledOnce();
    expect(w.systemNotice.send).toHaveBeenCalledWith({ tenantId: A, conversationId: CONV, kind: "opt_out_confirmation", text: fixedText("opt_out_confirmation", "ta") });
    expect(w.handoffs).toEqual([expect.objectContaining({ trigger: "opt_out", priority: "high" })]);
    expect(w.sendEvent).toHaveBeenCalledOnce();
    expect(w.audits.filter((a) => a.action === "message.answered").map((a) => a.entityId)).toEqual([M1]);
  });

  it("keeps the lead open when they only asked to stop, and loses it when they said they are not interested", async () => {
    const stays = world();
    await replyTurn(runner().step, stays.turn, leaving(), Date.now(), stays.deps);
    expect(lead(stays).stage).toBe("engaged");
    const lost = world();
    await replyTurn(runner().step, lost.turn, leaving({ notInterested: true }), Date.now(), lost.deps);
    expect(lead(lost).stage).toBe("lost");
  });

  it("never loses a booked lead", async () => {
    const w = world();
    lead(w).stage = "booked";
    await replyTurn(runner().step, w.turn, leaving({ notInterested: true }), Date.now(), w.deps);
    expect(lead(w).stage).toBe("booked");
    expect(w.contacts.get(CONTACT)?.optedOut).toBe(true);
  });

  it("is idempotent: a retried step sends no second confirmation and opens no second handover", async () => {
    const w = world();
    await replyTurn(runner().step, w.turn, leaving(), Date.now(), w.deps);
    await replyTurn(runner().step, w.turn, leaving(), Date.now(), w.deps); // a fresh runner: the step ran again
    expect(w.systemNotice.send).toHaveBeenCalledOnce();
    expect(w.handoffs).toHaveLength(1);
    expect(w.consentLogs).toHaveLength(1);
  });

  it("a handover that fails still marks the messages answered and fails the step, so the retry opens it without a second confirmation", async () => {
    const w = world();
    w.state.failNext.add("openHandoff");
    await expect(replyTurn(runner().step, w.turn, leaving(), Date.now(), w.deps)).rejects.toThrow(/openHandoff failed/);
    expect(w.audits.filter((a) => a.action === "message.answered")).toHaveLength(1);
    await replyTurn(runner().step, w.turn, leaving(), Date.now(), w.deps);
    expect(w.handoffs).toHaveLength(1);
    expect(w.systemNotice.send).toHaveBeenCalledOnce();
  });

  it("below the threshold nobody is opted out: the customer is asked once, with the STOP hint and the two choices", async () => {
    const w = world();
    const out = await replyTurn(runner().step, w.turn, leaving({ confidence: 0.79 }), Date.now(), w.deps);
    expect(out.reply).toMatchObject({ status: "sent", source: "fixed" });
    expect(w.send.mock.calls[0][2].interactive).toMatchObject({ type: "buttons", body: fixedText("exit_prompt", "en") });
    expect(w.contacts.get(CONTACT)?.optedOut).toBe(false);
    expect(w.handoffs).toEqual([]);
    expect(w.consentLogs).toEqual([]);
  });

  it.each(["x", "?", "ok", "👍"])("a stray %j that the model doubtfully reads as unclear_exit (below 0.5) is answered like any message: no question, no opt-out, no handover", async (stray) => {
    const w = world({ messages: [{ id: M1, tenantId: A, conversationId: CONV, direction: "in", sender: "customer", kind: "text", createdAt: at(3), body: stray, meta: {} }], script: ["How can I help you today?"] });
    const out = await replyTurn(runner().step, w.turn, understood({ outcome: "skipped" }, { intent: "unclear_exit", confidence: 0.3, hasQuestion: false }), Date.now(), w.deps);
    expect(out.case).toBe("nothing_to_look_up");
    expect(sentText(w)).toBe("How can I help you today?");
    expect(w.contacts.get(CONTACT)?.optedOut).toBe(false);
    expect(w.handoffs).toEqual([]);
    expect(w.consentLogs).toEqual([]);
  });

  it("never lets the words of the customer into a step result or a log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const w = world();
    const r = runner();
    await replyTurn(r.step, w.turn, leaving(), Date.now(), w.deps);
    const everything = JSON.stringify([...r.memo.values(), ...log.mock.calls, ...out.mock.calls]);
    for (const secret of [CUSTOMER_WORDS, QUESTION, HIDDEN.phone]) expect(everything).not.toContain(secret);
  });
});

describe("the exit question as two reply buttons", () => {
  const unclear = (over: Record<string, unknown> = {}) => understood({ outcome: "skipped" }, { intent: "unclear_exit", confidence: 0.7, ...over });
  const tap = (id: string, secondsAgo: number, buttonId: string, title: string): FakeMessage => ({ id, tenantId: A, conversationId: CONV, direction: "in", sender: "customer", kind: "interactive", createdAt: at(secondsAgo), body: title, meta: { buttonId } });

  it("goes out as [Talk to the team] [Continue] with the STOP hint in the text, and no STOP button", async () => {
    const w = world();
    await replyTurn(runner().step, w.turn, unclear(), Date.now(), w.deps);
    expect(w.send).toHaveBeenCalledOnce();
    const [tenant, kind, payload] = w.send.mock.calls[0];
    expect([tenant, kind]).toEqual([A, "ai_reply"]);
    expect(payload.text).toBeUndefined();
    expect(payload.interactive).toEqual({
      type: "buttons",
      body: fixedText("exit_prompt", "en"),
      buttons: [{ id: "exit:talk", title: "Talk to the team" }, { id: "exit:continue", title: "Continue" }],
    });
    expect(JSON.stringify(payload.interactive)).toContain("STOP");
    expect(JSON.stringify(payload.interactive?.type === "buttons" ? payload.interactive.buttons : null)).not.toMatch(/stop/i);
  });

  it("is in the customer's language", async () => {
    const w = world();
    await replyTurn(runner().step, w.turn, unclear({ language: "hi" }), Date.now(), w.deps);
    expect(w.send.mock.calls[0][2].interactive).toMatchObject({ body: fixedText("exit_prompt", "hi") });
  });

  it("falls back to the plain text with 'Reply 1' only if the buttons are refused (not for a retry, not for an unknown outcome)", async () => {
    const refused: SendOutcome = { status: "failed", error: { code: "validation_failed", message: "x", retryable: false, outcomeUnknown: false } };
    const w = world({ send: (n) => (n === 1 ? refused : SENT) });
    const out = await replyTurn(runner().step, w.turn, unclear(), Date.now(), w.deps);
    expect(w.send).toHaveBeenCalledTimes(2);
    // the buttons and the plain-text line are two forms of ONE reply and only one of them is ever recorded: they share the key, so a replay finds whichever went out
    expect(w.send.mock.calls[0][2].idempotencyKey).toBe(`reply:${M1}`);
    expect(w.send.mock.calls[1][2]).toEqual({ conversationId: CONV, text: fixedText("exit_question", "en"), idempotencyKey: `reply:${M1}` });
    expect(out.reply).toMatchObject({ status: "sent" });
    expect(w.audits.filter((a) => a.action === "message.answered")).toHaveLength(1);

    const unknown = world({ send: () => ({ status: "failed", error: { code: "upstream_failed", message: "x", retryable: true, outcomeUnknown: true } }) });
    await replyTurn(runner().step, unknown.turn, unclear(), Date.now(), unknown.deps);
    expect(unknown.send).toHaveBeenCalledOnce(); // it may have gone out: never sent again

    const retry = world({ send: () => ({ status: "failed", error: { code: "rate_limited", message: "x", retryable: true, outcomeUnknown: false } }) });
    await expect(replyTurn(runner().step, retry.turn, unclear(), Date.now(), retry.deps)).rejects.toThrow(/could not be sent/);
    expect(retry.send).toHaveBeenCalledOnce();
  });

  it("is plain text when the business has the team handover off: no button leads nowhere", async () => {
    const w = world({ agentSettings: { handoffTriggers: [{ key: "asked_human", enabled: false }] } });
    await replyTurn(runner().step, w.turn, unclear(), Date.now(), w.deps);
    expect(w.send.mock.calls[0][2]).toEqual({ conversationId: CONV, text: fixedText("exit_prompt", "en"), idempotencyKey: `reply:${M1}` });
  });

  it("a tap on Talk to the team hands the chat to a person", async () => {
    const w = world({ messages: [tap(M1, 3, "exit:talk", "Talk to the team")] });
    const out = await replyTurn(runner().step, w.turn, understood({ outcome: "skipped" }, { intent: "greeting", hasQuestion: false }), Date.now(), w.deps);
    expect(sentText(w)).toBe(fixedText("handoff", "en"));
    expect(out.handoff).toMatchObject({ trigger: "asked_human", switched: true });
    expect(w.handoffs).toEqual([expect.objectContaining({ trigger: "asked_human", priority: "high" })]);
  });

  it("a tap on Talk to the team reaches a person even if the language model is down", async () => {
    const w = world({ messages: [tap(M1, 3, "exit:talk", "Talk to the team")] });
    const out = await replyTurn(runner().step, w.turn, { status: "model_unavailable" }, Date.now(), w.deps);
    expect(out.case).toBe("exit_question_talk");
    expect(out.handoff).toMatchObject({ trigger: "asked_human", switched: true });
    expect(w.complete).not.toHaveBeenCalled();
  });

  it("carries the privacy notice once on the first question: in the buttons' text, and in the plain text if they were refused", async () => {
    const on = { agentSettings: { privacyNotice: true }, consentAt: null } as const;
    const w = world({ ...on });
    await replyTurn(runner().step, w.turn, unclear(), Date.now(), w.deps);
    const body = (w.send.mock.calls[0][2].interactive as { body: string }).body;
    expect(body).toBe(`${fixedText("exit_prompt", "en")}

${consentNotice("en", PRIVACY_URL)}`);
    expect(w.consentLogs).toHaveLength(1);

    const refused: SendOutcome = { status: "failed", error: { code: "validation_failed", message: "x", retryable: false, outcomeUnknown: false } };
    const f = world({ ...on, send: (n) => (n === 1 ? refused : SENT) });
    await replyTurn(runner().step, f.turn, unclear(), Date.now(), f.deps);
    expect(f.send.mock.calls[1][2].text).toBe(`${fixedText("exit_question", "en")}

${consentNotice("en", PRIVACY_URL)}`);
    expect(f.consentLogs).toHaveLength(1); // logged once, for the one message that went
  });

  it("a tap on Continue goes on as normal: no handover, answered like any message", async () => {
    const w = world({ messages: [tap(M1, 3, "exit:continue", "Continue")] });
    await replyTurn(runner().step, w.turn, understood({ outcome: "skipped" }, { intent: "greeting", hasQuestion: false }), Date.now(), w.deps);
    expect(w.handoffs).toEqual([]);
    expect(w.complete).toHaveBeenCalledOnce();
  });

  it("a tap on any other button (a booking button, a list row) is not ours", async () => {
    const w = world({ messages: [tap(M1, 3, "booking:abc:confirm", "Confirm")] });
    await replyTurn(runner().step, w.turn, understood({ outcome: "skipped" }, { intent: "greeting", hasQuestion: false }), Date.now(), w.deps);
    expect(w.handoffs).toEqual([]);
  });
});

describe("the question asked once when it is not clear how the customer is leaving", () => {
  const message = (id: string, secondsAgo: number, body: string, meta: Record<string, unknown> = {}): FakeMessage => ({ id, tenantId: A, conversationId: CONV, direction: "in", sender: "customer", kind: "text", createdAt: at(secondsAgo), body, meta });

  it("keeps its case on the message so the next turn can tell an answer to it", async () => {
    const w = world();
    await replyTurn(runner().step, w.turn, understood({ outcome: "skipped" }, { intent: "unclear_exit" }), Date.now(), w.deps);
    expect(w.messages.get(M1)?.meta?.agent).toMatchObject({ planCase: "exit_unclear" });
  });

  it('"1" in answer to it: the handover line, a person takes over, a high-priority asked_human handover', async () => {
    const w = world({ messages: [message(M0, 60, "enough", { agent: { planCase: "exit_unclear" } }), message(M1, 3, "1")] });
    const out = await replyTurn(runner().step, { ...w.turn, messageIds: [M1] }, understood({ outcome: "skipped" }, { intent: "give_details", hasQuestion: false }), Date.now(), w.deps);
    expect(sentText(w)).toBe(fixedText("handoff", "en"));
    expect(out.handoff).toMatchObject({ trigger: "asked_human", switched: true });
    expect(w.handoffs).toEqual([expect.objectContaining({ trigger: "asked_human", priority: "high" })]);
  });

  it('"1" when no question was asked is an ordinary message', async () => {
    const w = world({ messages: [message(M0, 60, "hello", { agent: { planCase: "nothing_to_look_up" } }), message(M1, 3, "1")] });
    await replyTurn(runner().step, { ...w.turn, messageIds: [M1] }, understood({ outcome: "skipped" }, { intent: "give_details", hasQuestion: false }), Date.now(), w.deps);
    expect(w.handoffs).toEqual([]);
  });

  it('"continue" (anything but 1) goes on as normal: answered from the knowledge base, no handover', async () => {
    const w = world({ messages: [message(M0, 60, "enough", { agent: { planCase: "exit_unclear" } }), message(M1, 3, "ok tell me the price")] });
    await replyTurn(runner().step, { ...w.turn, messageIds: [M1] }, understood(found), Date.now(), w.deps);
    expect(w.handoffs).toEqual([]);
    expect(w.complete).toHaveBeenCalledOnce();
  });
});

// Step 5 (qualifying) reaches the customer through the reply: the details to ask for go to the model by their labels, and a lead that
// is not a fit is closed kindly. What to ask and whether to close was decided by code (plan.ts); the model only words it.
describe("the details to ask for, and a lead that is not a fit", () => {
  const ASK = [
    { key: "location", label: "Preferred area" },
    { key: "timeline", label: "When are you planning to buy?", options: ["0-3m", "3-6m", "6m+"] },
  ];
  const qualified = (retrieval: Retrieval, over: Record<string, unknown>, q: Record<string, unknown> = {}): UnderstandResult => ({
    ...understood(retrieval, over),
    qualification: { score: 30, temperature: "cold", ask: ASK, missingRequired: ["location", "timeline"], readyForSlots: false, hardFail: null, ...q },
  } as UnderstandResult);

  it("an answer also asks for the next missing details, by their labels and the choices the pack allows", async () => {
    const w = world();
    const out = await replyTurn(runner().step, w.turn, qualified(found, {}), Date.now(), w.deps);
    expect(out).toMatchObject({ case: "answered_from_kb", reply: { status: "sent", source: "model" } });
    const user = w.complete.mock.calls[0][0].messages[0].content as string;
    expect(user).toContain("<ask>");
    expect(user).toContain("- Preferred area");
    expect(user).toContain("- When are you planning to buy? (the customer can choose: 0-3m, 3-6m, 6m+)");
  });

  it("details given with no question are acknowledged with a request for the next ones", async () => {
    const w = world({ question: null });
    const out = await replyTurn(runner().step, w.turn, qualified({ outcome: "skipped" }, { intent: "give_details", hasQuestion: false }), Date.now(), w.deps);
    expect(out).toMatchObject({ case: "ask_details", reply: { status: "sent", source: "model" } });
    expect(w.complete.mock.calls[0][0].messages[0].content).toContain("Ask the customer for the details listed in <ask>");
  });

  it("a lead that is not a fit is told so kindly, in the model's words from the fact, and nothing is asked", async () => {
    const w = world({ question: null, script: ["Thank you for asking. I am sorry, we do not have anything that fits right now."] });
    const failed = qualified({ outcome: "skipped" }, { intent: "give_details", hasQuestion: false, fieldKeys: ["budget"] }, { temperature: "disqualified", score: 0, ask: [], hardFail: { field: "budget", rule: "below min_project_price" } });
    const out = await replyTurn(runner().step, w.turn, failed, Date.now(), w.deps);
    expect(out).toMatchObject({ case: "disqualified", reply: { status: "sent", source: "model" }, handoff: null });
    const user = w.complete.mock.calls[0][0].messages[0].content as string;
    expect(user).toContain("nothing that fits what the customer is looking for");
    expect(user).not.toContain("<ask>");
    expect(w.handoffs).toHaveLength(0);
  });

  it("the step results stay small: the labels are the pack's, never the customer's words", async () => {
    const w = world();
    const r = runner();
    await replyTurn(r.step, w.turn, qualified(found, {}), Date.now(), w.deps);
    expect(JSON.stringify([...r.memo.values()])).not.toContain(CUSTOMER_WORDS);
  });
});
