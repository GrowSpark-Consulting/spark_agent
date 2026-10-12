import { describe, expect, it } from "vitest";
import type { LlmClient, LlmRequest } from "../agent/llm";
import { checkSummary, parseTriageArgs, runTriage, type TriageUsage } from "./triage";

// The triage harness end to end with a stubbed model client: what it asks, what it prints, and that the call cap is hard.

const KB = ["2BHK of 950 sq ft in Velachery starts at ₹78 lakh."];
const extraction = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ language: "ta-en", intent: "question", fields: { config: "2BHK", location: "Velachery" }, question: "What is the price of a 2BHK in Velachery?", preferredTime: null, sentiment: "neutral", asksIfHuman: false, confidence: 0.95, ...over });
const REPLY = "Velachery la 2BHK ₹78 lakh la start aagum.";

function stub(extractions: string[], replies: string[]) {
  const calls: LlmRequest[] = [];
  const client: LlmClient = {
    async complete(request) {
      calls.push(request);
      const text = (request.role === "extraction" ? extractions : replies).shift();
      if (text === undefined) throw new Error("the stub has nothing more to say");
      return { text, model: "stub", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.002, latencyMs: 1, attempts: 1, requestId: null };
    },
  };
  return { client, calls };
}
const lines = () => {
  const out: string[] = [];
  return { out, print: (line: string) => void out.push(line) };
};
const CHATS = [
  { name: "Velachery", messages: ["anna Velachery la 2BHK price enna?", "site visit venum"] },
  { name: "Second", messages: ["hello"] },
];

describe("runTriage", () => {
  it("runs each chat with the real client, prints one block per message and the summary, and counts the calls", async () => {
    const s = stub([extraction(), extraction({ intent: "give_details", confidence: 0.55, fields: {} }), extraction({ language: "en", confidence: 0.9 })], [REPLY, "Sure, which day suits you?", "Hello! How can I help?"]);
    const p = lines();
    const result = await runTriage(CHATS, { maxCalls: 20, kb: KB }, s.client, p.print);
    const text = p.out.join("\n");
    expect(result.rows).toHaveLength(3);
    expect(result.usage).toMatchObject({ calls: 6, max: 20, byRole: { extraction: 3, reply: 3 } });
    expect(text).toContain('chat 1: "Velachery" (2 messages)');
    expect(text).toContain("language: ta-en");
    expect(text).toContain("intent:   question (0.95)");
    expect(text).toContain("fields:   config=2BHK, location=Velachery");
    expect(text).toContain("reply:    Velachery la 2BHK ₹78 lakh la start aagum.");
    expect(text).toContain("<-- low confidence");
    expect(text).toContain('chat 2: "Second" (1 message)');
    expect(text).toMatch(/summary: 3 messages run, 0 not run/);
    expect(text).toMatch(/ta-en\s+2\s+1/);
    expect(text).toContain("calls: 6 of 20 (extraction 3, reply 3)");
  });

  it("asks the model with the chat's own messages in order, and the fake knowledge base for its facts", async () => {
    const s = stub([extraction(), extraction({ intent: "give_details" })], [REPLY, "Noted."]);
    await runTriage([CHATS[0]], { maxCalls: 20, kb: KB }, s.client, () => {});
    const extractionCalls = s.calls.filter((c) => c.role === "extraction");
    expect(extractionCalls).toHaveLength(2);
    expect(JSON.stringify(extractionCalls[1].messages)).toContain("site visit venum");
    expect(JSON.stringify(s.calls.find((c) => c.role === "reply")?.messages)).toContain("₹78 lakh");
  });

  it("the call cap is hard: the call after it is never made, the message it stops is marked, and the rest is not run", async () => {
    const s = stub([extraction(), extraction({ intent: "give_details" })], [REPLY, "Noted."]);
    const p = lines();
    const result = await runTriage(CHATS, { maxCalls: 3, kb: KB }, s.client, p.print);
    const text = p.out.join("\n");
    expect(s.calls).toHaveLength(3);
    expect(result.usage.calls).toBe(3);
    expect(result.rows.map((r) => r.status)).toEqual(["ok", "capped", "not_run"]);
    expect(text).toContain("stopped at the call cap");
    expect(text).toContain("not run (call cap reached)");
    expect(text).toMatch(/summary: 2 messages run, 1 not run/);
    expect(text).toContain("calls: 3 of 3");
  });

  it("stops at once when the cap falls before the first call, running nothing", async () => {
    const s = stub([extraction()], [REPLY]);
    const result = await runTriage(CHATS, { maxCalls: 0, kb: KB }, s.client, () => {});
    expect(s.calls).toHaveLength(0);
    expect(result.rows.every((r) => r.status !== "ok")).toBe(true);
    expect(result.usage.calls).toBe(0);
  });

  it("a message the pipeline answers without a model (a STOP phrase) costs no call and shows its action", async () => {
    const s = stub([], []);
    const p = lines();
    const result = await runTriage([{ name: "x", messages: ["STOP"] }], { maxCalls: 5, kb: [] }, s.client, p.print);
    expect(s.calls).toHaveLength(0);
    expect(result.rows[0]).toMatchObject({ status: "ok", action: "stop_phrase", optedOut: true });
    expect(p.out.join("\n")).toContain("action: stop_phrase, handoff opt_out/high, OPTED OUT");
  });

  it("reports the estimated cost from the model results", async () => {
    const s = stub([extraction()], [REPLY]);
    const result = await runTriage([{ name: "x", messages: ["price?"] }], { maxCalls: 5, kb: KB }, s.client, () => {});
    expect(result.usage.costUsd).toBeCloseTo(0.004, 6);
  });

  it("a model that fails does not end the run, and the message says what went wrong instead of looking like a silent outcome", async () => {
    const failing: LlmClient = {
      async complete() {
        throw new Error("down");
      },
    };
    const p = lines();
    const result = await runTriage([{ name: "x", messages: ["price?", "visit?"] }], { maxCalls: 9, kb: KB }, failing, p.print);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((r) => r.status === "ok")).toBe(true);
    expect(result.rows.every((r) => r.notes.some((n) => /pipeline threw|down/.test(n)))).toBe(true);
    expect(p.out.join("\n")).toContain("      note: ");
    expect(p.out.join("\n")).toMatch(/2 with notes/);
  });

  it("counts a call the client had to retry as the requests it really sent, and the cap counts them too", async () => {
    const calls: string[] = [];
    const retrying: LlmClient = {
      async complete(request) {
        calls.push(request.role);
        return {
          text: request.role === "extraction" ? extraction() : REPLY,
          model: "stub",
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          costUsd: 0.001,
          latencyMs: 1,
          attempts: 3,
          requestId: null,
        };
      },
    };
    const result = await runTriage([{ name: "x", messages: ["price?"] }], { maxCalls: 20, kb: KB }, retrying, () => {});
    expect(result.usage.calls).toBe(6);
    expect(result.usage.byRole).toEqual({ extraction: 3, reply: 3 });
    const capped = await runTriage([{ name: "x", messages: ["a", "b", "c"] }], { maxCalls: 4, kb: KB }, retrying, () => {});
    expect(capped.usage.calls).toBeLessThanOrEqual(4 + 2);
    expect(capped.rows.some((r) => r.status !== "ok")).toBe(true);
  });
});

describe("checkSummary", () => {
  it("says how many chats and messages the file holds, and that no model was called", () => {
    expect(checkSummary(CHATS)).toEqual(["2 chats, 3 messages: the file is in the right format.", "No model was called. Add --live to run it with the real models."]);
    expect(checkSummary([CHATS[1]])[0]).toBe("1 chat, 1 message: the file is in the right format.");
  });
});

describe("parseTriageArgs", () => {
  it("reads the file, --live, --max-calls, --kb and --keep-numbers", () => {
    expect(parseTriageArgs(["chats.txt"])).toEqual({ file: "chats.txt", live: false, maxCalls: 20, keepNumbers: false });
    expect(parseTriageArgs(["--", "chats.txt", "--live", "--max-calls", "12", "--kb", "kb.txt", "--keep-numbers"])).toEqual({ file: "chats.txt", live: true, maxCalls: 12, kb: "kb.txt", keepNumbers: true });
    expect(parseTriageArgs(["--max-calls=5", "chats.txt"]).maxCalls).toBe(5);
  });

  it("refuses a missing file, a bad cap, an unknown flag or a second file, with a message that says what to do", () => {
    expect(() => parseTriageArgs([])).toThrow(/file of chats/i);
    expect(() => parseTriageArgs(["a.txt", "--max-calls", "0"])).toThrow(/--max-calls/);
    expect(() => parseTriageArgs(["a.txt", "--max-calls", "x"])).toThrow(/--max-calls/);
    expect(() => parseTriageArgs(["a.txt", "--max-calls", "500"])).toThrow(/--max-calls/);
    expect(() => parseTriageArgs(["a.txt", "--bogus"])).toThrow(/unknown option/i);
    expect(() => parseTriageArgs(["a.txt", "b.txt"])).toThrow(/one file/i);
    expect(() => parseTriageArgs(["a.txt", "--kb"])).toThrow(/--kb/);
  });
});

export type { TriageUsage };
