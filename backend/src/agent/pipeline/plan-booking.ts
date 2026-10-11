import type { ActRequest, ActResult } from "../scheduling/act";
import { offerFacts, type OfferedSlot } from "../scheduling/offer";
import { matchSlotChoice } from "../scheduling/slot-choice";
import type { FixedTextKey, TextLanguage } from "./fixed-texts";
import type { Plan, PlanInput, ReplyPlan } from "./plan";
import type { QualificationSummary, Retrieval, UnderstandResult } from "./understand";

// Step 5 and 6, booking: when a time is offered, how the customer's answer is read, and what the customer is told once the calendar has
// been looked at. Plain code. The table (the order matters; the first row that fits wins):
//
//   booking is not on, or the business has no kind of booking that needs a time          | nothing here: the rest of plan.ts
//   the lead is certainly not a fit (a hard fail)                                          | nothing here: plan.ts closes or answers
//   the calendar has been looked at (scheduling.act)                                       | what it found, in the reply (afterAct)
//   a time is on offer and the customer picked one                                         | book it (act: book)
//   ... and wants another time or none of them                                             | look again (act: offer), from their words
//   ... and it is not clear, but they asked something the knowledge base answers           | nothing here: the answer comes first, the offer waits
//   ... and it is not clear                                                                | the same times again, kindly (offer_reask)
//   the lead already has a time booked                                                     | nothing here
//   the customer asked to book, or the lead is ready and no question is waiting            | look for times (act: offer), where they said
//   ... and the business has no single service to book                                     | a person takes over (stuck): the assistant never guesses which
//
// "Looking" and "booking" are not done here: `act` is a request, carried out by scheduling/act.ts through Dev 2's booking functions, and
// the next call of planReply (with the result in `scheduling.act`) says what the customer is told. The first answer's reply is only what is
// sent if that result never arrives: the safe line.

type Understood = Extract<UnderstandResult, { status: "understood" }>;

interface Args {
  input: PlanInput;
  summary: Understood["summary"];
  qualification: QualificationSummary | undefined;
  retrieval: Retrieval;
  language: TextLanguage;
}

const fixed = (text: FixedTextKey, language: TextLanguage): ReplyPlan => ({ mode: "fixed", text, language });

const pending = (act: ActRequest, language: TextLanguage): Plan => ({ reply: fixed("fallback", language), act, kbMisses: 0, case: "booking_pending" });
const personTakesOver = (language: TextLanguage, caseName: string): Plan => ({ reply: fixed("handoff", language), handoff: { trigger: "stuck", priority: "normal" }, kbMisses: 0, case: caseName });

function afterAct(act: ActResult, args: Args): Plan {
  const { language, summary } = args;
  const model = (action: Extract<ReplyPlan, { mode: "model" }>["action"], facts: string[]): ReplyPlan => ({ mode: "model", action, facts, language: summary.language });
  switch (act.kind) {
    case "offered": {
      const retaken = act.retaken === true;
      const facts = retaken
        ? ["The time the customer chose was just taken by someone else.", ...offerFacts(act.slots, { asked: true })]
        : offerFacts(act.slots, { asked: act.asked });
      return { reply: model({ kind: "offer_slots", serviceId: act.slots[0].serviceId }, facts), kbMisses: 0, case: retaken ? "offer_retaken" : "offer_slots" };
    }
    case "booked":
      return { reply: model({ kind: "confirm_booking", slotId: act.label }, [`Booked: ${act.label}.`]), kbMisses: 0, case: "booked" };
    case "no_slots":
      return personTakesOver(language, "no_slots");
    case "error":
      return { reply: fixed("fallback", language), handoff: { trigger: "stuck", priority: "normal" }, kbMisses: 0, case: "booking_error" };
  }
}

/** The booking part of the decision, or null when it is not about booking and the rest of plan.ts decides. */
export function planBooking(args: Args): Plan | null {
  const { input, summary, qualification, retrieval, language } = args;
  const s = input.scheduling;
  const bookingKind = qualification?.bookingKind ?? null;
  if (!s || !qualification || !bookingKind) return null;
  if (qualification.hardFail !== null) return null;

  if (s.act) return afterAct(s.act, args);

  if (s.offer) {
    const offer = s.offer;
    const pick = matchSlotChoice(s.customerText, offer, { timeZone: s.timeZone, now: s.now });
    if (pick.kind === "chosen") {
      const slot: OfferedSlot = offer[pick.index];
      return pending({ kind: "book", serviceId: slot.serviceId, bookingKind, slot }, language);
    }
    if (pick.kind === "other") return pending({ kind: "offer", serviceId: offer[0].serviceId, preferredText: s.customerText }, language);
    // Not clear. A question the knowledge base can answer is answered first, and the offer waits for the next message.
    if (summary.hasQuestion && retrieval.outcome === "found") return null;
    return {
      reply: { mode: "model", action: { kind: "offer_slots", serviceId: offer[0].serviceId }, facts: offerFacts(offer, { asked: true }), language: summary.language },
      kbMisses: 0,
      case: "offer_reask",
    };
  }

  if (s.hasBooking) return null;
  const asksToBook = summary.intent === "book";
  const readyAndFree = qualification.readyForSlots && !summary.hasQuestion;
  if (!asksToBook && !readyAndFree) return null;

  // Which service to book is the business's setting, not something to guess from the chat. One active service is the only case handled.
  if (s.service.state !== "one") return personTakesOver(language, "no_service");
  return pending({ kind: "offer", serviceId: s.service.id, preferredText: s.preferredTime ?? (asksToBook ? s.customerText : null) }, language);
}
