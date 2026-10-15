import { vi, type Mock } from "vitest";
import type { AuditEntry } from "../lib/audit";
import type { SendOutcome } from "../notify/send";
import { HOT_LEAD_ACTION } from "../agent/pipeline/events";
import { fakePipelineStore, type FakeMessage } from "./fake-pipeline-store";
import type { LlmClient, LlmRequest, LlmResult } from "../agent/llm/anthropic";
import type { FoundSlot, SchedulingDeps, SchedulingPort } from "../agent/scheduling/act";
import type { StepRunner, TurnContext } from "../agent/pipeline/process-message";
import type { ReplyDeps } from "../agent/pipeline/reply";
import type { QualificationSummary, Retrieval, UnderstandResult } from "../agent/pipeline/understand";

// A turn through the reply step with booking switched on: the store, the model, notify.send and the calendar are fakes. Shared by the
// booking tests (reply-booking.test.ts, reply-booking-change.test.ts).

export const A = "e0000000-0000-0000-0000-00000000000a";
export const CONV = "c0000000-0000-0000-0000-00000000000c";
export const CONTACT = "b0000000-0000-0000-0000-0000000000b1";
export const LEAD = "10000000-0000-0000-0000-0000000000f1";
export const SERVICE = "30000000-0000-0000-0000-000000000003";
export const RES = "20000000-0000-0000-0000-000000000002";
export const BOOKING = "40000000-0000-0000-0000-000000000004";
export const PREVIOUS = "a0000000-0000-0000-0000-0000000000a0";
export const M1 = "a0000000-0000-0000-0000-0000000000a1";
export const NOW = Date.parse("2026-10-10T04:30:00.000Z"); // Sat 10 Oct, 10:00 in Chennai
export const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();
const SENT: SendOutcome = { status: "sent", messageId: "m-out", providerMsgId: "wamid.OUT", creditsCharged: 1, usedTemplate: false };
export const WORDS = "SECRET-CUSTOMER-WORDS";

export const found = (start: string, label: string): FoundSlot => ({ start, end: new Date(Date.parse(start) + 3_600_000).toISOString(), resourceId: RES, resourceName: "Anand", serviceId: SERVICE, label });
export const SUN_10 = found("2026-10-11T04:30:00.000Z", "Sun 11 Oct, 10:00 am");
export const SUN_15 = found("2026-10-11T09:30:00.000Z", "Sun 11 Oct, 3:00 pm");
export const MON_17 = found("2026-10-12T12:00:00.000Z", "Mon 12 Oct, 5:30 pm");
export const plain = (s: FoundSlot) => ({ start: s.start, end: s.end, resourceId: s.resourceId, serviceId: s.serviceId, label: s.label });
export const OFFER = { slots: [SUN_10, SUN_15, MON_17].map(plain), at: at(120) };

export const ready: QualificationSummary = { score: 50, temperature: "warm", ask: [], missingRequired: [], readyForSlots: true, hardFail: null, bookingKind: "site_visit" };
const skipped: Retrieval = { outcome: "skipped" };
export const understood = (over: Record<string, unknown> = {}, q: QualificationSummary = ready): UnderstandResult => ({
  status: "understood",
  summary: { intent: "give_details", language: "en", sentiment: "neutral", asksIfHuman: false, notInterested: false, confidence: 0.9, hasQuestion: false, fieldKeys: [], ...over },
  retrieval: skipped,
  qualification: q,
}) as UnderstandResult;

export const llmResult = (text: string): LlmResult => ({ text, model: "claude-sonnet-5-5", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.01, latencyMs: 2000, attempts: 1, requestId: null });

export function runner() {
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

export interface Options {
  /** What the customer wrote this turn. */
  text?: string;
  /** The kind of the customer message (default text); an audio message has no words (body null). */
  kind?: string;
  body?: string | null;
  /** Messages the customer sent before this turn, oldest first (their agent meta is what the earlier turns kept). */
  earlier?: { body: string | null; kind?: string; agent?: Record<string, unknown> }[];
  preferredTime?: string | null;
  /** An offer made earlier in this chat. */
  offer?: typeof OFFER | null;
  script?: string[];
  port?: Partial<SchedulingPort>;
  services?: { id: string }[];
  /** tenants.agent_settings, as the dashboard saves it. */
  agentSettings?: unknown;
  enabled?: boolean;
  /** What the extraction kept on the message before the reply step ran (a retry finds the act's result already there). */
  agent?: Record<string, unknown>;
  /** What the lead already holds (leads.fields): the details the customer gave in earlier turns. */
  leadFields?: Record<string, unknown>;
}

export function world(over: Options = {}) {
  const customer = (id: string, secondsAgo: number, body: string | null, agent: Record<string, unknown>, kind = "text"): FakeMessage => ({
    id, tenantId: A, conversationId: CONV, direction: "in", sender: "customer", kind, createdAt: at(secondsAgo), body, meta: { agent },
  });
  const messages: FakeMessage[] = [];
  if (over.offer) messages.push(customer(PREVIOUS, 120, "earlier", { offer: over.offer }));
  (over.earlier ?? []).forEach((e, i) => messages.push(customer(`a0000000-0000-0000-0000-00000000010${i}`, 600 - i * 60, e.body, e.agent ?? {}, e.kind ?? "text")));
  messages.push(customer(M1, 3, over.body === undefined ? (over.text ?? WORDS) : over.body, { extraction: { question: null, preferredTime: over.preferredTime ?? null }, ...over.agent }, over.kind ?? "text"));
  const fake = fakePipelineStore({
    tenants: [{ id: A, vertical: "sample-pack", verticalVersion: 1 }],
    messages,
    conversations: [{ id: CONV, tenantId: A, contactId: CONTACT, mode: "ai" }],
    contacts: [{ id: CONTACT, tenantId: A, language: null, optedOut: false, consentAt: "2026-10-01T00:00:00Z" }],
    leads: [{ id: LEAD, tenantId: A, contactId: CONTACT, stage: "engaged", createdAt: 1, fields: over.leadFields ?? {} }],
    tenantInfo: { [A]: { name: "Skyline Homes", agentSettings: over.agentSettings ?? {} } },
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
    rescheduleBooking: vi.fn<SchedulingPort["rescheduleBooking"]>(async () => ({ id: BOOKING })),
    cancelBooking: vi.fn<SchedulingPort["cancelBooking"]>(async () => undefined),
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
    if (entry.action === HOT_LEAD_ACTION && entry.entityId) fake.hotAlerted.add(entry.entityId);
  });
  const sendEvent = vi.fn<ReplyDeps["sendEvent"]>(async () => undefined);
  const systemNotice = { send: vi.fn(async () => ({ status: "awaiting_notify_kind" as const })) };
  const deps: ReplyDeps = { store: fake.store, llm, send, audit, sendEvent, systemNotice, privacyPolicyUrl: "https://example.test/privacy", scheduling, now: () => NOW };
  const turn: TurnContext = { tenantId: A, conversationId: CONV, contactId: CONTACT, leadId: LEAD, leadCreated: false, messageIds: [M1], language: null, vertical: "sample-pack", verticalVersion: 1 };
  return { ...fake, complete, port, scheduling, send, sendEvent, audits, deps, turn };
}


export const agentMeta = (w: ReturnType<typeof world>) => (w.messages.get(M1)?.meta?.agent ?? {}) as Record<string, unknown>;
export const userPrompt = (w: ReturnType<typeof world>) => w.complete.mock.calls[0][0].messages[0].content as string;
export const OFFER_TEXT = "I can do Sun 11 Oct, 10:00 am, Sun 11 Oct, 3:00 pm or Mon 12 Oct, 5:30 pm. Which suits you?";
