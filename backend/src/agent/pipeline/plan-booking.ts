import type { Extraction } from "@pakka/types";
import type { ActRequest, ActResult } from "../scheduling/act";
import { offerFacts, type OfferedSlot } from "../scheduling/offer";
import { matchSlotChoice } from "../scheduling/slot-choice";
import { readYesNo } from "../scheduling/yes-no";
import type { FixedTextKey, TextLanguage } from "./fixed-texts";
import type { Plan, PlanInput, ReplyPlan } from "./plan";
import type { QualificationSummary, Retrieval, UnderstandResult } from "./understand";

// Step 5 and 6, booking: when a time is offered, how the customer's answer is read, what is done to a booking they already have, and what
// the customer is told once the calendar has been looked at. Plain code. The table (the order matters; the first row that fits wins):
//
//   booking is not on, or the business has no kind of booking that needs a time                | nothing here: the rest of plan.ts
//   the calendar has been looked at or changed (scheduling.act)                                  | what happened, in the reply (afterAct)
//   we asked whether to cancel, and the customer says yes                                        | cancel it (act: cancel)
//   ... says no                                                                                  | keep it, the question is over (act: keep)
//   ... says something else (a question the knowledge base answers waits; else it is asked again)| nothing here, or cancel_reask
//   a time is on offer (for a new booking, or for moving one) and the customer picked one         | book it, or move the booking to it (act)
//   ... and wants another time or none of them                                                   | look again (act: offer), from their words
//   ... and it is not clear (a question the knowledge base answers waits)                        | the same times again, kindly (offer_reask)
//   the customer has a booking and clearly asks to cancel it                                      | ask whether to cancel (act: ask_cancel): NEVER cancel on a first message
//   ... and asks to move it                                                                      | look for times for moving it (act: offer)
//   the lead is certainly not a fit (a hard fail)                                                | nothing here (no NEW booking is offered)
//   the lead's place is one the business has no sites in                                         | nothing here (no NEW booking is offered; plan.ts answers it)
//   the lead already has a time booked                                                           | nothing here
//   the customer asked to book, or the lead is ready and no question is waiting                  | look for times (act: offer), where they said
//   ... and the business has no single service to book                                           | a person takes over (stuck): the assistant never guesses which
//
// "Looking" and "booking" are not done here: `act` is a request, carried out by scheduling/act.ts through Dev 2's booking functions, and
// the next call of planReply (with the result in `scheduling.act`) says what the customer is told. The first answer's reply is only what is
// sent if that result never arrives: the safe line.

type Understood = Extract<UnderstandResult, { status: "understood" }>;
type Scheduling = NonNullable<PlanInput["scheduling"]>;

/** How sure the model must be that the customer asks to cancel before they are even asked whether to (the cancellation itself needs their yes). */
export const CANCEL_MIN_CONFIDENCE = 0.8;

/** What the reply is asked to answer when the question is ours, not the customer's: the model answers it from the facts. */
const CANCEL_QUESTION = "Can I cancel my booking?";
const KEEP_QUESTION = "Is my booking still on?";
const NOTHING_CANCELLED = "Nothing has been cancelled yet. Ask the customer to say yes or no to cancelling it.";

interface Args {
  input: PlanInput;
  summary: Understood["summary"];
  qualification: QualificationSummary | undefined;
  retrieval: Retrieval;
  language: TextLanguage;
  /** The language the reply model is told (plan.ts: a low-confidence "other" is decided in code). */
  modelLanguage: Extraction["language"] | null;
}

const fixed = (text: FixedTextKey, language: TextLanguage): ReplyPlan => ({ mode: "fixed", text, language });

const pending = (act: ActRequest, language: TextLanguage): Plan => ({ reply: fixed("fallback", language), act, kbMisses: 0, case: "booking_pending" });
const personTakesOver = (language: TextLanguage, caseName: string): Plan => ({ reply: fixed("handoff", language), handoff: { trigger: "stuck", priority: "normal" }, kbMisses: 0, case: caseName });

const movingLine = (s: Scheduling) => (s.booking ? [`The customer's booking is on ${s.booking.label} and they want to move it.`] : []);

function afterAct(act: ActResult, args: Args, s: Scheduling): Plan {
  const { language, modelLanguage } = args;
  const model = (action: Extract<ReplyPlan, { mode: "model" }>["action"], facts: string[]): ReplyPlan => ({ mode: "model", action, facts, language: modelLanguage });
  switch (act.kind) {
    case "offered": {
      const retaken = act.retaken === true;
      const moving = act.rescheduleBookingId !== undefined;
      const times = retaken ? offerFacts(act.slots, { asked: true }) : offerFacts(act.slots, { asked: act.asked });
      const facts = [...(retaken ? ["The time the customer chose was just taken by someone else."] : []), ...(moving ? movingLine(s) : []), ...times];
      return { reply: model({ kind: "offer_slots", serviceId: act.slots[0].serviceId }, facts), kbMisses: 0, case: retaken ? "offer_retaken" : moving ? "reschedule_offer" : "offer_slots" };
    }
    case "booked":
      return { reply: model({ kind: "confirm_booking", slotId: act.label }, [`Booked: ${act.label}.`]), kbMisses: 0, case: "booked" };
    case "rescheduled":
      return { reply: model({ kind: "confirm_booking", slotId: act.label }, [`Booking moved to: ${act.label}.`]), kbMisses: 0, case: "rescheduled" };
    case "cancel_asked":
      return {
        reply: model({ kind: "answer_and_ask", question: CANCEL_QUESTION, askFields: [] }, [`The customer's booking is on ${act.label}.`, NOTHING_CANCELLED]),
        kbMisses: 0,
        case: "cancel_ask",
      };
    case "cancelled":
      return { reply: model({ kind: "cancel", bookingId: s.booking?.id ?? "" }, [`Cancelled: ${act.label}.`]), kbMisses: 0, case: "cancelled" };
    case "kept":
      return {
        reply: model({ kind: "answer_and_ask", question: KEEP_QUESTION, askFields: [] }, [`The customer decided to keep their booking on ${act.label}. Nothing was cancelled.`]),
        kbMisses: 0,
        case: "kept",
      };
    case "no_slots":
      return personTakesOver(language, "no_slots");
    case "error":
      return { reply: fixed("fallback", language), handoff: { trigger: "stuck", priority: "normal" }, kbMisses: 0, case: "booking_error" };
  }
}

/** The booking part of the decision, or null when it is not about booking and the rest of plan.ts decides. */
export function planBooking(args: Args): Plan | null {
  const { input, summary, qualification, retrieval, language, modelLanguage } = args;
  const s = input.scheduling;
  const bookingKind = qualification?.bookingKind ?? null;
  if (!s || !qualification || !bookingKind) return null;

  if (s.act) return afterAct(s.act, args, s);

  const model = (action: Extract<ReplyPlan, { mode: "model" }>["action"], facts: string[]): ReplyPlan => ({ mode: "model", action, facts, language: modelLanguage });
  /** A question the knowledge base can answer is answered first; what is waiting is asked again on the next message. */
  const answerFirst = summary.hasQuestion && retrieval.outcome === "found";

  // We asked whether to cancel: only a clear yes cancels.
  if (s.cancelAsk) {
    const { bookingId, label } = s.cancelAsk;
    const answer = readYesNo(s.customerText);
    if (answer === "yes") return pending({ kind: "cancel", bookingId, label }, language);
    if (answer === "no") return pending({ kind: "keep", label }, language);
    if (answerFirst) return null;
    return { reply: model({ kind: "answer_and_ask", question: CANCEL_QUESTION, askFields: [] }, [`The customer's booking is on ${label}.`, NOTHING_CANCELLED]), kbMisses: 0, case: "cancel_reask" };
  }

  // A lead that is certainly not a fit is offered no NEW booking; moving one it already has is still allowed.
  const blocked = qualification.hardFail !== null;
  // A place the business has no sites in (plan.ts answers it): no NEW time is offered for it, and a customer who has just named such a place
  // is not booked from times they were offered for another one.
  const unserved = input.coverage !== undefined;
  const namesUnserved = input.coverage?.named === true;

  if (s.offer && !((blocked || namesUnserved) && !s.rescheduleBookingId)) {
    const offer = s.offer;
    const pick = matchSlotChoice(s.customerText, offer, { timeZone: s.timeZone, now: s.now });
    if (pick.kind === "chosen") {
      const slot: OfferedSlot = offer[pick.index];
      return s.rescheduleBookingId
        ? pending({ kind: "reschedule", serviceId: slot.serviceId, bookingId: s.rescheduleBookingId, slot }, language)
        : pending({ kind: "book", serviceId: slot.serviceId, bookingKind, slot }, language);
    }
    if (pick.kind === "other") {
      return pending(
        { kind: "offer", serviceId: offer[0].serviceId, preferredText: s.customerText, exclude: offer.map((o) => o.start), ...(s.rescheduleBookingId ? { rescheduleBookingId: s.rescheduleBookingId } : {}) },
        language,
      );
    }
    // Not clear. A question the knowledge base can answer is answered first, and the offer waits for the next message.
    if (answerFirst) return null;
    return {
      reply: model({ kind: "offer_slots", serviceId: offer[0].serviceId }, [...(s.rescheduleBookingId ? movingLine(s) : []), ...offerFacts(offer, { asked: true })]),
      kbMisses: 0,
      case: "offer_reask",
    };
  }

  // A booking the customer already has: moving it, or (after asking) cancelling it. Never cancelled on a first message.
  if (s.booking) {
    if (summary.intent === "cancel" && summary.confidence >= CANCEL_MIN_CONFIDENCE) return pending({ kind: "ask_cancel", bookingId: s.booking.id, label: s.booking.label }, language);
    if (summary.intent === "reschedule") {
      if (s.service.state !== "one") return personTakesOver(language, "no_service");
      return pending({ kind: "offer", serviceId: s.service.id, preferredText: s.preferredTime ?? s.customerText, rescheduleBookingId: s.booking.id }, language);
    }
  }

  if (blocked || unserved || s.hasBooking) return null;
  // Asking to cancel or move a booking the lead does not have is not a reason to offer a new one.
  if (summary.intent === "cancel" || summary.intent === "reschedule") return null;
  const asksToBook = summary.intent === "book";
  const readyAndFree = qualification.readyForSlots && !summary.hasQuestion;
  if (!asksToBook && !readyAndFree) return null;

  // Which service to book is the business's setting, not something to guess from the chat. One active service is the only case handled.
  if (s.service.state !== "one") return personTakesOver(language, "no_service");
  return pending({ kind: "offer", serviceId: s.service.id, preferredText: s.preferredTime ?? (asksToBook ? s.customerText : null) }, language);
}
