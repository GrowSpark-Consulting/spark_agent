import { describe, expect, it } from "vitest";
import { parseReplySettings } from "./persona";
import { planReply, type PlanInput } from "./plan";
import type { QualificationSummary, Retrieval, UnderstandResult } from "./understand";

// Moving or cancelling a booking (Day 3), the decisions of plan-booking.ts. A cancellation is never done on a first message: the customer is
// asked, and only a clear yes cancels. The calendar is not touched here: plan.act is the request, scheduling/act.ts carries it out.

const SERVICE = "30000000-0000-0000-0000-000000000003";
const RES = "20000000-0000-0000-0000-000000000002";
const BOOKING = "40000000-0000-0000-0000-000000000004";
const IST = "Asia/Kolkata";
const NOW = new Date("2026-10-10T04:30:00.000Z"); // Sat 10 Oct, 10:00 in Chennai
const slot = (start: string, label: string) => ({ start, end: new Date(Date.parse(start) + 3_600_000).toISOString(), resourceId: RES, serviceId: SERVICE, label });
const SUN_10 = slot("2026-10-11T04:30:00.000Z", "Sun 11 Oct, 10:00 am");
const SUN_15 = slot("2026-10-11T09:30:00.000Z", "Sun 11 Oct, 3:00 pm");
const MON_17 = slot("2026-10-12T12:00:00.000Z", "Mon 12 Oct, 5:30 pm");
const OFFER = [SUN_10, SUN_15, MON_17];
const CURRENT = { id: BOOKING, label: "Sun 11 Oct, 3:00 pm" };

type Summary = Extract<UnderstandResult, { status: "understood" }>["summary"];
type Scheduling = NonNullable<PlanInput["scheduling"]>;
const summary = (over: Partial<Summary> = {}): Summary => ({ intent: "give_details", language: "en", sentiment: "neutral", asksIfHuman: false, notInterested: false, confidence: 0.9, hasQuestion: false, fieldKeys: [], ...over });
const found: Retrieval = { outcome: "found", chunks: [{ documentId: "d1", title: "FAQ", content: "Parking is free.", similarity: 0.7 }] };
const ready: QualificationSummary = { score: 75, temperature: "hot", ask: [], missingRequired: [], readyForSlots: true, hardFail: null, bookingKind: "site_visit" };

const understood = (over: Partial<Summary> = {}, retrieval: Retrieval = { outcome: "skipped" }, q: QualificationSummary = ready): UnderstandResult =>
  ({ status: "understood", summary: summary(over), retrieval, qualification: q }) as UnderstandResult;

const scheduling = (over: Partial<Scheduling> = {}): Scheduling => ({
  service: { state: "one", id: SERVICE },
  offer: null,
  hasBooking: true,
  booking: CURRENT,
  customerText: "ok",
  preferredTime: null,
  timeZone: IST,
  now: NOW,
  ...over,
});

const plan = (u: UnderstandResult, s: Partial<Scheduling> = {}, extra: Partial<PlanInput> = {}) =>
  planReply({
    understood: u,
    question: null,
    contactLanguage: null,
    previousMisses: 0,
    settings: parseReplySettings({}),
    exitQuestionPending: false,
    customerSaidOne: false,
    talkButtonTapped: false,
    deadlineExceeded: false,
    scheduling: scheduling(s),
    ...extra,
  });

describe("moving a booking", () => {
  const move = (s: Partial<Scheduling> = {}, over: Partial<Summary> = {}) => plan(understood({ intent: "reschedule", ...over }), s);

  it("a customer with a booking who asks to move it is offered times for moving it, from where they said", () => {
    expect(move({ preferredTime: "monday evening" }).act).toEqual({ kind: "offer", serviceId: SERVICE, preferredText: "monday evening", rescheduleBookingId: BOOKING });
    expect(move({ customerText: "can we shift it to tuesday" }).act).toMatchObject({ kind: "offer", preferredText: "can we shift it to tuesday", rescheduleBookingId: BOOKING });
  });

  it("with no booking there is nothing to move: the message is answered like any other", () => {
    expect(move({ hasBooking: false, booking: null }).act).toBeUndefined();
  });

  it("a held time that is not yet confirmed cannot be moved by chat", () => {
    expect(move({ booking: null }).act).toBeUndefined();
  });

  it.each([["none"], ["several"]] as const)("%s service: a person takes over, as for a new booking", (state) => {
    expect(move({ service: { state } })).toMatchObject({ case: "no_service", handoff: { trigger: "stuck" } });
  });

  describe("the customer answers the offer for moving", () => {
    const answer = (text: string) => plan(understood({ intent: "give_details" }), { offer: OFFER, rescheduleBookingId: BOOKING, customerText: text });

    it("picks one: the booking is moved to it", () => {
      expect(answer("the second one").act).toEqual({ kind: "reschedule", serviceId: SERVICE, bookingId: BOOKING, slot: SUN_15 });
    });

    it("wants another time: the search is asked for again, still for moving it", () => {
      expect(answer("none of these, tuesday please").act).toMatchObject({ kind: "offer", rescheduleBookingId: BOOKING, preferredText: "none of these, tuesday please" });
    });

    it("is not clear: the same times again, with the booking they are moving", () => {
      const p = answer("hmm");
      expect(p.act).toBeUndefined();
      expect(p.case).toBe("offer_reask");
      expect((p.reply as { facts: string[] }).facts).toEqual([
        "The customer's booking is on Sun 11 Oct, 3:00 pm and they want to move it.",
        "Free times: Sun 11 Oct, 10:00 am; Sun 11 Oct, 3:00 pm; Mon 12 Oct, 5:30 pm.",
      ]);
    });
  });

  describe("what the customer is told", () => {
    const after = (act: NonNullable<Scheduling["act"]>) => move({ act });

    it("times for moving: said with the booking they are moving, and the times", () => {
      const p = after({ kind: "offered", slots: OFFER, asked: true, rescheduleBookingId: BOOKING });
      expect(p).toMatchObject({ case: "reschedule_offer", reply: { mode: "model", action: { kind: "offer_slots" } } });
      expect((p.reply as { facts: string[] }).facts).toEqual([
        "The customer's booking is on Sun 11 Oct, 3:00 pm and they want to move it.",
        "Free times: Sun 11 Oct, 10:00 am; Sun 11 Oct, 3:00 pm; Mon 12 Oct, 5:30 pm.",
      ]);
    });

    it("moved: confirmed from the fact", () => {
      expect(after({ kind: "rescheduled", label: "Mon 12 Oct, 5:30 pm" })).toMatchObject({
        case: "rescheduled",
        reply: { mode: "model", action: { kind: "confirm_booking" }, facts: ["Booking moved to: Mon 12 Oct, 5:30 pm."] },
      });
    });
  });
});

describe("cancelling a booking", () => {
  const cancel = (s: Partial<Scheduling> = {}, over: Partial<Summary> = {}) => plan(understood({ intent: "cancel", confidence: 0.9, ...over }), s);
  const ask = { bookingId: BOOKING, label: CURRENT.label };

  it("a first message that asks to cancel only asks whether to: nothing is cancelled", () => {
    expect(cancel().act).toEqual({ kind: "ask_cancel", bookingId: BOOKING, label: "Sun 11 Oct, 3:00 pm" });
  });

  it("a reading the model is not sure of is not acted on at all", () => {
    expect(cancel({}, { confidence: 0.6 }).act).toBeUndefined();
  });

  it("with no booking there is nothing to cancel", () => {
    expect(cancel({ hasBooking: false, booking: null }).act).toBeUndefined();
  });

  describe("the customer answers the question", () => {
    const answer = (text: string, over: Partial<Summary> = {}) => plan(understood({ intent: "give_details", ...over }), { cancelAsk: ask, customerText: text });

    it("yes: it is cancelled", () => {
      expect(answer("yes cancel it").act).toEqual({ kind: "cancel", bookingId: BOOKING, label: "Sun 11 Oct, 3:00 pm" });
    });

    it("no: the booking stays, and the question is over", () => {
      expect(answer("no keep it").act).toEqual({ kind: "keep", label: "Sun 11 Oct, 3:00 pm" });
    });

    it("anything else: asked again, and nothing is cancelled", () => {
      const p = answer("what time is it again?");
      expect(p.act).toBeUndefined();
      expect(p).toMatchObject({ case: "cancel_reask", reply: { mode: "model", action: { kind: "answer_and_ask" } } });
      expect((p.reply as { facts: string[] }).facts.join(" ")).toContain("Nothing has been cancelled yet");
    });

    it("a yes and a no together is not an answer", () => {
      expect(answer("yes, don't cancel").act).toBeUndefined();
    });

    it("a question the knowledge base can answer is answered first, and the question waits", () => {
      const p = plan(understood({ hasQuestion: true, intent: "question" }, found), { cancelAsk: ask, customerText: "is parking free?" }, { question: "Is parking free?" });
      expect(p.act).toBeUndefined();
      expect(p.case).toBe("answered_from_kb");
    });

    it("a person asked for comes before the question", () => {
      expect(plan(understood({ intent: "talk_to_human" }), { cancelAsk: ask, customerText: "yes" }).handoff).toMatchObject({ trigger: "asked_human" });
    });
  });

  describe("what the customer is told", () => {
    const after = (act: NonNullable<Scheduling["act"]>) => cancel({ act });

    it("asked: a confirmation is requested, and the reply is told nothing has been cancelled yet", () => {
      const p = after({ kind: "cancel_asked", bookingId: BOOKING, label: "Sun 11 Oct, 3:00 pm" });
      expect(p).toMatchObject({ case: "cancel_ask", reply: { mode: "model", action: { kind: "answer_and_ask", askFields: [] } } });
      const facts = (p.reply as { facts: string[] }).facts;
      expect(facts[0]).toBe("The customer's booking is on Sun 11 Oct, 3:00 pm.");
      expect(facts[1]).toMatch(/Nothing has been cancelled yet/);
    });

    it("cancelled: confirmed from the fact", () => {
      expect(after({ kind: "cancelled", label: "Sun 11 Oct, 3:00 pm" })).toMatchObject({ case: "cancelled", reply: { mode: "model", action: { kind: "cancel" }, facts: ["Cancelled: Sun 11 Oct, 3:00 pm."] } });
    });

    it("kept: the booking stays, the reply says so", () => {
      expect(after({ kind: "kept", label: "Sun 11 Oct, 3:00 pm" })).toMatchObject({
        case: "kept",
        reply: { mode: "model", facts: ["The customer decided to keep their booking on Sun 11 Oct, 3:00 pm. Nothing was cancelled."] },
      });
    });
  });

  it("a lead that is not a fit can still cancel or move a booking it already has", () => {
    const failed: QualificationSummary = { ...ready, temperature: "disqualified", readyForSlots: false, hardFail: { field: "budget", rule: "below x" } };
    expect(plan(understood({ intent: "cancel", confidence: 0.9 }, { outcome: "skipped" }, failed), {}).act).toMatchObject({ kind: "ask_cancel" });
    expect(plan(understood({ intent: "reschedule" }, { outcome: "skipped" }, failed), {}).act).toMatchObject({ kind: "offer", rescheduleBookingId: BOOKING });
  });

  it("a customer with a booking is still not offered a second one", () => {
    expect(plan(understood({ intent: "book" }), {}).act).toBeUndefined();
  });
});
