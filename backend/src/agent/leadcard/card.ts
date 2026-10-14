import { z } from "zod";
import { maskPhone } from "../../channels/whatsapp/phone";
import { cleanDisplayText, refusesAreaText, refusesDisplayText } from "../scoring/area-text";

// The lead card (docs/handover.md, module 6; Raja, 11 Oct): everything staff need to pick up a chat WITHOUT reading it. Who the customer is,
// what they want, how promising (hot, warm or cold), why the assistant is calling a person, a short summary, what to do next, a reply ready to
// send, and, when they asked for a discount, what they asked for. Built by `buildLeadCard` (build.ts); this file is the part that needs no model:
// the shape, the plain-words reasons, and the safe summary written by code when the model cannot be used.
//
// Staff alerts, lead cards and staff replies cost no credits (docs/handover.md, module 7).

export type CardAnswer = { label: string; value: string | number | boolean };

/** What is known about a lead before any words are written. All of it comes from the database, none of it from a model. */
export interface CardFacts {
  contact: { name: string | null; phone: string; language: string | null };
  /** The lead's answers, labelled by the business's pack, in the pack's order. */
  fields: CardAnswer[];
  score: number | null;
  temperature: "hot" | "warm" | "cold" | "disqualified" | null;
  /** The next booking as the customer would read it ("Site visit, Sun 11 Oct, 3:00 pm · Anand"), or null. */
  booking: string | null;
  /** The handoff trigger, or null when staff opened the lead themselves. */
  trigger: string | null;
  priority: "high" | "normal" | null;
  sentiment: "positive" | "neutral" | "negative" | "angry";
  source: string;
  owner: string | null;
}

/** The words of the card: written by the model when it can be, by code when it cannot. */
export interface CardWords {
  need: string;
  /** Two to five short lines, separated by a line break. */
  summary: string;
  nextStep: string;
  /** A reply staff can send as it is, in the customer's language, or null. */
  suggestedReply: string | null;
  /** What the customer asked for in a discount request ("Asked for ₹70 lakh instead of ₹78 lakh"), or null. */
  discount: string | null;
}

const LINE_LIMIT = 220;
const SUMMARY_LIMIT = 700;
const REPLY_LIMIT = 600;

export const LeadCard = z.object({
  contact: z.object({ name: z.string().nullable(), phone: z.string(), phoneMasked: z.string(), language: z.string().nullable() }),
  need: z.string().max(LINE_LIMIT),
  languageNote: z.string(),
  source: z.string(),
  answers: z.array(z.string().max(LINE_LIMIT)),
  score: z.number().nullable(),
  temperature: z.enum(["hot", "warm", "cold", "disqualified"]).nullable(),
  /** Hot lead: the score says so, or the alert was raised because it turned hot. */
  isHot: z.boolean(),
  booking: z.string().nullable(),
  trigger: z.string().nullable(),
  priority: z.enum(["high", "normal"]).nullable(),
  sentiment: z.enum(["positive", "neutral", "negative", "angry"]),
  summary: z.string().max(SUMMARY_LIMIT),
  nextStep: z.string().max(LINE_LIMIT),
  suggestedReply: z.string().max(REPLY_LIMIT).nullable(),
  discount: z.string().max(LINE_LIMIT).nullable(),
  owner: z.string().nullable(),
  /** The words were written by the model (true) or by code (false). Staff can read the chat either way. */
  aiWritten: z.boolean(),
});
export type LeadCard = z.infer<typeof LeadCard>;

const TRIGGER_TEXT: Record<string, string> = {
  asked_human: "Asked to talk to a person",
  complaint: "Unhappy with the service",
  negotiation: "Asked for a discount",
  hot_lead: "Hot lead: ready to move",
  kb_gap: "Asked something the assistant could not answer",
  stuck: "The assistant could not continue",
  credits_exhausted: "Out of credits: the assistant has paused",
  opt_out: "Asked to stop the messages",
};
const UNKNOWN_TRIGGER = "The assistant asked for a person to look at this chat";

export function triggerText(trigger: string | null): string | null {
  if (trigger === null) return null;
  return Object.hasOwn(TRIGGER_TEXT, trigger) ? TRIGGER_TEXT[trigger] : UNKNOWN_TRIGGER;
}

const NEXT_STEP: Record<string, string> = {
  asked_human: "Reply to the customer and find out what they need.",
  complaint: "Say sorry and call the customer today to put it right.",
  negotiation: "Decide whether any discount is possible, then reply with a clear answer.",
  hot_lead: "Message or call now to confirm a site visit.",
  kb_gap: "Answer the customer's question, then add it to the knowledge base.",
  stuck: "Check the business setup, then reply to the customer.",
  credits_exhausted: "Top up credits so the assistant can reply again, and answer this customer yourself.",
  opt_out: "Do not message this customer again.",
};
const DEFAULT_NEXT_STEP = "Read the last messages and reply to the customer.";

export function nextStepFor(trigger: string | null): string {
  return trigger !== null && Object.hasOwn(NEXT_STEP, trigger) ? NEXT_STEP[trigger] : DEFAULT_NEXT_STEP;
}

const LANGUAGE_NOTE: Record<string, string> = {
  en: "Writes in English",
  ta: "Writes in Tamil",
  "ta-en": "Writes in Tanglish (Tamil in English letters)",
  hi: "Writes in Hindi",
  ml: "Writes in Malayalam",
};

export function languageNote(language: string | null): string {
  return language !== null && Object.hasOwn(LANGUAGE_NOTE, language) ? LANGUAGE_NOTE[language] : "Language not known yet";
}

const oneLine = (text: string, max = LINE_LIMIT) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const showValue = (value: string | number | boolean): string => (typeof value === "boolean" ? (value ? "yes" : "no") : String(value));

/** A run of this many digits in a value or in words shown to staff is a phone number (a 6-digit pincode and an amount such as 1,20,00,000 are not). */
const PHONE_DIGITS = 10;
/** The labels of a detail that is a place: held to the strict place cleaner (no link, no @, no 7-digit run, only plain characters). */
const PLACE_LABEL = /\b(?:location|locality|pincode|pin code|pin|place)\b|\barea\b/i;
/** ...except a size: "Area in sq ft" is a number, not a place. */
const SIZE_LABEL = /\b(?:sq|sqft|square|size|ft|feet|meters?|metres?|sqm)\b/i;
const isPlaceLabel = (label: string): boolean => PLACE_LABEL.test(label) && !SIZE_LABEL.test(label);

type ShownAnswer = { label: string; value: string; hidden: boolean };

/** What staff see of one answer: its text, or "hidden" when it carries a link, an "@" or a phone number (a place: or anything outside plain characters). */
function shownAnswer(f: CardAnswer): ShownAnswer {
  const value = showValue(f.value).trim();
  if (typeof f.value !== "string" || value === "") return { label: f.label, value, hidden: false };
  const hidden = isPlaceLabel(f.label) ? refusesAreaText(value) : refusesDisplayText(value, PHONE_DIGITS, true);
  return { label: f.label, value: hidden ? "" : value, hidden };
}

/** One line per answer, "Budget: 60L", in the pack's order. An empty answer is left out; one with a link, an "@" or a phone number says "not shown". */
export function answerLines(fields: CardAnswer[]): string[] {
  return fields
    .map(shownAnswer)
    .filter((f) => f.hidden || f.value !== "")
    .map((f) => oneLine(f.hidden ? `${f.label}: not shown` : `${f.label}: ${f.value}`));
}

/** What the customer wants, from their answers alone: area first, then the rest. Used when the model's words are not. */
function needFrom(fields: CardAnswer[]): string {
  // A yes-or-no answer ("Are you the buyer? yes") is not something the customer is looking at.
  const values = fields
    .filter((f) => typeof f.value !== "boolean")
    .map(shownAnswer)
    .map((f) => ({ label: f.label.toLowerCase(), value: f.value }))
    .filter((f) => f.value !== "");
  if (values.length === 0) return "No details collected yet";
  const area = values.find((f) => /area|location|place/.test(f.label));
  const budget = values.find((f) => /budget/.test(f.label));
  const rest = values.filter((f) => f !== area && f !== budget);
  const parts = [...(area ? [area.value] : []), ...rest.map((f) => f.value), ...(budget ? [`budget ${budget.value}`] : [])];
  return oneLine(`Looking at: ${parts.join(", ")}`);
}

/**
 * The words of a card with no model: what they want, why staff are being told, and where the booking stands. Every word is from the facts, so it
 * is never wrong, only plain.
 */
export function codeSummary(facts: CardFacts): Pick<CardWords, "need" | "summary" | "nextStep"> {
  const need = needFrom(facts.fields);
  const reason = triggerText(facts.trigger);
  const lines = [need, ...(reason ? [`${reason}.`] : []), facts.booking ? `Booking: ${facts.booking}.` : "No visit booked yet."];
  return { need, summary: lines.join("\n"), nextStep: nextStepFor(facts.trigger) };
}

export function assembleCard(facts: CardFacts, modelWords: CardWords & { aiWritten: boolean }): LeadCard {
  // A summary, need, next step or discount that carries a link, an "@" or a phone number (from the chat, or from a value that slipped through) is replaced by the words written by code, and
  // a suggested reply with one is dropped (staff would send it as it is): this card also feeds the staff WhatsApp alerts (notify/staff-alerts.ts).
  // Each line on its own: digits at the end of one line and the start of the next are not one number.
  const refusesWords = (text: string) => text.split("\n").some((line) => refusesDisplayText(line, PHONE_DIGITS, true));
  const unsafe = [modelWords.need, modelWords.summary, modelWords.nextStep, modelWords.discount ?? ""].some(refusesWords);
  const words: CardWords & { aiWritten: boolean } = unsafe
    ? { ...codeSummary(facts), discount: null, suggestedReply: null, aiWritten: false }
    : { ...modelWords, suggestedReply: modelWords.suggestedReply !== null && refusesWords(modelWords.suggestedReply) ? null : modelWords.suggestedReply };
  return {
    // The name is the customer's profile name: a link, an "@" or a phone number in it is not shown (null: the screens show the masked number, as for a contact with no name). Their number stays: staff call it.
    contact: { name: facts.contact.name === null ? null : cleanDisplayText(facts.contact.name, 40, 7), phone: facts.contact.phone, phoneMasked: maskPhone(facts.contact.phone), language: facts.contact.language },
    need: oneLine(words.need),
    languageNote: languageNote(facts.contact.language),
    source: facts.source,
    answers: answerLines(facts.fields),
    score: facts.score,
    temperature: facts.temperature,
    isHot: facts.temperature === "hot" || facts.trigger === "hot_lead",
    booking: facts.booking,
    trigger: triggerText(facts.trigger),
    priority: facts.priority,
    sentiment: facts.sentiment,
    summary: words.summary,
    nextStep: words.nextStep,
    suggestedReply: words.suggestedReply,
    discount: words.discount,
    owner: facts.owner,
    aiWritten: words.aiWritten,
  };
}
