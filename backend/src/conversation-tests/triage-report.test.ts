import { describe, expect, it } from "vitest";
import { formatChat, formatSummary, summarize, type MessageRow } from "./triage-report";

// What the harness prints: one block per message, then a table of languages and weak readings.

const row = (over: Partial<MessageRow> = {}): MessageRow => ({
  customer: "anna Velachery la 2BHK price enna?",
  status: "ok",
  language: "ta-en",
  sentiment: "neutral",
  fields: { config: "2BHK", location: "Velachery" },
  intent: "question",
  confidence: 0.95,
  action: "answered_from_kb",
  handoff: null,
  optedOut: false,
  reply: "Velachery la 2BHK ₹78 lakh la start aagum.",
  notes: [],
  ...over,
});

describe("formatChat", () => {
  it("prints, for one message: the language, the fields, the intent with its confidence, the action and the reply", () => {
    expect(formatChat(1, "Velachery 2BHK", [row()])).toEqual([
      'chat 1: "Velachery 2BHK" (1 message)',
      "  [1] customer: anna Velachery la 2BHK price enna?",
      "      language: ta-en     sentiment: neutral",
      "      intent:   question (0.95)     action: answered_from_kb",
      "      fields:   config=2BHK, location=Velachery",
      "      reply:    Velachery la 2BHK ₹78 lakh la start aagum.",
    ]);
  });

  it("shows a handoff, an opt-out, no fields and no reply plainly", () => {
    const lines = formatChat(2, "x", [row({ fields: {}, reply: null, handoff: "negotiation/high", action: "negotiation" }), row({ optedOut: true, action: "stop_phrase", reply: null, intent: null, confidence: null, language: null, sentiment: null })]).join("\n");
    expect(lines).toContain("action: negotiation, handoff negotiation/high");
    expect(lines).toContain("fields:   (none)");
    expect(lines).toContain("reply:    (none)");
    expect(lines).toContain("action: stop_phrase, OPTED OUT");
    expect(lines).toContain("language: -");
    expect(lines).toContain("intent:   - (-)");
  });

  it("prints what went wrong with a message under it, so an error is not mistaken for a silent outcome", () => {
    const text = formatChat(1, "x", [row({ notes: ["the pipeline threw: the model said no"] })]).join("\n");
    expect(text).toContain("      note: the pipeline threw: the model said no");
  });

  it("marks a reading below 0.6, and only that", () => {
    const text = formatChat(1, "x", [row({ confidence: 0.55 }), row({ confidence: 0.6 }), row({ confidence: 0.4 })]).join("\n");
    expect(text.match(/low confidence/g)).toHaveLength(2);
    expect(text).toContain("question (0.55)     action: answered_from_kb   <-- low confidence");
    expect(text).toContain("question (0.6)     action: answered_from_kb\n");
  });

  it("says when a message stopped at the call cap, or was not run at all, and never prints a reading it does not have", () => {
    const text = formatChat(1, "x", [row({ status: "capped", reply: null }), row({ status: "not_run", language: null, intent: null, confidence: null, action: "-", fields: {}, reply: null })]).join("\n");
    expect(text).toContain("stopped at the call cap");
    expect(text).toContain("not run (call cap reached)");
    expect(text.split("\n").filter((l) => l.includes("not run"))).toHaveLength(1);
  });

  it("uses the singular for one message and the plural for more", () => {
    expect(formatChat(1, "x", [row()])[0]).toContain("(1 message)");
    expect(formatChat(1, "x", [row(), row()])[0]).toContain("(2 messages)");
  });
});

describe("summarize and formatSummary", () => {
  const rows = [
    row({ language: "ta-en", confidence: 0.9 }),
    row({ language: "ta-en", confidence: 0.5 }),
    row({ language: "ta-en", confidence: 0.59 }),
    row({ language: "ta", confidence: 0.3 }),
    row({ language: "en", confidence: 0.95 }),
    row({ language: null, intent: null, confidence: null, action: "stop_phrase" }),
    row({ status: "not_run", language: null, confidence: null }),
  ];

  it("counts, per language, the messages that were run and those with an intent confidence below 0.6", () => {
    const summary = summarize(rows);
    expect(summary.languages).toEqual([
      { language: "ta-en", messages: 3, low: 2 },
      { language: "-", messages: 1, low: 0 },
      { language: "en", messages: 1, low: 0 },
      { language: "ta", messages: 1, low: 1 },
    ]);
    expect(summary).toMatchObject({ run: 6, notRun: 1, low: 3 });
  });

  it("does not count a message that was not run, and counts one that stopped at the cap by what it did read", () => {
    const summary = summarize([row({ status: "capped", confidence: 0.2 }), row({ status: "not_run", confidence: 0.1, language: "ta" })]);
    expect(summary).toMatchObject({ run: 1, notRun: 1, low: 1 });
    expect(summary.languages).toEqual([{ language: "ta-en", messages: 1, low: 1 }]);
  });

  it("prints a table with a line per language, the totals, the calls and the estimated cost", () => {
    const text = formatSummary(summarize(rows), { calls: 17, max: 20, byRole: { extraction: 9, reply: 8 }, costUsd: 0.0123 }).join("\n");
    expect(text).not.toContain("with notes");
    expect(text).toContain("summary: 6 messages run, 1 not run");
    expect(text).toMatch(/language\s+messages\s+confidence below 0\.6/);
    expect(text).toMatch(/ta-en\s+3\s+2/);
    expect(text).toMatch(/ta\s+1\s+1/);
    expect(text).toContain("total");
    expect(text).toContain("calls: 17 of 20 (extraction 9, reply 8); estimated cost $0.01");
  });

  it("says how many messages had something wrong, when any did", () => {
    const text = formatSummary(summarize([row({ notes: ["x"] }), row()]), { calls: 2, max: 20, byRole: { extraction: 1, reply: 1 }, costUsd: 0.01 }).join("\n");
    expect(text).toContain("summary: 2 messages run, 0 not run, 1 with notes");
  });

  it("says the cap was reached when messages were not run", () => {
    const text = formatSummary(summarize(rows), { calls: 20, max: 20, byRole: { extraction: 10, reply: 10 }, costUsd: null }).join("\n");
    expect(text).toContain("call cap reached");
    expect(text).toContain("estimated cost unknown");
  });

  it("handles a run with no messages at all", () => {
    expect(formatSummary(summarize([]), { calls: 0, max: 20, byRole: {}, costUsd: 0 }).join("\n")).toContain("summary: 0 messages run");
  });
});
