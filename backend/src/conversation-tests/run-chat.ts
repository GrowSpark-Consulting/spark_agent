import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AuditEntry } from "../lib/audit";
import type { InjectableFailure } from "../lib/env";
import { withLlmFailures, type FailureInjection } from "../lib/failure-injection";
import type { LlmClient, LlmRequest, LlmResult } from "../agent/llm";
import { NonRetriableError } from "inngest";
import { amountsIn } from "../agent/pipeline/postcheck";
import { BOOKING_REMINDER_ACTION, HOT_LEAD_ACTION, HOT_LEAD_EVENT, VOICE_NOTE_EVENT } from "../agent/pipeline/events";
import { fixedText } from "../agent/pipeline/fixed-texts";
import type { StepRunner, TurnContext } from "../agent/pipeline/process-message";
import { replyTurn, type ReplyDeps, type ReplyOutcome } from "../agent/pipeline/reply";
import type { AreaReminderInput } from "../agent/handoff/area-reminder";
import type { BookingChangeReminderInput } from "../agent/handoff/booking-change-reminder";
import { stopCheck } from "../agent/pipeline/stop";
import { understandTurn, type UnderstandDeps, type UnderstandResult } from "../agent/pipeline/understand";
import type { SendOutcome } from "../notify/send";
import { fakePipelineStore, type FakeMessage } from "../test-support/fake-pipeline-store";
import { createCalendar } from "./calendar";
import type { Chat, ChatTurn, TurnExpect } from "./schema";

// Runs one scripted chat through the real pipeline steps (stop check, understanding, reply) on an in-memory store, as
// process-message runs them. In the default (mock) mode the language models are scripted by the chat, the knowledge
// base returns the chat's own chunks and nothing is ever sent: it checks the code around the models. In live mode the
// models are the real ones (the knowledge base and the sender stay fakes), so only `expect` is checked: what the real
// model understood. See tests/conversations/README.md.

const PACKS_DIR = fileURLToPath(new URL("../../../packs", import.meta.url));
const A = "e0000000-0000-0000-0000-00000000000a";
const CONV = "c0000000-0000-0000-0000-00000000000c";
const CONTACT = "b0000000-0000-0000-0000-0000000000b1";
const LEAD = "10000000-0000-0000-0000-0000000000f1";
export const PRIVACY_URL = "https://example.test/privacy";
const messageId = (kind: "in" | "out", n: number) => `${kind === "in" ? "a" : "d"}0000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

/**
 * Timing of one run, for the latency harness (conversation-tests/latency.ts). Everything it is given is a name and a number of milliseconds: no text, no ids.
 * Nothing the pipeline does depends on it, and without one the run is exactly what it was.
 */
/** An error that carries this is not recorded as a timing: the call never happened (the latency harness's request cap refusing it). */
export interface UntimedError {
  untimed: true;
}

export interface StageProbe {
  /**
   * One timed piece of work: a pipeline step ("step:extract"), a model call ("llm:extraction", "llm:reply"), the knowledge-base search ("kb"), the send
   * ("send") or a calendar call ("booking"). Calls made inside a step are inside that step's time.
   */
  record(stage: string, ms: number): void;
  /** A whole turn (stop check, understanding and reply), from before the stop check to after the reply step. */
  turn?(index: number, ms: number): void;
}

export interface RunOptions {
  mode: "mock" | "live";
  /** Times the steps and the calls (conversation-tests/latency.ts). */
  probe?: StageProbe;
  /** The real client, in live mode. */
  llm?: LlmClient;
  /** Called with the index of each turn just before it starts (the triage harness uses it to tell which message a model call belongs to). */
  onTurn?: (index: number) => void;
}

export interface TurnTranscript {
  customer: string;
  reply: string | null;
  intent: string | null;
  confidence: number | null;
  planCase: string;
  optedOut: boolean;
  handoff: string | null;
  /** What the extraction read from the message; null when no model read it (a STOP phrase, a chat the assistant is out of). */
  extraction: { language: string | null; sentiment: string | null; fields: Record<string, unknown> } | null;
}
export interface ChatReport {
  failures: string[];
  transcript: TurnTranscript[];
}

const result = (text: string): LlmResult => ({ text, model: "mock", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, latencyMs: 0, attempts: 1, requestId: null });
const QUIET_EXTRACTION = { language: "en", intent: "question", fields: {}, question: null, preferredTime: null, sentiment: "neutral", asksIfHuman: false, confidence: 0.9 };

function memoRunner(probe?: StageProbe): StepRunner {
  const memo = new Map<string, unknown>();
  return {
    async run(id, fn) {
      if (memo.has(id)) return memo.get(id) as never;
      const startedAt = performance.now();
      try {
        const value = await fn();
        memo.set(id, value);
        return value;
      } finally {
        recordSafely(probe, `step:${id}`, performance.now() - startedAt);
      }
    },
  };
}

/** A probe that fails must never change a run: it is told, and if it throws, nothing else happens. */
function recordSafely(probe: StageProbe | undefined, stage: string, ms: number): void {
  try {
    probe?.record(stage, ms);
  } catch {
    // a timing that could not be kept is not worth a run
  }
}

/** The function, timed under a stage name when there is a probe; the function itself when there is not. */
function timed<A extends unknown[], R>(probe: StageProbe | undefined, stage: string | ((...args: A) => string), fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  if (!probe) return fn;
  return async (...args: A) => {
    const startedAt = performance.now();
    let untimed = false;
    try {
      return await fn(...args);
    } catch (error) {
      untimed = typeof error === "object" && error !== null && (error as Partial<UntimedError>).untimed === true;
      throw error;
    } finally {
      if (!untimed) recordSafely(probe, typeof stage === "string" ? stage : stage(...args), performance.now() - startedAt);
    }
  };
}

const subset = (actual: Record<string, unknown> | undefined, wanted: Record<string, unknown>): string[] =>
  Object.entries(wanted).filter(([key, value]) => actual?.[key] !== value).map(([key, value]) => `${key}: wanted ${JSON.stringify(value)}, got ${JSON.stringify(actual?.[key])}`);

/** Every function of the calendar port, timed as "booking". */
function timedPort<P extends object>(port: P, probe: StageProbe): P {
  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(port)) wrapped[name] = typeof value === "function" ? timed(probe, "booking", value as (...args: unknown[]) => Promise<unknown>) : value;
  return wrapped as P;
}

/**
 * The text the fake knowledge base finds on a turn, the same in mock and --live (the runner's retrieve reads this and nothing else): the turn's own `kb`
 * (`kb: []` = nothing found, so the code sees a miss), else the older `mock.kb`, else the chat's `kb`.
 */
export function knowledgeBaseForTurn(chat: Pick<Chat, "kb">, turn: Pick<ChatTurn, "kb" | "mock">): string[] {
  return turn.kb ?? turn.mock?.kb ?? chat.kb;
}

export async function runChat(chat: Chat, options: RunOptions): Promise<ChatReport> {
  const pack = JSON.parse(readFileSync(`${PACKS_DIR}/${chat.pack}.json`, "utf8")) as { key: string; version: number };
  const live = options.mode === "live";
  const failures: string[] = [];
  const transcript: TurnTranscript[] = [];

  // A chat with a `booking` setup runs on its own fixed clock, so "tomorrow evening" does not depend on when the test runs.
  const setup = chat.booking;
  const clock = setup ? () => Date.parse(setup.now) : Date.now;
  const base = clock() - 6 * 3_600_000;
  const fake = fakePipelineStore({
    tenants: [{ id: A, vertical: pack.key, verticalVersion: pack.version }],
    messages: [],
    conversations: [{ id: CONV, tenantId: A, contactId: CONTACT, mode: "ai" }],
    contacts: [{ id: CONTACT, tenantId: A, language: chat.contact.language, optedOut: false, consentAt: chat.contact.alreadySawNotice ? "2026-10-01T00:00:00Z" : null }],
    leads: [{ id: LEAD, tenantId: A, contactId: CONTACT, stage: "new", createdAt: 1, fields: {} }],
    tenantInfo: { [A]: { name: "Skyline Homes", agentSettings: chat.settings } },
  });

  // The calendar: only for a chat that says so. A booking being confirmed moves the lead to booked (Dev 2's confirm_booking does it in the database).
  const calendar = setup
    ? createCalendar({
        now: setup.now,
        timeZone: setup.timeZone,
        slots: setup.slots,
        takenWhenChosen: setup.takenWhenChosen,
        existing: setup.existing,
        workPincodes: setup.workPincodes,
        onConfirm: () => {
          const lead = fake.leads.get(LEAD);
          if (lead) lead.stage = "booked";
        },
      })
    : null;

  // Per turn: what the mocked models say, and what the pipeline did.
  let extractionScript: Record<string, unknown> = {};
  let replyScript: string[] = [];
  let kb: string[] = chat.kb;
  let creditsZero = false;
  // The failures this turn injects (`mock.inject`), through the same wrapper staging uses.
  let injected: readonly InjectableFailure[] = [];
  const turnInjection: FailureInjection = { breaks: (_tenantId, failure) => injected.includes(failure) };
  const sends: { kind: string; text: string; buttons: string[] }[] = [];
  const confirmations: string[] = [];
  const audits: AuditEntry[] = [];
  let outCount = 0;

  const mockLlm: LlmClient = {
    async complete(request: LlmRequest) {
      if (request.role === "extraction") return result(JSON.stringify({ ...QUIET_EXTRACTION, ...extractionScript }));
      const next = replyScript.shift();
      if (next === undefined) throw new Error("the mocked reply model was called more often than the chat scripts");
      return result(next);
    },
  };
  const realOrMock = live ? options.llm : mockLlm;
  if (!realOrMock) throw new Error("live mode needs a language-model client");
  const chosenLlm = withLlmFailures(realOrMock, turnInjection);
  const llm: LlmClient = options.probe ? { complete: timed(options.probe, (request: LlmRequest) => `llm:${request.role}`, (request: LlmRequest) => chosenLlm.complete(request)) } : chosenLlm;

  const plainSend: ReplyDeps["send"] = async (_tenantId, kind, payload): Promise<SendOutcome> => {
    // Out of credits: notify.send refuses the reply and spends nothing.
    if (creditsZero) return { status: "skipped", reason: "insufficient_credits" };
    // An injected WhatsApp failure, as notify.send reports the sender's SendError: nothing went out (or, on a timeout, maybe).
    if (injected.includes("whatsapp_send_timeout")) return { status: "failed", error: { code: "upstream_failed", message: "WhatsApp did not answer (injected failure).", retryable: true, outcomeUnknown: true } };
    if (injected.includes("whatsapp_send_error")) return { status: "failed", error: { code: "upstream_failed", message: "WhatsApp refused the message (injected failure).", retryable: true, outcomeUnknown: false } };
    const interactive = payload.interactive;
    const text = interactive ? interactive.body : (payload.text ?? "");
    sends.push({ kind, text, buttons: interactive?.type === "buttons" ? interactive.buttons.map((b) => b.title) : [] });
    const sentAt = new Date(clock()).toISOString();
    fake.messages.set(messageId("out", ++outCount), { id: messageId("out", outCount), tenantId: A, conversationId: CONV, direction: "out", sender: "ai", kind: "text", createdAt: sentAt, body: text, meta: {} } as FakeMessage);
    return { status: "sent", messageId: `m-out-${outCount}`, providerMsgId: `wamid.${outCount}`, creditsCharged: 1, usedTemplate: false };
  };
  const send: ReplyDeps["send"] = timed(options.probe, "send", plainSend);
  const audit = async (entry: AuditEntry) => {
    audits.push(entry);
    if (entry.action === "message.answered" && entry.entityId) fake.answered.set(entry.entityId, Date.now());
    if (entry.action === HOT_LEAD_ACTION && entry.entityId) fake.hotAlerted.add(entry.entityId);
    if (entry.action === BOOKING_REMINDER_ACTION && entry.entityId) fake.bookingReminded.add(entry.entityId);
  };
  const systemNotice = {
    send: async (input: { text: string }) => {
      confirmations.push(input.text);
      return { status: "sent" as const };
    },
  };
  const handoffEvents: string[] = [];
  const hotLeadEvents: string[] = [];
  const voiceEvents: string[] = [];
  const areaReminders: AreaReminderInput[] = [];
  const bookingReminders: BookingChangeReminderInput[] = [];
  let bookingReminderFails = false;
  const sendEvent: ReplyDeps["sendEvent"] = async (event) => {
    handoffEvents.push(event.id);
    if (event.name === HOT_LEAD_EVENT) hotLeadEvents.push(event.id);
    if (event.name === VOICE_NOTE_EVENT) voiceEvents.push(event.id);
  };
  const replyDeps: ReplyDeps = {
    store: fake.store,
    llm,
    send,
    audit,
    sendEvent,
    systemNotice,
    privacyPolicyUrl: PRIVACY_URL,
    areaReminder: async (input) => {
      areaReminders.push(input);
      return { recipients: 1, sent: 1, skipped: 0, failed: 0 };
    },
    bookingChangeReminder: async (input) => {
      bookingReminders.push(input);
      return bookingReminderFails ? { recipients: 1, sent: 0, skipped: 0, failed: 1 } : { recipients: 1, sent: 1, skipped: 0, failed: 0 };
    },
    now: clock,
    ...(setup && calendar
      ? {
          scheduling: {
            port: options.probe ? timedPort(calendar.port, options.probe) : calendar.port,
            isEnabled: async () => true,
            services: async () => Array.from({ length: setup.services }, (_, i) => ({ id: `30000000-0000-0000-0000-${String(i + 3).padStart(12, "0")}` })),
            timeZone: async () => setup.timeZone,
          },
        }
      : {}),
  };
  const understandDeps: UnderstandDeps = {
    store: fake.store,
    llm,
    loadPackDefinition: async (key, version) => (key === pack.key && version === pack.version ? (pack as unknown) : null),
    retrieve: timed(options.probe, "kb", async () => kb.map((content, i) => ({ chunkId: `chunk-${i}`, documentId: "doc-1", title: "Knowledge base", content, similarity: 0.8 }))),
    ...(setup ? { scoring: { loadCatalog: async () => setup.catalog, isEnabled: async () => true } } : {}),
  };

  for (const [index, turnSpec] of chat.turns.entries()) {
    options.onTurn?.(index);
    const label = `turn ${index + 1} (${JSON.stringify(turnSpec.customer.slice(0, 40))})`;
    const fail = (message: string) => failures.push(`${label}: ${message}`);
    extractionScript = turnSpec.mock?.extraction ?? {};
    replyScript = turnSpec.mock?.reply === undefined ? [] : [...(Array.isArray(turnSpec.mock.reply) ? turnSpec.mock.reply : [turnSpec.mock.reply])];
    kb = knowledgeBaseForTurn(chat, turnSpec);
    creditsZero = turnSpec.mock?.credits === "zero";
    bookingReminderFails = turnSpec.mock?.bookingReminder === "fails";
    injected = turnSpec.mock?.inject ?? [];
    const sendsBefore = sends.length;
    const confirmationsBefore = confirmations.length;
    const logsBefore = fake.consentLogs.length;
    const handoffsBefore = fake.handoffs.length;
    const hotLeadBefore = hotLeadEvents.length;
    const voiceBefore = voiceEvents.length;
    const areaRemindersBefore = areaReminders.length;
    const bookingRemindersBefore = bookingReminders.length;

    const id = messageId("in", index + 1);
    fake.messages.set(id, { id, tenantId: A, conversationId: CONV, direction: "in", sender: "customer", kind: turnSpec.voice ? "audio" : turnSpec.tap ? "interactive" : "text", createdAt: new Date(base + index * 60_000).toISOString(), body: turnSpec.voice ? null : turnSpec.customer, meta: turnSpec.tap ? { buttonId: turnSpec.tap } : {} } as FakeMessage);
    const turn: TurnContext = { tenantId: A, conversationId: CONV, contactId: CONTACT, leadId: LEAD, leadCreated: false, messageIds: [id], language: null, vertical: pack.key, verticalVersion: pack.version };
    const step = memoRunner(options.probe);
    const turnStartedAt = performance.now();

    let stopped = false;
    let understood: UnderstandResult | null = null;
    let outcome: ReplyOutcome | null = null;
    const optedOutAtStart = fake.contacts.get(CONTACT)?.optedOut === true;
    try {
      if (optedOutAtStart) {
        // The gate (step 3) stops a contact who opted out: nothing is read or answered.
      } else {
        stopped = (await stopCheck(step, turn, { store: fake.store, audit, systemNotice, sendEvent })).status === "opted_out";
        if (!stopped) {
          understood = await understandTurn(step, turn, understandDeps);
          outcome = await replyTurn(step, turn, understood, clock(), replyDeps);
        }
      }
    } catch (error) {
      fail(`the pipeline threw: ${error instanceof NonRetriableError ? "non-retriable " : ""}${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      options.probe?.turn?.(index, performance.now() - turnStartedAt);
    } catch {
      // see recordSafely
    }
    const turnSends = sends.slice(sendsBefore);
    const replyText = turnSends[0]?.text ?? null;
    const contact = fake.contacts.get(CONTACT);
    const meta = fake.messages.get(id)?.meta?.agent as { extraction?: Record<string, unknown>; planCase?: string } | undefined;
    const lastHandoff = fake.handoffs[fake.handoffs.length - 1];
    transcript.push({
      customer: turnSpec.customer,
      reply: replyText,
      intent: typeof meta?.extraction?.intent === "string" ? meta.extraction.intent : null,
      confidence: typeof meta?.extraction?.confidence === "number" ? meta.extraction.confidence : null,
      planCase: stopped ? "stop_phrase" : (outcome?.case ?? (optedOutAtStart ? "gated_opted_out" : "none")),
      optedOut: contact?.optedOut === true,
      handoff: fake.handoffs.length > handoffsBefore ? `${lastHandoff.trigger}/${lastHandoff.priority}` : null,
      extraction: meta?.extraction
        ? {
            language: typeof meta.extraction.language === "string" ? meta.extraction.language : null,
            sentiment: typeof meta.extraction.sentiment === "string" ? meta.extraction.sentiment : null,
            fields: typeof meta.extraction.fields === "object" && meta.extraction.fields !== null ? (meta.extraction.fields as Record<string, unknown>) : {},
          }
        : null,
    });

    // What must hold for every chat, in every mode.
    if (turnSends.length > 1) fail(`more than one AI reply was sent (${turnSends.length})`);
    if (turnSends.some((s) => s.kind !== "ai_reply")) fail("an outbound message did not go as an ai_reply through notify.send");
    if (contact?.optedOut && turnSends.length > 0) fail("a reply was sent to a contact who opted out");

    const check = (expect: TurnExpect | undefined) => {
      if (!expect) return;
      if (expect.stop !== undefined && stopped !== expect.stop) fail(`stop: wanted ${expect.stop}, got ${stopped}`);
      if (expect.extracted) {
        const { fields, ...top } = expect.extracted;
        for (const problem of subset(meta?.extraction, top)) fail(`extracted ${problem}`);
        if (fields) for (const problem of subset(meta?.extraction?.fields as Record<string, unknown> | undefined, fields)) fail(`extracted field ${problem}`);
      }
      if (expect.case !== undefined && transcript[index].planCase !== expect.case) fail(`case: wanted ${expect.case}, got ${transcript[index].planCase}`);
      if (expect.reply) {
        const r = expect.reply;
        if (r.sent !== undefined && (turnSends.length === 1) !== r.sent) fail(`reply sent: wanted ${r.sent}, got ${turnSends.length} AI replies`);
        if (r.fixed) {
          const wanted = fixedText(r.fixed.key, r.fixed.language);
          if (!replyText?.includes(wanted)) fail(`reply: wanted the fixed line ${r.fixed.key}/${r.fixed.language}, got ${JSON.stringify(replyText)}`);
        }
        if (r.buttons && JSON.stringify(turnSends[0]?.buttons ?? []) !== JSON.stringify(r.buttons)) fail(`reply buttons: wanted ${JSON.stringify(r.buttons)}, got ${JSON.stringify(turnSends[0]?.buttons ?? [])}`);
        for (const text of r.contains ?? []) if (!replyText?.includes(text)) fail(`reply: should contain ${JSON.stringify(text)}, got ${JSON.stringify(replyText)}`);
        for (const pattern of r.matches ?? []) if (!new RegExp(pattern, "i").test(replyText ?? "")) fail(`reply: should match /${pattern}/i, but got ${JSON.stringify(replyText)}`);
        for (const text of r.notContains ?? []) if (replyText?.includes(text)) fail(`reply: must not contain ${JSON.stringify(text)}`);
        if (r.notice !== undefined && (replyText?.includes(PRIVACY_URL) ?? false) !== r.notice) fail(`privacy notice on the reply: wanted ${r.notice}`);
      }
      if (expect.noInventedPrice && !replyText) fail("noInventedPrice: there is no reply to check");
      if (expect.noInventedPrice && replyText) {
        const known = amountsIn(kb.join(" "));
        for (const amount of amountsIn(replyText)) if (!known.has(amount)) fail(`the reply has an amount that is not in the knowledge base: ${amount}`);
      }
      if (expect.optedOut !== undefined && (contact?.optedOut === true) !== expect.optedOut) fail(`optedOut: wanted ${expect.optedOut}`);
      if (expect.consent) {
        const logs = fake.consentLogs.slice(logsBefore).map((l) => ({ event: l.event, source: l.source }));
        if (JSON.stringify(logs) !== JSON.stringify(expect.consent)) fail(`consent_logs: wanted ${JSON.stringify(expect.consent)}, got ${JSON.stringify(logs)}`);
      }
      if (expect.handoff !== undefined) {
        const opened = fake.handoffs.length > handoffsBefore ? { trigger: lastHandoff.trigger, priority: lastHandoff.priority } : null;
        if (JSON.stringify(opened) !== JSON.stringify(expect.handoff)) fail(`handoff: wanted ${JSON.stringify(expect.handoff)}, got ${JSON.stringify(opened)}`);
      }
      if (expect.mode !== undefined && fake.conversations.get(CONV)?.mode !== expect.mode) fail(`mode: wanted ${expect.mode}, got ${fake.conversations.get(CONV)?.mode}`);
      if (expect.leadStage !== undefined && fake.leads.get(LEAD)?.stage !== expect.leadStage) fail(`lead stage: wanted ${expect.leadStage}, got ${fake.leads.get(LEAD)?.stage}`);
      if (expect.leadFields) for (const problem of subset(fake.leads.get(LEAD)?.fields as Record<string, unknown> | undefined, expect.leadFields)) fail(`lead field ${problem}`);
      if (expect.hotLead !== undefined && hotLeadEvents.length - hotLeadBefore > 0 !== expect.hotLead) fail(`hot lead alert this turn: wanted ${expect.hotLead}, got ${hotLeadEvents.length - hotLeadBefore > 0}`);
      if (expect.voiceNoteAlert !== undefined && voiceEvents.length - voiceBefore > 0 !== expect.voiceNoteAlert) fail(`voice note alert this turn: wanted ${expect.voiceNoteAlert}, got ${voiceEvents.length - voiceBefore > 0}`);
      if (expect.areaReminder !== undefined && areaReminders.length - areaRemindersBefore > 0 !== expect.areaReminder) fail(`area reminder this turn: wanted ${expect.areaReminder}, got ${areaReminders.length - areaRemindersBefore > 0}`);
      if (expect.bookingChangeReminder !== undefined && bookingReminders.length - bookingRemindersBefore > 0 !== expect.bookingChangeReminder) fail(`booking change reminder this turn: wanted ${expect.bookingChangeReminder}, got ${bookingReminders.length - bookingRemindersBefore > 0}`);
      if (expect.leadTemperature !== undefined && fake.leads.get(LEAD)?.temperature !== expect.leadTemperature) fail(`lead temperature: wanted ${expect.leadTemperature}, got ${fake.leads.get(LEAD)?.temperature}`);
      if (expect.leadScore !== undefined && fake.leads.get(LEAD)?.score !== expect.leadScore) fail(`lead score: wanted ${expect.leadScore}, got ${fake.leads.get(LEAD)?.score}`);
      if (expect.calendar) {
        if (!calendar) fail("calendar: the chat has no booking setup");
        else {
          if (expect.calendar.confirmed && JSON.stringify(calendar.confirmed()) !== JSON.stringify(expect.calendar.confirmed)) fail(`calendar confirmed: wanted ${JSON.stringify(expect.calendar.confirmed)}, got ${JSON.stringify(calendar.confirmed())}`);
          if (expect.calendar.cancelled !== undefined && calendar.cancelled() !== expect.calendar.cancelled) fail(`calendar cancelled: wanted ${expect.calendar.cancelled}, got ${calendar.cancelled()}`);
        }
      }
      if (expect.aiReplies !== undefined && turnSends.length !== expect.aiReplies) fail(`AI replies: wanted ${expect.aiReplies}, got ${turnSends.length}`);
      if (expect.confirmations !== undefined && confirmations.length - confirmationsBefore !== expect.confirmations) fail(`confirmations: wanted ${expect.confirmations}, got ${confirmations.length - confirmationsBefore}`);
    };
    check(turnSpec.expect);
    if (!live) check(turnSpec.mockOnly);

    // Unused script is a mistake in the chat, not in the code: say so (mock mode only).
    if (!live && replyScript.length > 0) fail(`the chat scripts ${replyScript.length} more mocked reply than the pipeline asked for`);
  }
  return { failures, transcript };
}
