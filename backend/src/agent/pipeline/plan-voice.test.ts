import { describe, expect, it } from "vitest";
import { fixedText } from "./fixed-texts";
import { parseReplySettings } from "./persona";
import { planReply, type PlanInput } from "./plan";
import type { UnderstandResult } from "./understand";

// Day 4 (Raja, 11 Oct, question 1): a voice note cannot be listened to yet. The assistant replies once, asking the customer to type (an AI reply: 1
// credit), and staff are told a voice note is waiting. A burst of voice notes gets one reply, not one each. A voice note with typed words next to it
// is just a message with a voice note in it, and is answered like any message.

const noText: UnderstandResult = { status: "fallback", reason: "no_text" };
const plan = (over: Partial<PlanInput> = {}, understood: UnderstandResult = noText) =>
  planReply({
    understood,
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

describe("a voice note on its own", () => {
  it("is answered with one polite line asking the customer to type, and staff are told", () => {
    const p = plan({ voiceNote: true });
    expect(p).toMatchObject({ case: "voice_note", reply: { mode: "fixed", text: "voice_note", language: "en" }, voiceNote: true, kbMisses: 0 });
    expect(p.handoff).toBeUndefined();
    expect(p.act).toBeUndefined();
  });

  it("in the customer's own language, from what is known about the contact", () => {
    for (const language of ["en", "ta", "ta-en", "hi"] as const) {
      expect(plan({ voiceNote: true, contactLanguage: language }).reply).toMatchObject({ text: "voice_note", language });
    }
    expect(plan({ voiceNote: true, contactLanguage: "ml" }).reply).toMatchObject({ language: "en" }); // any other language gets English
  });

  it("the line is short, says it cannot listen, and asks for text, in every language", () => {
    for (const language of ["en", "ta", "ta-en", "hi"] as const) {
      const text = fixedText("voice_note", language);
      expect(text.length).toBeGreaterThan(20);
      expect(text.length).toBeLessThan(160);
      expect(text).not.toBe(fixedText("clarify", language));
    }
    expect(fixedText("voice_note", "en")).toMatch(/voice notes/i);
    expect(fixedText("voice_note", "en")).toMatch(/type/i);
  });

  it("a second voice note right after is not answered again, only marked answered (no second credit, no second alert)", () => {
    const p = plan({ voiceNote: true, voiceNoteRepeat: true });
    expect(p).toMatchObject({ case: "voice_note_repeat", reply: { mode: "none" }, markAnswered: true });
    expect(p.voiceNote).toBeUndefined();
  });

  it("the chat after that goes back to normal: the next voice note, after something else was said, is answered again", () => {
    expect(plan({ voiceNote: true, voiceNoteRepeat: false }).case).toBe("voice_note");
  });
});

describe("what is not a voice note", () => {
  it("a message with no words that is not a voice note is still asked to say more", () => {
    expect(plan({}).reply).toMatchObject({ mode: "fixed", text: "clarify" });
    expect(plan({ voiceNote: false }).case).toBe("clarify_no_text");
  });

  it("a voice note with typed words next to it is understood and answered like any message", () => {
    const understood: UnderstandResult = { status: "understood", summary: { intent: "question", language: "en", sentiment: "neutral", asksIfHuman: false, notInterested: false, confidence: 0.9, hasQuestion: true, fieldKeys: [] }, retrieval: { outcome: "none" } };
    const p = plan({ voiceNote: false }, understood);
    expect(p.case).not.toBe("voice_note");
    expect(p.voiceNote).toBeUndefined();
  });

  it("the pack missing or the model down still wins over the voice-note line: nothing about voice is said when something else is wrong", () => {
    expect(plan({ voiceNote: true }, { status: "no_pack" }).case).toBe("no_pack");
    expect(plan({ voiceNote: true }, { status: "model_unavailable" }).case).toBe("model_unavailable");
  });
});
