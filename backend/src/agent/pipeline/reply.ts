import type { HandoffTrigger } from "@pakka/types";
import { NonRetriableError } from "inngest";
import { normaliseQuestion } from "../../kb/question";
import type { AuditEntry } from "../../lib/audit";
import { recordAnswered } from "./answered";
import { recordHandoff } from "./handoff";
import { applyStop, completeOptOut } from "./stop";
import { stripUnsafeCharacters } from "../../lib/text";
import type { NotifyPayload, SendOutcome } from "../../notify/send";
import type { LlmClient, LlmMessage } from "../llm/anthropic";
import { LlmError } from "../llm/anthropic";
import { buildReplyMessages, buildReplySystem, REPLY_PROMPT } from "../prompts/reply_v1";
import { consentNotice, EXIT_BUTTON_IDS, exitQuestionButtons, fixedText, textLanguage } from "./fixed-texts";
import { parseReplySettings, type ReplySettings } from "./persona";
import { planReply, type Plan, type PlanInput, type ReplyPlan } from "./plan";
import { checkReply } from "./postcheck";
import type { PortOutcome, SystemNoticePort } from "./ports";
import type { StepRunner, TurnContext } from "./process-message";
import type { Interactive } from "../../notify/interactive";
import type { HandoffPriority, PipelineStore } from "./store";
import { turnClock } from "./turn-deadline";
import type { UnderstandResult } from "./understand";

// The message pipeline, step 7 and the send (docs/handover.md, module 2): turn what step 4 found into ONE reply, check
// it, send it through notify.send, and record that the customer's messages were answered. Day 2's action is fixed
// (answer from the knowledge base's facts, or a safe line); plan.ts decides which, for every way step 4 can end, and this
// file carries it out.
//
// Steps (each a step.run; what a step returns is kept by Inngest, so only ids, flags and a case name, never text):
//   plan     the table in plan.ts, and its two side effects: the question the knowledge base could not answer is
//            recorded as a gap (once), and the chat's count of misses in a row is kept for the next turn.
//   reply    write the reply (the strong model for an answer, fixed words for everything else; the post-check; one
//            regeneration; then the safe fallback), look again at the chat's mode and the contact's opt-out, send it
//            through notify.send, and write `message.answered` for every message of the turn IN THIS STEP: a crash
//            between the send and the record would send the reply twice on retry.
//   handoff  when the plan says a person must take over (after the reply went), or the business is out of credits: the
//            handoffs row, the switch of the chat to `human`, the `handoff.opened` event (the owner's alert is Dev 2's `handoff-alert` job, from that event: the pipeline sends none).
//
// Never two replies: a step that finds the last message answered does nothing; a send whose outcome is unknown is
// treated as answered (the sender says it may have gone out); the answered rows are written with a few tries and a
// failure there is logged, never thrown (throwing would retry the step and send again).

export interface ReplyDeps {
  store: PipelineStore;
  llm: LlmClient;
  /** notify.send (Dev 2). */
  send: (tenantId: string, kind: "ai_reply", payload: NotifyPayload) => Promise<SendOutcome>;
  /** writeAudit (Dev 2): the answered rows and the handoff row. */
  audit: (entry: AuditEntry) => Promise<void>;
  /** Inngest's send, for `handoff.opened`. */
  sendEvent: (event: { id: string; name: string; data: Record<string, string> }) => Promise<unknown>;
  systemNotice: SystemNoticePort;
  /** The link in the privacy notice (PRIVACY_POLICY_URL, https). */
  privacyPolicyUrl: string;
  now?: () => number;
}

export type NotSentReason = "no_conversation" | "not_ai_mode" | "opted_out" | "feature_off" | "outside_window" | "send_failed";
export type ReplyResult =
  | { status: "sent"; source: "model" | "fixed" }
  | { status: "sent_unknown" } // the send's outcome is unknown: it may have gone out, so it is never sent again
  | { status: "already_answered" }
  | { status: "not_sent"; reason: NotSentReason }
  | { status: "no_credits" }
  /** The customer clearly asked to stop and was opted out (model_intent): nothing was sent but the one confirmation. */
  | { status: "opted_out"; confirmation: PortOutcome["status"] | "not_needed" };

export interface HandoffSummary {
  trigger: HandoffTrigger;
  opened: boolean;
  switched: boolean;
  holding: PortOutcome["status"] | "not_needed";
}

export interface ReplyOutcome {
  /** The table row (plan.ts) that decided what the customer got. */
  case: string;
  reply: ReplyResult;
  handoff: HandoffSummary | null;
}

const TAG = "[pipeline]";
const CORRECTION =
  "That reply cannot be sent. Use only the amounts, dates and times that are in <facts>, keep it under 600 characters and ask at most two questions. Write the reply again.";

/** What the plan step tells the later steps: a case name and a handover, no text. */
interface PlanSummary {
  case: string;
  deadlineExceeded: boolean;
  handoff: { trigger: HandoffTrigger; priority: HandoffPriority } | null;
  optOut: { notInterested: boolean } | null;
}

interface Loaded {
  input: PlanInput;
  agent: Record<string, unknown> | null;
  settings: ReplySettings;
  businessName: string | null;
  lastAt: string;
}

async function loadPlanInput(turn: TurnContext, understood: UnderstandResult, deadlineExceeded: boolean, deps: ReplyDeps): Promise<Loaded> {
  const { store } = deps;
  const lastMessageId = turn.messageIds[turn.messageIds.length - 1];
  const texts = await store.getBatchTexts(turn.tenantId, turn.conversationId, turn.messageIds);
  const firstAt = texts[0]?.createdAt ?? new Date().toISOString();
  const lastAt = texts[texts.length - 1]?.createdAt ?? firstAt;
  const [agent, contact, info, previousMisses, previousCase] = await Promise.all([
    store.getAgentMeta(turn.tenantId, turn.conversationId, lastMessageId),
    store.getContact(turn.tenantId, turn.contactId),
    store.getTenantReplyInfo(turn.tenantId),
    store.getPreviousMisses(turn.tenantId, turn.conversationId, firstAt),
    store.getPreviousPlanCase(turn.tenantId, turn.conversationId, firstAt),
  ]);
  const asked = (agent?.extraction as { question?: unknown } | undefined)?.question;
  const settings = parseReplySettings(info?.agentSettings);
  return {
    agent,
    settings,
    businessName: info?.name ?? null,
    lastAt,
    input: { understood, question: typeof asked === "string" ? asked : null, contactLanguage: contact?.language ?? null, previousMisses, settings, deadlineExceeded, exitQuestionPending: previousCase === "exit_unclear", customerSaidOne: texts.some((t) => isJustOne(t.body)), talkButtonTapped: texts.some((t) => t.buttonId === EXIT_BUTTON_IDS.talk) },
  };
}

/** The customer's answer "1" to the question we asked ("Reply 1 to talk to the team"): the digit alone, in any of the usual forms, with or without a full stop. */
function isJustOne(body: string | null): boolean {
  return body !== null && /^[1१１][.)]?$/u.test(body.trim());
}

/** Keeps something on the newest message's meta; a message that is not found is a bug, not retried. */
async function keep(deps: ReplyDeps, turn: TurnContext, agent: Record<string, unknown>): Promise<void> {
  const lastMessageId = turn.messageIds[turn.messageIds.length - 1];
  const saved = await deps.store.saveAgentMeta(turn.tenantId, turn.conversationId, lastMessageId, { ...agent, at: new Date().toISOString() });
  if (!saved) throw new NonRetriableError("The message was not found.");
}

export async function replyTurn(step: StepRunner, turn: TurnContext, understood: UnderstandResult, startedAt: number, deps: ReplyDeps): Promise<ReplyOutcome> {
  const now = deps.now ?? Date.now;

  const planned = await step.run<PlanSummary>("plan", async () => {
    const clock = turnClock(startedAt, now());
    const loaded = await loadPlanInput(turn, understood, clock.exceeded, deps);
    const plan = planReply(loaded.input);
    // A question the knowledge base could not answer is a gap: recorded once per turn (the marker is on the message,
    // so a retried step does not count it twice).
    if (plan.gap && loaded.agent?.gapRecorded !== true) {
      const question = [...stripUnsafeCharacters(plan.gap.question).replace(/\s+/g, " ").trim()].slice(0, 300).join("");
      const questionNorm = normaliseQuestion(question);
      if (questionNorm) {
        await deps.store.recordKbGap(turn.tenantId, { question, questionNorm, contactId: turn.contactId });
        await keep(deps, turn, { gapRecorded: true });
      }
    }
    await keep(deps, turn, { kbMisses: plan.kbMisses, planCase: plan.case });
    return { case: plan.case, deadlineExceeded: clock.exceeded, handoff: plan.handoff ?? null, optOut: plan.optOut ?? null };
  });

  // A clear request to stop that the model read: opted out like a STOP phrase, nothing else is sent (and no credit is spent).
  if (planned.optOut) {
    const optOut = planned.optOut;
    const reply = await step.run<ReplyResult>("opt-out", () => optOutByIntent(turn, understood, optOut, deps));
    return { case: planned.case, reply, handoff: null };
  }

  const reply = await step.run<ReplyResult>("reply", () => sendReply(turn, understood, startedAt, planned, deps));

  const trigger: { trigger: HandoffTrigger; priority: HandoffPriority } | null =
    reply.status === "no_credits"
      ? { trigger: "credits_exhausted", priority: "high" }
      : planned.handoff && (reply.status === "sent" || reply.status === "sent_unknown" || reply.status === "already_answered")
        ? planned.handoff
        : null;
  const handoff = trigger ? await step.run<HandoffSummary>("handoff", () => openHandoff(turn, trigger, deps)) : null;

  return { case: planned.case, reply, handoff };
}

// ---------------------------------------------------------------------------------------------------------------------
// The reply

/** The text to send for a plan: the model's answer after the post-check, or fixed words. Never throws for a model problem. */
async function compose(plan: Plan, loaded: Loaded, turn: TurnContext, exceeded: boolean, signal: AbortSignal, deps: ReplyDeps): Promise<{ text: string; source: "model" | "fixed" }> {
  const fixedPlan = (reply: ReplyPlan) => (reply.mode === "fixed" ? reply : null);
  const fixedOf = fixedPlan(plan.reply);
  if (fixedOf) return { text: fixedText(fixedOf.text, fixedOf.language), source: "fixed" };

  const model = plan.reply as Extract<ReplyPlan, { mode: "model" }>;
  const fallback = { text: fixedText("fallback", textLanguage(model.language, loaded.input.contactLanguage)), source: "fixed" as const };
  if (exceeded) return fallback;

  try {
    if (!loaded.businessName) throw new Error("the business has no name");
    const system = buildReplySystem({ businessName: loaded.businessName, persona: loaded.settings.persona, tone: loaded.settings.tone });
    // The last 10 messages, ending with the customer's latest (they are all stored before the turn runs).
    // Up to the turn's newest message and no further: a message that arrived after it belongs to the next turn.
    const history = await deps.store.getHistory(turn.tenantId, turn.conversationId, new Date(Date.parse(loaded.lastAt) + 1).toISOString(), 10);
    const first: LlmMessage[] = buildReplyMessages({
      action: model.action,
      facts: model.facts,
      askFields: model.ask?.map(({ label, options }) => ({ label, options })),
      history: history.map((h) => ({ sender: h.sender, text: h.body })),
      language: model.language ?? undefined,
    });

    let messages = first;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const result = await deps.llm.complete({ role: "reply", tenantId: turn.tenantId, conversationId: turn.conversationId, prompt: REPLY_PROMPT, system, messages, signal });
      const text = stripUnsafeCharacters(result.text).trim();
      const check = checkReply(text, model.facts);
      if (check.ok) return { text, source: "model" };
      // The kinds of problem only: never the reply or what it said.
      console.error(`${TAG} a reply failed the post-check (${check.problems.join(", ")}; attempt ${attempt})`);
      messages = [...first, { role: "assistant", content: text }, { role: "user", content: CORRECTION }];
    }
  } catch (error) {
    // The model, its prompt or the history failed: the customer still gets an answer. The code only, never the words.
    console.error(`${TAG} the reply could not be written (${error instanceof LlmError ? error.code : error instanceof Error ? error.name : "unknown"})`);
  }
  return fallback;
}

/** The opt-out the model asked for: the same writes as a STOP phrase (stop.ts), with the language of the message. */
async function optOutByIntent(turn: TurnContext, understood: UnderstandResult, optOut: { notInterested: boolean }, deps: ReplyDeps): Promise<ReplyResult> {
  const contact = await deps.store.getContact(turn.tenantId, turn.contactId);
  const language = textLanguage(understood.status === "understood" ? understood.summary.language : null, contact?.language);
  const lastMessageId = turn.messageIds[turn.messageIds.length - 1];
  const result = await completeOptOut(turn, { source: "model_intent", messageId: lastMessageId, language, leadId: turn.leadId, notInterested: optOut.notInterested }, deps);
  return { status: "opted_out", confirmation: result.confirmation };
}

async function sendReply(turn: TurnContext, understood: UnderstandResult, startedAt: number, planned: PlanSummary, deps: ReplyDeps): Promise<ReplyResult> {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const lastMessageId = turn.messageIds[turn.messageIds.length - 1];
  const loaded = await loadPlanInput(turn, understood, planned.deadlineExceeded, deps);

  // A retried step, or a repeated event: the last message has been answered, so nothing is sent again. Two signals:
  // the audit row, and the marker the send leaves on the message's meta (if the audit could not be written, the marker
  // still stops a second reply; then the missing rows are written now).
  const markedSent = loaded.agent?.reply !== undefined && loaded.agent.reply !== null;
  const answered = await store.isAnswered(turn.tenantId, lastMessageId, loaded.lastAt);
  if (answered || markedSent) {
    if (!answered) await recordAnswered(turn, deps);
    return { status: "already_answered" };
  }

  const clock = turnClock(startedAt, now());
  const plan = planReply(loaded.input);
  if (plan.reply.mode === "none") return { status: "not_sent", reason: "opted_out" }; // the opt-out step handles it (replyTurn); nothing to send here
  const { text, source } = await compose(plan, loaded, turn, clock.exceeded, clock.signal, deps);

  // Staff may have taken over, or the customer sent STOP, since the gate looked.
  const [conversation, contact] = await Promise.all([store.getConversation(turn.tenantId, turn.conversationId), store.getContact(turn.tenantId, turn.contactId)]);
  if (!conversation) return { status: "not_sent", reason: "no_conversation" };
  if (conversation.mode !== "ai") return { status: "not_sent", reason: "not_ai_mode" };
  if (!contact || contact.optedOut) return { status: "not_sent", reason: "opted_out" };

  // The model can take seconds: look once more, right before the send, in case another run answered meanwhile.
  if (await store.isAnswered(turn.tenantId, lastMessageId, loaded.lastAt)) return { status: "already_answered" };

  // The first AI reply to a contact carries the privacy notice (DPDP): who answers, how to stop, the policy link, only when
  // the business turned it on (agent_settings.privacyNotice; off by default per Raja, 9 Oct).
  const noticeLanguage = plan.reply.mode === "fixed" ? plan.reply.language : textLanguage(plan.reply.language, loaded.input.contactLanguage);
  const carriesNotice = loaded.settings.privacyNotice && contact.consentAt === null;
  const outgoing = carriesNotice ? `${text}\n\n${consentNotice(noticeLanguage, deps.privacyPolicyUrl)}` : text;

  // The exit question goes as two reply buttons (Raja, 9 Oct); if WhatsApp refuses them (not a retry, not an unknown outcome) the
  // same question goes once as plain text with "Reply 1". A tap or a "1" is read by plan.ts.
  const exit = plan.reply.mode === "fixed" && plan.reply.text === "exit_question" ? exitQuestionButtons(plan.reply.language) : null;
  const send = (payload: { text: string } | { interactive: Interactive }) => deps.send(turn.tenantId, "ai_reply", { conversationId: turn.conversationId, ...payload });
  let outcome = exit
    ? await send({ interactive: { type: "buttons", body: carriesNotice ? `${exit.body}

${consentNotice(noticeLanguage, deps.privacyPolicyUrl)}` : exit.body, buttons: [...exit.buttons] } })
    : await send({ text: outgoing });
  if (exit && outcome.status === "failed" && !outcome.error.retryable && !outcome.error.outcomeUnknown) outcome = await send({ text: outgoing });
  switch (outcome.status) {
    case "sent":
      // The marker first (one cheap write), then the rows: if the rows cannot be written, a retry still sees the marker.
      await keep(deps, turn, { reply: { case: planned.case, source } }).catch(() => undefined);
      if (carriesNotice) await noticeShown(turn, outcome.messageId, deps);
      await recordAnswered(turn, deps);
      return { status: "sent", source };
    case "skipped":
      if (outcome.reason === "insufficient_credits") return { status: "no_credits" };
      console.error(`${TAG} the reply was not sent (${outcome.reason})`);
      return { status: "not_sent", reason: outcome.reason };
    case "failed":
      // It may have gone out anyway: never resend, and count it as answered.
      if (outcome.error.outcomeUnknown) {
        await keep(deps, turn, { reply: { case: planned.case, source: "unknown_outcome" } }).catch(() => undefined);
        await recordAnswered(turn, deps);
        return { status: "sent_unknown" };
      }
      console.error(`${TAG} the reply could not be sent (${outcome.error.code})`);
      // Waiting can fix it (a blip, a rate limit): the step is tried again; anything else is final.
      if (outcome.error.retryable) throw new Error(`the reply could not be sent (${outcome.error.code})`);
      return { status: "not_sent", reason: "send_failed" };
  }
}

/**
 * The notice went out: set consent_at and log `notice_shown` (one transaction, once). A failure is logged and never thrown,
 * like the answered rows: a retry would send the reply again. The cost of a failure is that the next reply carries the notice too.
 */
async function noticeShown(turn: TurnContext, messageId: string | null, deps: ReplyDeps): Promise<void> {
  try {
    await deps.store.recordNoticeShown(turn.tenantId, turn.contactId, messageId);
  } catch {
    console.error(`${TAG} could not record the privacy notice (business ${turn.tenantId})`);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The handover

async function openHandoff(turn: TurnContext, handoff: { trigger: HandoffTrigger; priority: HandoffPriority }, deps: ReplyDeps): Promise<HandoffSummary> {
  const { store } = deps;
  // On every run, not only the one that made the row (handoff.ts): a retry after a failure between the row and the event must still tell staff.
  const opened = await recordHandoff(turn, handoff, deps);
  const switched = await store.setConversationMode(turn.tenantId, turn.conversationId, "human");

  const settle = async (send: () => Promise<PortOutcome>): Promise<PortOutcome["status"]> => {
    try {
      return (await send()).status;
    } catch {
      return "failed";
    }
  };
  // Out of credits: the customer got no reply from the assistant, so one free holding line says a person will answer.
  let holding: HandoffSummary["holding"] = "not_needed";
  // Only the run that opened the handoff sends it: the line is a real message now, and a retry must not send it twice (the
  // cost: a crash between the row and this send means no holding line; staff still see the handoff).
  if (handoff.trigger === "credits_exhausted" && opened.created) {
    const contact = await store.getContact(turn.tenantId, turn.contactId);
    holding = await settle(() =>
      deps.systemNotice.send({ tenantId: turn.tenantId, conversationId: turn.conversationId, kind: "credits_holding", text: fixedText("credits_holding", textLanguage(contact?.language)) }),
    );
  }
  return { trigger: handoff.trigger, opened: opened.created, switched, holding };
}

// ---------------------------------------------------------------------------------------------------------------------
// When the run gave up

/**
 * Called when a run has failed after its retries: a customer must not be left without an answer. If their latest
 * messages are still unanswered and the chat is still the assistant's, one safe line goes out and they are marked
 * answered. Best effort, never throws, and safe to call twice (it looks first).
 */
export async function answerAfterFailure(ids: { tenantId: string; conversationId: string; messageId: string }, batchWindowMs: number, deps: ReplyDeps): Promise<"sent" | "opted_out" | "nothing_to_do" | "not_sent"> {
  const { store } = deps;
  try {
    const message = await store.getMessage(ids.tenantId, ids.conversationId, ids.messageId);
    if (!message || message.sender !== "customer") return "nothing_to_do";
    const since = new Date(Date.parse(message.createdAt) - batchWindowMs).toISOString();
    const pending = await store.recentUnanswered(ids.tenantId, ids.conversationId, since);
    if (pending.length === 0) return "nothing_to_do";
    const conversation = await store.getConversation(ids.tenantId, ids.conversationId);
    if (!conversation) return "nothing_to_do";
    const contact = await store.getContact(ids.tenantId, conversation.contactId);
    if (!contact || contact.optedOut) return "nothing_to_do";
    // The run may have died before its STOP check: a customer who asked to stop must not get a reply (or a privacy notice) now.
    const stopped = await applyStop({ tenantId: ids.tenantId, conversationId: ids.conversationId, contactId: contact.id, messageIds: pending.map((m) => m.id) }, deps);
    if (stopped) return "opted_out";
    if (conversation.mode !== "ai") return "nothing_to_do";

    const language = textLanguage(contact.language);
    // The notice is optional: if the business's settings cannot be read, the safe line still goes out, without it.
    const info = await store.getTenantReplyInfo(ids.tenantId).catch(() => null);
    const notice = parseReplySettings(info?.agentSettings).privacyNotice && contact.consentAt === null ? `\n\n${consentNotice(language, deps.privacyPolicyUrl)}` : "";
    const outcome = await deps.send(ids.tenantId, "ai_reply", { conversationId: ids.conversationId, text: fixedText("fallback", language) + notice });
    if (outcome.status === "sent" || (outcome.status === "failed" && outcome.error.outcomeUnknown)) {
      // A notice is recorded as shown only when the send is known to have gone out: an unknown outcome leaves consent_at
      // null, so the next reply carries the notice again (a repeated notice costs nothing; a false "shown" would be a lie in the log).
      if (notice && outcome.status === "sent") {
        try {
          await store.recordNoticeShown(ids.tenantId, contact.id, outcome.messageId);
        } catch {
          // logged by the store; the next reply carries the notice again
        }
      }
      await recordAnswered({ tenantId: ids.tenantId, conversationId: ids.conversationId, messageIds: pending.map((m) => m.id) } as TurnContext, deps);
      return "sent";
    }
    return "not_sent";
  } catch {
    return "not_sent";
  }
}
