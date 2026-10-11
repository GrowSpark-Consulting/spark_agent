import { describe, expect, it } from "vitest";
import { fixedText } from "./fixed-texts";
import { parseReplySettings } from "./persona";
import { KB_MISSES_FOR_HANDOFF, OPT_OUT_MIN_CONFIDENCE, planReply, UNCLEAR_EXIT_MIN_CONFIDENCE, type PlanInput } from "./plan";
import type { Retrieval, UnderstandResult } from "./understand";

// The table of outcomes: what the customer gets for every way the understanding step can end. Every row of the
// table in plan.ts is a test here, and the three rules about consecutive misses are tested as sequences.

const summary = (over: Partial<Extract<UnderstandResult, { status: "understood" }>["summary"]> = {}) => ({
  intent: "question" as const,
  language: "en" as const,
  sentiment: "neutral" as const,
  asksIfHuman: false,
  notInterested: false,
  confidence: 0.9,
  hasQuestion: true,
  fieldKeys: [] as string[],
  ...over,
});
const understood = (retrieval: Retrieval, over: Parameters<typeof summary>[0] = {}): UnderstandResult => ({ status: "understood", summary: summary(over), retrieval });
const found: Retrieval = { outcome: "found", chunks: [{ documentId: "d1", title: "Price list", content: "2BHK starts at ₹78 lakh.", similarity: 0.7 }] };

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  understood: understood(found),
  question: "What is the price of a 2BHK?",
  contactLanguage: null,
  previousMisses: 0,
  settings: parseReplySettings({}),
  exitQuestionPending: false,
  customerSaidOne: false,
  talkButtonTapped: false,
  deadlineExceeded: false,
  ...over,
});

describe("understood, and the knowledge base had the answer", () => {
  it("is the model's answer from the facts, and the miss count goes back to 0", () => {
    const plan = planReply(input({ previousMisses: 1 }));
    expect(plan).toMatchObject({
      case: "answered_from_kb",
      kbMisses: 0,
      reply: { mode: "model", action: { kind: "answer_and_ask", question: "What is the price of a 2BHK?", askFields: [] }, facts: ["Price list: 2BHK starts at ₹78 lakh."], language: "en" },
    });
    expect(plan.handoff).toBeUndefined();
    expect(plan.gap).toBeUndefined();
  });

  it("gives every snippet as a fact, with its title when it has one", () => {
    const plan = planReply(input({ understood: understood({ outcome: "found", chunks: [{ documentId: "a", title: null, content: "One.", similarity: 0.6 }, { documentId: "b", title: "T", content: "Two.", similarity: 0.5 }] }) }));
    expect(plan.reply).toMatchObject({ facts: ["One.", "T: Two."] });
  });
});

describe("understood, and the knowledge base had nothing (a miss)", () => {
  const miss = understood({ outcome: "none" });

  it("is the safe fallback, records the gap and counts the miss", () => {
    expect(planReply(input({ understood: miss }))).toEqual({
      case: "kb_miss",
      reply: { mode: "fixed", text: "fallback", language: "en" },
      gap: { question: "What is the price of a 2BHK?" },
      kbMisses: 1,
    });
  });

  it("does not record a gap when there is no question to record", () => {
    expect(planReply(input({ understood: miss, question: null })).gap).toBeUndefined();
    expect(planReply(input({ understood: miss, question: "   " })).gap).toBeUndefined();
  });

  it("is the handover on the second miss in a row in this chat, with the handover line and a kb_gap handoff", () => {
    const plan = planReply(input({ understood: miss, previousMisses: 1 }));
    expect(plan).toMatchObject({ case: "kb_miss_handoff", reply: { mode: "fixed", text: "handoff" }, handoff: { trigger: "kb_gap", priority: "normal" }, kbMisses: 0 });
    expect(plan.gap).toEqual({ question: "What is the price of a 2BHK?" }); // the second miss is a gap too
  });

  it("is no handover when the business has switched the knowledge-gap handover off", () => {
    const settings = parseReplySettings({ handoffTriggers: [{ key: "kb_gap", enabled: false }] });
    const plan = planReply(input({ understood: miss, previousMisses: 1, settings }));
    expect(plan).toMatchObject({ case: "kb_miss", reply: { mode: "fixed", text: "fallback" }, kbMisses: 2 });
    expect(plan.handoff).toBeUndefined();
  });

  it("a chat a person hands back starts again from 0: the handover used the misses up, so the next miss is the first", () => {
    const handedOver = planReply(input({ understood: miss, previousMisses: 1 }));
    expect(handedOver.kbMisses).toBe(0);
    const next = planReply(input({ understood: miss, previousMisses: handedOver.kbMisses }));
    expect(next.handoff).toBeUndefined();
    expect(next.kbMisses).toBe(1);
  });

  it("does not bank misses while the trigger is off: turned on later, it still takes two in a row", () => {
    const off = parseReplySettings({ handoffTriggers: [{ key: "kb_gap", enabled: false }] });
    let misses = 0;
    for (let i = 0; i < 5; i++) misses = planReply(input({ understood: miss, previousMisses: misses, settings: off })).kbMisses;
    expect(misses).toBe(2); // never above the threshold
    const on = planReply(input({ understood: miss, previousMisses: 0 })); // after an answered turn: back to 0, then one miss
    expect(on.handoff).toBeUndefined();
  });

  it("is the handover from the threshold on, however many misses came before", () => {
    expect(KB_MISSES_FOR_HANDOFF).toBe(2);
    expect(planReply(input({ understood: miss, previousMisses: 5 })).handoff?.trigger).toBe("kb_gap");
  });
});

describe("the three rules about consecutive misses, as a conversation", () => {
  /** Runs turns through the plan, carrying the miss count like the pipeline does (it keeps it on the chat's messages). */
  function chat(turns: Retrieval[]) {
    let misses = 0;
    return turns.map((retrieval) => {
      const plan = planReply(input({ understood: understood(retrieval), previousMisses: misses }));
      misses = plan.kbMisses;
      return plan;
    });
  }
  const none: Retrieval = { outcome: "none" };

  it("the same question from two different customers is no handover: each chat starts from 0", () => {
    const first = chat([none]);
    const second = chat([none]); // another customer, another chat: its own count, whatever the business-wide gap count says
    expect(first[0].handoff).toBeUndefined();
    expect(second[0].handoff).toBeUndefined();
    expect(second[0].reply).toMatchObject({ mode: "fixed", text: "fallback" });
  });

  it("two misses in a row in one chat is a handover", () => {
    const [one, two] = chat([none, none]);
    expect(one.handoff).toBeUndefined();
    expect(two.handoff).toMatchObject({ trigger: "kb_gap" });
  });

  it("a miss, an answered turn, then a miss is no handover", () => {
    const [a, b, c] = chat([none, found, none]);
    expect(a.kbMisses).toBe(1);
    expect(b.kbMisses).toBe(0);
    expect(c.kbMisses).toBe(1);
    expect(c.handoff).toBeUndefined();
  });

  it("a greeting between two misses is an answered turn too", () => {
    const [, greeting, last] = chat([none, { outcome: "skipped" }, none]);
    expect(greeting.kbMisses).toBe(0);
    expect(last.handoff).toBeUndefined();
  });

  it("a search outage between two misses is neither a miss nor an answer: the count carries", () => {
    const [, outage, last] = chat([none, { outcome: "unavailable" }, none]);
    expect(outage.kbMisses).toBe(1);
    expect(last.handoff).toMatchObject({ trigger: "kb_gap" });
  });

  it("a clarifying question or an outage of the model does not reset it either", () => {
    let misses = 1;
    for (const understoodResult of [{ status: "fallback", reason: "invalid_output" }, { status: "model_unavailable" }] as UnderstandResult[]) {
      misses = planReply(input({ understood: understoodResult, previousMisses: misses })).kbMisses;
      expect(misses).toBe(1);
    }
  });
});

describe("understood, and the search could not run", () => {
  it("is the safe fallback with no gap and no handover (an outage is not a gap in the knowledge base)", () => {
    const plan = planReply(input({ understood: understood({ outcome: "unavailable" }), previousMisses: 1 }));
    expect(plan).toEqual({ case: "kb_unavailable", reply: { mode: "fixed", text: "fallback", language: "en" }, kbMisses: 1 });
  });
});

describe("understood, and there was nothing to look up", () => {
  it("is the model's reply with no facts (a greeting, details given, a booking word), and the count goes back to 0", () => {
    const plan = planReply(input({ understood: understood({ outcome: "skipped" }, { intent: "greeting", hasQuestion: false }), question: null, previousMisses: 1 }));
    expect(plan).toMatchObject({ case: "nothing_to_look_up", kbMisses: 0, reply: { mode: "model", action: { kind: "answer_and_ask", question: "" }, facts: [] } });
  });
});

describe("understood, and off topic", () => {
  it("is the model's polite decline, with no facts", () => {
    const plan = planReply(input({ understood: understood({ outcome: "skipped" }, { intent: "off_topic" }) }));
    expect(plan).toMatchObject({ case: "off_topic", kbMisses: 0, reply: { mode: "model", action: { kind: "decline_off_topic" }, facts: [] } });
  });
});

describe("understood, and the customer clearly asks to stop (opt_out, confidence at least the threshold)", () => {
  const leaving = (over: Parameters<typeof summary>[0] = {}) => planReply(input({ understood: understood({ outcome: "skipped" }, { intent: "opt_out", ...over }) }));

  it("the threshold is 0.8 (Raja, 9 Oct)", () => {
    expect(OPT_OUT_MIN_CONFIDENCE).toBe(0.8);
  });

  it("is an opt-out: nothing is sent, the lead is not marked lost unless they said they are not interested", () => {
    expect(leaving({ confidence: 0.8 })).toEqual({ case: "opt_out_intent", reply: { mode: "none" }, optOut: { notInterested: false }, kbMisses: 0 });
    expect(leaving({ confidence: 0.95 }).optOut).toEqual({ notInterested: false });
  });

  it("says when they are not interested, so the lead can be lost", () => {
    expect(leaving({ confidence: 0.9, notInterested: true })).toMatchObject({ case: "opt_out_not_interested", optOut: { notInterested: true } });
  });

  it("opens no handover from the plan (the opt-out step opens its own) and never replies", () => {
    const plan = leaving({ confidence: 0.99 });
    expect(plan.handoff).toBeUndefined();
    expect(plan.reply).toEqual({ mode: "none" });
  });
});

describe("understood, and the customer may be leaving but it is not clear how", () => {
  const plan = (over: Parameters<typeof summary>[0]) => planReply(input({ understood: understood({ outcome: "skipped" }, over) }));

  it.each([
    ["opt_out below the threshold", { intent: "opt_out" as const, confidence: 0.79 }],
    ["opt_out, far below", { intent: "opt_out" as const, confidence: 0.2 }],
    ["unclear_exit, however sure", { intent: "unclear_exit" as const, confidence: 0.99 }],
  ])("%s: the customer is asked once, in their language, and not opted out", (_name, over) => {
    const result = plan({ ...over, language: "ta-en" });
    expect(result).toEqual({ case: "exit_unclear", reply: { mode: "fixed", text: "exit_question", language: "ta-en" }, kbMisses: 0 });
    expect(result.optOut).toBeUndefined();
  });

  it("the floor is 0.5: an unclear_exit reading below it is not believed (a stray character, \"ok\", \"?\", an emoji alone)", () => {
    expect(UNCLEAR_EXIT_MIN_CONFIDENCE).toBe(0.5);
    for (const confidence of [0, 0.2, 0.3, 0.49]) {
      const result = planReply(input({ understood: understood({ outcome: "skipped" }, { intent: "unclear_exit", confidence, hasQuestion: false }) }));
      expect(result.case, String(confidence)).not.toBe("exit_unclear");
      expect(result.optOut).toBeUndefined();
      expect(result.handoff).toBeUndefined();
      expect(result.reply.mode).toBe("model"); // answered like any message with nothing to look up
    }
    expect(planReply(input({ understood: understood({ outcome: "skipped" }, { intent: "unclear_exit", confidence: 0.5 }) })).case).toBe("exit_unclear");
  });

  it("the floor does not weaken the opt-out rules: opt_out below 0.8 is still asked, opt_out at 0.8 is still an opt-out", () => {
    expect(planReply(input({ understood: understood({ outcome: "skipped" }, { intent: "opt_out", confidence: 0.6 }) })).case).toBe("exit_unclear");
    expect(planReply(input({ understood: understood({ outcome: "skipped" }, { intent: "opt_out", confidence: 0.8 }) })).optOut).toBeDefined();
  });

  it("the line has the STOP hint and the two choices as text until sendButtons exists, and no STOP button", () => {
    for (const language of ["en", "ta", "ta-en", "hi"] as const) {
      const text = fixedText("exit_question", language);
      expect(text).toContain("STOP");
      expect(text).toContain("1");
    }
    expect(fixedText("exit_question", "en")).toContain("Reply 1 to talk to the team, or just continue");
    expect(fixedText("exit_question", "en")).toContain("If you'd like us to stop messaging you, just reply STOP.");
  });

  it('"1" after that question is a person taking over: handover asked_human, high priority', () => {
    const result = planReply(input({ understood: understood({ outcome: "skipped" }, { intent: "give_details", hasQuestion: false }), exitQuestionPending: true, customerSaidOne: true }));
    expect(result).toEqual({ case: "exit_question_talk", reply: { mode: "fixed", text: "handoff", language: "en" }, handoff: { trigger: "asked_human", priority: "high" }, kbMisses: 0 });
  });

  it("a tap on the Talk to the team button is a person taking over, whatever the model made of the title, and even if the question is not the last thing asked", () => {
    for (const over of [{ intent: "greeting" as const }, { intent: "unclear_exit" as const }, { intent: "opt_out" as const, confidence: 0.99 }, { intent: "question" as const }]) {
      const result = planReply(input({ understood: understood({ outcome: "skipped" }, over), talkButtonTapped: true }));
      expect(result, JSON.stringify(over)).toMatchObject({ case: "exit_question_talk", handoff: { trigger: "asked_human", priority: "high" }, reply: { mode: "fixed", text: "handoff" } });
      expect(result.optOut).toBeUndefined();
    }
  });

  it("a tap on Talk to the team is a handover even when the message could not be understood: the model down, the answer invalid, no pack, the turn out of time", () => {
    const cases: Partial<PlanInput>[] = [
      { understood: { status: "model_unavailable" } },
      { understood: { status: "fallback", reason: "invalid_output" } },
      { understood: { status: "fallback", reason: "model_declined" } },
      { understood: { status: "no_pack" } },
      { deadlineExceeded: true },
    ];
    for (const over of cases) {
      const result = planReply(input({ ...over, talkButtonTapped: true, contactLanguage: "hi" }));
      expect(result, JSON.stringify(over)).toMatchObject({ case: "exit_question_talk", handoff: { trigger: "asked_human", priority: "high" }, reply: { mode: "fixed", text: "handoff", language: over.deadlineExceeded ? "en" : "hi" } }); // (an understood message keeps its own language)
    }
  });

  it("a tap on the button is not a handover when the business switched asked_human off (the question had no button then)", () => {
    const settings = parseReplySettings({ handoffTriggers: [{ key: "asked_human", enabled: false }] });
    expect(planReply(input({ understood: understood(found), talkButtonTapped: true, settings })).case).toBe("answered_from_kb");
  });

  it("when the business switched asked_human off the question has no way to reach the team: the short line with the STOP hint, no button and no '1'", () => {
    const settings = parseReplySettings({ handoffTriggers: [{ key: "asked_human", enabled: false }] });
    const result = planReply(input({ understood: understood({ outcome: "skipped" }, { intent: "unclear_exit", confidence: 0.7, language: "ta-en" }), settings }));
    expect(result).toMatchObject({ case: "exit_unclear", reply: { mode: "fixed", text: "exit_prompt", language: "ta-en" } });
    expect(fixedText("exit_prompt", "ta-en")).toContain("STOP");
    expect(fixedText("exit_prompt", "en")).not.toMatch(/[0-9]/);
  });

  it('"1" wins over what the model made of it: not asked twice, not opted out after choosing the team', () => {
    for (const over of [{ intent: "unclear_exit" as const }, { intent: "opt_out" as const, confidence: 0.5 }, { intent: "opt_out" as const, confidence: 0.99 }]) {
      const result = planReply(input({ understood: understood({ outcome: "skipped" }, over), exitQuestionPending: true, customerSaidOne: true }));
      expect(result.case, JSON.stringify(over)).toBe("exit_question_talk");
      expect(result.optOut).toBeUndefined();
    }
  });

  it("the question is asked once: a second unclear message is answered like any other", () => {
    for (const over of [{ intent: "unclear_exit" as const }, { intent: "opt_out" as const, confidence: 0.5 }]) {
      const result = planReply(input({ understood: understood({ outcome: "skipped" }, over), exitQuestionPending: true }));
      expect(result.case, JSON.stringify(over)).not.toBe("exit_unclear");
      expect(result.reply.mode).toBe("model");
    }
  });

  it("a clear opt-out after the question is still an opt-out", () => {
    expect(planReply(input({ understood: understood({ outcome: "skipped" }, { intent: "opt_out", confidence: 0.95 }), exitQuestionPending: true })).optOut).toEqual({ notInterested: false });
  });

  it('"1" when nothing was asked, or anything else after the question, is an ordinary message', () => {
    expect(planReply(input({ understood: understood(found), customerSaidOne: true })).case).toBe("answered_from_kb");
    expect(planReply(input({ understood: understood(found), exitQuestionPending: true, customerSaidOne: false })).case).toBe("answered_from_kb");
  });

  it('"1" is not a handover when the business switched asked_human off', () => {
    const settings = parseReplySettings({ handoffTriggers: [{ key: "asked_human", enabled: false }] });
    expect(planReply(input({ understood: understood(found), exitQuestionPending: true, customerSaidOne: true, settings })).case).toBe("answered_from_kb");
  });
});

describe("understood, and the customer wants a person, or is unhappy or angry (Raja, 9 Oct)", () => {
  const plan = (over: Parameters<typeof summary>[0], settings = parseReplySettings({})) => planReply(input({ understood: understood({ outcome: "skipped" }, over), settings }));

  it("wants a person: the handover line and a high-priority asked_human handover", () => {
    expect(plan({ intent: "talk_to_human", language: "hi" })).toEqual({ case: "asked_human", reply: { mode: "fixed", text: "handoff", language: "hi" }, handoff: { trigger: "asked_human", priority: "high" }, kbMisses: 0 });
  });

  it.each([
    ["a complaint", { intent: "complaint" as const }],
    ["an angry customer asking something else", { intent: "question" as const, sentiment: "angry" as const }],
    ["an angry customer who is negotiating", { intent: "price_negotiation" as const, sentiment: "angry" as const }],
  ])("%s: the handover line and a high-priority complaint handover", (_name, over) => {
    expect(plan(over)).toEqual({ case: "complaint", reply: { mode: "fixed", text: "handoff", language: "en" }, handoff: { trigger: "complaint", priority: "high" }, kbMisses: 0 });
  });

  it("only asking whether it is a bot is answered, not handed over", () => {
    expect(plan({ intent: "question", asksIfHuman: true }).handoff).toBeUndefined();
  });

  it("a negative (not angry) customer is answered like anyone else", () => {
    expect(plan({ intent: "question", sentiment: "negative" }).handoff).toBeUndefined();
  });

  it("a business can switch each handover off, and the message is then answered normally", () => {
    const noHuman = parseReplySettings({ handoffTriggers: [{ key: "asked_human", enabled: false }] });
    const noComplaint = parseReplySettings({ handoffTriggers: [{ key: "complaint", enabled: false }] });
    expect(plan({ intent: "talk_to_human" }, noHuman).handoff).toBeUndefined();
    expect(plan({ intent: "complaint" }, noComplaint).handoff).toBeUndefined();
    expect(plan({ intent: "talk_to_human" }, noComplaint).handoff).toEqual({ trigger: "asked_human", priority: "high" });
  });

  it("a person is asked for before anything is looked up: the handover wins over a knowledge-base answer", () => {
    const result = planReply(input({ understood: understood(found, { intent: "talk_to_human" }) }));
    expect(result.case).toBe("asked_human");
  });
});

describe("the step did not understand", () => {
  it.each(["no_text", "invalid_output", "model_declined"] as const)("%s is a clarifying question", (reason) => {
    expect(planReply(input({ understood: { status: "fallback", reason }, contactLanguage: "ta" }))).toEqual({
      case: `clarify_${reason}`,
      reply: { mode: "fixed", text: "clarify", language: "ta" },
      kbMisses: 0,
    });
  });

  it("the language model could not be reached is the safe fallback", () => {
    expect(planReply(input({ understood: { status: "model_unavailable" } }))).toEqual({ case: "model_unavailable", reply: { mode: "fixed", text: "fallback", language: "en" }, kbMisses: 0 });
  });

  it("no usable pack is the safe fallback and a handoff, so a person looks at it", () => {
    expect(planReply(input({ understood: { status: "no_pack" } }))).toEqual({
      case: "no_pack",
      reply: { mode: "fixed", text: "fallback", language: "en" },
      handoff: { trigger: "stuck", priority: "normal" },
      kbMisses: 0,
    });
  });
});

describe("the turn's time ran out", () => {
  it("is the safe fallback, whatever else the step found", () => {
    for (const result of [understood(found), understood({ outcome: "none" }), understood({ outcome: "skipped" }), { status: "model_unavailable" } as UnderstandResult]) {
      const plan = planReply(input({ understood: result, deadlineExceeded: true, previousMisses: 1 }));
      expect(plan).toEqual({ case: "deadline", reply: { mode: "fixed", text: "fallback", language: "en" }, kbMisses: 1 });
    }
  });
});

describe("the language of a fixed line", () => {
  it("is the message's language, else the contact's, else English", () => {
    expect(planReply(input({ understood: understood({ outcome: "none" }, { language: "hi" }), contactLanguage: "ta" })).reply).toMatchObject({ language: "hi" });
    expect(planReply(input({ understood: understood({ outcome: "none" }, { language: "other" }), contactLanguage: "ta" })).reply).toMatchObject({ language: "ta" });
    expect(planReply(input({ understood: understood({ outcome: "none" }, { language: "ml" }), contactLanguage: null })).reply).toMatchObject({ language: "en" });
    expect(planReply(input({ understood: { status: "model_unavailable" }, contactLanguage: "ta" })).reply).toMatchObject({ language: "ta" });
  });
});

// Step 5, qualifying (Day 3): the model's reply also asks for the next missing details, and a lead that is certainly not a fit is
// closed kindly. The facts come from understandTurn's qualification; with none, nothing here applies (every test above).
describe("qualifying the lead", () => {
  const ASK = [
    { key: "location", label: "Preferred area" },
    { key: "timeline", label: "Timeline", options: ["0-3m", "3-6m", "6m+"] },
  ];
  const qualification = (over: Partial<NonNullable<Extract<UnderstandResult, { status: "understood" }>["qualification"]>> = {}) => ({
    score: 30,
    temperature: "cold" as const,
    ask: ASK,
    missingRequired: ["location", "timeline"],
    readyForSlots: false,
    hardFail: null,
    ...over,
  });
  const withQualification = (retrieval: Retrieval, q = qualification(), over: Parameters<typeof summary>[0] = {}): UnderstandResult => ({ status: "understood", summary: summary(over), retrieval, qualification: q });

  it("an answer from the knowledge base also asks for the next missing details, with their labels", () => {
    const plan = planReply(input({ understood: withQualification(found) }));
    expect(plan).toMatchObject({
      case: "answered_from_kb",
      reply: { mode: "model", action: { kind: "answer_and_ask", question: "What is the price of a 2BHK?", askFields: ["location", "timeline"] }, ask: ASK },
    });
  });

  it("details given with no question are acknowledged with a request for the next ones (ask_fields)", () => {
    const plan = planReply(input({ understood: withQualification({ outcome: "skipped" }, qualification(), { intent: "give_details", hasQuestion: false }), question: null }));
    expect(plan).toMatchObject({ case: "ask_details", kbMisses: 0, reply: { mode: "model", action: { kind: "ask_fields", askFields: ["location", "timeline"] }, ask: ASK, facts: [] } });
  });

  it("with everything required in, nothing is asked and the reply is as before", () => {
    const done = qualification({ ask: [], missingRequired: [], temperature: "hot", score: 75, readyForSlots: true });
    const plan = planReply(input({ understood: withQualification({ outcome: "skipped" }, done, { intent: "give_details", hasQuestion: false }), question: null }));
    expect(plan).toMatchObject({ case: "nothing_to_look_up", reply: { mode: "model", action: { kind: "answer_and_ask", question: "", askFields: [] } } });
    expect(planReply(input({ understood: withQualification(found, done) })).reply).toMatchObject({ action: { askFields: [] } });
  });

  it("never asks more than two things at once, whatever the qualification holds", () => {
    const many = qualification({ ask: [...ASK, { key: "c", label: "C" }, { key: "d", label: "D" }] });
    const plan = planReply(input({ understood: withQualification(found, many) }));
    expect((plan.reply as { action: { askFields: string[] }; ask: unknown[] }).action.askFields).toHaveLength(2);
    expect((plan.reply as { ask: unknown[] }).ask).toHaveLength(2);
  });

  it("a knowledge-base miss, an outage or a handover do not ask anything: the fixed lines stay as they are", () => {
    expect(planReply(input({ understood: withQualification({ outcome: "none" }) })).reply).toEqual({ mode: "fixed", text: "fallback", language: "en" });
    expect(planReply(input({ understood: withQualification({ outcome: "unavailable" }) })).reply).toEqual({ mode: "fixed", text: "fallback", language: "en" });
    expect(planReply(input({ understood: withQualification(found, qualification(), { intent: "talk_to_human" }) })).reply).toMatchObject({ mode: "fixed", text: "handoff" });
  });

  it("an off-topic message is declined, not asked a question", () => {
    const plan = planReply(input({ understood: withQualification({ outcome: "skipped" }, qualification(), { intent: "off_topic", hasQuestion: false }) }));
    expect(plan.reply).toMatchObject({ action: { kind: "decline_off_topic" } });
    expect((plan.reply as { ask?: unknown }).ask).toBeUndefined();
  });

  describe("a lead that is certainly not a fit", () => {
    const failed = qualification({ temperature: "disqualified", score: 0, ask: [], missingRequired: ["location"], hardFail: { field: "budget", rule: "below min_project_price" } });

    it("is closed kindly when the customer has just given the detail that fails it and asked nothing else", () => {
      const plan = planReply(input({ understood: withQualification({ outcome: "skipped" }, failed, { intent: "give_details", hasQuestion: false, fieldKeys: ["budget"] }), question: null }));
      expect(plan).toMatchObject({ case: "disqualified", kbMisses: 0, reply: { mode: "model", action: { kind: "close_disqualified", reason: "The business has nothing that fits what the customer is looking for." }, facts: ["The business has nothing that fits what the customer is looking for."] } });
      expect(plan.handoff).toBeUndefined();
    });

    it("is not closed again on a later message that gives nothing new about it", () => {
      const plan = planReply(input({ understood: withQualification({ outcome: "skipped" }, failed, { intent: "greeting", hasQuestion: false, fieldKeys: [] }), question: null }));
      expect(plan.case).toBe("nothing_to_look_up");
    });

    it("a question the knowledge base can answer is still answered, and nothing is asked", () => {
      const plan = planReply(input({ understood: withQualification(found, failed, { fieldKeys: ["budget"] }) }));
      expect(plan).toMatchObject({ case: "answered_from_kb", reply: { action: { kind: "answer_and_ask", askFields: [] } } });
    });
  });
});
