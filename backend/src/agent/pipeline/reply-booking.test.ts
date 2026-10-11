import { describe, expect, it, vi, type Mock } from "vitest";
import type { AuditEntry } from "../../lib/audit";
import { AppError } from "../../lib/errors";
import type { SendOutcome } from "../../notify/send";
import { fakePipelineStore, HIDDEN, type FakeMessage } from "../../test-support/fake-pipeline-store";
import type { LlmClient, LlmRequest, LlmResult } from "../llm/anthropic";
import type { FoundSlot, SchedulingDeps, SchedulingPort } from "../scheduling/act";
import type { StepRunner, TurnContext } from "./process-message";
import { replyTurn, type ReplyDeps } from "./reply";
import type { QualificationSummary, Retrieval, UnderstandResult } from "./understand";

// Step 6 through the reply step: the calendar is looked at (offer) or changed (book) in its own "act" step, its result is kept on the
// customer's message, and the plan is made again with it in hand. The store, the model, notify.send and the calendar are fakes; the
// decisions themselves are plan-booking.test.ts, and the calendar calls are scheduling/act.test.ts.

const A = "e0000000-0000-0000-0000-00000000000a";
const CONV = "c0000000-0000-0000-0000-00000000000c";
const CONTACT = "b0000000-0000-0000-0000-0000000000b1";
const LEAD = "10000000-0000-0000-0000-0000000000f1";
const SERVICE = "30000000-0000-0000-0000-000000000003";
const RES = "20000000-0000-0000-0000-000000000002";
const BOOKING = "40000000-0000-0000-0000-000000000004";
const PREVIOUS = "a0000000-0000-0000-0000-0000000000a0";
const M1 = "a0000000-0000-0000-0000-0000000000a1";
const NOW = Date.parse("2026-10-10T04:30:00.000Z"); // Sat 10 Oct, 10:00 in Chennai
const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();
const SENT: SendOutcome = { status: "sent", messageId: "m-out", providerMsgId: "wamid.OUT", creditsCharged: 1, usedTemplate: false };
const WORDS = "SECRET-CUSTOMER-WORDS";

const found = (start: string, label: string): FoundSlot => ({ start, end: new Date(Date.parse(start) + 3_600_000).toISOString(), resourceId: RES, resourceName: "Anand", serviceId: SERVICE, label });
const SUN_10 = found("2026-10-11T04:30:00.000Z", "Sun 11 Oct, 10:00 am");
const SUN_15 = found("2026-10-11T09:30:00.000Z", "Sun 11 Oct, 3:00 pm");
const MON_17 = found("2026-10-12T12:00:00.000Z", "Mon 12 Oct, 5:30 pm");
const plain = (s: FoundSlot) => ({ start: s.start, end: s.end, resourceId: s.resourceId, serviceId: s.serviceId, label: s.label });
const OFFER = { slots: [SUN_10, SUN_15, MON_17].map(plain), at: at(120) };

const ready: QualificationSummary = { score: 75, temperature: "hot", ask: [], missingRequired: [], readyForSlots: true, hardFail: null, bookingKind: "site_visit" };
const skipped: Retrieval = { outcome: "skipped" };
const understood = (over: Record<string, unknown> = {}, q: QualificationSummary = ready): UnderstandResult => ({
  status: "understood",
  summary: { intent: "give_details", language: "en", sentiment: "neutral", asksIfHuman: false, notInterested: false, confidence: 0.9, hasQuestion: false, fieldKeys: [], ...over },
  retrieval: skipped,
  qualification: q,
}) as UnderstandResult;

const llmResult = (text: string): LlmResult => ({ text, model: "claude-sonnet-5-5", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.01, latencyMs: 2000, attempts: 1, requestId: null });

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
  return { step, ran, memo };
}

interface Options {
  /** What the customer wrote this turn. */
  text?: string;
  preferredTime?: string | null;
  /** An offer made earlier in this chat. */
  offer?: typeof OFFER | null;
  script?: string[];
  port?: Partial<SchedulingPort>;
  services?: { id: string }[];
  enabled?: boolean;
  /** What the extraction kept on the message before the reply step ran (a retry finds the act's result already there). */
  agent?: Record<string, unknown>;
}

function world(over: Options = {}) {
  const customer = (id: string, secondsAgo: number, body: string, agent: Record<string, unknown>): FakeMessage => ({
    id, tenantId: A, conversationId: CONV, direction: "in", sender: "customer", kind: "text", createdAt: at(secondsAgo), body, meta: { agent },
  });
  const messages: FakeMessage[] = [];
  if (over.offer) messages.push(customer(PREVIOUS, 120, "earlier", { offer: over.offer }));
  messages.push(customer(M1, 3, over.text ?? WORDS, { extraction: { question: null, preferredTime: over.preferredTime ?? null }, ...over.agent }));
  const fake = fakePipelineStore({
    tenants: [{ id: A, vertical: "sample-pack", verticalVersion: 1 }],
    messages,
    conversations: [{ id: CONV, tenantId: A, contactId: CONTACT, mode: "ai" }],
    contacts: [{ id: CONTACT, tenantId: A, language: null, optedOut: false, consentAt: "2026-10-01T00:00:00Z" }],
    leads: [{ id: LEAD, tenantId: A, contactId: CONTACT, stage: "engaged", createdAt: 1, fields: {} }],
    tenantInfo: { [A]: { name: "Skyline Homes", agentSettings: {} } },
    answered: [],
  });
  const queue = [...(over.script ?? ["Done."])];
  const complete = vi.fn<(request: LlmRequest) => Promise<LlmResult>>(async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("the model was called more often than the test expected");
    return llmResult(next);
  });
  const llm: LlmClient = { complete };
  const port = {
    findSlots: vi.fn<SchedulingPort["findSlots"]>(async () => [SUN_10, SUN_15, MON_17]),
    holdSlot: vi.fn<SchedulingPort["holdSlot"]>(async () => ({ id: BOOKING })),
    confirmBooking: vi.fn<SchedulingPort["confirmBooking"]>(async () => ({ id: BOOKING })),
    activeBooking: vi.fn<SchedulingPort["activeBooking"]>(async () => null),
    ...over.port,
  } as unknown as { [K in keyof SchedulingPort]: Mock<SchedulingPort[K]> };
  const scheduling: SchedulingDeps = {
    port,
    isEnabled: vi.fn(async () => over.enabled ?? true),
    services: vi.fn(async () => over.services ?? [{ id: SERVICE }]),
    timeZone: vi.fn(async () => "Asia/Kolkata"),
  };
  const send = vi.fn<ReplyDeps["send"]>(async () => SENT);
  const audits: AuditEntry[] = [];
  const audit = vi.fn(async (entry: AuditEntry) => {
    audits.push(entry);
    if (entry.action === "message.answered" && entry.entityId) fake.answered.set(entry.entityId, NOW);
  });
  const sendEvent = vi.fn<ReplyDeps["sendEvent"]>(async () => undefined);
  const systemNotice = { send: vi.fn(async () => ({ status: "awaiting_notify_kind" as const })) };
  const deps: ReplyDeps = { store: fake.store, llm, send, audit, sendEvent, systemNotice, privacyPolicyUrl: "https://example.test/privacy", scheduling, now: () => NOW };
  const turn: TurnContext = { tenantId: A, conversationId: CONV, contactId: CONTACT, leadId: LEAD, leadCreated: false, messageIds: [M1], language: null, vertical: "sample-pack", verticalVersion: 1 };
  return { ...fake, complete, port, scheduling, send, deps, turn };
}

const agentMeta = (w: ReturnType<typeof world>) => (w.messages.get(M1)?.meta?.agent ?? {}) as Record<string, unknown>;
const userPrompt = (w: ReturnType<typeof world>) => w.complete.mock.calls[0][0].messages[0].content as string;
const OFFER_TEXT = "I can do Sun 11 Oct, 10:00 am, Sun 11 Oct, 3:00 pm or Mon 12 Oct, 5:30 pm. Which suits you?";

describe("offering times", () => {
  it("looks at the calendar in its own step, offers what is free through notify.send, and remembers the offer on the message", async () => {
    const w = world({ script: [OFFER_TEXT] });
    const r = runner();
    const out = await replyTurn(r.step, w.turn, understood(), NOW, w.deps);
    expect(r.ran).toEqual(["plan", "act", "plan-act", "reply"]);
    expect(out).toMatchObject({ case: "offer_slots", reply: { status: "sent", source: "model" }, handoff: null });
    expect(w.port.findSlots).toHaveBeenCalledOnce();
    expect(w.port.holdSlot).not.toHaveBeenCalled();
    expect(w.send).toHaveBeenCalledOnce();
    expect(w.send.mock.calls[0][2]).toEqual({ conversationId: CONV, text: OFFER_TEXT });
    expect(userPrompt(w)).toContain("Free times: Sun 11 Oct, 10:00 am; Sun 11 Oct, 3:00 pm; Mon 12 Oct, 5:30 pm.");
    expect(agentMeta(w).offer).toEqual({ slots: [SUN_10, SUN_15, MON_17].map(plain), at: new Date(NOW).toISOString() });
    expect(agentMeta(w).act).toMatchObject({ kind: "offered", asked: false });
    expect(agentMeta(w).planCase).toBe("offer_slots");
  });

  it("reads where the customer asked from the extraction", async () => {
    const w = world({ preferredTime: "sunday morning", script: [OFFER_TEXT] });
    await replyTurn(runner().step, w.turn, understood(), NOW, w.deps);
    expect(w.port.findSlots.mock.calls[0][1].from.toISOString()).toBe("2026-10-11T03:30:00.000Z"); // 9:00 on Sunday in Chennai
    expect(agentMeta(w).act).toMatchObject({ asked: true });
  });

  it("a reply that states a time that was not offered is caught by the post-check, as for any reply", async () => {
    const w = world({ script: ["How about Sun 11 Oct, 11:00 am?", "Sun 11 Oct, 11:00 am works?"] });
    const out = await replyTurn(runner().step, w.turn, understood(), NOW, w.deps);
    expect(out.reply).toMatchObject({ status: "sent", source: "fixed" }); // the safe line
    expect(w.send.mock.calls[0][2].text).not.toContain("11:00");
  });

  it("nothing free anywhere: the customer is told a person will follow up, and the chat goes to a person", async () => {
    const w = world({ port: { findSlots: vi.fn(async () => []) } });
    const out = await replyTurn(runner().step, w.turn, understood(), NOW, w.deps);
    expect(out).toMatchObject({ case: "no_slots", reply: { status: "sent", source: "fixed" }, handoff: { trigger: "stuck", opened: true, switched: true } });
    expect(w.handoffs).toHaveLength(1);
    expect(agentMeta(w).offer).toBeNull();
  });
});

describe("a business with no single service", () => {
  it.each([[[]], [[{ id: SERVICE }, { id: "30000000-0000-0000-0000-000000000009" }]]])("is taken over by a person, and the calendar is not searched (%j services)", async (services) => {
    const w = world({ services });
    const r = runner();
    const out = await replyTurn(r.step, w.turn, understood(), NOW, w.deps);
    expect(out).toMatchObject({ case: "no_service", handoff: { trigger: "stuck" } });
    expect(r.ran).toEqual(["plan", "reply", "handoff"]);
    expect(w.port.findSlots).not.toHaveBeenCalled();
  });
});

describe("the customer picks a time", () => {
  it("holds it and confirms it, tells the customer, and ends the offer", async () => {
    const w = world({ offer: OFFER, text: "the second one", script: ["You are booked for Sun 11 Oct, 3:00 pm. See you then!"] });
    const out = await replyTurn(runner().step, w.turn, understood(), NOW, w.deps);
    expect(out).toMatchObject({ case: "booked", reply: { status: "sent", source: "model" }, handoff: null });
    expect(w.port.holdSlot).toHaveBeenCalledWith(A, plain(SUN_15), LEAD, "site_visit");
    expect(w.port.confirmBooking).toHaveBeenCalledWith(A, BOOKING);
    expect(w.port.findSlots).not.toHaveBeenCalled();
    expect(userPrompt(w)).toContain("Booked: Sun 11 Oct, 3:00 pm.");
    expect(agentMeta(w).act).toEqual({ kind: "booked", label: "Sun 11 Oct, 3:00 pm" });
    expect(agentMeta(w).offer).toBeNull();
    expect(w.send).toHaveBeenCalledOnce();
  });

  it("when someone else just took it: nothing is booked, and the others are offered with the reason", async () => {
    const w = world({
      offer: OFFER,
      text: "3pm",
      script: ["Sorry, that one was just taken. I can do Sun 11 Oct, 10:00 am or Mon 12 Oct, 5:30 pm. Which suits you?"],
      port: { holdSlot: vi.fn(async () => { throw new AppError("slot_taken", "That time was just taken."); }), findSlots: vi.fn(async () => [SUN_10, MON_17]) },
    });
    const out = await replyTurn(runner().step, w.turn, understood(), NOW, w.deps);
    expect(out).toMatchObject({ case: "offer_retaken", reply: { status: "sent" } });
    expect(w.port.confirmBooking).not.toHaveBeenCalled();
    expect(userPrompt(w)).toContain("just taken by someone else");
    expect((agentMeta(w).offer as { slots: unknown[] }).slots).toHaveLength(2);
  });

  it("wants another time: the calendar is searched again from their words", async () => {
    const w = world({ offer: OFFER, text: "none of these, can we do monday evening", script: ["How about Mon 12 Oct, 5:30 pm?"], port: { findSlots: vi.fn(async () => [MON_17]) } });
    await replyTurn(runner().step, w.turn, understood(), NOW, w.deps);
    expect(w.port.holdSlot).not.toHaveBeenCalled();
    expect(w.port.findSlots.mock.calls[0][1].from.toISOString()).toBe("2026-10-12T11:30:00.000Z"); // 17:00 on Monday in Chennai
  });

  it("is not clear: the same times are offered again, with no calendar call at all", async () => {
    const w = world({ offer: OFFER, text: "hmm let me think", script: [OFFER_TEXT] });
    const r = runner();
    const out = await replyTurn(r.step, w.turn, understood(), NOW, w.deps);
    expect(out).toMatchObject({ case: "offer_reask", reply: { status: "sent" } });
    expect(r.ran).toEqual(["plan", "reply"]);
    expect(w.port.findSlots).not.toHaveBeenCalled();
    expect(w.port.holdSlot).not.toHaveBeenCalled();
    expect(Object.hasOwn(agentMeta(w), "offer")).toBe(false); // nothing written: the offer carries on
  });

  it("an offer from days ago is forgotten, so a pick is not read against times that may be gone", async () => {
    const stale = { ...OFFER, at: new Date(NOW - 3 * 24 * 3_600_000).toISOString() };
    const w = world({ offer: stale, text: "the second one", script: [OFFER_TEXT] });
    await replyTurn(runner().step, w.turn, understood(), NOW, w.deps);
    expect(w.port.holdSlot).not.toHaveBeenCalled();
  });
});

describe("safe to run again", () => {
  it("a retry after the act already kept its result does not touch the calendar again", async () => {
    const w = world({ offer: OFFER, text: "the second one", script: ["You are booked for Sun 11 Oct, 3:00 pm."], agent: { act: { kind: "booked", label: "Sun 11 Oct, 3:00 pm" } } });
    await replyTurn(runner().step, w.turn, understood(), NOW, w.deps);
    expect(w.port.holdSlot).not.toHaveBeenCalled();
    expect(w.port.findSlots).not.toHaveBeenCalled();
    expect(w.send).toHaveBeenCalledOnce();
  });

  it("running the whole turn twice sends one reply and books once", async () => {
    const w = world({ offer: OFFER, text: "the second one", script: ["You are booked for Sun 11 Oct, 3:00 pm."] });
    await replyTurn(runner().step, w.turn, understood(), NOW, w.deps);
    const again = await replyTurn(runner().step, w.turn, understood(), NOW, w.deps);
    expect(again.reply.status).toBe("already_answered");
    expect(w.send).toHaveBeenCalledOnce();
    expect(w.port.holdSlot).toHaveBeenCalledOnce();
  });

  it("a calendar outage is thrown, so the step is tried again; nothing is kept and nothing is sent", async () => {
    const w = world({ port: { findSlots: vi.fn(async () => { throw new Error("database down"); }) } });
    await expect(replyTurn(runner().step, w.turn, understood(), NOW, w.deps)).rejects.toThrow("database down");
    expect(w.send).not.toHaveBeenCalled();
    expect(agentMeta(w).act).toBeUndefined();
  });
});

describe("when booking does not apply", () => {
  it("not switched on for the business: the turn runs as it always did, and the calendar is not read", async () => {
    const w = world({ enabled: false, script: ["Hello! How can I help?"] });
    const r = runner();
    await replyTurn(r.step, w.turn, understood(), NOW, w.deps);
    expect(r.ran).toEqual(["plan", "reply"]);
    expect(w.port.findSlots).not.toHaveBeenCalled();
    expect(w.port.activeBooking).not.toHaveBeenCalled();
  });

  it("no scheduling deps at all: the same", async () => {
    const w = world({ script: ["Hello! How can I help?"] });
    const r = runner();
    await replyTurn(r.step, w.turn, understood(), NOW, { ...w.deps, scheduling: undefined });
    expect(r.ran).toEqual(["plan", "reply"]);
  });

  it("nothing about booking going on: the calendar is not read for an ordinary message", async () => {
    const w = world({ script: ["Sure, tell me more."] });
    await replyTurn(runner().step, w.turn, understood({}, { ...ready, readyForSlots: false, ask: [{ key: "location", label: "Preferred area" }] }), NOW, w.deps);
    expect(w.scheduling.services).not.toHaveBeenCalled();
    expect(w.port.activeBooking).not.toHaveBeenCalled();
  });

  it("a customer who already has a time booked is not offered another", async () => {
    const w = world({ port: { activeBooking: vi.fn(async () => ({ id: BOOKING, start: SUN_15.start, end: SUN_15.end, status: "confirmed" })) }, script: ["Hello again!"] });
    const r = runner();
    await replyTurn(r.step, w.turn, understood(), NOW, w.deps);
    expect(r.ran).toEqual(["plan", "reply"]);
    expect(w.port.findSlots).not.toHaveBeenCalled();
  });
});

describe("what the steps remember", () => {
  it("is small facts only: not the customer's words, not a phone number or a name", async () => {
    const w = world({ offer: OFFER, text: `${WORDS} the second one`, script: ["You are booked for Sun 11 Oct, 3:00 pm."] });
    const r = runner();
    await replyTurn(r.step, w.turn, understood(), NOW, w.deps);
    const kept = JSON.stringify([...r.memo.values()]);
    for (const secret of [WORDS, HIDDEN.phone, HIDDEN.name, HIDDEN.body]) expect(kept).not.toContain(secret);
  });
});
