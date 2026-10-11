import { z } from "zod";
import { stripUnsafeCharacters } from "../../lib/text";
import { LlmError, type LlmClient } from "../llm/anthropic";
import { parseJsonObject } from "../llm/json";
import { asciiDigits } from "../pipeline/postcheck";
import { buildLeadCardMessages, buildLeadCardSystem, LEADCARD_PROMPT, type HistoryMessage } from "../prompts/leadcard_v1";
import { answerLines, codeSummary, triggerText, type CardFacts, type CardWords } from "./card";

// The words of the lead card: written by the model, CHECKED by code. A card is useful because staff can act on it without reading the chat,
// so it must never state what the chat does not support. The model's answer is therefore checked like any outside input:
//   - it must be one JSON object with the fields asked for, short enough to read at a glance;
//   - every number it writes must be a number that is in the chat, in the lead's details or in the booking (it may not work out a sum, a
//     percentage or a price of its own), and it may not add a link;
//   - if the summary, the need or the next step fails that, the whole card is the plain one built from the facts (codeSummary): never wrong, only plain;
//   - the suggested reply and the discount line stand or fall on their own: a reply that fails is dropped (null), the rest of the card stays.
// A model that is down, slow or wrong therefore never stops a card from being made.

const TAG = "[leadcard]";
const LINE_MAX = 220;
const SUMMARY_LINES = 5;
const REPLY_MAX = 400;
const MAX_QUESTIONS = 2;

const Answer = z.object({
  need: z.string(),
  summary: z.string(),
  nextStep: z.string(),
  suggestedReply: z.string().nullable().optional(),
  discount: z.string().nullable().optional(),
});

/** One line: no control characters, no run of spaces. */
const tidy = (text: string): string => stripUnsafeCharacters(text).replace(/\s+/g, " ").trim();

/** Every number in a text, as digits and without separators: "₹7,800,000" and "78.5" are one number each. Single digits are ignored (a count, a day). */
function numbersIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of asciiDigits(text).matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const number = match[0].replace(/,/g, "");
    if (number.length >= 2) found.add(number);
  }
  return found;
}

const LINK = /https?:\/\/|www\./i;

/** Whether everything the model wrote is something the chat, the lead or the booking said: no number or link of its own. */
function grounded(text: string, known: Set<string>, source: string): boolean {
  for (const number of numbersIn(text)) if (!known.has(number)) return false;
  return !LINK.test(text) || LINK.test(source);
}

/** The model's words as a card, or null when they are not good enough to use. */
function accept(answer: z.infer<typeof Answer>, known: Set<string>, source: string): CardWords | null {
  const need = tidy(answer.need);
  const nextStep = tidy(answer.nextStep);
  const lines = stripUnsafeCharacters(answer.summary)
    .split(/\r?\n/)
    .map(tidy)
    .filter((l) => l !== "")
    .slice(0, SUMMARY_LINES);
  if (need === "" || nextStep === "" || lines.length === 0) return null;
  if (need.length > LINE_MAX || nextStep.length > LINE_MAX || lines.some((l) => l.length > LINE_MAX)) return null;
  const summary = lines.join("\n");
  if (![need, summary, nextStep].every((text) => grounded(text, known, source))) return null;

  const reply = answer.suggestedReply ? tidy(answer.suggestedReply) : "";
  const suggestedReply = reply !== "" && reply.length <= REPLY_MAX && (reply.match(/\?/g)?.length ?? 0) <= MAX_QUESTIONS && grounded(reply, known, source) ? reply : null;
  const asked = answer.discount ? tidy(answer.discount) : "";
  const discount = asked !== "" && asked.length <= LINE_MAX && grounded(asked, known, source) ? asked : null;
  return { need, summary, nextStep, suggestedReply, discount };
}

export interface WriteCardWordsInput {
  tenantId: string;
  conversationId: string;
  llm: LlmClient;
  facts: CardFacts;
  /** The conversation so far, oldest first. */
  history: HistoryMessage[];
  signal?: AbortSignal;
}

/** The words of the card. Never throws: a model that cannot be used gives the plain words. */
export async function writeCardWords({ tenantId, conversationId, llm, facts, history, signal }: WriteCardWordsInput): Promise<CardWords & { aiWritten: boolean }> {
  const plain = { ...codeSummary(facts), suggestedReply: null, discount: null, aiWritten: false };
  try {
    const answers = answerLines(facts.fields);
    const messages = buildLeadCardMessages({
      lead: { answers, temperature: facts.temperature, score: facts.score, booking: facts.booking, reason: triggerText(facts.trigger), language: facts.contact.language },
      history,
    });
    const result = await llm.complete({ role: "summary", tenantId, conversationId, prompt: LEADCARD_PROMPT, system: buildLeadCardSystem(), messages, signal });

    const parsed = parseJsonObject(result.text);
    const answer = parsed.ok ? Answer.safeParse(parsed.value) : null;
    if (!answer?.success) return plain;

    // What the model may state: what the chat, the lead and the booking say.
    const source = [...history.map((m) => m.text), ...answers, facts.booking ?? "", String(facts.score ?? "")].join("\n");
    const accepted = accept(answer.data, numbersIn(source), source);
    return accepted ? { ...accepted, aiWritten: true } : plain;
  } catch (error) {
    // The class only: never the customer's words.
    console.error(`${TAG} the card was written without the model (${error instanceof LlmError ? error.code : error instanceof Error ? error.name : "unknown"}; business ${tenantId})`);
    return plain;
  }
}
