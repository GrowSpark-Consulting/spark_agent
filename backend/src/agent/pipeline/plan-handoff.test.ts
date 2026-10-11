import { describe, expect, it } from "vitest";
import { fixedText } from "./fixed-texts";
import { parseReplySettings } from "./persona";
import { planReply, type PlanInput } from "./plan";
import type { QualificationSummary, Retrieval, UnderstandResult } from "./understand";

// Day 4, handoff triggers in decide (docs/handover.md, module 6). Three more reasons for a person to hear about a chat, all decided with Raja:
//   - an angry customer or a complaint: one short sorry, then a person takes over (high priority)
//   - a customer who asks for a discount: the assistant never agrees to a price change; a person is alerted at once (high priority)
//   - a hot lead: staff are told once, and the assistant KEEPS helping (the chat stays with the AI)

type Summary = Extract<UnderstandResult, { status: "understood" }>["summary"];
const summary = (over: Partial<Summary> = {}): Summary => ({ intent: "question", language: "en", sentiment: "neutral", asksIfHuman: false, notInterested: false, confidence: 0.9, hasQuestion: true, fieldKeys: [], ...over });
const found: Retrieval = { outcome: "found", chunks: [{ documentId: "d1", title: "Price list", content: "2BHK starts at ₹78 lakh.", similarity: 0.7 }] };
const skipped: Retrieval = { outcome: "skipped" };
const hot: QualificationSummary = { score: 75, temperature: "hot", ask: [], missingRequired: [], readyForSlots: true, hardFail: null, bookingKind: null };
const warm: QualificationSummary = { ...hot, score: 50, temperature: "warm" };

const plan = (over: Partial<PlanInput> = {}, s: Partial<Summary> = {}, retrieval: Retrieval = found, qualification?: QualificationSummary) =>
  planReply({
    understood: { status: "understood", summary: summary(s), retrieval, ...(qualification ? { qualification } : {}) },
    question: null,
    contactLanguage: null,
    previousMisses: 0,
    settings: parseReplySettings({}),
    exitQuestionPending: false,
    customerSaidOne: false,
    talkButtonTapped: false,
    deadlineExceeded: false,
    ...over,
  });

describe("an angry customer or a complaint: one short sorry, then a person", () => {
  it.each([
    ["a complaint", { intent: "complaint" as const }],
    ["an angry customer", { sentiment: "angry" as const }],
  ])("%s gets the apology and the handover line together, and the chat goes to a person at high priority", (_why, s) => {
    expect(plan({}, s)).toMatchObject({ case: "complaint", reply: { mode: "fixed", text: "handoff_sorry", language: "en" }, handoff: { trigger: "complaint", priority: "high" } });
  });

  it("says sorry in the customer's language", () => {
    expect(plan({}, { intent: "complaint", language: "ta" }).reply).toMatchObject({ text: "handoff_sorry", language: "ta" });
  });

  it("the apology is short and says sorry, in every language", () => {
    for (const language of ["en", "ta", "ta-en", "hi"] as const) {
      const text = fixedText("handoff_sorry", language);
      expect(text.length).toBeGreaterThan(20);
      expect(text.length).toBeLessThan(160);
      expect(text).not.toBe(fixedText("handoff", language));
    }
    expect(fixedText("handoff_sorry", "en")).toMatch(/sorry/i);
  });

  it("a business that switched the complaint handover off answers like any other message", () => {
    const settings = parseReplySettings({ handoffTriggers: [{ key: "complaint", enabled: false }] });
    expect(plan({ settings }, { intent: "complaint" }).case).toBe("answered_from_kb");
  });
});

describe("a customer who asks for a discount", () => {
  const ask = (over: Partial<PlanInput> = {}, s: Partial<Summary> = {}) => plan(over, { intent: "price_negotiation", ...s }, skipped);

  it("is told by the model, from one fact, that a person will look at it: no price change is ever agreed", () => {
    const p = ask();
    expect(p).toMatchObject({ case: "negotiation", kbMisses: 0, handoff: { trigger: "negotiation", priority: "high" } });
    expect(p.reply).toMatchObject({ mode: "model", action: { kind: "handoff", trigger: "negotiation" } });
    const facts = (p.reply as { facts: string[] }).facts;
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatch(/cannot agree to any price/i);
    expect(facts[0]).toMatch(/team member/i);
  });

  it("comes before an answer from the knowledge base, even when the same message asks a question", () => {
    expect(plan({}, { intent: "price_negotiation", hasQuestion: true }, found).case).toBe("negotiation");
  });

  it("a business that switched this handover off answers like any other message", () => {
    const settings = parseReplySettings({ handoffTriggers: [{ key: "negotiation", enabled: false }] });
    expect(ask({ settings }).case).not.toBe("negotiation");
  });

  it("comes after a clear opt-out and a request for a person, which win", () => {
    expect(plan({}, { intent: "opt_out", confidence: 0.95 }).optOut).toBeDefined();
    expect(plan({}, { intent: "talk_to_human" }).handoff).toMatchObject({ trigger: "asked_human" });
  });

  it("the settings key may be spelled negotiation or price_negotiation", () => {
    for (const key of ["negotiation", "price_negotiation"]) {
      expect(parseReplySettings({ handoffTriggers: [{ key, enabled: false }] }).negotiationHandoffEnabled).toBe(false);
    }
    expect(parseReplySettings({}).negotiationHandoffEnabled).toBe(true);
  });
});

describe("a hot lead: staff are told once, and the assistant keeps going", () => {
  // Not a handover: the chat stays with the AI, so no handoff row is made (the inbox would call the chat "needs a person"). The turn
  // carries a flag, and the reply step announces it once (a lead.hot event) for the alert to be sent.
  const talk = (over: Partial<PlanInput> = {}, s: Partial<Summary> = {}, retrieval: Retrieval = found, q: QualificationSummary | undefined = hot) => plan({ hotLeadAlerted: false, ...over }, s, retrieval, q);

  it("alongside an ordinary answer, with no handover", () => {
    const p = talk();
    expect(p).toMatchObject({ case: "answered_from_kb", reply: { mode: "model" }, hotLead: true });
    expect(p.handoff).toBeUndefined();
  });

  it("alongside whatever else the turn did, such as asking for the next details", () => {
    const p = talk({}, { intent: "give_details", hasQuestion: false }, skipped, { ...hot, ask: [{ key: "timeline", label: "Timeline" }], readyForSlots: false });
    expect(p.case).toBe("ask_details");
    expect(p.hotLead).toBe(true);
  });

  it("not when the lead is only warm or cold", () => {
    expect(talk({}, {}, found, warm).hotLead).toBeUndefined();
    expect(talk({}, {}, found, { ...warm, temperature: "cold" }).hotLead).toBeUndefined();
  });

  it("not twice: once the business has been told about this lead", () => {
    expect(talk({ hotLeadAlerted: true }).hotLead).toBeUndefined();
  });

  it("not when it is not known whether staff were told (the safe default is silence)", () => {
    expect(plan({}, {}, found, hot).hotLead).toBeUndefined();
  });

  it("not when the business switched it off", () => {
    const settings = parseReplySettings({ handoffTriggers: [{ key: "hot_lead", enabled: false }] });
    expect(talk({ settings }).hotLead).toBeUndefined();
  });

  it("not when a real handover is already happening this turn: that alert is the stronger one", () => {
    const asked = talk({}, { intent: "talk_to_human" });
    expect(asked.handoff).toMatchObject({ trigger: "asked_human" });
    expect(asked.hotLead).toBeUndefined();
    const haggle = talk({}, { intent: "price_negotiation" }, skipped);
    expect(haggle.handoff).toMatchObject({ trigger: "negotiation" });
    expect(haggle.hotLead).toBeUndefined();
  });

  it("not when the customer is leaving", () => {
    expect(talk({}, { intent: "opt_out", confidence: 0.95 }).hotLead).toBeUndefined();
  });

  it("not while the turn is still waiting for the calendar: it goes with the final plan", () => {
    const p = talk({
      understood: { status: "understood", summary: summary({ intent: "book", hasQuestion: false }), retrieval: skipped, qualification: { ...hot, bookingKind: "site_visit" } },
      scheduling: { service: { state: "one", id: "30000000-0000-0000-0000-000000000003" }, offer: null, hasBooking: false, customerText: "book", preferredTime: null, timeZone: "Asia/Kolkata", now: new Date("2026-10-10T04:30:00.000Z") },
    });
    expect(p.act).toBeDefined();
    expect(p.hotLead).toBeUndefined();
  });

  it("and with the calendar's answer in, the alert goes with the offer", () => {
    const slot = { start: "2026-10-11T04:30:00.000Z", end: "2026-10-11T05:30:00.000Z", resourceId: "20000000-0000-0000-0000-000000000002", serviceId: "30000000-0000-0000-0000-000000000003", label: "Sun 11 Oct, 10:00 am" };
    const p = talk({
      understood: { status: "understood", summary: summary({ intent: "book", hasQuestion: false }), retrieval: skipped, qualification: { ...hot, bookingKind: "site_visit" } },
      scheduling: {
        service: { state: "one", id: slot.serviceId },
        offer: null,
        hasBooking: false,
        customerText: "book",
        preferredTime: null,
        timeZone: "Asia/Kolkata",
        now: new Date("2026-10-10T04:30:00.000Z"),
        act: { kind: "offered", slots: [slot], asked: true },
      },
    });
    expect(p).toMatchObject({ case: "offer_slots", hotLead: true });
  });
});
