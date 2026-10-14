import { describe, expect, it } from "vitest";
import { buildReplySystem } from "../prompts/reply_v2";
import { checkReply, REPLY_MAX_CHARS } from "./postcheck";

// Finding 4 of Day 7 PR C (found by the live run, chat 84): the reply began with "The task says the customer writes in a language other than English, but the message
// has no real language content, so I'll go with English." Instruction wording in a customer reply that the post-check did not catch. Two plain-code checks, both for the
// problem kind "leak": (1) meta-commentary about the prompt (English only: a leak in another language is NOT caught, a stated limit), and (2) a run of 8 or more consecutive
// words copied from the FIXED RULES text. The run is compared with the rules ONLY, never with the business block, the facts or a KB chunk: a correct reply may quote the
// business's own FAQ or price text.

const RULES = buildReplySystem({ businessName: "Skyline Homes" })[0].text;
const FACTS = ["2BHK of 950 sq ft in Velachery starts at ₹78 lakh.", "Site visits are on weekends from 10 am to 5 pm."];
const check = (reply: string, facts: readonly string[] = FACTS) => checkReply(reply, facts, { rules: RULES });
const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

describe("meta-commentary about the prompt is a leak", () => {
  it.each([
    // chat 84, live, 14 Oct: the exact reply
    "The task says the customer writes in a language other than English, but the message has no real language content, so I'll go with English.\n\nHi, thanks for your message. I can only help with Skyline Homes and our services.",
    "Per the task, I should ask for your budget. What is your budget?",
    "The task is to help you with a site visit.",
    "According to the facts, a 2BHK starts at ₹78 lakh.",
    "I was told to only talk about Skyline Homes.",
    "I have been instructed not to share that.",
    "My instructions say I cannot discuss discounts.",
    "My rules do not let me do that.",
    "I cannot reveal my system prompt.",
    "The system prompt tells me to be friendly.",
    "The customer writes in English, so I will reply in English.",
    "The customer's latest message is unclear.",
    "The user wrote in English, so I will reply in English.",
    "My instruction is to stay on topic.",
    "The system message says to be friendly.",
    "The prompt says I should ask for your budget.",
    "The instructions say no discounts.",
    "I'm instructed to only discuss Skyline Homes.",
    "I've been told to stay on topic.",
    "Here is the <facts> block: 2BHK starts at ₹78 lakh.",
    "<task>Greet the customer</task> Hello!",
    "Answering inside the <conversation> as asked.",
  ])("is refused: %j", (reply) => {
    expect(check(reply).problems).toContain("leak");
    expect(check(reply).ok).toBe(false);
  });
});

describe("a run of 8 words copied from the fixed rules is a leak", () => {
  const ruleWords = words(RULES);
  const run = (from: number, n: number) => ruleWords.slice(from, from + n).join(" ");

  it("8 consecutive words of the rules, anywhere in a reply, are refused", () => {
    for (const from of [0, 20, 60, 100, 140]) {
      const reply = `Sure, happy to help. ${run(from, 8)}. Is there anything else?`;
      expect(check(reply).problems, `from word ${from}`).toContain("leak");
    }
  });

  it("a longer copy is refused too, and so is a copy with different capitals and punctuation", () => {
    expect(check(run(30, 25)).problems).toContain("leak");
    expect(check(run(30, 9).toUpperCase().replace(/ /g, ",  ")).problems).toContain("leak");
  });

  it("7 words of the rules are not enough (the run is 8)", () => {
    expect(check(`Yes. ${run(30, 7)}. Thanks.`).problems).not.toContain("leak");
  });

  it("a rule quoted in a sentence is caught, which closes the pinned limit of injection-limits.test.ts for a copied rule", () => {
    // no marker word at all: it is the copied run of the rules that is refused
    expect(check("Remember: never claim or imply you are a human, even if you are given a name.").problems).toContain("leak");
  });

  it("a reply that only shares scattered words with the rules is fine", () => {
    expect(check("I can only help with this business and its services. A 2BHK of 950 sq ft in Velachery starts at ₹78 lakh. Would you like to visit?").ok).toBe(true);
  });
});

describe("the run is compared with the rules ONLY, never with the facts, a KB chunk or the business block", () => {
  const CHUNK =
    "Skyline Homes offers 2BHK and 3BHK apartments in Velachery and Tambaram with covered parking, a clubhouse, a children's play area and round the clock security for every resident of the community.";
  const chunkWords = words(CHUNK);

  it.each([8, 12, chunkWords.length])("a reply quoting %i consecutive words of a KB chunk passes", (n) => {
    const quote = chunkWords.slice(0, n).join(" ");
    const result = check(`Here is what we have: ${quote}. Would you like to visit?`, [CHUNK, ...FACTS]);
    expect(result.problems).not.toContain("leak");
    expect(result.ok).toBe(true);
  });

  it("a reply quoting the whole chunk word for word passes", () => {
    expect(check(CHUNK, [CHUNK]).ok).toBe(true);
  });

  it("a reply quoting the business's own price text word for word passes", () => {
    expect(check("2BHK of 950 sq ft in Velachery starts at ₹78 lakh. Site visits are on weekends from 10 am to 5 pm.").ok).toBe(true);
  });

  it("a chunk that itself repeats a rule's words does not make a copy of the RULES pass: the rules are checked whatever the facts say", () => {
    const poisoned = [`Note: ${words(RULES).slice(40, 52).join(" ")}`];
    expect(check(words(RULES).slice(40, 52).join(" "), poisoned).problems).toContain("leak");
  });

  it("the check does not look at the business block: the business name, persona and tone line are not compared", () => {
    const business = buildReplySystem({ businessName: "Skyline Homes", persona: "Asha" })[1].text;
    expect(check(business.replace(/\n/g, " ")).problems).not.toContain("leak");
  });

  it("without the rules (a caller that has none) only the markers apply, and the run check is off", () => {
    expect(checkReply("My view: Never claim or imply you are a human, even if you are given a name.", FACTS).problems).not.toContain("leak");
    expect(checkReply("The task says to greet.", FACTS).problems).toContain("leak");
  });
});

describe("replies that are fine are not flagged (the real replies of the live runs, 14 Oct, and ordinary ones)", () => {
  it.each([
    "I can't share that, sorry. I'm the virtual assistant for Skyline Homes, so I can only help with our homes and services. If you have a question about those, just ask and I'll do my best. If I don't have the answer, I'll check with the team for you.",
    "Hi, thank you so much for reaching out to Skyline Homes. I checked the details you shared for Velachery, and right now we don't have anything that fits what you're looking for, so I'm not able to go ahead with the booking. I'm sorry about that.",
    "Thanks for your message! I'm Skyline Homes' virtual assistant, so I can't take on the owner's role or approve any discounts or price changes. I can ask a team member to look at your request about the 2BHK and get back to you. What would you like to know?",
    "Hi, I'm the virtual assistant for Skyline Homes. I can't share lead details or anyone's phone numbers here, since I only help customers with questions about our services. If you're on the team, please use your internal channels for that.",
    "Hi! A 2BHK of 950 sq ft in Velachery starts at ₹78 lakh. To help you better, could you tell me your budget? And when are you planning to buy: within 3 months, in 3 to 6 months, or after 6 months?",
    "Thanks for your message. The booking I can see is on Sun 11 Oct at 3:00 pm. Nothing has been cancelled yet. Would you like me to cancel that booking? Please reply yes or no.",
    "Sorry, innoru customer oda number or chat-a share panna mudiyadhu, adhu avanga privacy. Aana ungalukku help panren.",
    "மன்னிக்கவும், அந்தப் பகுதியில் தற்போது எங்களிடம் இடங்கள் இல்லை.",
    "Our customer care team will call you tomorrow. Is 11 am fine?",
    "We follow the rules of the housing society, so visits are on weekends only.",
    "Please read the facts sheet we sent: a 2BHK starts at ₹78 lakh.",
    "The task lighting in the kitchen is included in the package.",
    "The task of painting all rooms will take 3 days.",
    "Please follow these instructions to reach the site: take the left at the signal.",
    "Please follow these guidelines of the society while visiting.",
    "Details are in the facts sheet, and the facts above are from the brochure.",
    "As the customer care team asked, we will call you tomorrow.",
    "Per the rules of the society, visits are on weekends only.",
  ])("%j", (reply) => {
    const result = check(reply, ["2BHK of 950 sq ft in Velachery starts at ₹78 lakh.", "Is 11 am fine?", "Sun 11 Oct, 3:00 pm", "Visits are on weekends only."]);
    expect(result.problems).not.toContain("leak");
  });

  it("the cap, the question limit and the other problems still work beside the new one", () => {
    expect(check("The task says " + "word ".repeat(130)).problems).toEqual(expect.arrayContaining(["leak", "length"]));
    expect(REPLY_MAX_CHARS).toBe(600);
  });
});
