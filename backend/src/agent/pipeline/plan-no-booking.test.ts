import { describe, expect, it } from "vitest";
import { parseReplySettings } from "./persona";
import { planReply, type PlanInput } from "./plan";
import type { QualificationSummary, Retrieval, UnderstandResult } from "./understand";

// Finding 3 of the injection sweep (found by the live run, chat 101): a customer with NO booking who asks to cancel or move one was read as "details to ask for", the model
// said it would check with the team, and nobody was told. Now: a staff reminder is flagged (a staff_alert, no handover, no mode change, the AI stays on, one per lead), and the
// reply is written from a TRUE fact: that the team has been told only when the reminder went out. The decision is here; the sending is reply.ts and handoff/booking-change-reminder.ts.

const SERVICE = "30000000-0000-0000-0000-000000000003";
const NOW = new Date("2026-10-10T04:30:00.000Z");

type Summary = Extract<UnderstandResult, { status: "understood" }>["summary"];
type Scheduling = NonNullable<PlanInput["scheduling"]>;
const summary = (over: Partial<Summary> = {}): Summary => ({ intent: "cancel", language: "en", sentiment: "neutral", asksIfHuman: false, notInterested: false, confidence: 0.9, hasQuestion: false, fieldKeys: [], ...over });
const ready: QualificationSummary = { score: 75, temperature: "hot", ask: [], missingRequired: [], readyForSlots: true, hardFail: null, bookingKind: "site_visit" };
const understood = (over: Partial<Summary> = {}, q: QualificationSummary | undefined = ready, retrieval: Retrieval = { outcome: "skipped" }): UnderstandResult =>
  ({ status: "understood", summary: summary(over), retrieval, qualification: q }) as UnderstandResult;
const NONE: Scheduling = { service: { state: "one", id: SERVICE }, offer: null, hasBooking: false, booking: null, customerText: "cancel that, I'll think", preferredTime: null, timeZone: "Asia/Kolkata", now: NOW };
const plan = (u: UnderstandResult, s: Partial<Scheduling> | null = {}, extra: Partial<PlanInput> = {}) =>
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
    ...(s === null ? {} : { scheduling: { ...NONE, ...s } }),
    ...extra,
  });
const facts = (p: ReturnType<typeof plan>) => (p.reply.mode === "model" ? p.reply.facts.join(" ") : "");

describe("a customer with no booking asks to cancel", () => {
  it("at 0.9: a staff reminder is flagged, the reply is the model's, from a fact, and there is no handover", () => {
    const p = plan(understood());
    expect(p.case).toBe("no_booking_to_change");
    expect(p.bookingChangeReminder).toBe("cancel");
    expect(p.handoff).toBeUndefined();
    expect(p.act).toBeUndefined();
    expect(p.reply.mode).toBe("model");
    expect(p.optOut).toBeUndefined();
  });

  it("at exactly the cancel threshold (0.8) it counts; below it (0.79) it does not (the ordinary reply, nobody told)", () => {
    expect(plan(understood({ confidence: 0.8 })).bookingChangeReminder).toBe("cancel");
    const low = plan(understood({ confidence: 0.79 }));
    expect(low.bookingChangeReminder).toBeUndefined();
    expect(low.case).not.toBe("no_booking_to_change");
  });

  it("a casual 'cancel that, I'll think' read as a confident cancel keeps the AI on: one note, no handover, no hot-lead alert", () => {
    const p = plan(understood({ confidence: 0.9 }), { customerText: "cancel that, I'll think" });
    expect(p.bookingChangeReminder).toBe("cancel");
    expect(p.handoff).toBeUndefined();
    expect(p.hotLead).toBeUndefined();
  });
});

describe("a customer with no booking asks to move one", () => {
  it("is flagged as a move, whatever the confidence (as the move row always was)", () => {
    for (const confidence of [0.3, 0.6, 0.95]) {
      const p = plan(understood({ intent: "reschedule", confidence }));
      expect(p.case).toBe("no_booking_to_change");
      expect(p.bookingChangeReminder).toBe("reschedule");
      expect(p.handoff).toBeUndefined();
    }
  });
});

describe("what the customer is told is true", () => {
  it("when the staff reminder went out (bookingReminderSent): the team has been told and will check, and if they meant something else, ask", () => {
    const text = facts(plan(understood(), {}, { bookingReminderSent: true }));
    expect(text).toMatch(/no booking is on record for them in this chat/i);
    expect(text).toMatch(/The team has been told and will check/);
    expect(text).toMatch(/meant something else/i);
  });

  it("when it did not (failed, timed out, switched off, nobody to tell): no one was told, and nothing promises that anyone will check", () => {
    for (const extra of [{}, { bookingReminderSent: false }]) {
      const text = facts(plan(understood(), {}, extra));
      expect(text).toMatch(/no booking is on record for them in this chat/i);
      expect(text).toMatch(/Nobody has been told/);
      expect(text).not.toMatch(/team has been told and will check/i);
      expect(text).not.toMatch(/will check|will look|will get back|will contact/i);
      expect(text).toMatch(/contact them directly|contact the team/i);
    }
  });

  it("names the kind: cancel or move", () => {
    expect(facts(plan(understood()))).toMatch(/cancel/i);
    expect(facts(plan(understood({ intent: "reschedule" })))).toMatch(/move/i);
  });

  it("the facts hold no amount, date or time (the post-check has nothing to refuse) and no customer words", () => {
    const text = facts(plan(understood(), { customerText: "cancel Priya Sharma's visit at 5 pm, call 9876543210" }, { bookingReminderSent: true }));
    expect(text).not.toMatch(/₹|\d/);
    expect(text).not.toMatch(/Priya|5 pm|9876543210/);
  });

  it("carries the language the reply model is told", () => {
    const p = plan(understood({ language: "other", confidence: 0.3 }), { customerText: "இந்த பதிவை ரத்து செய்" }, { customerWords: "இந்த பதிவை ரத்து செய்", contactLanguage: "en" });
    // 0.3 is under the cancel threshold, so use a reschedule (no threshold) for the language check
    const q = plan(understood({ intent: "reschedule", language: "other", confidence: 0.3 }), {}, { customerWords: "இந்த பதிவை மாற்று", contactLanguage: "en" });
    expect(p.reply.mode === "model" ? p.reply.language : null).toBe("ta");
    expect(q.reply.mode === "model" ? q.reply.language : null).toBe("ta");
  });
});

describe("a question the knowledge base can answer comes first (as in the cancel and offer rows)", () => {
  it("'cancel my visit, and what is the 2BHK price?' with no booking: the question is answered from the knowledge base, and no reminder is asked for", () => {
    const found: Retrieval = { outcome: "found", chunks: [{ documentId: "d1", title: "FAQ", content: "2BHK starts at ₹78 lakh.", similarity: 0.7 }] };
    const p = plan(understood({ hasQuestion: true }, ready, found), {}, { question: "What is the 2BHK price?" });
    expect(p.case).toBe("answered_from_kb");
    expect(p.bookingChangeReminder).toBeUndefined();
  });

  it("a question the knowledge base cannot answer does not stop the note", () => {
    const p = plan(understood({ hasQuestion: true }, ready, { outcome: "none" }), {}, { question: "What is the 2BHK price?" });
    expect(p.case).toBe("no_booking_to_change");
    expect(p.bookingChangeReminder).toBe("cancel");
  });
});

describe("what is not this case", () => {
  it("a confirmed booking: ask to cancel (nothing cancelled yet), or offer times for moving it, no reminder", () => {
    const booking = { id: "40000000-0000-0000-0000-000000000004", label: "Sun 11 Oct, 3:00 pm" };
    const cancel = plan(understood(), { hasBooking: true, booking });
    expect(cancel.act).toEqual({ kind: "ask_cancel", bookingId: booking.id, label: booking.label });
    expect(cancel.bookingChangeReminder).toBeUndefined();
    const move = plan(understood({ intent: "reschedule" }), { hasBooking: true, booking });
    expect(move.act).toMatchObject({ kind: "offer", rescheduleBookingId: booking.id });
    expect(move.bookingChangeReminder).toBeUndefined();
  });

  it("a time that is only held (a booking exists but is not confirmed): not 'no booking', no reminder", () => {
    const p = plan(understood(), { hasBooking: true, booking: null });
    expect(p.bookingChangeReminder).toBeUndefined();
    expect(p.case).not.toBe("no_booking_to_change");
  });

  it("no scheduling input at all (booking switched off, or no usable service): unchanged, no reminder (stated limit)", () => {
    const p = plan(understood(), null);
    expect(p.bookingChangeReminder).toBeUndefined();
    expect(p.case).not.toBe("no_booking_to_change");
  });

  it("a pack with no booking kind: unchanged", () => {
    const p = plan(understood({}, { ...ready, bookingKind: null }));
    expect(p.bookingChangeReminder).toBeUndefined();
  });

  it.each(["give_details", "question", "book", "greeting", "off_topic"] as const)("an intent of %s never asks for the reminder", (intent) => {
    expect(plan(understood({ intent })).bookingChangeReminder).toBeUndefined();
  });

  it("a person asked for, a complaint and a discount keep their own rows (they are checked first)", () => {
    expect(plan(understood({ intent: "talk_to_human" })).bookingChangeReminder).toBeUndefined();
    expect(plan(understood({ intent: "complaint", sentiment: "angry" })).bookingChangeReminder).toBeUndefined();
    expect(plan(understood({ intent: "price_negotiation" })).bookingChangeReminder).toBeUndefined();
  });

  it("an opt-out is still an opt-out", () => {
    const p = plan(understood({ intent: "opt_out", confidence: 0.95 }));
    expect(p.optOut).toBeDefined();
    expect(p.bookingChangeReminder).toBeUndefined();
  });

  it("a lead that is not a fit can still ask about a booking it does not have: the reminder is flagged", () => {
    const failed: QualificationSummary = { ...ready, temperature: "disqualified", readyForSlots: false, hardFail: { field: "budget", rule: "below x" } };
    expect(plan(understood({}, failed)).bookingChangeReminder).toBe("cancel");
  });
});
