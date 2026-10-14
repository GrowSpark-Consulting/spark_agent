import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadChats } from "./load";
import { runChat } from "./run-chat";
import { Chat } from "./schema";

// The runner itself: a chat that is wrong must FAIL, or the suite proves nothing.

const chat = (turn: Record<string, unknown>) =>
  Chat.parse({
    name: "x",
    kb: ["2BHK starts at ₹78 lakh."],
    turns: [{ customer: "2BHK price?", mock: { extraction: { intent: "question", question: "price of a 2BHK?" }, reply: "A 2BHK starts at ₹78 lakh. Shall we visit?" }, ...turn }],
  });

describe("runChat", () => {
  it("passes a chat whose expectations are true", async () => {
    const report = await runChat(chat({ expect: { reply: { contains: ["₹78 lakh"] }, aiReplies: 1, handoff: null }, mockOnly: { case: "answered_from_kb" } }), { mode: "mock" });
    expect(report.failures).toEqual([]);
    expect(report.transcript[0]).toMatchObject({ intent: "question", planCase: "answered_from_kb", optedOut: false });
  });

  it.each([
    ["a reply that is not what was expected", { expect: { reply: { contains: ["₹79 lakh"] } } }, /should contain/],
    ["a handover that did not happen", { expect: { handoff: { trigger: "asked_human", priority: "high" } } }, /handoff/],
    ["a wrong case", { mockOnly: { case: "kb_miss" } }, /case: wanted kb_miss/],
    ["an opt-out that did not happen", { expect: { optedOut: true } }, /optedOut/],
    ["a wrong extracted intent", { expect: { extracted: { intent: "complaint" } } }, /extracted intent/],
  ])("fails %s", async (_name, turn, message) => {
    const report = await runChat(chat(turn), { mode: "mock" });
    expect(report.failures.join("\n")).toMatch(message);
  });

  // The reply is plain words with no price, date or time, so the post-check leaves it as scripted.
  const saying = (reply: string, turn: Record<string, unknown>) => chat({ mock: { extraction: { intent: "question", question: "q?" }, reply }, ...turn });
  const VISIT = ["\\bcall (or|and) (a )?visit\\b"];

  it("matches: a reply passes when each pattern is found, in any wording the pattern allows and any letter case", async () => {
    for (const reply of ["We can arrange a call or a visit.", "We can arrange a CALL or visit.", "A call and a visit, as you like."]) {
      const report = await runChat(saying(reply, { expect: { reply: { matches: VISIT } } }), { mode: "mock" });
      expect(report.failures).toEqual([]);
    }
  });

  it("matches: every pattern must be found, and one that is not fails, naming the pattern and the reply", async () => {
    const report = await runChat(saying("We can arrange a call or a visit.", { expect: { reply: { matches: VISIT.concat(["\\bcallback\\b"]) } } }), { mode: "mock" });
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatch(/should match \/\\bcallback\\b\/i, but got "We can arrange a call or a visit\."/);
  });

  it("matches: a pattern that is not a valid regular expression is refused when the chat is loaded", () => {
    expect(() => chat({ expect: { reply: { matches: ["("] } } })).toThrow(/regular expression/);
  });

  it("a strict mockOnly contains still fails in mock mode while expect only has the looser matches (mock mode is not loosened)", async () => {
    const report = await runChat(saying("We can arrange a call or a visit.", { expect: { reply: { matches: VISIT } }, mockOnly: { reply: { contains: ["site visit"] } } }), { mode: "mock" });
    expect(report.failures.join("\n")).toMatch(/should contain "site visit"/);
  });

  it("records what the extraction read for each turn (language, sentiment, fields), for the triage harness", async () => {
    const report = await runChat(chat({ mock: { extraction: { intent: "question", question: "price?", language: "ta-en", sentiment: "neutral", fields: { location: "Velachery" } }, reply: "A 2BHK starts at ₹78 lakh. Shall we visit?" }, expect: { aiReplies: 1 } }), { mode: "mock" });
    expect(report.transcript[0].extraction).toEqual({ language: "ta-en", sentiment: "neutral", fields: { location: "Velachery" } });
  });

  it("tells the caller which turn it is on before each turn starts (onTurn)", async () => {
    const seen: number[] = [];
    await runChat(chat({ expect: { aiReplies: 1 } }), { mode: "mock", onTurn: (index) => seen.push(index) });
    expect(seen).toEqual([0]);
  });

  it("does not check mockOnly in live mode, and refuses live mode without a client", async () => {
    await expect(runChat(chat({ expect: { aiReplies: 1 } }), { mode: "live" })).rejects.toThrow(/live mode needs/);
  });

  it("says when the chat scripts a mocked reply that the pipeline never asked for", async () => {
    const report = await runChat(chat({ customer: "STOP", mock: { reply: ["unused"] }, expect: { stop: true } }), { mode: "mock" });
    expect(report.failures.join("\n")).toMatch(/more mocked reply/);
  });
});

// The booking setup: a chat that is wrong about the calendar, the score or the credits must FAIL too.
describe("runChat with a booking setup", () => {
  const SLOTS = ["2026-10-11T04:30:00.000Z", "2026-10-11T09:30:00.000Z", "2026-10-12T12:00:00.000Z"];
  const bookingChat = (turns: Record<string, unknown>[], booking: Record<string, unknown> = {}) =>
    Chat.parse({
      name: "booking",
      booking: { now: "2026-10-10T04:30:00.000Z", catalog: [{ priceFrom: 6000000, attributes: { price_to: 8000000, area: "Velachery" } }], slots: SLOTS, ...booking },
      turns,
    });
  const details = { customer: "2BHK in Velachery, 60 lakh, within 3 months", mock: { extraction: { intent: "give_details", fields: { location: "Velachery", budget: "60L", timeline: "0-3m" } }, reply: "I can do Sunday at 10:00 am, Sunday at 3:00 pm or Monday at 5:30 pm. Which suits you?" } };

  it("passes when the offer, the score and the calendar are as expected", async () => {
    const report = await runChat(bookingChat([{ ...details, expect: { reply: { contains: ["3:00 pm"] }, calendar: { confirmed: [], cancelled: 0 }, aiReplies: 1 }, mockOnly: { case: "offer_slots", leadTemperature: "hot", leadScore: 75 } }]), { mode: "mock" });
    expect(report.failures).toEqual([]);
  });

  it.each([
    ["a wrong score", { mockOnly: { leadScore: 80 } }, /lead score: wanted 80, got 75/],
    ["a wrong temperature", { mockOnly: { leadTemperature: "cold" } }, /lead temperature: wanted cold, got hot/],
    ["a booking that was not made", { expect: { calendar: { confirmed: [SLOTS[1]] } } }, /calendar confirmed/],
    ["a cancellation that did not happen", { expect: { calendar: { cancelled: 1 } } }, /calendar cancelled: wanted 1, got 0/],
  ])("fails %s", async (_name, assertion, message) => {
    const report = await runChat(bookingChat([{ ...details, ...assertion }]), { mode: "mock" });
    expect(report.failures.join("\n")).toMatch(message);
  });

  it("refuses a calendar expectation in a chat that has no booking setup", async () => {
    const report = await runChat(chat({ expect: { calendar: { confirmed: [] } } }), { mode: "mock" });
    expect(report.failures.join("\n")).toMatch(/no booking setup/);
  });

  it("books a time and moves the lead to booked, so the next turn's expectations see it", async () => {
    const report = await runChat(
      bookingChat([
        { ...details, expect: { aiReplies: 1 } },
        { customer: "the second one", mock: { extraction: { intent: "give_details" }, reply: "Booked for Sunday at 3:00 pm." }, expect: { leadStage: "booked", calendar: { confirmed: [SLOTS[1]] } } },
      ]),
      { mode: "mock" },
    );
    expect(report.failures).toEqual([]);
  });

  it("out of credits: nothing is sent and the holding line is the only thing the customer gets", async () => {
    const report = await runChat(bookingChat([{ ...details, mock: { ...details.mock, credits: "zero" }, expect: { aiReplies: 0, confirmations: 1, handoff: { trigger: "credits_exhausted", priority: "high" }, mode: "human" } }]), { mode: "mock" });
    expect(report.failures).toEqual([]);
  });

  it("checks whether staff were told about a hot lead: true passes, and the wrong answer fails", async () => {
    expect((await runChat(bookingChat([{ ...details, expect: { hotLead: true } }]), { mode: "mock" })).failures).toEqual([]);
    const wrong = await runChat(bookingChat([{ ...details, expect: { hotLead: false } }]), { mode: "mock" });
    expect(wrong.failures.join("\n")).toMatch(/hot lead alert this turn: wanted false, got true/);
  });

  it("a chat without a booking setup is unaffected: no calendar, no scoring, the clock is the real one", async () => {
    const report = await runChat(chat({ expect: { aiReplies: 1 }, mockOnly: { leadTemperature: "hot" } }), { mode: "mock" });
    expect(report.failures.join("\n")).toMatch(/lead temperature: wanted hot, got undefined/);
  });
});

describe("runChat with a voice note", () => {
  const voiceChat = (expectation: Record<string, unknown>) => Chat.parse({ name: "voice", turns: [{ customer: "[voice note]", voice: true, expect: expectation }] });

  it("answers it once and tells staff: the expectations that say so pass", async () => {
    expect((await runChat(voiceChat({ aiReplies: 1, voiceNoteAlert: true, mode: "ai" }), { mode: "mock" })).failures).toEqual([]);
  });

  it("fails an expectation that says nobody is told", async () => {
    const report = await runChat(voiceChat({ voiceNoteAlert: false }), { mode: "mock" });
    expect(report.failures.join("\n")).toMatch(/voice note alert this turn: wanted false, got true/);
  });
});

describe("loadChats", () => {
  const dirWith = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "chats-"));
    mkdirSync(join(dir, "real-estate"));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, "real-estate", name), text);
    return dir;
  };

  it("loads valid chats in file-name order", () => {
    const dir = dirWith({ "b.yaml": "name: b\nturns:\n  - customer: hi\n    expect: { aiReplies: 1 }\n", "a.yaml": "name: a\nturns:\n  - customer: hi\n    expect: { aiReplies: 1 }\n" });
    expect(loadChats(dir).map((c) => c.chat.name)).toEqual(["a", "b"]);
  });

  it("names the file of a chat that is not valid, so a typo cannot make a test quietly pass", () => {
    expect(() => loadChats(dirWith({ "bad.yaml": "name: bad\nturns:\n  - customer: hi\n    expectt: {}\n" }))).toThrow(/real-estate\/bad\.yaml is not a valid chat/);
  });

  it("refuses a chat that says another pack than its folder", () => {
    expect(() => loadChats(dirWith({ "x.yaml": "name: x\npack: salon\nturns:\n  - customer: hi\n    expect: { aiReplies: 1 }\n" }))).toThrow(/folder/);
  });
});

describe("runChat with an area the business has no sites in", () => {
  const unserved = (second: Record<string, unknown>) =>
    Chat.parse({
      name: "an unserved area",
      booking: { now: "2026-10-10T04:30:00.000Z", slots: ["2026-10-11T04:30:00.000Z"], catalog: [{ priceFrom: 6000000, attributes: { price_to: 8000000, area: "Velachery" } }] },
      turns: [
        { customer: "2BHK in Adyar", mock: { extraction: { intent: "give_details", fields: { config: "2BHK", location: "Adyar" } } }, expect: { case: "area_options", reply: { contains: ["Velachery"] }, areaReminder: false, aiReplies: 1 } },
        { customer: "only Adyar", mock: { extraction: { intent: "give_details", fields: { location: "Adyar" } } }, ...second },
      ],
    });

  it("passes: the options, then 'nothing there' with one staff reminder, the lead still open", async () => {
    const report = await runChat(unserved({ expect: { case: "area_unavailable", reply: { contains: ["don't have any property in Adyar"] }, areaReminder: true, leadStage: "engaged", handoff: null, calendar: { confirmed: [] } } }), { mode: "mock" });
    expect(report.failures).toEqual([]);
    expect(report.transcript.map((t) => t.planCase)).toEqual(["area_options", "area_unavailable"]);
  });

  it("fails an expectation that says nobody is reminded when staff were", async () => {
    const report = await runChat(unserved({ expect: { areaReminder: false } }), { mode: "mock" });
    expect(report.failures.join("\n")).toMatch(/area reminder this turn: wanted false, got true/);
  });
});
