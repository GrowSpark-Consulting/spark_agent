import { describe, expect, it, vi } from "vitest";
import type { AuditEntry } from "../../lib/audit";
import type { SendOutcome } from "../../notify/send";
import { fakePipelineStore, type FakeMessage } from "../../test-support/fake-pipeline-store";
import type { LlmClient, LlmRequest, LlmResult } from "../llm/anthropic";
import { ROLE_SETTINGS } from "../llm/models";
import type { SystemNoticePort } from "./ports";
import type { StepRunner, TurnContext } from "./process-message";
import { replyTurn, type ReplyDeps } from "./reply";
import { TURN_HARD_STOP_MS, TURN_TARGET_MS } from "./turn-deadline";
import type { Retrieval, UnderstandResult } from "./understand";

// STEP 8 AUDIT (Day 6, PR 6). "Step 8" is taken to mean the tail of a turn: the reply is sent, recorded, never twice and never to silence, inside the 10-second
// target and the 25-second hard stop (docs/task-notes/2026-10-13-day6-dev1-step8-audit.md has the reading and the findings). reply.test.ts covers the send and the
// record case by case; this file pins what it does not, and marks the gaps the audit found.
//
// (Both gaps the audit found are closed, so every test below is an ordinary test: the missing idempotency key, and a retry that asked the reply model again, which now reuses the
// reply kept on the message: reply-draft.test.ts has the cases.) Nothing here changes the code, a prompt or the agent's behaviour.

const A = "e0000000-0000-0000-0000-00000000000a";
const CONV = "c0000000-0000-0000-0000-00000000000c";
const CONTACT = "b0000000-0000-0000-0000-0000000000b1";
const LEAD = "10000000-0000-0000-0000-0000000000f1";
const M1 = "a0000000-0000-0000-0000-0000000000a1";
const NOW = Date.now();
const SENT: SendOutcome = { status: "sent", messageId: "m-out", providerMsgId: "wamid.OUT", creditsCharged: 1, usedTemplate: false };
const RETRYABLE: SendOutcome = { status: "failed", error: { code: "rate_limited", message: "x", retryable: true, outcomeUnknown: false } };
const llmResult = (text: string): LlmResult => ({ text, model: "m", requestId: "r", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, latencyMs: 1, attempts: 1 });

function runner() {
  const memo = new Map<string, unknown>();
  const step: StepRunner = {
    async run(id, fn) {
      if (memo.has(id)) return memo.get(id) as never;
      const value = await fn();
      memo.set(id, value);
      return value;
    },
  };
  return step;
}

const found: Retrieval = { outcome: "found", chunks: [{ documentId: "d1", title: "Brochure", content: "Site visits are free. 2BHK starts at ₹78 lakh.", similarity: 0.7 }] };
const understood: UnderstandResult = {
  status: "understood",
  summary: { intent: "question", language: "en", sentiment: "neutral", asksIfHuman: false, notInterested: false, confidence: 0.9, hasQuestion: true, fieldKeys: [] },
  retrieval: found,
};

function world(over: { script?: string[]; send?: (n: number) => SendOutcome } = {}) {
  const message: FakeMessage = {
    id: M1, tenantId: A, conversationId: CONV, direction: "in", sender: "customer", kind: "text", createdAt: new Date(NOW - 3000).toISOString(), body: "price?", meta: { agent: { extraction: { question: "Do you do home visits?" } } },
  };
  const fake = fakePipelineStore({
    tenants: [{ id: A, vertical: "sample-pack", verticalVersion: 1 }],
    messages: [message],
    conversations: [{ id: CONV, tenantId: A, contactId: CONTACT, mode: "ai" }],
    contacts: [{ id: CONTACT, tenantId: A, language: null, optedOut: false, consentAt: "2026-10-01T00:00:00Z" }],
    leads: [{ id: LEAD, tenantId: A, contactId: CONTACT, stage: "engaged", createdAt: 1, fields: {} }],
    tenantInfo: { [A]: { name: "Skyline Homes", agentSettings: {} } },
  });
  const queue = [...(over.script ?? ["Yes, we do site visits."])];
  const complete = vi.fn<(request: LlmRequest) => Promise<LlmResult>>(async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("the model was called more often than the test expected");
    return llmResult(next);
  });
  let sends = 0;
  const order: string[] = [];
  const send = vi.fn<ReplyDeps["send"]>(async () => {
    order.push("send");
    return over.send ? over.send(++sends) : SENT;
  });
  const audits: AuditEntry[] = [];
  const audit = vi.fn(async (entry: AuditEntry) => {
    order.push(entry.action);
    audits.push(entry);
    if (entry.action === "message.answered" && entry.entityId) fake.answered.set(entry.entityId, Date.now());
  });
  const originalSave = fake.store.saveAgentMeta.bind(fake.store);
  fake.store.saveAgentMeta = async (...args) => {
    const agent = args[3] as { reply?: unknown };
    if (agent.reply !== undefined) order.push("marker");
    return originalSave(...args);
  };
  const sendEvent = vi.fn<ReplyDeps["sendEvent"]>(async () => undefined);
  const systemNotice = { send: vi.fn(async (): Promise<{ status: "sent" }> => ({ status: "sent" })) };
  const deps: ReplyDeps = { store: fake.store, llm: { complete } as LlmClient, send, audit, sendEvent, systemNotice: systemNotice as unknown as SystemNoticePort, privacyPolicyUrl: "https://example.test/privacy", now: () => Date.now() };
  const turn: TurnContext = { tenantId: A, conversationId: CONV, contactId: CONTACT, leadId: LEAD, leadCreated: false, messageIds: [M1], language: null, vertical: "sample-pack", verticalVersion: 1 };
  return { ...fake, complete, send, audit, audits, order, sendEvent, systemNotice, deps, turn };
}

describe("send, record: the order that makes a retry safe", () => {
  it("the marker on the message is written before the answered rows, and both after the send", async () => {
    const w = world();
    await replyTurn(runner(), w.turn, understood, Date.now(), w.deps);
    expect(w.send).toHaveBeenCalledOnce();
    expect(w.order).toEqual(["send", "marker", "message.answered"]);
  });
});

describe("never silence: what a customer and the staff hear when no reply goes out", () => {
  it("a reply that could not be delivered leaves the customer's messages unanswered, so the next run collects them with the next message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const w = world({ send: () => ({ status: "skipped", reason: "outside_window" }) });
    expect((await replyTurn(runner(), w.turn, understood, Date.now(), w.deps)).reply).toEqual({ status: "not_sent", reason: "outside_window" });
    expect(await w.store.isAnswered(A, M1, new Date(NOW - 3000).toISOString())).toBe(false);
    expect((await w.store.recentUnanswered(A, CONV, new Date(NOW - 3_600_000).toISOString())).map((m) => m.id)).toEqual([M1]);
  });

  it("KNOWN: when a reply cannot be delivered for a reason that will not pass (the number is disconnected, outside the 24 hours, the feature switched off) no handover is opened and nobody is alerted: the customer and the staff both see nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const refusals: SendOutcome[] = [
      { status: "failed", error: { code: "whatsapp_not_connected", message: "x", retryable: false, outcomeUnknown: false } },
      { status: "skipped", reason: "outside_window" },
      { status: "skipped", reason: "feature_off" },
    ];
    for (const refusal of refusals) {
      const w = world({ send: () => refusal });
      const out = await replyTurn(runner(), w.turn, understood, Date.now(), w.deps);
      expect(out.reply.status).toBe("not_sent");
      expect(out.handoff).toBeNull();
      expect(w.handoffs).toEqual([]);
      expect(w.sendEvent).not.toHaveBeenCalled();
      expect(w.systemNotice.send).not.toHaveBeenCalled();
    }
  });
});

describe("the turn's clock and the model calls inside it", () => {
  it("the reply model is given the turn's abort signal, which is not aborted early in the turn (it aborts at the hard stop)", async () => {
    const w = world();
    await replyTurn(runner(), w.turn, understood, Date.now(), w.deps);
    const signal = w.complete.mock.calls[0][0].signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it("the role timeouts and the turn's limits: each role's own total timeout is within the hard stop, and the hard stop is later than the target (the abort signal above is what holds a call to the turn)", () => {
    expect(TURN_TARGET_MS).toBe(10_000);
    expect(TURN_HARD_STOP_MS).toBe(25_000);
    expect(TURN_HARD_STOP_MS).toBeGreaterThan(TURN_TARGET_MS);
    expect(ROLE_SETTINGS.extraction.totalTimeoutMs).toBeLessThanOrEqual(TURN_HARD_STOP_MS);
    expect(ROLE_SETTINGS.reply.totalTimeoutMs).toBeLessThanOrEqual(TURN_HARD_STOP_MS);
  });
});

describe("the reply's idempotency key (was the audit's first gap; reply.test.ts has the cases)", () => {
  it("the reply is sent with an idempotency key that names the turn's last message, so a run that died after Meta accepted the reply cannot send it a second time (notify.send dedupes on the key)", async () => {
    const w = world();
    await replyTurn(runner(), w.turn, understood, Date.now(), w.deps);
    expect(w.send).toHaveBeenCalledOnce();
    expect(w.send.mock.calls[0][2].idempotencyKey).toBe(`reply:${M1}`);
  });
});

describe("a retry of the reply step reuses the reply already written (was the audit's second gap; reply-draft.test.ts has the cases)", () => {
  it("a retry of the reply step after a send that waiting can fix does not ask the reply model again: it sends the text the first attempt wrote, under the same key", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const w = world({ script: ["Yes, we do site visits.", "Yes, we do site visits, shall we plan one?"], send: (n) => (n === 1 ? RETRYABLE : SENT) });
    const step = runner(); // the same memo: what Inngest remembers between the attempts
    await expect(replyTurn(step, w.turn, understood, Date.now(), w.deps)).rejects.toThrow(/could not be sent/);
    await replyTurn(step, w.turn, understood, Date.now(), w.deps);
    expect(w.complete).toHaveBeenCalledTimes(1);
    expect(w.send).toHaveBeenCalledTimes(2);
    expect(w.send.mock.calls[1][2]).toMatchObject({ text: "Yes, we do site visits.", idempotencyKey: `reply:${M1}` });
    expect(w.send.mock.calls[0][2]).toMatchObject({ text: "Yes, we do site visits." });
  });
});
