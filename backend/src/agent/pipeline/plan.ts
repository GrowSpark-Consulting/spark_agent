import type { Extraction, HandoffTrigger, NextAction } from "@pakka/types";
import type { ActRequest, ActResult } from "../scheduling/act";
import type { OfferedSlot } from "../scheduling/offer";
import { MAX_ASK_FIELDS, type AskField } from "../scoring/qualify";
import { textLanguage, type AreaWords, type FixedTextKey, type TextLanguage } from "./fixed-texts";
import { planBooking } from "./plan-booking";
import { languageForReply } from "./reply-language";
import type { ReplySettings } from "./persona";
import type { UnderstandResult } from "./understand";

// What the customer gets for every way the understanding step can end. Plain code, no model: the table below is
// the whole decision, and every row is a case in plan.test.ts. NOTHING ENDS WITHOUT A DEFINED ANSWER: a customer
// whose message was read, not read, found nothing, or hit an outage always gets a reply, a clarifying question or a
// handover.
//
//   the step ended with                                  | the customer gets                      | also
//   -----------------------------------------------------+----------------------------------------+---------------------------------------------
//   the turn's time ran out (25 s)                       | the safe fallback                      |
//   understood, a clear opt-out (confidence >= 0.8)      | nothing (opted out)                    | confirmation, handoff opt_out, lead lost if "not interested"
//   understood, may be leaving but unclear / opt_out < 0.8| the "talk to the team or continue" line|
//   ... the customer then sends "1"                      | the handover line                      | handoff asked_human (high), chat to a person
//   understood, wants a person                           | the handover line                      | handoff asked_human (high), if the business has it on
//   a voice note on its own (nothing typed)              | one line asking the customer to type    | staff told a voice note is waiting; not repeated for the next one
//   understood, a complaint, or an angry customer        | one short sorry and the handover line  | handoff complaint (high), if the business has it on
//   understood, asks for a discount or a lower price     | the model: a person will look at it    | handoff negotiation (high), if the business has it on
//   ... and the lead has just become hot (once)          | the reply of the row it fell in        | hotLead: staff are told once, the chat stays with the AI (no handoff row)
//   understood, off topic                                | the model's polite decline             |
//   understood, gave the detail that fails the lead, and | the model's kind close (no handover)   | the lead's temperature is already "disqualified"
//   ... asked nothing else                               |                                        |
//   understood, names a place the business has no sites  | the places it does have, to choose from| the state "options" is kept; no time is offered
//   ... the same place again after those were listed     | nothing there for now, we will update  | state "unavailable"; staff reminded once to record it; the lead stays open
//   understood, the knowledge base had the answer        | the model's answer from the facts      | the miss count goes back to 0
//   understood, the knowledge base had nothing (a gap)   | the safe fallback                      | the gap is recorded; the miss count goes up
//   ... and that is the second miss in a row, same chat  | the handover line                      | handoff kb_gap (if the business has it on)
//   understood, the search could not run (an outage)     | the safe fallback                      | no gap, no handoff
//   understood, nothing to look up (a greeting, details) | the model's reply, no facts            | the miss count goes back to 0
//   ... and required details are still missing           | the model acknowledges and asks for    | at most two, from the lead's qualification
//                                                        | the next ones (ask_fields)             |
//   fallback (no text, bad answer twice, model declined) | a clarifying question                  |
//   the language model could not be reached              | the safe fallback                      |
//   the business has no usable pack                      | the safe fallback                      | handoff stuck, so a person looks at it
//
// A "miss" is a question the knowledge base could not answer. Two in a row IN THE SAME CHAT is the handover trigger
// (docs/handover.md); a miss, then any answered turn, then a miss is not. The count lives on the chat's own messages
// (`messages.meta.agent.kbMisses`), never on the business-wide gap count, which only feeds the dashboard's most-asked list.

export const KB_MISSES_FOR_HANDOFF = 2;

/** What the reply may say when a customer asks for a discount: no price change, a person will look at it. The only fact it is given. */
const NEGOTIATION_FACT = "The customer asked for a discount or a lower price. You cannot agree to any price change. A team member will look at it and get back to them.";

/** What the reply may say about why: no amounts, no promises. The pack's hard fail names the field; the words stay general. */
const NOT_A_FIT = "The business has nothing that fits what the customer is looking for.";

/**
 * How sure the model must be that a customer clearly asks to stop before the code opts them out (Raja, 9 Oct; approved).
 * Below it the customer is asked once what they want (the `exit_question` line), never opted out on a guess.
 */
export const OPT_OUT_MIN_CONFIDENCE = 0.8;

/**
 * An "unclear_exit" reading below this is not believed: a stray character, "ok", "?" or an emoji alone is read that way by a
 * model that is unsure what a message even is (seen in the local run, 9 Oct: "x" at 0.3). The message is then answered like any other.
 */
export const UNCLEAR_EXIT_MIN_CONFIDENCE = 0.5;

export type ReplyPlan =
  | { mode: "model"; action: NextAction; facts: string[]; language: Extraction["language"] | null; /** The labels (and allowed choices) of the details the action asks for. */ ask?: AskField[] }
  | { mode: "fixed"; text: FixedTextKey; language: TextLanguage; /** What an area line is filled in with (fixed-texts.ts areaText). */ vars?: AreaWords }
  /** Nothing is sent: the customer is opted out (Plan.optOut). */
  | { mode: "none" };

export interface PlanInput {
  understood: UnderstandResult;
  /** The question the customer asked, in English, from the extraction (messages.meta.agent), or null. */
  question: string | null;
  /** contacts.language, as the last fallback for the language of a fixed line. */
  contactLanguage: string | null;
  /** The words of the customer's messages of this turn (reply.ts), for the script of a low-confidence "other" reading (reply-language.ts). */
  customerWords?: string;
  /** The staff reminder for a cancel or move with no booking went out (kept on the message by the reply step): only then may the reply say the team has been told. */
  bookingReminderSent?: boolean;
  /** Consecutive misses in this chat before this turn. */
  previousMisses: number;
  settings: ReplySettings;
  /** The chat's last earlier turn asked the "talk to the team or continue" question (its plan case was exit_unclear), and nobody has answered it yet. */
  exitQuestionPending: boolean;
  /** The customer's newest message is just "1". */
  customerSaidOne: boolean;
  /** The customer tapped the "Talk to the team" button of the exit question (inbound message meta.buttonId). */
  talkButtonTapped: boolean;
  /** The turn's hard stop has passed: no model call, the safe fallback. */
  deadlineExceeded: boolean;
  /**
   * Staff have already been told that this lead is hot (a hot_lead handoff exists for the chat). Only when this is false does a hot lead raise
   * the alert; when it is missing, nothing is raised (the safe default is silence).
   */
  hotLeadAlerted?: boolean;
  /**
   * The place the lead wants is one the business has no sites in (scoring/coverage.ts, read by the understanding step). Present only then.
   * `named`: the customer gave it in this very message (or asked to book while it is the lead's place). `stage`: what this chat already
   * said about this same place (`options`: the areas were listed; `unavailable`: told there is nothing there), or null.
   */
  coverage?: { area: string; shown: string; areas: string[]; named: boolean; stage: "options" | "unavailable" | null };
  /** The customer gave a place in this message and the business has sites there: what the chat said about an unserved place is over. */
  areaServedNamed?: boolean;
  /** Every message of the burst is a voice note: nothing was typed, and nothing can be listened to yet. */
  voiceNote?: boolean;
  /** The chat's previous turn was also a voice note that was answered: a second one right after is not answered again. */
  voiceNoteRepeat?: boolean;
  /**
   * Booking (steps 5 and 6), only for a business that has booking switched on and a kind of booking that needs a time. Without it
   * nothing about booking is decided (plan-booking.ts has the table).
   */
  scheduling?: {
    /** The business's active services: exactly one is the only case the assistant books on its own. */
    service: { state: "one"; id: string } | { state: "none" } | { state: "several" };
    /** The times waiting for the customer's answer (not older than a day), or null. */
    offer: OfferedSlot[] | null;
    /** The lead already has a held or confirmed booking that has not ended. */
    hasBooking: boolean;
    /** The lead's confirmed booking, with its time as the customer reads it (a time still only held cannot be moved or cancelled by chat). */
    booking?: { id: string; label: string } | null;
    /** The offer of times is for moving this booking, not for a new one. */
    rescheduleBookingId?: string | null;
    /** We asked whether to cancel this booking and are waiting for yes or no. */
    cancelAsk?: { bookingId: string; label: string } | null;
    /** What the customer wrote last. Only read here, to find which time they picked; never kept. */
    customerText: string;
    /** What the extraction copied of when they want it ("tomorrow evening"), or null. */
    preferredTime: string | null;
    /** The business's own time zone. */
    timeZone: string;
    now: Date;
    /** What the calendar step found or did for this turn, once it has run. */
    act?: ActResult;
    /** A visit to the customer's address: the six-digit pincode the lead holds, for the calendar step to look only at someone who works there. Not read by the planner; never kept. */
    pincode?: string;
  };
}

export interface Plan {
  reply: ReplyPlan;
  /** The customer clearly asked to stop: opt them out (source model_intent), one confirmation, an opt_out handover, and no reply. */
  optOut?: { notInterested: boolean };
  /** Open a handover after the reply is sent. */
  handoff?: { trigger: HandoffTrigger; priority: "high" | "normal" };
  /** Record this question as a gap in the knowledge base. */
  gap?: { question: string };
  /** The calendar must be looked at or changed before this turn's reply can be written (scheduling/act.ts); `reply` is only the fallback until then. */
  act?: ActRequest;
  /**
   * The lead has just turned hot and staff have not been told: announce it once (the reply step emits `lead.hot`). Not a handover: the chat stays with
   * the AI, so there is no handoff row (the inbox would call the chat "needs a person") and no switch of mode.
   */
  hotLead?: boolean;
  /** A voice note was answered with the request to type: staff are told one is waiting (the reply step emits `voice_note.received`). */
  voiceNote?: boolean;
  /** Nothing is sent, but the customer's messages count as answered (a repeated voice note): they must not be picked up again. */
  markAnswered?: boolean;
  /**
   * What this chat has said about an unserved place, to keep for the next turn (`messages.meta.agent.coverage`): the place and what was
   * said, or null when the customer moved on to a place the business has. Absent: nothing changes.
   */
  coverage?: { area: string; stage: "options" | "unavailable" } | null;
  /** Staff are reminded, once, to record in their CRM that this customer wants a place the business has nothing in. */
  areaReminder?: boolean;
  /** A customer with no booking on record asked to cancel or move one (plan-booking.ts): staff are told, before the reply, with no handover and no mode change. */
  bookingChangeReminder?: "cancel" | "reschedule";
  /** The miss count to keep for the next turn of this chat. */
  kbMisses: number;
  /** The row of the table above, for the log (never a customer's words). */
  case: string;
}

const fixed = (text: FixedTextKey, language: TextLanguage): ReplyPlan => ({ mode: "fixed", text, language });

/** The plan for a turn, and, when the lead has just turned hot and staff have not been told, the one alert that goes with whatever the turn does. */
export function planReply(input: PlanInput): Plan {
  const decided = decide(input);
  const { understood } = input;
  // A place the business has was named: whatever this chat said about an unserved one is over, so the options come first if one is named later.
  const plan = input.areaServedNamed && understood.status === "understood" && !input.deadlineExceeded && decided.coverage === undefined ? { ...decided, coverage: null } : decided;
  const hot =
    input.hotLeadAlerted === false &&
    input.settings.hotLeadAlertEnabled &&
    understood.status === "understood" &&
    understood.qualification?.temperature === "hot" &&
    plan.handoff === undefined &&
    plan.optOut === undefined &&
    plan.act === undefined &&
    plan.reply.mode !== "none";
  return hot ? { ...plan, hotLead: true } : plan;
}

function decide(input: PlanInput): Plan {
  const { understood, question, previousMisses, settings } = input;
  const language = textLanguage(understood.status === "understood" ? understood.summary.language : null, input.contactLanguage);
  const carry = previousMisses;
  // The language the reply MODEL is told (a low-confidence "other" is decided in code, reply-language.ts); fixed lines use `language` above.
  const modelLanguage = understood.status === "understood" ? languageForReply(understood.summary.language, understood.summary.confidence, input.customerWords, input.contactLanguage) : null;

  // The customer answered our question: they tapped Talk to the team, or (if the buttons were refused and the plain text went)
  // sent "1". A person takes over. Checked before anything else, even when the message could not be understood (the model down,
  // a bad answer, no time left): the model's reading of a tap or a bare "1" is not under our control, and the customer must not
  // be asked twice or opted out after choosing the team. A tap is the customer's own choice at any time; a bare "1" only counts
  // right after the question.
  if (settings.askedHumanHandoffEnabled && (input.talkButtonTapped || (input.exitQuestionPending && input.customerSaidOne))) {
    return { reply: fixed("handoff", language), handoff: { trigger: "asked_human", priority: "high" }, kbMisses: 0, case: "exit_question_talk" };
  }

  if (input.deadlineExceeded) return { reply: fixed("fallback", language), kbMisses: carry, case: "deadline" };

  switch (understood.status) {
    case "no_pack":
      return { reply: fixed("fallback", language), handoff: { trigger: "stuck", priority: "normal" }, kbMisses: carry, case: "no_pack" };
    case "model_unavailable":
      return { reply: fixed("fallback", language), kbMisses: carry, case: "model_unavailable" };
    case "fallback":
      // A voice note on its own (Raja, 11 Oct): one polite line asking the customer to type, and staff told. Not again for the next one right after.
      if (understood.reason === "no_text" && input.voiceNote) {
        if (input.voiceNoteRepeat) return { reply: { mode: "none" }, markAnswered: true, kbMisses: carry, case: "voice_note_repeat" };
        return { reply: fixed("voice_note", language), voiceNote: true, kbMisses: carry, case: "voice_note" };
      }
      return { reply: fixed("clarify", language), kbMisses: carry, case: `clarify_${understood.reason}` };
    case "understood":
      break;
  }

  const { summary, retrieval } = understood;
  // Leaving, or not sure how (Raja, 9 Oct). Code decides; the model only reported the intent and how sure it was.
  if (summary.intent === "opt_out" && summary.confidence >= OPT_OUT_MIN_CONFIDENCE) {
    return { reply: { mode: "none" }, optOut: { notInterested: summary.notInterested }, kbMisses: 0, case: summary.notInterested ? "opt_out_not_interested" : "opt_out_intent" };
  }
  // Asked once: if the last turn already asked, a second unclear message is answered like any other (never the same question twice).
  const unclear = summary.intent === "opt_out" || (summary.intent === "unclear_exit" && summary.confidence >= UNCLEAR_EXIT_MIN_CONFIDENCE);
  if (unclear && !input.exitQuestionPending) {
    // With the team handover switched off a button (or a "1") would lead nowhere: the short line with the STOP hint only.
    return { reply: fixed(settings.askedHumanHandoffEnabled ? "exit_question" : "exit_prompt", language), kbMisses: carry, case: "exit_unclear" };
  }
  // Wants a person, is unhappy or angry: the chat goes to staff. A business can switch each of these off, and then the
  // message is answered like any other.
  if (summary.intent === "talk_to_human" && settings.askedHumanHandoffEnabled) {
    return { reply: fixed("handoff", language), handoff: { trigger: "asked_human", priority: "high" }, kbMisses: 0, case: "asked_human" };
  }
  if ((summary.intent === "complaint" || summary.sentiment === "angry") && settings.complaintHandoffEnabled) {
    return { reply: fixed("handoff_sorry", language), handoff: { trigger: "complaint", priority: "high" }, kbMisses: 0, case: "complaint" };
  }
  // Asks for a discount: the assistant never agrees to a price change (reply prompt rule 3). It says a person will look at it, and a person
  // is told at once, with the card showing what was asked for.
  if (summary.intent === "price_negotiation" && settings.negotiationHandoffEnabled) {
    return {
      reply: { mode: "model", action: { kind: "handoff", trigger: "negotiation" }, facts: [NEGOTIATION_FACT], language: modelLanguage },
      handoff: { trigger: "negotiation", priority: "high" },
      kbMisses: 0,
      case: "negotiation",
    };
  }

  const asked = question?.trim() ? question.trim() : "";
  const model = (action: NextAction, facts: string[] = [], ask?: AskField[]): ReplyPlan => ({ mode: "model", action, facts, language: modelLanguage, ...(ask ? { ask } : {}) });

  if (summary.intent === "off_topic") return { reply: model({ kind: "decline_off_topic" }), kbMisses: 0, case: "off_topic" };

  // Booking (steps 5 and 6): times to offer, the customer's pick, and what follows a booking. A booking intent comes before the answer.
  const booking = planBooking({ input, summary, qualification: understood.qualification, retrieval, language, modelLanguage });
  if (booking) return booking;

  // Qualifying (step 5): the next missing details to ask for, two at most (the reply prompt's rule 4).
  const qualification = understood.qualification;
  const ask = qualification ? qualification.ask.slice(0, MAX_ASK_FIELDS) : [];
  const askFields = ask.map((a) => a.key);

  // A lead that is certainly not a fit, told so once: when the customer has JUST given the detail that fails it and asked nothing else.
  // A question the knowledge base can answer is answered first (below), and a later message that gives nothing new about it is answered
  // like any other, so the customer is never told twice. It is a kind close, not a handover and not an opt-out: a new answer re-scores.
  if (qualification?.hardFail && !summary.hasQuestion && summary.fieldKeys.includes(qualification.hardFail.field)) {
    return { reply: model({ kind: "close_disqualified", reason: NOT_A_FIT }, [NOT_A_FIT]), kbMisses: 0, case: "disqualified" };
  }

  // A place the business has no sites in (Raja, 14 Oct): first the places it does have, so the customer can choose; when they name the same
  // place again, that there is nothing there for now (no visit is offered, staff are reminded to record it). The lead stays open and the chat
  // stays with the assistant. After the hard fail, so a customer who cannot be served at all is not sent looking for another area.
  const area = input.coverage;
  if (area && (area.named || summary.intent === "book")) {
    // Only the same place NAMED again after the options is insisting; asking to book without naming it repeats what was said.
    const unavailable = area.stage === "unavailable" || (area.stage === "options" && area.named);
    return {
      reply: { mode: "fixed", text: unavailable ? "area_unavailable" : "area_options", language, vars: { area: area.shown, areas: area.areas } },
      coverage: { area: area.area, stage: unavailable ? "unavailable" : "options" },
      ...(area.stage === "options" && area.named ? { areaReminder: true } : {}),
      kbMisses: 0,
      case: unavailable ? "area_unavailable" : "area_options",
    };
  }

  switch (retrieval.outcome) {
    case "found": {
      const facts = retrieval.chunks.map((chunk) => (chunk.title ? `${chunk.title}: ${chunk.content}` : chunk.content));
      return { reply: model({ kind: "answer_and_ask", question: asked, askFields }, facts, qualification ? ask : undefined), kbMisses: 0, case: "answered_from_kb" };
    }
    case "none": {
      // Capped: a business that had this trigger off (or a chat a person handed back) must not start with a bank of misses.
      const misses = Math.min(previousMisses, KB_MISSES_FOR_HANDOFF - 1) + 1;
      const gap = asked ? { question: asked } : undefined;
      if (misses >= KB_MISSES_FOR_HANDOFF && settings.kbGapHandoffEnabled) {
        // The handover uses the misses up: when a person hands the chat back, it starts again from 0.
        return { reply: fixed("handoff", language), handoff: { trigger: "kb_gap", priority: "normal" }, gap, kbMisses: 0, case: "kb_miss_handoff" };
      }
      return { reply: fixed("fallback", language), gap, kbMisses: misses, case: "kb_miss" };
    }
    case "unavailable":
      return { reply: fixed("fallback", language), kbMisses: carry, case: "kb_unavailable" };
    case "skipped":
      // Details given and more still to ask for: acknowledge and ask for the next ones, instead of a bare greeting.
      if (askFields.length > 0) return { reply: model({ kind: "ask_fields", askFields }, [], ask), kbMisses: 0, case: "ask_details" };
      return { reply: model({ kind: "answer_and_ask", question: "", askFields: [] }), kbMisses: 0, case: "nothing_to_look_up" };
  }
}
