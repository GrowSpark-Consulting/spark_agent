import { describe, expect, it } from "vitest";
import { answerLines, assembleCard, codeSummary, languageNote, LeadCard, nextStepFor, triggerText, type CardFacts } from "./card";

// The lead card (docs/handover.md, module 6; Raja, 11 Oct): so staff never have to read the whole chat. This file is the part that needs no AI:
// the shape, the plain-words reasons, and the safe summary built by code when the model cannot be used.

const facts = (over: Partial<CardFacts> = {}): CardFacts => ({
  contact: { name: "Priya", phone: "+919812345621", language: "ta-en" },
  fields: [
    { label: "Budget", value: "60L" },
    { label: "Preferred area", value: "Velachery" },
    { label: "BHK / type", value: "2BHK" },
    { label: "Are you the buyer?", value: true },
  ],
  score: 75,
  temperature: "hot",
  booking: null,
  trigger: "asked_human",
  priority: "high",
  sentiment: "neutral",
  source: "WhatsApp",
  owner: null,
  ...over,
});

describe("what staff are told about why", () => {
  it.each([
    ["asked_human", /talk to a person/i],
    ["complaint", /unhappy/i],
    ["negotiation", /discount/i],
    ["hot_lead", /hot lead/i],
    ["kb_gap", /could not answer/i],
    ["stuck", /could not continue/i],
    ["credits_exhausted", /out of credits/i],
    ["opt_out", /stop/i],
  ])("%s is said in plain words", (trigger, words) => {
    expect(triggerText(trigger)).toMatch(words);
  });

  it("a reason it does not know is not shown as a code", () => {
    expect(triggerText("something_new")).toBe("The assistant asked for a person to look at this chat");
    expect(triggerText(null)).toBeNull();
  });

  it("every reason has a suggested next step, and an unknown one a safe default", () => {
    for (const trigger of ["asked_human", "complaint", "negotiation", "hot_lead", "kb_gap", "stuck", "credits_exhausted", "opt_out", "other"]) {
      expect(nextStepFor(trigger).length).toBeGreaterThan(10);
    }
    expect(nextStepFor(null)).toBe(nextStepFor("other"));
    expect(nextStepFor("negotiation")).toMatch(/discount/i);
    expect(nextStepFor("complaint")).toMatch(/sorry|apolog/i);
  });
});

describe("the language note", () => {
  it.each([
    ["en", "Writes in English"],
    ["ta", "Writes in Tamil"],
    ["ta-en", "Writes in Tanglish (Tamil in English letters)"],
    ["hi", "Writes in Hindi"],
    ["ml", "Writes in Malayalam"],
    [null, "Language not known yet"],
    ["xx", "Language not known yet"],
  ])("%s", (language, note) => {
    expect(languageNote(language)).toBe(note);
  });
});

describe("the answers, labelled by the business's pack", () => {
  it("one line each, in the pack's order, with yes and no for a yes-or-no answer", () => {
    expect(answerLines(facts().fields)).toEqual(["Budget: 60L", "Preferred area: Velachery", "BHK / type: 2BHK", "Are you the buyer?: yes"]);
    expect(answerLines([{ label: "Buyer", value: false }])).toEqual(["Buyer: no"]);
    expect(answerLines([{ label: "Party", value: 4 }])).toEqual(["Party: 4"]);
  });

  it("leaves out an empty answer", () => {
    expect(answerLines([{ label: "Budget", value: "  " }, { label: "Area", value: "OMR" }])).toEqual(["Area: OMR"]);
  });

  it("keeps a long answer short and on one line", () => {
    const [line] = answerLines([{ label: "Notes", value: `${"x".repeat(500)}\nsecond line` }]);
    expect(line.length).toBeLessThanOrEqual(220);
    expect(line).not.toContain("\n");
  });
});

describe("the summary built by code, when the model is not used", () => {
  it("says what the customer wants, why staff are being told, and where the booking stands: two to four short lines", () => {
    const s = codeSummary(facts());
    expect(s.need).toBe("Looking at: Velachery, 2BHK, budget 60L");
    const lines = s.summary.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(s.summary).toMatch(/talk to a person/i);
    expect(s.summary).toMatch(/no visit booked/i);
    expect(s.nextStep).toBe(nextStepFor("asked_human"));
  });

  it("mentions the booking when there is one", () => {
    expect(codeSummary(facts({ booking: "Site visit, Sun 11 Oct, 3:00 pm · Anand" })).summary).toContain("Site visit, Sun 11 Oct, 3:00 pm · Anand");
  });

  it("is honest when nothing has been collected yet", () => {
    const s = codeSummary(facts({ fields: [] }));
    expect(s.need).toBe("No details collected yet");
  });

  it("never invents anything: every word comes from the facts", () => {
    const s = codeSummary(facts({ trigger: null }));
    expect(s.summary).not.toMatch(/discount|angry|hot/i);
  });
});

describe("the card", () => {
  const summary = { need: "Wants a 2BHK in Velachery", summary: "Line one.\nLine two.", nextStep: "Call them.", suggestedReply: "Hi Priya, shall we fix a visit?", discount: null };

  it("puts everything staff need in one place, and is valid", () => {
    const card = assembleCard(facts(), { ...summary, aiWritten: true });
    expect(LeadCard.safeParse(card).success).toBe(true);
    expect(card).toMatchObject({
      contact: { name: "Priya", phone: "+919812345621", phoneMasked: expect.any(String), language: "ta-en" },
      need: "Wants a 2BHK in Velachery",
      languageNote: "Writes in Tanglish (Tamil in English letters)",
      source: "WhatsApp",
      answers: ["Budget: 60L", "Preferred area: Velachery", "BHK / type: 2BHK", "Are you the buyer?: yes"],
      score: 75,
      temperature: "hot",
      isHot: true,
      trigger: "Asked to talk to a person",
      priority: "high",
      sentiment: "neutral",
      summary: "Line one.\nLine two.",
      nextStep: "Call them.",
      suggestedReply: "Hi Priya, shall we fix a visit?",
      discount: null,
      owner: null,
      aiWritten: true,
    });
  });

  it("the full phone number is for staff in the dashboard; the masked one is for anything that is logged or sent", () => {
    const card = assembleCard(facts(), { ...summary, aiWritten: false });
    expect(card.contact.phone).toBe("+919812345621");
    expect(card.contact.phoneMasked).not.toBe(card.contact.phone);
    expect(card.contact.phoneMasked).toBe("+9198xxxxxx21");
  });

  it("a hot lead is marked hot, whatever else is going on", () => {
    expect(assembleCard(facts({ temperature: "warm", trigger: "hot_lead" }), { ...summary, aiWritten: false }).isHot).toBe(true);
    expect(assembleCard(facts({ temperature: "hot" }), { ...summary, aiWritten: false }).isHot).toBe(true);
    expect(assembleCard(facts({ temperature: "warm", trigger: "asked_human" }), { ...summary, aiWritten: false }).isHot).toBe(false);
  });

  it("carries what was asked for in a discount request", () => {
    const card = assembleCard(facts({ trigger: "negotiation" }), { ...summary, discount: "Asked for ₹70 lakh instead of ₹78 lakh", aiWritten: true });
    expect(card.discount).toBe("Asked for ₹70 lakh instead of ₹78 lakh");
    expect(card.trigger).toMatch(/discount/i);
  });

  it("a lead with no score yet has none, not a zero", () => {
    const card = assembleCard(facts({ score: null, temperature: null }), { ...summary, aiWritten: false });
    expect(card).toMatchObject({ score: null, temperature: null, isHot: false });
  });

  it("a card with no trigger (staff opened the lead themselves) shows no reason and no priority", () => {
    expect(assembleCard(facts({ trigger: null, priority: null }), { ...summary, aiWritten: false })).toMatchObject({ trigger: null, priority: null });
  });

  it("refuses text that is too long to read at a glance", () => {
    const card = assembleCard(facts(), { ...summary, aiWritten: true });
    expect(LeadCard.safeParse({ ...card, summary: "x".repeat(2000) }).success).toBe(false);
    expect(LeadCard.safeParse({ ...card, suggestedReply: "x".repeat(2000) }).success).toBe(false);
  });
});
