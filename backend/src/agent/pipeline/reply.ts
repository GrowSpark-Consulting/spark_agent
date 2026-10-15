import type { HandoffTrigger } from "@pakka/types";
import { NonRetriableError } from "inngest";
import { z } from "zod";
import { normaliseQuestion } from "../../kb/question";
import type { AuditEntry } from "../../lib/audit";
import type { AreaReminderInput } from "../handoff/area-reminder";
import type { BookingChangeReminderInput } from "../handoff/booking-change-reminder";
import { recordAnswered } from "./answered";
import { BOOKING_REMINDER_ACTION, HOT_LEAD_ACTION, HOT_LEAD_EVENT, VOICE_NOTE_EVENT } from "./events";
import { recordHandoff } from "./handoff";
import { applyStop, completeOptOut } from "./stop";
import { stripUnsafeCharacters } from "../../lib/text";
import type { NotifyPayload, SendOutcome } from "../../notify/send";
import type { LlmClient, LlmMessage } from "../llm/anthropic";
import { LlmError } from "../llm/anthropic";
import { buildReplyMessages, buildReplySystem, REPLY_PROMPT } from "../prompts/reply_v2";
import { mentionsArea, normaliseArea } from "../scoring/coverage";
import { areaText, consentNotice, EXIT_BUTTON_IDS, exitQuestionButtons, fixedText, textLanguage } from "./fixed-texts";
import { parseReplySettings, type ReplySettings } from "./persona";
import { runAct, ActResultSchema, type ActResult } from "../scheduling/act";
import { slotLabel } from "../../booking/time";
import { freshOffer } from "../scheduling/state";
import { planReply, type Plan, type PlanInput, type ReplyPlan } from "./plan";
import { checkReply } from "./postcheck";
import type { PortOutcome, SystemNoticePort } from "./ports";
import type { StepRunner, TurnContext } from "./process-message";
import type { Interactive } from "../../notify/interactive";
import type { SchedulingDeps } from "../scheduling/act";
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
  /**
   * Booking (step 6): the calendar and the business's services, through Dev 2's booking functions. Without it nothing about booking
   * happens and every turn runs as before.
   */
  scheduling?: SchedulingDeps;
  /**
   * Reminds the owners and admins, once, to record in their CRM that a customer wants an area the business has no sites in (agent/handoff/area-reminder.ts:
   * a staff_alert through notify.send with our own text). Without it nobody is reminded and the customer's reply is the same. Never needed for the reply.
   */
  areaReminder?: (input: AreaReminderInput) => Promise<unknown>;
  /**
   * Tells the owners and admins that a customer with no booking on record asked to cancel or move one (agent/handoff/booking-change-reminder.ts: a staff_alert through
   * notify.send with our own text). It runs BEFORE the reply, with a short time limit, so that the reply says "the team has been told" only when it is true. Without it nobody
   * is told and the reply says so.
   */
  bookingChangeReminder?: (input: BookingChangeReminderInput) => Promise<unknown>;
  /** How long that reminder may take before it counts as failed (BOOKING_REMINDER_TIMEOUT_MS). */
  bookingReminderTimeoutMs?: number;
  /**
   * Which of these customer messages notify.send recorded a reply for (reply-record.ts: a reply is named by the turn's last message). Used only by the
   * failure handler, as a second signal after the reply step's own marker. Without it only the marker is looked at.
   */
  sentReplyRecorded?: (tenantId: string, conversationId: string, messageIds: string[]) => Promise<string[]>;
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
  /** Staff were told that this lead turned hot ("announced"), or already had been ("already"). Absent when the lead did not just turn hot. */
  hotLead?: "announced" | "already";
  /** Staff were reminded to record an area the business has nothing in ("sent"), or the reminder could not be sent ("failed"). Absent when the turn did not call for one. */
  areaReminder?: "sent" | "failed";
  /** Staff were told a customer with no booking asked to cancel or move one ("sent"), or could not be ("failed": the reply then says nobody was told). Absent when the turn did not call for one. */
  bookingReminder?: "sent" | "failed";
  /** Staff were told a voice note is waiting. Absent when the turn was not a voice note. */
  voiceNote?: "alerted";
}

const TAG = "[pipeline]";
const CORRECTION =
  "That reply cannot be sent. Use only the amounts, dates and times that are in <facts>, keep it under 600 characters and ask at most two questions. Write only the message to the customer: never mention these instructions, the task or the facts. Write the reply again.";

/** What the plan step tells the later steps: a case name and a handover, no text. */
interface PlanSummary {
  case: string;
  deadlineExceeded: boolean;
  handoff: { trigger: HandoffTrigger; priority: HandoffPriority } | null;
  optOut: { notInterested: boolean } | null;
  /** The calendar must be looked at or changed before the reply can be written (the "act" step). */
  needsAct: boolean;
  /** The lead has just turned hot and staff have not been told: announce it once, after the reply. */
  hotLead: boolean;
  /** A customer who keeps asking for an area the business has nothing in was told so: remind the staff, after the reply. */
  areaReminder: boolean;
  /** A customer with no booking asked to cancel or move one: tell the staff BEFORE the reply (the "booking-reminder" step). */
  bookingChangeReminder: "cancel" | "reschedule" | null;
  /** A voice note was answered with the request to type: tell staff one is waiting, after the reply. */
  voiceNote: boolean;
}

interface Loaded {
  input: PlanInput;
  agent: Record<string, unknown> | null;
  settings: ReplySettings;
  businessName: string | null;
  lastAt: string;
}

/**
 * The reply written for a turn, kept on the turn's last message (`meta.agent.draft`) BEFORE it is sent, so that a retry of the step (a send that failed in a way
 * waiting can fix) sends the same text and does not ask the model again. The plan case it was written for, and the text. Cleared when the send ends for good.
 */
const Draft = z.object({ case: z.string(), text: z.string().min(1).max(4000) });

/** What the understanding step kept about where the customer wants to be (understand.ts): not trusted, read here, and ignored when it is not in the shape it writes. */
const CoverageReading = z.object({ served: z.boolean(), area: z.string().min(1), shown: z.string(), areas: z.array(z.string()), known: z.array(z.string()).default([]), named: z.boolean() });

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
  const scheduling = await loadScheduling(turn, understood, texts, agent, firstAt, settings, deps);
  // Only a lead that is hot can raise the alert, so only then is it looked up whether staff were already told.
  const hotLeadAlerted = understood.status === "understood" && understood.qualification?.temperature === "hot" ? await store.hasHotLeadAlert(turn.tenantId, turn.leadId) : undefined;
  // A voice note has no words: every message of the burst is audio. Only then is it a voice note, and only a repeat if the last turn was one too.
  const voiceNote = texts.length > 0 && texts.every((t) => t.kind === "audio");
  // A place the business has no sites in: what this chat has already said about it is read only when there is one to talk about.
  const area = CoverageReading.safeParse(agent?.coverageReading);
  const unserved = area.success && !area.data.served ? area.data : null;
  const previous = unserved ? await store.getPreviousCoverage(turn.tenantId, turn.conversationId, firstAt) : null;
  const stage = unserved && previous && previous.area === unserved.area ? previous.stage : null;
  // The model names the place only when a message adds it, and a repeat adds nothing (the place is already on the lead): a customer who repeats it is
  // read from their own words. Only against the place this chat already answered (never before the options were shown), as a whole word, and not when
  // the same message also names a place the business has (they may be weighing the two).
  const words = texts.map((t) => t.body ?? "").join(" ");
  const repeated = unserved !== null && !unserved.named && stage !== null && mentionsArea(words, unserved.area) && ![...unserved.known, ...unserved.areas.map(normaliseArea)].some((a) => mentionsArea(words, a));
  const coverage = unserved ? { area: unserved.area, shown: unserved.shown, areas: unserved.areas, named: unserved.named || repeated, stage } : null;
  return {
    agent,
    settings,
    businessName: info?.name ?? null,
    lastAt,
    input: { ...(scheduling ? { scheduling } : {}), ...(hotLeadAlerted === undefined ? {} : { hotLeadAlerted }), ...(voiceNote ? { voiceNote, voiceNoteRepeat: previousCase === "voice_note" } : {}), ...(coverage ? { coverage } : {}), ...(area.success && area.data.served && area.data.named ? { areaServedNamed: true } : {}), understood, question: typeof asked === "string" ? asked : null, contactLanguage: contact?.language ?? null, customerWords: words, ...(agent?.bookingReminder === "sent" ? { bookingReminderSent: true } : {}), previousMisses, settings, deadlineExceeded, exitQuestionPending: previousCase === "exit_unclear", customerSaidOne: texts.some((t) => isJustOne(t.body)), talkButtonTapped: texts.some((t) => t.buttonId === EXIT_BUTTON_IDS.talk) },
  };
}

/**
 * Tells whoever sends staff alerts that this lead turned hot (an event with ids only, one per lead) and remembers it in the audit log, so it is
 * said once. Safe to run again: it looks first, and a repeat of the event is dropped by its id. Nothing about the chat changes.
 */
async function announceHotLead(turn: TurnContext, deps: ReplyDeps): Promise<"announced" | "already"> {
  if (await deps.store.hasHotLeadAlert(turn.tenantId, turn.leadId)) return "already";
  await deps.sendEvent({ id: `lead_hot:${turn.leadId}`, name: HOT_LEAD_EVENT, data: { tenantId: turn.tenantId, leadId: turn.leadId, conversationId: turn.conversationId } });
  try {
    await deps.audit({ tenantId: turn.tenantId, actor: "ai", action: HOT_LEAD_ACTION, entity: "lead", entityId: turn.leadId, diff: { temperature: "hot" } });
  } catch {
    // The event is out; a lost audit row only means the next hot turn announces again, which the event id drops.
    console.error(`${TAG} could not record the hot lead alert (business ${turn.tenantId})`);
  }
  return "announced";
}

/**
 * Reminds the owners and admins to record the area (agent/handoff/area-reminder.ts). The place is read from the message's meta, where the understanding
 * step kept it (a step's result holds no words). The reminder carries an idempotency key per lead and place, so a repeat of this step sends nothing
 * again. A reminder that cannot be sent is logged without a word of the customer's and never fails the turn: the reply has gone.
 */
async function announceAreaReminder(turn: TurnContext, deps: ReplyDeps): Promise<"sent" | "failed" | "skipped"> {
  const lastMessageId = turn.messageIds[turn.messageIds.length - 1];
  const reading = CoverageReading.safeParse((await deps.store.getAgentMeta(turn.tenantId, turn.conversationId, lastMessageId))?.coverageReading);
  if (!reading.success || reading.data.served || !deps.areaReminder) return "skipped";
  try {
    const counts = (await deps.areaReminder({ tenantId: turn.tenantId, conversationId: turn.conversationId, leadId: turn.leadId, area: reading.data.shown, areaKey: reading.data.area })) as { sent?: unknown; failed?: unknown } | undefined;
    // sendToAdmins counts instead of throwing: a reminder that reached nobody because every send or the lookup failed is not "sent". (Best effort: the reply has gone.)
    if (counts && counts.sent === 0 && typeof counts.failed === "number" && counts.failed > 0) {
      console.error(`${TAG} the area reminder reached nobody (business ${turn.tenantId})`);
      return "failed";
    }
    return "sent";
  } catch {
    console.error(`${TAG} the area reminder could not be sent (business ${turn.tenantId})`);
    return "failed";
  }
}

/** How long the staff reminder for a cancel or move with no booking may take; past it the reminder counts as failed and the reply goes out saying nobody was told. */
export const BOOKING_REMINDER_TIMEOUT_MS = 3000;

/**
 * Tells the owners and admins that a customer with no booking asked to cancel or move one, before the reply. Already told for this lead (the audit row of an earlier send): nothing is
 * sent again. Otherwise the reminder is tried within the time limit; a send that went out writes the audit row, anything else (a refusal, a switch that is off, nobody to tell, an error, a
 * timeout) counts as failed and a later message of the lead tries again (the send's key lets it: notify.send releases a refused claim, and never sends a recorded or unknown one twice).
 * The result is kept on the message for the reply. Never throws for a send problem.
 */
async function announceBookingReminder(turn: TurnContext, kind: "cancel" | "reschedule", deps: ReplyDeps): Promise<"sent" | "failed"> {
  let result: "sent" | "failed" = "failed";
  // A person has taken the chat, or the customer has opted out, since the plan: no reply will go out, so nobody is alerted (sendReply looks at the same two things).
  const [conversation, contact] = await Promise.all([deps.store.getConversation(turn.tenantId, turn.conversationId), deps.store.getContact(turn.tenantId, turn.contactId)]);
  const replyWillGo = conversation?.mode === "ai" && contact !== null && !contact.optedOut;
  if (deps.bookingChangeReminder && replyWillGo) {
    try {
      if (await deps.store.hasBookingChangeReminder(turn.tenantId, turn.leadId)) {
        result = "sent";
      } else {
        // The call is started first (in a promise, so a dep that throws at once is a rejection too), and the timer only after it: nothing is left running if it fails.
        const call = Promise.resolve().then(() => deps.bookingChangeReminder!({ tenantId: turn.tenantId, conversationId: turn.conversationId, leadId: turn.leadId, kind }));
        let timer: ReturnType<typeof setTimeout> | undefined;
        const limit = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("timed out")), deps.bookingReminderTimeoutMs ?? BOOKING_REMINDER_TIMEOUT_MS);
        });
        const counts = (await Promise.race([call, limit]).finally(() => clearTimeout(timer))) as { sent?: unknown } | undefined;
        if (counts && typeof counts.sent === "number" && counts.sent > 0) {
          result = "sent";
          try {
            await deps.audit({ tenantId: turn.tenantId, actor: "ai", action: BOOKING_REMINDER_ACTION, entity: "lead", entityId: turn.leadId, diff: { kind } });
          } catch {
            // The staff were told; a lost audit row only means a later message asks again, and the send's own key stops a second send.
            console.error(`${TAG} could not record the booking-change reminder (business ${turn.tenantId})`);
          }
        }
      }
    } catch {
      console.error(`${TAG} the booking-change reminder could not be sent (business ${turn.tenantId})`);
    }
  }
  await keep(deps, turn, { bookingReminder: result });
  return result;
}

/** Tells whoever sends staff alerts that a voice note is waiting (an event with ids only). A repeat is dropped by its id. */
async function announceVoiceNote(turn: TurnContext, deps: ReplyDeps): Promise<"alerted"> {
  const lastMessageId = turn.messageIds[turn.messageIds.length - 1];
  await deps.sendEvent({ id: `voice_note:${lastMessageId}`, name: VOICE_NOTE_EVENT, data: { tenantId: turn.tenantId, conversationId: turn.conversationId, leadId: turn.leadId } });
  return "alerted";
}

/** The booking part of the plan input, or undefined when booking is off, does not apply to this business, or nothing about it is going on. */
async function loadScheduling(
  turn: TurnContext,
  understood: UnderstandResult,
  texts: { body: string | null }[],
  agent: Record<string, unknown> | null,
  firstAt: string,
  settings: ReplySettings,
  deps: ReplyDeps,
): Promise<PlanInput["scheduling"] | undefined> {
  const sd = deps.scheduling;
  if (!sd || understood.status !== "understood") return undefined;
  const q = understood.qualification;
  if (!q?.bookingKind) return undefined;
  if (!(await sd.isEnabled(turn.tenantId, "booking"))) return undefined;

  const now = new Date((deps.now ?? Date.now)());
  const stored = ActResultSchema.safeParse(agent?.act);
  const waiting = freshOffer(await deps.store.getPreviousOffer(turn.tenantId, turn.conversationId, firstAt), now);
  const intent = understood.summary.intent;
  // The calendar is only read when something about booking is going on: something waiting for an answer, a booking asked for, moved or
  // cancelled, or a lead that is ready.
  const aboutBooking = intent === "book" || intent === "reschedule" || intent === "cancel" || q.readyForSlots;
  if (!stored.success && !waiting && !aboutBooking) return undefined;

  const pincode = q.bookingKind === "field_visit" && q.visitAreaField ? visitPincode((await deps.store.getLead(turn.tenantId, turn.leadId))?.fields[q.visitAreaField]) : undefined;
  const [services, timeZone, active] = await Promise.all([sd.services(turn.tenantId), sd.timeZone(turn.tenantId), sd.port.activeBooking(turn.tenantId, turn.leadId)]);
  const preferred = (agent?.extraction as { preferredTime?: unknown } | undefined)?.preferredTime;
  const times = waiting && "slots" in waiting ? waiting : null;
  const cancelAsk = waiting && "cancel" in waiting ? waiting.cancel : null;
  return {
    service: chosenService(services, settings),
    offer: times ? times.slots : null,
    rescheduleBookingId: times?.rescheduleBookingId ?? null,
    cancelAsk,
    hasBooking: active !== null,
    // Only a confirmed booking can be moved or cancelled by chat; a time that is still only held cannot.
    booking: active && active.status === "confirmed" ? { id: active.id, label: slotLabel(new Date(active.start), timeZone) } : null,
    customerText: texts[texts.length - 1]?.body ?? "",
    preferredTime: typeof preferred === "string" && preferred.trim() ? preferred : null,
    timeZone,
    now,
    ...(stored.success ? { act: stored.data as ActResult } : {}),
    ...(pincode ? { pincode } : {}),
  };
}

/** The six digits of a pincode the lead holds (typed with a space or a dash it is the same pincode), or undefined: a place name, a short number or nothing is not one. */
function visitPincode(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : typeof value === "number" && Number.isInteger(value) ? String(value) : "";
  const digits = normaliseArea(text);
  return /^\d{6}$/.test(digits) ? digits : undefined;
}

/** The service to book: the one the business named, if it is active; else the only one; never a guess among several. */
function chosenService(services: { id: string }[], settings: ReplySettings): NonNullable<PlanInput["scheduling"]>["service"] {
  const named = settings.bookingServiceId ? services.find((s) => s.id === settings.bookingServiceId) : undefined;
  if (named) return { state: "one", id: named.id };
  return services.length === 1 ? { state: "one", id: services[0].id } : services.length === 0 ? { state: "none" } : { state: "several" };
}

/**
 * What a turn's act step keeps as what waits for the customer's answer next: new times (for a booking, or for moving one), the question
 * whether to cancel, nothing (what was waiting is over), or no change at all (leave it as it was).
 */
function offerAfter(result: ActResult, at: Date): { offer: Record<string, unknown> | null } | Record<string, never> {
  switch (result.kind) {
    case "offered":
      return { offer: { slots: result.slots, at: at.toISOString(), ...(result.rescheduleBookingId ? { rescheduleBookingId: result.rescheduleBookingId } : {}) } };
    case "cancel_asked":
      return { offer: { cancel: { bookingId: result.bookingId, label: result.label }, at: at.toISOString() } };
    case "booked":
    case "rescheduled":
    case "cancelled":
    case "kept":
    case "no_slots":
      return { offer: null };
    case "error":
      return {};
  }
}

/** The act step: look at the calendar, or book, as the plan asked, and keep the result on the message. Safe to run again: a result already kept is used. */
async function performAct(turn: TurnContext, understood: UnderstandResult, deps: ReplyDeps): Promise<{ kind: ActResult["kind"] }> {
  const loaded = await loadPlanInput(turn, understood, false, deps);
  const sd = deps.scheduling;
  const s = loaded.input.scheduling;
  if (!sd || !s) return keepAct(turn, { kind: "error" }, new Date((deps.now ?? Date.now)()), deps);
  if (s.act) return { kind: s.act.kind };
  const request = planReply(loaded.input).act;
  if (!request) return keepAct(turn, { kind: "error" }, s.now, deps);
  const result = await runAct(request, { tenantId: turn.tenantId, leadId: turn.leadId, timeZone: s.timeZone, now: s.now, port: sd.port, ...(s.pincode ? { pincode: s.pincode } : {}) });
  return keepAct(turn, result, s.now, deps);
}

async function keepAct(turn: TurnContext, result: ActResult, now: Date, deps: ReplyDeps): Promise<{ kind: ActResult["kind"] }> {
  await keep(deps, turn, { act: result, ...offerAfter(result, now) });
  return { kind: result.kind };
}

/** The plan again, with the act result in hand: what the customer is told, and whether a person must take over. */
async function replan(turn: TurnContext, understood: UnderstandResult, startedAt: number, deps: ReplyDeps): Promise<PlanSummary> {
  const clock = turnClock(startedAt, (deps.now ?? Date.now)());
  const loaded = await loadPlanInput(turn, understood, clock.exceeded, deps);
  const plan = planReply(loaded.input);
  await keep(deps, turn, planMeta(plan));
  return { case: plan.case, deadlineExceeded: clock.exceeded, handoff: plan.handoff ?? null, optOut: plan.optOut ?? null, needsAct: false, hotLead: plan.hotLead === true, areaReminder: plan.areaReminder === true, bookingChangeReminder: plan.bookingChangeReminder ?? null, voiceNote: plan.voiceNote === true };
}

/** The customer's answer "1" to the question we asked ("Reply 1 to talk to the team"): the digit alone, in any of the usual forms, with or without a full stop. */
function isJustOne(body: string | null): boolean {
  return body !== null && /^[1१１][.)]?$/u.test(body.trim());
}

/**
 * The name a turn's reply goes out under (notify.send's idempotencyKey: 1 to 200 characters, and the message id it derives is the credit ref). One reply per
 * turn, and a turn is its newest customer message, so that message names it.
 */
export const replyKey = (lastMessageId: string): string => `reply:${lastMessageId}`;

/** What a plan leaves on the message for the next turn: the miss count, the case, and, when it changed, what was said about an unserved place. */
const planMeta = (plan: Plan): Record<string, unknown> => ({ kbMisses: plan.kbMisses, planCase: plan.case, ...(plan.coverage !== undefined ? { coverage: plan.coverage } : {}) });

/**
 * The kept reply, when it still fits: written for the plan case of this turn, and still passing the post-check against the facts of this turn. Otherwise null,
 * and the model is asked as usual. Only a model answer is ever kept (fixed words cost nothing to write again), so a draft is always the model's text.
 */
function reusableDraft(loaded: Loaded, planned: PlanSummary, plan: Plan): string | null {
  if (plan.reply.mode !== "model" || !loaded.businessName) return null;
  const draft = Draft.safeParse(loaded.agent?.draft);
  if (!draft.success || draft.data.case !== planned.case) return null;
  try {
    const system = buildReplySystem({ businessName: loaded.businessName, persona: loaded.settings.persona, tone: loaded.settings.tone });
    return checkReply(draft.data.text, plan.reply.facts, { rules: system[0]?.text }).ok ? draft.data.text : null;
  } catch {
    return null;
  }
}

/**
 * Keeps the written reply (or, with null, clears it). Best effort and never thrown: a draft that cannot be kept only means a retry asks the model again, and one
 * that cannot be cleared is harmless (nothing reads it once the message is answered or a later message is the turn's last). The kind of error only is logged,
 * never the text (the store has already logged the database's code). Says whether the draft is now there to clear.
 */
async function keepDraft(deps: ReplyDeps, turn: TurnContext, draft: { case: string; text: string } | null): Promise<boolean> {
  try {
    await keep(deps, turn, { draft });
    return true;
  } catch (error) {
    console.error(`${TAG} ${draft ? "the written reply could not be kept" : "the kept draft could not be cleared"} (${error instanceof Error ? error.name : "unknown"})`);
    return false;
  }
}

/** Keeps something on the newest message's meta; a message that is not found is a bug, not retried. */
async function keep(deps: ReplyDeps, turn: TurnContext, agent: Record<string, unknown>): Promise<void> {
  const lastMessageId = turn.messageIds[turn.messageIds.length - 1];
  const saved = await deps.store.saveAgentMeta(turn.tenantId, turn.conversationId, lastMessageId, { ...agent, at: new Date().toISOString() });
  if (!saved) throw new NonRetriableError("The message was not found.");
}

export async function replyTurn(step: StepRunner, turn: TurnContext, understood: UnderstandResult, startedAt: number, deps: ReplyDeps): Promise<ReplyOutcome> {
  const now = deps.now ?? Date.now;

  let planned = await step.run<PlanSummary>("plan", async () => {
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
    await keep(deps, turn, planMeta(plan));
    return { case: plan.case, deadlineExceeded: clock.exceeded, handoff: plan.handoff ?? null, optOut: plan.optOut ?? null, needsAct: plan.act !== undefined, hotLead: plan.hotLead === true, areaReminder: plan.areaReminder === true, bookingChangeReminder: plan.bookingChangeReminder ?? null, voiceNote: plan.voiceNote === true };
  });

  // The calendar is looked at or changed once (step 6), its result kept on the message, and the plan made again with it in hand.
  if (planned.needsAct) {
    await step.run("act", () => performAct(turn, understood, deps));
    planned = await step.run<PlanSummary>("plan-act", () => replan(turn, understood, startedAt, deps));
  }

  // A clear request to stop that the model read: opted out like a STOP phrase, nothing else is sent (and no credit is spent).
  if (planned.optOut) {
    const optOut = planned.optOut;
    const reply = await step.run<ReplyResult>("opt-out", () => optOutByIntent(turn, understood, optOut, deps));
    return { case: planned.case, reply, handoff: null };
  }

  // A customer with no booking on record asked to cancel or move one: the staff are told FIRST (a short time limit, never blocks), so the reply can say the team has been told only if so.
  const bookingChange = planned.bookingChangeReminder;
  const bookingReminder = bookingChange ? await step.run<"sent" | "failed">("booking-reminder", () => announceBookingReminder(turn, bookingChange, deps)) : null;

  const reply = await step.run<ReplyResult>("reply", () => sendReply(turn, understood, startedAt, planned, deps));

  const trigger: { trigger: HandoffTrigger; priority: HandoffPriority } | null =
    reply.status === "no_credits"
      ? { trigger: "credits_exhausted", priority: "high" }
      : planned.handoff && (reply.status === "sent" || reply.status === "sent_unknown" || reply.status === "already_answered")
        ? planned.handoff
        : null;
  const handoff = trigger ? await step.run<HandoffSummary>("handoff", () => openHandoff(turn, trigger, deps)) : null;

  // A lead that has just turned hot: staff are told once, after the customer has their reply. The chat stays with the AI.
  const answered = reply.status === "sent" || reply.status === "sent_unknown" || reply.status === "already_answered";
  const hotLead = planned.hotLead && answered ? await step.run<"announced" | "already">("hot-lead", () => announceHotLead(turn, deps)) : null;

  // A customer who keeps asking for an area the business has nothing in, and has been told so: the staff are reminded, once. Never blocks or fails the turn.
  const areaAlert = planned.areaReminder && answered && deps.areaReminder ? await step.run<"sent" | "failed" | "skipped">("area-reminder", () => announceAreaReminder(turn, deps)) : null;

  // A voice note that was answered: staff are told one is waiting, so someone can listen to it. One event per message (its id), ids only.
  const voiceAlert = planned.voiceNote && answered ? await step.run<"alerted">("voice-alert", () => announceVoiceNote(turn, deps)) : null;

  return { case: planned.case, reply, handoff, ...(hotLead ? { hotLead } : {}), ...(areaAlert && areaAlert !== "skipped" ? { areaReminder: areaAlert } : {}), ...(bookingReminder ? { bookingReminder } : {}), ...(voiceAlert ? { voiceNote: voiceAlert } : {}) };
}

// ---------------------------------------------------------------------------------------------------------------------
// The reply

/** The text to send for a plan: the model's answer after the post-check, or fixed words. Never throws for a model problem. */
async function compose(plan: Plan, loaded: Loaded, turn: TurnContext, exceeded: boolean, signal: AbortSignal, deps: ReplyDeps): Promise<{ text: string; source: "model" | "fixed" }> {
  const fixedPlan = (reply: ReplyPlan) => (reply.mode === "fixed" ? reply : null);
  const fixedOf = fixedPlan(plan.reply);
  if (fixedOf) {
    const areaLine = fixedOf.vars && (fixedOf.text === "area_options" || fixedOf.text === "area_unavailable") ? areaText(fixedOf.text, fixedOf.language, fixedOf.vars) : null;
    return { text: areaLine ?? fixedText(fixedOf.text, fixedOf.language), source: "fixed" };
  }

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
      const check = checkReply(text, model.facts, { rules: system[0]?.text });
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
  if (plan.reply.mode === "none") {
    // A repeated voice note: nothing is sent, but the messages are answered, so they are not picked up again.
    if (plan.markAnswered) {
      await recordAnswered(turn, deps);
      return { status: "already_answered" };
    }
    return { status: "not_sent", reason: "opted_out" }; // the opt-out step handles it (replyTurn); nothing to send here
  }
  // A retry of this step (the send below failed in a way waiting can fix) finds the reply the first attempt wrote and sends it: no second model call, and the same text.
  // It is used even when the turn's clock has run out (it needs no model). A fresh reply from the model is kept before the send; fixed words and the safe line are not.
  const reused = reusableDraft(loaded, planned, plan);
  const { text, source } = reused !== null ? { text: reused, source: "model" as const } : await compose(plan, loaded, turn, clock.exceeded, clock.signal, deps);
  let draftKept = reused !== null;
  if (reused === null && source === "model") draftKept = await keepDraft(deps, turn, { case: planned.case, text });
  const dropDraft = async () => {
    if (draftKept) await keepDraft(deps, turn, null);
  };

  // Staff may have taken over, or the customer sent STOP, since the gate looked.
  const [conversation, contact] = await Promise.all([store.getConversation(turn.tenantId, turn.conversationId), store.getContact(turn.tenantId, turn.contactId)]);
  if (!conversation || conversation.mode !== "ai" || !contact || contact.optedOut) {
    await dropDraft();
    if (!conversation) return { status: "not_sent", reason: "no_conversation" };
    if (conversation.mode !== "ai") return { status: "not_sent", reason: "not_ai_mode" };
    return { status: "not_sent", reason: "opted_out" };
  }

  // The model can take seconds: look once more, right before the send, in case another run answered meanwhile.
  if (await store.isAnswered(turn.tenantId, lastMessageId, loaded.lastAt)) {
    await dropDraft();
    return { status: "already_answered" };
  }

  // The first AI reply to a contact carries the privacy notice (DPDP): who answers, how to stop, the policy link, only when
  // the business turned it on (agent_settings.privacyNotice; off by default per Raja, 9 Oct).
  const noticeLanguage = plan.reply.mode === "fixed" ? plan.reply.language : textLanguage(plan.reply.language, loaded.input.contactLanguage);
  const carriesNotice = loaded.settings.privacyNotice && contact.consentAt === null;
  const outgoing = carriesNotice ? `${text}\n\n${consentNotice(noticeLanguage, deps.privacyPolicyUrl)}` : text;

  // The exit question goes as two reply buttons (Raja, 9 Oct); if WhatsApp refuses them (not a retry, not an unknown outcome) the
  // same question goes once as plain text with "Reply 1". A tap or a "1" is read by plan.ts.
  const exit = plan.reply.mode === "fixed" && plan.reply.text === "exit_question" ? exitQuestionButtons(plan.reply.language) : null;
  // Named by the turn's last message (notify.send dedupes on the key): a run that died after WhatsApp accepted the reply, and so could not record it, sends it again
  // under the same name and gets the first send's outcome instead of a second message. The buttons and the plain-text line are two forms of ONE reply and only one of
  // them is ever recorded (a refused send is not), so they share the key: a replay that starts with the buttons finds the text that went out.
  const key = replyKey(lastMessageId);
  const send = (payload: { text: string } | { interactive: Interactive }) =>
    deps.send(turn.tenantId, "ai_reply", { conversationId: turn.conversationId, ...payload, idempotencyKey: key });
  let outcome = exit
    ? await send({ interactive: { type: "buttons", body: carriesNotice ? `${exit.body}

${consentNotice(noticeLanguage, deps.privacyPolicyUrl)}` : exit.body, buttons: [...exit.buttons] } })
    : await send({ text: outgoing });
  if (exit && outcome.status === "failed" && !outcome.error.retryable && !outcome.error.outcomeUnknown) outcome = await send({ text: outgoing });
  switch (outcome.status) {
    case "sent":
      // The marker first (one cheap write), then the rows: if the rows cannot be written, a retry still sees the marker.
      await keep(deps, turn, { reply: { case: planned.case, source }, ...(draftKept ? { draft: null } : {}) }).catch(() => undefined);
      if (carriesNotice) await noticeShown(turn, outcome.messageId, deps);
      await recordAnswered(turn, deps);
      return { status: "sent", source };
    case "skipped":
      await dropDraft();
      if (outcome.reason === "insufficient_credits") return { status: "no_credits" };
      console.error(`${TAG} the reply was not sent (${outcome.reason})`);
      return { status: "not_sent", reason: outcome.reason };
    case "failed":
      // It may have gone out anyway: never resend, and count it as answered.
      if (outcome.error.outcomeUnknown) {
        await keep(deps, turn, { reply: { case: planned.case, source: "unknown_outcome" }, ...(draftKept ? { draft: null } : {}) }).catch(() => undefined);
        await recordAnswered(turn, deps);
        return { status: "sent_unknown" };
      }
      console.error(`${TAG} the reply could not be sent (${outcome.error.code})`);
      // Waiting can fix it (a blip, a rate limit): the step is tried again; anything else is final.
      if (outcome.error.retryable) {
        // A count and nothing else (no ids, phone numbers or text): how often this happens, to judge whether saving the written reply between attempts would ever pay.
        // The last attempt of a run is counted too; the "gave up" line of the function's failure handler follows it.
        console.log(`${TAG} reply send retried`);
        throw new Error(`the reply could not be sent (${outcome.error.code})`);
      }
      await dropDraft();
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
 * How far a reply that already went out reaches among these unanswered messages (oldest first): the index of the NEWEST one it answered, or -1. A reply
 * answers the turn's last message and every unanswered message before it, so it reaches up to the newest message that carries the marker (the reply step's
 * own rule for "answered", an unknown outcome included) or has a recorded reply; a message that arrived after it is not covered. Fails open: a check that
 * cannot be read says "none" and logs one fixed line (no ids, no words).
 */
async function replyReach(ids: { tenantId: string; conversationId: string }, pending: { id: string }[], deps: ReplyDeps): Promise<number> {
  try {
    for (let i = pending.length - 1; i >= 0; i--) {
      const agent = await deps.store.getAgentMeta(ids.tenantId, ids.conversationId, pending[i].id);
      if (agent?.reply !== undefined && agent.reply !== null) return i;
    }
    if (!deps.sentReplyRecorded) return -1;
    const replied = new Set(await deps.sentReplyRecorded(ids.tenantId, ids.conversationId, pending.map((m) => m.id)));
    for (let i = pending.length - 1; i >= 0; i--) if (replied.has(pending[i].id)) return i;
    return -1;
  } catch {
    console.error(`${TAG} could not check whether a reply already went out; sending the safe line`);
    return -1;
  }
}

/**
 * Called when a run has failed after its retries: a customer must not be left without an answer. If their latest
 * messages are still unanswered and the chat is still the assistant's, one safe line goes out and they are marked
 * answered. Best effort, never throws, and safe to call twice (it looks first).
 *
 * "Still unanswered" is read from the audit rows, and those can be lost after a reply went out. So before the safe line, two signals that a reply for these
 * messages already went out are looked at, in this order: the marker the reply step leaves on the message after its send (it is written even when the send's
 * record failed), then the row notify.send recorded for the reply's key (reply-record.ts). Either one means the customer has their answer: no safe line, and
 * the messages are marked answered so a later run does not collect them again ("already_replied"). A reply covers only the messages up to the one it
 * answered: a message that arrived after it still gets the safe line. A check that cannot be read FAILS OPEN: the safe line
 * goes out, because a customer left in silence is worse than one extra line. When neither signal exists (WhatsApp accepted the reply and nothing of ours
 * recorded it) nothing can tell, and the safe line may follow a delivered reply: the notify.send gap of the Day 6 reply-key note, section 3.1.
 */
export async function answerAfterFailure(
  ids: { tenantId: string; conversationId: string; messageId: string },
  batchWindowMs: number,
  deps: ReplyDeps,
): Promise<"sent" | "opted_out" | "nothing_to_do" | "already_replied" | "not_sent"> {
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

    // Only when the reply reaches the newest unanswered message: one that arrived after it still needs an answer (the safe line below, for all of them).
    if ((await replyReach(ids, pending, deps)) === pending.length - 1) {
      // Best effort: the customer has their reply, and that is what is reported.
      await recordAnswered({ tenantId: ids.tenantId, conversationId: ids.conversationId, messageIds: pending.map((m) => m.id) } as TurnContext, deps).catch(() => undefined);
      return "already_replied";
    }

    const language = textLanguage(contact.language);
    // The notice is optional: if the business's settings cannot be read, the safe line still goes out, without it.
    const info = await store.getTenantReplyInfo(ids.tenantId).catch(() => null);
    const notice = parseReplySettings(info?.agentSettings).privacyNotice && contact.consentAt === null ? `\n\n${consentNotice(language, deps.privacyPolicyUrl)}` : "";
    // A key of its own, named by the message that started the run, so the failure handler running twice sends the line once. It is never a reply's key: the run's reply is named by the
    // newest answerable message it took, which this cannot tell from here (a photo may be newer, or a message that arrived after the run began), and a shared name could return the
    // safe line in place of a real answer.
    const outcome = await deps.send(ids.tenantId, "ai_reply", { conversationId: ids.conversationId, text: fixedText("fallback", language) + notice, idempotencyKey: `gave_up:${ids.messageId}` });
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
