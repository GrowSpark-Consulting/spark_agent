import type { Extraction, HandoffTrigger, NextAction } from "@pakka/types";
import type { ActRequest, ActResult } from "../scheduling/act";
import type { OfferedSlot } from "../scheduling/offer";
import { MAX_ASK_FIELDS, type AskField } from "../scoring/qualify";
import { textLanguage, type FixedTextKey, type TextLanguage } from "./fixed-texts";
import { planBooking } from "./plan-booking";
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
//   understood, a complaint, or an angry customer        | the handover line                      | handoff complaint (high), if the business has it on
//   understood, off topic                                | the model's polite decline             |
//   understood, gave the detail that fails the lead, and | the model's kind close (no handover)   | the lead's temperature is already "disqualified"
//   ... asked nothing else                               |                                        |
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
  | { mode: "fixed"; text: FixedTextKey; language: TextLanguage }
  /** Nothing is sent: the customer is opted out (Plan.optOut). */
  | { mode: "none" };

export interface PlanInput {
  understood: UnderstandResult;
  /** The question the customer asked, in English, from the extraction (messages.meta.agent), or null. */
  question: string | null;
  /** contacts.language, as the last fallback for the language of a fixed line. */
  contactLanguage: string | null;
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
  /** The miss count to keep for the next turn of this chat. */
  kbMisses: number;
  /** The row of the table above, for the log (never a customer's words). */
  case: string;
}

const fixed = (text: FixedTextKey, language: TextLanguage): ReplyPlan => ({ mode: "fixed", text, language });

export function planReply(input: PlanInput): Plan {
  const { understood, question, previousMisses, settings } = input;
  const language = textLanguage(understood.status === "understood" ? understood.summary.language : null, input.contactLanguage);
  const carry = previousMisses;

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
    return { reply: fixed("handoff", language), handoff: { trigger: "complaint", priority: "high" }, kbMisses: 0, case: "complaint" };
  }

  const asked = question?.trim() ? question.trim() : "";
  const model = (action: NextAction, facts: string[] = [], ask?: AskField[]): ReplyPlan => ({ mode: "model", action, facts, language: summary.language, ...(ask ? { ask } : {}) });

  if (summary.intent === "off_topic") return { reply: model({ kind: "decline_off_topic" }), kbMisses: 0, case: "off_topic" };

  // Booking (steps 5 and 6): times to offer, the customer's pick, and what follows a booking. A booking intent comes before the answer.
  const booking = planBooking({ input, summary, qualification: understood.qualification, retrieval, language });
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
