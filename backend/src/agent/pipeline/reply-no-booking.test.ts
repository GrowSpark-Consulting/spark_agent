import { describe, expect, it, vi } from "vitest";
import type { AuditEntry } from "../../lib/audit";
import type { SendOutcome } from "../../notify/send";
import { fakePipelineStore, type FakeMessage } from "../../test-support/fake-pipeline-store";
import type { LlmClient, LlmRequest } from "../llm/anthropic";
import { BOOKING_REMINDER_ACTION } from "./events";
import type { SystemNoticePort } from "./ports";
import type { StepRunner, TurnContext } from "./process-message";
import { replyTurn, type ReplyDeps } from "./reply";
import type { QualificationSummary, UnderstandResult } from "./understand";

// Finding 3, end to end through the reply step: a customer with no booking on record asks to cancel or move one. The staff reminder runs BEFORE the reply, so that "the team has been
// told" is said only when it is true; its result is kept on the message and read back when the reply is written. It has a short time limit (a timeout counts as failed), never throws,
// never blocks the reply, opens no handover and changes no mode. One reminder per lead, but a failed one is tried again by the lead's next message.

const A = "e0000000-0000-0000-0000-00000000000a";
const CONV = "c0000000-0000-0000-0000-00000000000c";
const CONTACT = "b0000000-0000-0000-0000-0000000000b1";
const LEAD = "10000000-0000-0000-0000-0000000000f1";
const M1 = "a0000000-0000-0000-0000-0000000000a1";
const M2 = "a0000000-0000-0000-0000-0000000000a2";
const NOW = Date.now();
const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();
const SENT: SendOutcome = { status: "sent", messageId: "m-out", providerMsgId: "wamid.OUT", creditsCharged: 1, usedTemplate: false };
const COUNTS = { told: { recipients: 2, sent: 2, skipped: 0, failed: 0 }, nobody: { recipients: 0, sent: 0, skipped: 0, failed: 0 }, failed: { recipients: 1, sent: 0, skipped: 0, failed: 1 } };

const ready: QualificationSummary = { score: 55, temperature: "warm", ask: [], missingRequired: [], readyForSlots: true, hardFail: null, bookingKind: "site_visit" };
const understood = (over: Record<string, unknown> = {}): UnderstandResult =>
  ({ status: "understood", summary: { intent: "cancel", language: "en", sentiment: "neutral", asksIfHuman: false, notInterested: false, confidence: 0.9, hasQuestion: false, fieldKeys: [], ...over }, retrieval: { outcome: "skipped" }, qualification: ready }) as UnderstandResult;

type ReminderBehaviour = "told" | "nobody" | "failed" | "throws" | "hangs";
interface Options {
  reminder?: ReminderBehaviour | "absent";
  understood?: UnderstandResult;
  timeoutMs?: number;
  words?: string;
}

function world(over: Options = {}) {
  const customer = (id: string, secondsAgo: number): FakeMessage => ({ id, tenantId: A, conversationId: CONV, direction: "in", sender: "customer", kind: "text", createdAt: at(secondsAgo), body: over.words ?? "cancel that, I'll think", meta: {} });
  const fake = fakePipelineStore({
    tenants: [{ id: A, vertical: "sample-pack", verticalVersion: 1 }],
    messages: [customer(M1, 40), customer(M2, 3)],
    conversations: [{ id: CONV, tenantId: A, contactId: CONTACT, mode: "ai" }],
    contacts: [{ id: CONTACT, tenantId: A, language: null, optedOut: false, consentAt: "2026-10-01T00:00:00Z" }],
    leads: [{ id: LEAD, tenantId: A, contactId: CONTACT, stage: "engaged", createdAt: 1, fields: {} }],
    tenantInfo: { [A]: { name: "Skyline Homes", agentSettings: {} } },
  });
  const order: string[] = [];
  const requests: LlmRequest[] = [];
  const complete = vi.fn(async (request: LlmRequest) => {
    order.push("model");
    requests.push(request);
    return { text: "I can't see a booking in this chat. Could you tell me what you meant?", model: "mock", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, latencyMs: 0, attempts: 1, requestId: null };
  });
  const send = vi.fn<ReplyDeps["send"]>(async () => {
    order.push("send");
    return SENT;
  });
  const audits: AuditEntry[] = [];
  const audit = vi.fn(async (entry: AuditEntry) => {
    audits.push(entry);
    if (entry.action === "message.answered" && entry.entityId) fake.answered.set(entry.entityId, Date.now());
    if (entry.action === BOOKING_REMINDER_ACTION && entry.entityId) fake.bookingReminded.add(entry.entityId);
  });
  const behaviour = { current: over.reminder ?? "told" };
  const reminder = vi.fn<NonNullable<ReplyDeps["bookingChangeReminder"]>>(async () => {
    order.push("reminder");
    switch (behaviour.current) {
      case "told": return COUNTS.told;
      case "nobody": return COUNTS.nobody;
      case "failed": return COUNTS.failed;
      case "throws": throw new Error("staff alerts are down");
      default: return new Promise(() => undefined); // never answers
    }
  });
  const port = {
    activeBooking: async () => null,
    findSlots: async () => [],
    holdSlot: async () => { throw new Error("not used"); },
    confirmBooking: async () => { throw new Error("not used"); },
    rescheduleBooking: async () => { throw new Error("not used"); },
    cancelBooking: async () => { throw new Error("not used"); },
  };
  const deps: ReplyDeps = {
    store: fake.store,
    llm: { complete } as unknown as LlmClient,
    send,
    audit,
    sendEvent: vi.fn(async () => undefined),
    systemNotice: { send: vi.fn(async () => ({ status: "awaiting_notify_kind" as const })) } as unknown as SystemNoticePort,
    privacyPolicyUrl: "https://example.test/privacy",
    now: () => Date.now(),
    scheduling: { port, isEnabled: async () => true, services: async () => [{ id: "30000000-0000-0000-0000-000000000003" }], timeZone: async () => "Asia/Kolkata" },
    ...(over.reminder === "absent" ? {} : { bookingChangeReminder: reminder }),
    ...(over.timeoutMs ? { bookingReminderTimeoutMs: over.timeoutMs } : {}),
  };
  const turnFor = (id: string): TurnContext => ({ tenantId: A, conversationId: CONV, contactId: CONTACT, leadId: LEAD, leadCreated: false, messageIds: [id], language: null, vertical: "sample-pack", verticalVersion: 1 });
  return { ...fake, complete, send, audit, audits, reminder, behaviour, order, requests, deps, turnFor, understood: over.understood ?? understood() };
}

function runner() {
  const memo = new Map<string, unknown>();
  const ran: string[] = [];
  const step: StepRunner = {
    async run(id, fn) {
      if (memo.has(id)) return memo.get(id) as never;
      ran.push(id);
      const value = await fn();
      memo.set(id, value);
      return value;
    },
  };
  return { step, ran };
}
const run = (w: ReturnType<typeof world>, id = M2, r = runner()) => replyTurn(r.step, w.turnFor(id), w.understood, NOW, w.deps).then((outcome) => ({ outcome, ran: r.ran }));
const factsOf = (w: ReturnType<typeof world>, n = 0) => /<facts>\n([\s\S]*?)\n<\/facts>/.exec(w.requests[n].messages[0].content)?.[1] ?? "";
const metaOf = (w: ReturnType<typeof world>, id = M2) => w.messages.get(id)?.meta?.agent as Record<string, unknown>;

describe("the reminder goes first, and what the customer is told is true", () => {
  it("sent: the reminder runs before the model and the send, the reply says the team has been told, one reply, no handover, the chat stays with the AI", async () => {
    const w = world();
    const { outcome, ran } = await run(w);
    expect(outcome).toMatchObject({ case: "no_booking_to_change", reply: { status: "sent", source: "model" }, handoff: null, bookingReminder: "sent" });
    expect(w.order).toEqual(["reminder", "model", "send"]);
    expect(ran.indexOf("booking-reminder")).toBeLessThan(ran.indexOf("reply"));
    expect(w.reminder).toHaveBeenCalledTimes(1);
    expect(w.reminder.mock.calls[0][0]).toMatchObject({ tenantId: A, conversationId: CONV, leadId: LEAD, kind: "cancel" });
    expect(factsOf(w)).toMatch(/The team has been told and will check/);
    expect(w.send).toHaveBeenCalledTimes(1);
    expect(w.handoffs).toHaveLength(0);
    expect(w.conversations.get(CONV)?.mode).toBe("ai");
    expect(w.leads.get(LEAD)?.stage).toBe("engaged");
    expect(w.audits.filter((a) => a.action === BOOKING_REMINDER_ACTION)).toEqual([expect.objectContaining({ entity: "lead", entityId: LEAD, actor: "ai" })]);
    expect(metaOf(w)).toMatchObject({ bookingReminder: "sent" });
  });

  it("a move is passed on as a move", async () => {
    const w = world({ understood: understood({ intent: "reschedule" }) });
    await run(w);
    expect(w.reminder.mock.calls[0][0]).toMatchObject({ kind: "reschedule" });
    expect(factsOf(w)).toMatch(/move/i);
  });

  it.each(["nobody", "failed", "throws"] as const)("%s: the reply says nobody has been told and promises no check, the turn does not fail, and no audit row says it was sent", async (behaviour) => {
    const w = world({ reminder: behaviour });
    const { outcome } = await run(w);
    expect(outcome).toMatchObject({ case: "no_booking_to_change", reply: { status: "sent" }, bookingReminder: "failed" });
    expect(factsOf(w)).toMatch(/Nobody has been told/);
    expect(factsOf(w)).not.toMatch(/team has been told and will check/i);
    expect(w.send).toHaveBeenCalledTimes(1);
    expect(w.audits.some((a) => a.action === BOOKING_REMINDER_ACTION)).toBe(false);
    expect(w.handoffs).toHaveLength(0);
    expect(metaOf(w)).toMatchObject({ bookingReminder: "failed" });
  });

  it("a reminder that never answers is cut off after the time limit (a timeout counts as failed) and the reply goes out", async () => {
    const w = world({ reminder: "hangs", timeoutMs: 30 });
    const started = Date.now();
    const { outcome } = await run(w);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(outcome).toMatchObject({ reply: { status: "sent" }, bookingReminder: "failed" });
    expect(factsOf(w)).toMatch(/Nobody has been told/);
  });

  it("a reminder that throws before it returns a promise (not an async function) does not leave a timer behind or crash the turn", async () => {
    const w = world({ timeoutMs: 40 });
    w.reminder.mockImplementation((() => {
      throw new Error("sync failure");
    }) as never);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const { outcome } = await run(w);
    await new Promise((resolve) => setTimeout(resolve, 120)); // longer than the limit: a timer left behind would reject now
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ reply: { status: "sent" }, bookingReminder: "failed" });
  });

  it("a person has the chat, or the customer has opted out, by the time the step runs: nobody is alerted (no reply will go out)", async () => {
    for (const change of [(w: ReturnType<typeof world>) => { w.conversations.get(CONV)!.mode = "human"; }, (w: ReturnType<typeof world>) => { w.contacts.get(CONTACT)!.optedOut = true; }]) {
      const w = world();
      change(w);
      const { outcome } = await run(w);
      expect(w.reminder).not.toHaveBeenCalled();
      expect(w.send).not.toHaveBeenCalled();
      expect(outcome).toMatchObject({ bookingReminder: "failed" });
      expect(w.audits.some((a) => a.action === BOOKING_REMINDER_ACTION)).toBe(false);
    }
  });

  it("the time limit is about three seconds by default", async () => {
    const { BOOKING_REMINDER_TIMEOUT_MS } = await import("./reply");
    expect(BOOKING_REMINDER_TIMEOUT_MS).toBe(3000);
  });

  it("no reminder wired (a caller without one): nobody is told, and the reply says so", async () => {
    const w = world({ reminder: "absent" });
    const { outcome } = await run(w);
    expect(outcome).toMatchObject({ case: "no_booking_to_change", reply: { status: "sent" } });
    expect(factsOf(w)).toMatch(/Nobody has been told/);
  });

  it("a cancel below the threshold, or any other intent, sends no reminder", async () => {
    for (const u of [understood({ confidence: 0.6 }), understood({ intent: "give_details" }), understood({ intent: "off_topic" })]) {
      const w = world({ understood: u });
      await run(w);
      expect(w.reminder).not.toHaveBeenCalled();
    }
  });

  it("the staff reminder never carries what the customer typed: the input holds ids and the kind only", async () => {
    const w = world({ words: "cancel Priya Sharma's visit, call 9876543210 or see http://evil.example" });
    await run(w);
    expect(JSON.stringify(w.reminder.mock.calls[0][0])).not.toMatch(/Priya|9876543210|evil/);
  });
});

describe("one reminder per lead, but a failed one is tried again", () => {
  it("a failure on the first message: the lead's next message tries again, and when that one goes out, the reply says the team has been told", async () => {
    const w = world({ reminder: "failed" });
    await run(w, M1);
    expect(w.reminder).toHaveBeenCalledTimes(1);
    expect(factsOf(w, 0)).toMatch(/Nobody has been told/);

    w.behaviour.current = "told";
    await run(w, M2);
    expect(w.reminder).toHaveBeenCalledTimes(2);
    expect(factsOf(w, 1)).toMatch(/The team has been told and will check/);
    expect(w.audits.filter((a) => a.action === BOOKING_REMINDER_ACTION)).toHaveLength(1);
  });

  it("a timeout on the first message is tried again on the next as well", async () => {
    const w = world({ reminder: "hangs", timeoutMs: 20 });
    await run(w, M1);
    w.behaviour.current = "told";
    await run(w, M2);
    expect(w.reminder).toHaveBeenCalledTimes(2);
    expect(factsOf(w, 1)).toMatch(/The team has been told/);
  });

  it("after a success, a later message sends nothing more (the audit row says so), and the reply still says the team has been told", async () => {
    const w = world({ reminder: "told" });
    await run(w, M1);
    expect(w.reminder).toHaveBeenCalledTimes(1);
    await run(w, M2);
    expect(w.reminder).toHaveBeenCalledTimes(1);
    expect(factsOf(w, 1)).toMatch(/The team has been told and will check/);
    expect(w.audits.filter((a) => a.action === BOOKING_REMINDER_ACTION)).toHaveLength(1);
    expect(w.send).toHaveBeenCalledTimes(2); // one customer reply per turn
  });

  it("the same turn run again (a replayed step) sends the reminder once: its result is kept by the step", async () => {
    const w = world();
    const r = runner();
    await replyTurn(r.step, w.turnFor(M2), w.understood, NOW, w.deps);
    await replyTurn(r.step, w.turnFor(M2), w.understood, NOW, w.deps);
    expect(w.reminder).toHaveBeenCalledTimes(1);
    expect(w.send).toHaveBeenCalledTimes(1);
  });
});
