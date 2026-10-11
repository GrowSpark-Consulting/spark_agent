import { describe, expect, it } from "vitest";
import { parseReplySettings } from "./persona";
import { planReply, type PlanInput } from "./plan";
import type { QualificationSummary, Retrieval, UnderstandResult } from "./understand";

// Step 5 and 6, booking (Day 3): when a time is offered, how the customer's answer is read, and what follows a booking. The calendar is
// not touched here: this table only DECIDES (plan.act is the request, carried out by scheduling/act.ts), and with the act's result in
// hand (scheduling.act) it says what the customer is told.

const SERVICE = "30000000-0000-0000-0000-000000000003";
const RES = "20000000-0000-0000-0000-000000000002";
const IST = "Asia/Kolkata";
const NOW = new Date("2026-10-10T04:30:00.000Z"); // Sat 10 Oct, 10:00 in Chennai
const slot = (start: string, label: string) => ({ start, end: new Date(Date.parse(start) + 3_600_000).toISOString(), resourceId: RES, serviceId: SERVICE, label });
const SUN_10 = slot("2026-10-11T04:30:00.000Z", "Sun 11 Oct, 10:00 am");
const SUN_15 = slot("2026-10-11T09:30:00.000Z", "Sun 11 Oct, 3:00 pm");
const MON_17 = slot("2026-10-12T12:00:00.000Z", "Mon 12 Oct, 5:30 pm");
const OFFER = [SUN_10, SUN_15, MON_17];

type Summary = Extract<UnderstandResult, { status: "understood" }>["summary"];
const summary = (over: Partial<Summary> = {}): Summary => ({ intent: "give_details", language: "en", sentiment: "neutral", asksIfHuman: false, notInterested: false, confidence: 0.9, hasQuestion: false, fieldKeys: [], ...over });
const found: Retrieval = { outcome: "found", chunks: [{ documentId: "d1", title: "FAQ", content: "Parking is free.", similarity: 0.7 }] };

const ready: QualificationSummary = { score: 75, temperature: "hot", ask: [], missingRequired: [], readyForSlots: true, hardFail: null, bookingKind: "site_visit" };
const notReady: QualificationSummary = { ...ready, score: 30, temperature: "cold", ask: [{ key: "location", label: "Preferred area" }], missingRequired: ["location"], readyForSlots: false };
type Qualification = QualificationSummary;

const scheduling = (over: Partial<NonNullable<PlanInput["scheduling"]>> = {}): NonNullable<PlanInput["scheduling"]> => ({
  service: { state: "one", id: SERVICE },
  offer: null,
  hasBooking: false,
  customerText: "ok",
  preferredTime: null,
  timeZone: IST,
  now: NOW,
  ...over,
});
const understood = (q: Qualification = ready, retrieval: Retrieval = { outcome: "skipped" }, over: Partial<Summary> = {}): UnderstandResult =>
  ({ status: "understood", summary: summary(over), retrieval, qualification: q }) as UnderstandResult;

const plan = (over: Partial<PlanInput> & { s?: Partial<NonNullable<PlanInput["scheduling"]>> } = {}) => {
  const { s, ...rest } = over;
  return planReply({
    understood: understood(),
    question: null,
    contactLanguage: null,
    previousMisses: 0,
    settings: parseReplySettings({}),
    exitQuestionPending: false,
    customerSaidOne: false,
    talkButtonTapped: false,
    deadlineExceeded: false,
    scheduling: scheduling(s),
    ...rest,
  });
};

describe("a time is offered", () => {
  it("to a lead that is ready: the details are in and it scores well. The search is asked for, nothing is said yet", () => {
    const p = plan();
    expect(p.act).toEqual({ kind: "offer", serviceId: SERVICE, preferredText: null });
    expect(p.case).toBe("booking_pending");
    expect(p.reply).toMatchObject({ mode: "fixed", text: "fallback" }); // what is sent only if the act's result never arrives
    expect(p.handoff).toBeUndefined();
  });

  it("to a customer who asks to book, even when not every detail is in yet", () => {
    expect(plan({ understood: understood(notReady, { outcome: "skipped" }, { intent: "book" }) }).act).toMatchObject({ kind: "offer" });
  });

  it("looking where the customer said, from the extraction's words, or else from what they wrote when they asked to book", () => {
    expect(plan({ s: { preferredTime: "tomorrow evening" } }).act).toMatchObject({ preferredText: "tomorrow evening" });
    expect(plan({ understood: understood(ready, { outcome: "skipped" }, { intent: "book" }), s: { customerText: "can I visit saturday morning" } }).act).toMatchObject({ preferredText: "can I visit saturday morning" });
  });

  it("not to a lead that is not ready and did not ask to book", () => {
    const p = plan({ understood: understood(notReady, { outcome: "skipped" }, { intent: "give_details" }) });
    expect(p.act).toBeUndefined();
    expect(p.case).toBe("ask_details");
  });

  it("not while a question is waiting to be answered: the answer comes first", () => {
    const p = plan({ understood: understood(ready, found, { hasQuestion: true, intent: "question" }), question: "Is parking free?" });
    expect(p.act).toBeUndefined();
    expect(p.case).toBe("answered_from_kb");
  });

  it("a customer who asks to book AND asks a question gets the times (a booking intent comes before the answer)", () => {
    expect(plan({ understood: understood(ready, found, { hasQuestion: true, intent: "book" }), question: "Is parking free?" }).act).toMatchObject({ kind: "offer" });
  });

  it("not to a customer who already has a time booked", () => {
    expect(plan({ s: { hasBooking: true } }).act).toBeUndefined();
  });

  it("not when the lead is certainly not a fit", () => {
    const failed: QualificationSummary = { ...ready, temperature: "disqualified", readyForSlots: false, hardFail: { field: "budget", rule: "below min_project_price" } };
    expect(plan({ understood: understood(failed, { outcome: "skipped" }, { intent: "book" }) }).act).toBeUndefined();
  });

  it("not for a business with no kind of booking that needs a time", () => {
    expect(plan({ understood: understood({ ...ready, bookingKind: null }) }).act).toBeUndefined();
  });

  it("not when booking is not switched on for the business (no scheduling input at all)", () => {
    expect(plan({ scheduling: undefined }).act).toBeUndefined();
  });
});

describe("a business that has no single service to book", () => {
  it.each([["none"], ["several"]] as const)("%s: a person takes over, since which service is not for the assistant to guess", (state) => {
    const p = plan({ s: { service: { state } } });
    expect(p.act).toBeUndefined();
    expect(p).toMatchObject({ case: "no_service", reply: { mode: "fixed", text: "handoff" }, handoff: { trigger: "stuck", priority: "normal" } });
  });
});

describe("the customer answers the offer", () => {
  const answer = (text: string, over: Partial<Summary> = {}) => plan({ understood: understood(ready, { outcome: "skipped" }, over), s: { offer: OFFER, customerText: text } });

  it("picks one: that time is booked", () => {
    const p = answer("the second one");
    expect(p.act).toEqual({ kind: "book", serviceId: SERVICE, bookingKind: "site_visit", slot: SUN_15 });
    expect(p.case).toBe("booking_pending");
  });

  it("picks one by its time or day", () => {
    expect(answer("monday 5:30 pm").act).toMatchObject({ kind: "book", slot: MON_17 });
    expect(answer("10 am").act).toMatchObject({ kind: "book", slot: SUN_10 });
  });

  it("wants another time: the search is asked for again, from their words", () => {
    expect(answer("none of these, can we do saturday morning").act).toEqual({ kind: "offer", serviceId: SERVICE, preferredText: "none of these, can we do saturday morning", exclude: OFFER.map((o) => o.start) });
    expect(answer("how about tuesday 4 pm").act).toMatchObject({ kind: "offer", preferredText: "how about tuesday 4 pm" });
  });

  it("is not clear: the same times are offered again, kindly, and nothing is searched or booked", () => {
    const p = answer("hmm let me think");
    expect(p.act).toBeUndefined();
    expect(p).toMatchObject({
      case: "offer_reask",
      reply: { mode: "model", action: { kind: "offer_slots", serviceId: SERVICE }, facts: ["Free times: Sun 11 Oct, 10:00 am; Sun 11 Oct, 3:00 pm; Mon 12 Oct, 5:30 pm."] },
    });
  });

  it("asks something instead of answering and the knowledge base has it: the question is answered, the offer waits", () => {
    const p = plan({ understood: understood(ready, found, { hasQuestion: true, intent: "question" }), question: "Is parking free?", s: { offer: OFFER, customerText: "is parking free?" } });
    expect(p.act).toBeUndefined();
    expect(p.case).toBe("answered_from_kb");
  });

  it("wants a person or is unhappy: that comes first, whatever is on offer", () => {
    expect(plan({ understood: understood(ready, { outcome: "skipped" }, { intent: "talk_to_human" }), s: { offer: OFFER, customerText: "the first" } }).handoff).toMatchObject({ trigger: "asked_human" });
    expect(plan({ understood: understood(ready, { outcome: "skipped" }, { intent: "complaint" }), s: { offer: OFFER, customerText: "the first" } }).handoff).toMatchObject({ trigger: "complaint" });
  });

  it("wants to stop: that comes first too", () => {
    expect(plan({ understood: understood(ready, { outcome: "skipped" }, { intent: "opt_out", confidence: 0.95 }), s: { offer: OFFER, customerText: "stop" } }).optOut).toBeDefined();
  });

  it("a chat that is only a greeting does not book anything", () => {
    expect(answer("hello", { intent: "greeting" }).act).toBeUndefined();
  });
});

describe("what the customer is told once the search or the booking is done", () => {
  const after = (act: NonNullable<NonNullable<PlanInput["scheduling"]>["act"]>, q: Qualification = ready) => plan({ understood: understood(q, { outcome: "skipped" }, { intent: "book" }), s: { act } });

  it("times inside what they asked for: offered in plain words from the facts", () => {
    const p = after({ kind: "offered", slots: OFFER, asked: true });
    expect(p.act).toBeUndefined();
    expect(p).toMatchObject({
      case: "offer_slots",
      kbMisses: 0,
      reply: { mode: "model", action: { kind: "offer_slots", serviceId: SERVICE }, facts: ["Free times: Sun 11 Oct, 10:00 am; Sun 11 Oct, 3:00 pm; Mon 12 Oct, 5:30 pm."] },
    });
  });

  it("the nearest times when none were free where they asked: the reply is told so", () => {
    const p = after({ kind: "offered", slots: [SUN_15], asked: false });
    expect((p.reply as { facts: string[] }).facts).toEqual(["Nothing was free at the time the customer asked for. These are the closest free times.", "Free times: Sun 11 Oct, 3:00 pm."]);
  });

  it("when the time they chose was just taken: the reply says so, then offers the others", () => {
    const p = after({ kind: "offered", slots: [SUN_10, MON_17], asked: false, retaken: true });
    expect(p.case).toBe("offer_retaken");
    expect((p.reply as { facts: string[] }).facts[0]).toBe("The time the customer chose was just taken by someone else.");
    expect((p.reply as { facts: string[] }).facts).toContain("Free times: Sun 11 Oct, 10:00 am; Mon 12 Oct, 5:30 pm.");
  });

  it("booked: confirmed from the fact, with its day and time exactly as written", () => {
    const p = after({ kind: "booked", label: "Sun 11 Oct, 3:00 pm" });
    expect(p).toMatchObject({ case: "booked", kbMisses: 0, reply: { mode: "model", action: { kind: "confirm_booking" }, facts: ["Booked: Sun 11 Oct, 3:00 pm."] } });
    expect(p.handoff).toBeUndefined();
  });

  it("nothing free anywhere: a person is asked to follow up, and the customer is told one will", () => {
    expect(after({ kind: "no_slots" })).toMatchObject({ case: "no_slots", reply: { mode: "fixed", text: "handoff" }, handoff: { trigger: "stuck", priority: "normal" } });
  });

  it("the booking engine refused: the safe line, and a person looks at it", () => {
    expect(after({ kind: "error" })).toMatchObject({ case: "booking_error", reply: { mode: "fixed", text: "fallback" }, handoff: { trigger: "stuck", priority: "normal" } });
  });
});
