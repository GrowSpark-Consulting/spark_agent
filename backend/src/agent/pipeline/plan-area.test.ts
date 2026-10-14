import { describe, expect, it } from "vitest";
import { parseReplySettings } from "./persona";
import { planReply, type PlanInput } from "./plan";
import type { QualificationSummary, Retrieval, UnderstandResult } from "./understand";

// A customer names an area the business has no sites in (Raja, 14 Oct). The table in plan.ts, one test per row:
//   first time (or after a different area)            | the areas the business has, so they can choose   | the state "options" is kept; no visit is offered
//   the same area again after the options were shown  | nothing there for now, they will be told         | the state "unavailable"; staff are reminded once
//   ... and again                                     | the same line                                    | no second reminder
//   an unserved area is the lead's, not named now     | the rest of the table                            | but no NEW time is offered for it
//   the customer asks to book, with that area         | the options, or "nothing there" after them       |
//   an area the business has                          | the rest of the table                            | the state is cleared, so "the options first" holds next time
// Whatever comes first in plan.ts still does: opt-out, a person, a complaint, a discount, off topic, a lead that is certainly not a fit.

const SERVICE = "30000000-0000-0000-0000-000000000003";
const NOW = new Date("2026-10-10T04:30:00.000Z");
const AREAS = ["Velachery", "Tambaram", "Anna Nagar"];

type Summary = Extract<UnderstandResult, { status: "understood" }>["summary"];
const summary = (over: Partial<Summary> = {}): Summary => ({ intent: "give_details", language: "en", sentiment: "neutral", asksIfHuman: false, notInterested: false, confidence: 0.9, hasQuestion: false, fieldKeys: ["location"], ...over });
const ready: QualificationSummary = { score: 55, temperature: "warm", ask: [], missingRequired: [], readyForSlots: true, hardFail: null, bookingKind: "site_visit" };
const found: Retrieval = { outcome: "found", chunks: [{ documentId: "d1", title: "FAQ", content: "Parking is free.", similarity: 0.7 }] };
const understood = (over: Partial<Summary> = {}, q: QualificationSummary = ready, retrieval: Retrieval = { outcome: "skipped" }): UnderstandResult => ({ status: "understood", summary: summary(over), retrieval, qualification: q }) as UnderstandResult;

const coverage = (over: Partial<NonNullable<PlanInput["coverage"]>> = {}): NonNullable<PlanInput["coverage"]> => ({ area: "adyar", shown: "Adyar", areas: AREAS, named: true, stage: null, ...over });
const scheduling = (): NonNullable<PlanInput["scheduling"]> => ({ service: { state: "one", id: SERVICE }, offer: null, hasBooking: false, customerText: "Adyar", preferredTime: null, timeZone: "Asia/Kolkata", now: NOW });

const plan = (over: Partial<PlanInput> = {}) =>
  planReply({
    understood: understood(),
    question: null,
    contactLanguage: null,
    previousMisses: 0,
    settings: parseReplySettings({}),
    exitQuestionPending: false,
    customerSaidOne: false,
    talkButtonTapped: false,
    deadlineExceeded: false,
    scheduling: scheduling(),
    coverage: coverage(),
    ...over,
  });

describe("an area the business has no sites in is named for the first time", () => {
  it("lists the areas the business has, as one fixed line, keeps the state, and offers nothing", () => {
    const p = plan();
    expect(p).toMatchObject({
      case: "area_options",
      reply: { mode: "fixed", text: "area_options", language: "en", vars: { area: "Adyar", areas: AREAS } },
      coverage: { area: "adyar", stage: "options" },
      kbMisses: 0,
    });
    expect(p.act).toBeUndefined();
    expect(p.handoff).toBeUndefined();
    expect(p.areaReminder).toBeUndefined();
    expect(p.optOut).toBeUndefined();
  });

  it("is said in the customer's language, from the message first and the contact's after it", () => {
    expect(plan({ understood: understood({ language: "ta" }) }).reply).toMatchObject({ language: "ta" });
    expect(plan({ contactLanguage: "hi", understood: understood({ language: "other" }) }).reply).toMatchObject({ language: "hi" });
  });

  it("is the first reply even for a lead that is hot and ready: the options come before any time", () => {
    const hot: QualificationSummary = { ...ready, score: 80, temperature: "hot" };
    const p = plan({ understood: understood({}, hot), hotLeadAlerted: false });
    expect(p.case).toBe("area_options");
    expect(p.act).toBeUndefined();
  });

  it("answers an area given together with a question by the options too: the question is about a place the business is not in", () => {
    expect(plan({ understood: understood({ intent: "question", hasQuestion: true }, ready, found), question: "Price of a 2BHK in Adyar?" }).case).toBe("area_options");
  });

  it("is another area's options again when the customer names a different area that is not served either", () => {
    const p = plan({ coverage: coverage({ area: "mylapore", shown: "Mylapore", stage: null }) });
    expect(p).toMatchObject({ case: "area_options", reply: { vars: { area: "Mylapore" } }, coverage: { area: "mylapore", stage: "options" } });
  });
});

describe("the same area is named again after the options were shown", () => {
  it("says there is nothing there for now, keeps the state and asks for the staff reminder", () => {
    const p = plan({ coverage: coverage({ stage: "options" }) });
    expect(p).toMatchObject({
      case: "area_unavailable",
      reply: { mode: "fixed", text: "area_unavailable", language: "en", vars: { area: "Adyar", areas: AREAS } },
      coverage: { area: "adyar", stage: "unavailable" },
      areaReminder: true,
    });
    expect(p.act).toBeUndefined();
    expect(p.handoff).toBeUndefined(); // the lead stays open and the chat stays with the AI
  });

  it("says it again, without a second reminder, when the customer keeps asking", () => {
    const p = plan({ coverage: coverage({ stage: "unavailable" }) });
    expect(p).toMatchObject({ case: "area_unavailable", coverage: { area: "adyar", stage: "unavailable" } });
    expect(p.areaReminder).toBeUndefined();
  });
});

describe("the lead's area is not served but the customer did not name it this time", () => {
  const quiet = { named: false };

  it("is answered like any other message", () => {
    const p = plan({ coverage: coverage(quiet), understood: understood({ intent: "question", hasQuestion: true, fieldKeys: [] }, ready, found), question: "Is parking free?", scheduling: undefined });
    expect(p.case).toBe("answered_from_kb");
    expect(p.coverage).toBeUndefined(); // nothing about the state changes
  });

  it("is offered no NEW time for that area, though the lead is ready", () => {
    expect(plan({ coverage: coverage(quiet), understood: understood({ fieldKeys: [] }) }).act).toBeUndefined();
  });

  it("gets the options when it asks to book, and the options again (never 'nothing there', never a reminder) when they were already shown: only the same area NAMED again is insisting", () => {
    const book = understood({ intent: "book", fieldKeys: [] });
    expect(plan({ coverage: coverage(quiet), understood: book })).toMatchObject({ case: "area_options", coverage: { stage: "options" } });
    const again = plan({ coverage: coverage({ ...quiet, stage: "options" }), understood: book });
    expect(again).toMatchObject({ case: "area_options", coverage: { stage: "options" } });
    expect(again.areaReminder).toBeUndefined();
  });

  it("keeps saying 'nothing there' once it has been said, when the customer asks to book without naming the area again", () => {
    const p = plan({ coverage: coverage({ named: false, stage: "unavailable" }), understood: understood({ intent: "book", fieldKeys: [] }) });
    expect(p).toMatchObject({ case: "area_unavailable", coverage: { stage: "unavailable" } });
    expect(p.areaReminder).toBeUndefined();
  });
});

describe("an area the business has", () => {
  it("clears the state, so the options come first if an unserved area is named later", () => {
    const p = plan({ coverage: undefined, areaServedNamed: true });
    expect(p.coverage).toBeNull();
    expect(p.case).toBe("booking_pending"); // the rest of the table: a ready lead is offered times
  });

  it("changes nothing when no area was judged at all", () => {
    const p = plan({ coverage: undefined });
    expect(p.coverage).toBeUndefined();
    expect(p.areaReminder).toBeUndefined();
  });
});

describe("what still comes first", () => {
  it("a clear opt-out", () => {
    expect(plan({ understood: understood({ intent: "opt_out", confidence: 0.95 }) })).toMatchObject({ case: "opt_out_intent", optOut: { notInterested: false } });
  });

  it("a person is asked for, a complaint, a discount", () => {
    expect(plan({ understood: understood({ intent: "talk_to_human" }) }).case).toBe("asked_human");
    expect(plan({ understood: understood({ intent: "complaint" }) }).case).toBe("complaint");
    expect(plan({ understood: understood({ intent: "price_negotiation" }) }).case).toBe("negotiation");
  });

  it("off topic", () => {
    expect(plan({ understood: understood({ intent: "off_topic" }) }).case).toBe("off_topic");
  });

  it("a lead that is certainly not a fit, told once, when it has just given the detail that fails it", () => {
    const failed: QualificationSummary = { ...ready, temperature: "disqualified", readyForSlots: false, hardFail: { field: "budget", rule: "below min_project_price" } };
    expect(plan({ understood: understood({ fieldKeys: ["budget", "location"] }, failed) }).case).toBe("disqualified");
  });

  it("the turn's time running out", () => {
    const p = plan({ deadlineExceeded: true });
    expect(p.case).toBe("deadline");
    expect(p.coverage).toBeUndefined();
  });

  it("a time the customer is picking from an offer they already have", () => {
    const offered = { ...scheduling(), offer: [{ start: "2026-10-11T04:30:00.000Z", end: "2026-10-11T05:30:00.000Z", resourceId: "r", serviceId: SERVICE, label: "Sun 11 Oct, 10:00 am" }], customerText: "Sun 11 Oct, 10:00 am" };
    expect(plan({ scheduling: offered, coverage: coverage({ named: false }), understood: understood({ fieldKeys: [] }) }).case).toBe("booking_pending");
  });
});
