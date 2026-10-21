// The check before a reply is sent (docs/handover.md, "Post-check before sending"): every ₹ amount, date and time in the
// reply must appear in the facts the model was given; the reply must fit the cap (600 characters) and ask at most
// two questions. Plain code, no model: a model that invents a price or a time is caught here, whatever the customer
// said to it.
//
// What counts as a value in a reply:
// - an AMOUNT: a number with a currency mark (₹, Rs, INR, rupees, /-, Tamil ரூ and ரூபாய், Hindi रु and रुपये, and $ € £ USD,
//   so a price in the wrong currency is caught too), or with a unit (lakh, lac, crore, thousand, k, L, Cr; Tamil லட்சம் and கோடி,
//   also with a Tamil ending such as லட்சத்தில்; Hindi लाख and करोड़). Compared by value in rupees, so "₹85 lakh", "85L", "₹85,00,000" and "₹8500000" are the same amount;
//   "80-90 lakh" is two amounts. Tamil and Hindi numerals count as digits. A plain number with no ₹ and no unit
//   (2BHK, 950 sq ft, a floor, a phone extension) is not an amount.
// - a DATE: a day and a month name ("10 Oct", "Oct 10th 2026"), dd/mm or dd/mm/yyyy, or yyyy-mm-dd. Compared by month and
//   day (and by year when both have one). A weekday or "tomorrow" alone is not checked: it names no date to compare.
// - a TIME: "5 pm", "5:30 pm", "17:00", or an hour with மணி / baje / बजे. Compared by hour and minute; am/pm only when
//   both say it.
// Month names in Tamil or Hindi are not read: a date written that way is not checked (the facts for slots come from
// code, in English labels).
//
// A reply that talks ABOUT the prompt is a "leak" (Day 7, Finding 4, found by the live run: a reply that began "The task says the customer writes in a language other than
// English..."): meta-commentary such as "the task", "my instructions", "the system prompt", "according to the facts", "the customer writes", or one of the prompt's own tag names
// (ENGLISH ONLY: a leak in Tamil, Hindi or any other language is not caught), or a run of 8 or more consecutive words copied from the FIXED RULES text the model was given. The
// run is compared with the rules ONLY, never with the business block, the facts or a knowledge-base chunk: a correct reply may quote the business's own FAQ or price text.
// A paraphrase of the rules is not caught either.
//
// The check is strict on purpose: a reply that repeats a figure the customer gave ("your ₹80L budget") but that is not in
// the facts fails too. The reply is then written again once, and then the safe fallback is sent.

export const REPLY_MAX_CHARS = 600;
export const MAX_QUESTIONS = 2;

export type PostCheckProblem = "amount" | "date" | "time" | "length" | "questions" | "empty" | "leak";
export interface PostCheck {
  ok: boolean;
  problems: PostCheckProblem[];
}

const UNIT_WORDS = String.raw`lakhs?|lacs?|lac|crores?|crs?|cr|thousand|லட்ச[\p{L}\p{M}]*|கோடி[\p{L}\p{M}]*|लाख|करोड़|करोड`;
// A currency mark in front of a number: ₹ and the words for rupees in English, Tamil and Hindi, and the common foreign signs.
const CURRENCY_BEFORE = String.raw`(?:₹|\$|€|£|(?<![\p{L}])(?:rs\.?|inr|usd|rupees?|ரூபாய்|ரூ\.?|रुपये|रुपए|रु\.?))`;
const CURRENCY_AFTER = String.raw`(?:rupees?|usd|dollars?|euros?|ரூபாய்|रुपये|रुपए|/-)`;
const MULTIPLIER: Record<string, number> = { lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, l: 1e5, crore: 1e7, crores: 1e7, cr: 1e7, crs: 1e7, k: 1e3, thousand: 1e3, "लाख": 1e5, "करोड़": 1e7, "करोड": 1e7 };
function multiplierOf(unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith("லட்ச")) return 1e5;
  if (u.startsWith("கோடி")) return 1e7;
  return MULTIPLIER[u] ?? 1;
}
const NUM = String.raw`\d[\d,]*(?:\.\d+)?`;

/** ASCII digits for Tamil (௦-௯) and Devanagari (०-९) numerals, and full-width forms. */
export function asciiDigits(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[௦-௯]/g, (c) => String(c.charCodeAt(0) - 0x0be6))
    .replace(/[०-९]/g, (c) => String(c.charCodeAt(0) - 0x0966));
}

const toNumber = (text: string) => Number.parseFloat(text.replace(/,/g, ""));
const withUnit = (value: number, unit: string | undefined) => Math.round(value * (unit ? multiplierOf(unit) : 1));

/** The amounts in a text, in rupees. */
export function amountsIn(rawText: string): Set<number> {
  let text = asciiDigits(rawText);
  const found = new Set<number>();

  // A range with one unit at the end ("80-90 lakh", "₹80-90L"): both ends carry the unit.
  const range = new RegExp(String.raw`(?:${CURRENCY_BEFORE})?\s*(${NUM})\s*(?:-|–|—|to)\s*(?:${CURRENCY_BEFORE})?\s*(${NUM})\s*(${UNIT_WORDS}|k|l)(?![\p{L}\d])`, "giu");
  text = text.replace(range, (_m, a: string, b: string, unit: string) => {
    found.add(withUnit(toNumber(a), unit));
    found.add(withUnit(toNumber(b), unit));
    return " ";
  });

  // With a currency mark: ₹85 lakh, Rs. 85,00,000, INR 85L, ₹8500000.
  const currency = new RegExp(String.raw`${CURRENCY_BEFORE}\s*(${NUM})(?:\s*(${UNIT_WORDS}|k|l)(?![\p{L}\d]))?`, "giu");
  text = text.replace(currency, (_m, n: string, unit: string | undefined) => {
    found.add(withUnit(toNumber(n), unit));
    return " ";
  });
  // With the mark after the number: 5000 rupees, 85 lakh rupees, 5000/-.
  const after = new RegExp(String.raw`(?<![\d.,])(${NUM})\s*(?:(${UNIT_WORDS})\s*)?${CURRENCY_AFTER}`, "giu");
  text = text.replace(after, (_m, n: string, unit: string | undefined) => {
    found.add(withUnit(toNumber(n), unit));
    return " ";
  });

  // With a unit and no mark: 85 lakh, 1.2 crore, 80L, 50k.
  const spaced = new RegExp(String.raw`(?<![\d.,])(${NUM})\s*(${UNIT_WORDS})(?![\p{L}])`, "giu");
  for (const m of text.matchAll(spaced)) found.add(withUnit(toNumber(m[1]), m[2]));
  const attached = /(?<![\d.,])(\d[\d,]*(?:\.\d+)?)(l|k)(?![\p{L}\d])/giu;
  for (const m of text.matchAll(attached)) found.add(withUnit(toNumber(m[1]), m[2]));
  // A capital L, K or Cr after a space ("85 L", "50 K"): only capitals, so "5 l of paint" is not an amount.
  const capital = /(?<![\d.,])(\d[\d,]*(?:\.\d+)?)\s+(L|K|Cr)(?![\p{L}\d])/gu;
  for (const m of text.matchAll(capital)) found.add(withUnit(toNumber(m[1]), m[2]));

  found.delete(Number.NaN);
  return found;
}

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const MONTH_NUMBER = (name: string) => ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(name.slice(0, 3).toLowerCase()) + 1;

export interface DateValue {
  month: number;
  day: number;
  year?: number;
}
const validDate = (month: number, day: number) => month >= 1 && month <= 12 && day >= 1 && day <= 31;
const fullYear = (year: string | undefined) => (year === undefined ? undefined : year.length === 2 ? 2000 + Number(year) : Number(year));

export function datesIn(rawText: string): DateValue[] {
  const text = asciiDigits(rawText);
  const found: DateValue[] = [];
  const add = (month: number, day: number, year?: string) => {
    if (validDate(month, day)) found.push({ month, day, year: fullYear(year) });
  };
  for (const m of text.matchAll(new RegExp(String.raw`(?<![\d/-])(\d{1,2})(?:st|nd|rd|th)?\s*(?:of\s+)?(${MONTHS})\b\.?(?:,?\s*(\d{4}))?`, "giu"))) add(MONTH_NUMBER(m[2]), Number(m[1]), m[3]);
  // "Oct 11" is a date, but the number after a month is NOT a day when it starts a time ("11 Oct 5:30 pm", "11 Oct 10 am": the 5 and the 10 are hours).
  const startsATime = String.raw`(?!\s*(?::\s*\d|[ap]\.?\s*m\b))`;
  for (const m of text.matchAll(new RegExp(String.raw`\b(${MONTHS})\b\.?\s*(\d{1,2})(?:st|nd|rd|th)?\b${startsATime}(?:,?\s*(\d{4}))?`, "giu"))) add(MONTH_NUMBER(m[1]), Number(m[2]), m[3]);
  for (const m of text.matchAll(/(?<![\d/-])(\d{4})-(\d{2})-(\d{2})(?![\d-])/g)) add(Number(m[2]), Number(m[3]), m[1]);
  // dd/mm and dd/mm/yyyy (India); dd-mm-yyyy only with a year, so a range like "1-2 BHK" is not a date
  for (const m of text.matchAll(/(?<![\d/.-])(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?![\d/])/g)) {
    if (m[1] === "24" && m[2] === "7" && m[3] === undefined) continue; // "open 24/7" is not the 24th of July
    add(Number(m[2]), Number(m[1]), m[3]);
  }
  for (const m of text.matchAll(/(?<![\d/.-])(\d{1,2})-(\d{1,2})-(\d{2,4})(?![\d-])/g)) add(Number(m[2]), Number(m[1]), m[3]);
  return found;
}

export interface TimeValue {
  hour12: number; // 0-11
  minute: number;
  /** am or pm when the text said so (or a 24-hour time made it plain), else null */
  period: "am" | "pm" | null;
}

export function timesIn(rawText: string): TimeValue[] {
  const text = asciiDigits(rawText);
  const found: TimeValue[] = [];
  const add = (hour: number, minute: number, period: "am" | "pm" | null) => {
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return;
    found.push({ hour12: hour % 12, minute, period });
  };
  for (const m of text.matchAll(/(?<![\d:.])(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/giu)) {
    const hour = Number(m[1]);
    if (hour < 1 || hour > 12) continue;
    add(hour, m[2] === undefined ? 0 : Number(m[2]), m[3].toLowerCase().startsWith("a") ? "am" : "pm");
  }
  // Indian style, "5.30 pm" (only with am/pm: a bare "5.30" is a number)
  for (const m of text.matchAll(/(?<![\d:.])(\d{1,2})\.(\d{2})\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/giu)) {
    const hour = Number(m[1]);
    if (hour >= 1 && hour <= 12) add(hour, Number(m[2]), m[3].toLowerCase().startsWith("a") ? "am" : "pm");
  }
  for (const m of text.matchAll(/(?<![\d:.])([01]?\d|2[0-3]):([0-5]\d)(?!\d)(?!\s*(?:a\.?m|p\.?m))/giu)) {
    const hour = Number(m[1]);
    add(hour, Number(m[2]), hour >= 13 ? "pm" : hour === 0 ? "am" : null);
  }
  for (const m of text.matchAll(/(?<![\d:.])(\d{1,2})\s*(?:மணிக்கு|மணி|mani|baje|बजे)/giu)) add(Number(m[1]), 0, null);
  return found;
}

const sameDate = (a: DateValue, b: DateValue) => a.month === b.month && a.day === b.day && (a.year === undefined || b.year === undefined || a.year === b.year);
const sameTime = (a: TimeValue, b: TimeValue) => a.hour12 === b.hour12 && a.minute === b.minute && (a.period === null || b.period === null || a.period === b.period);

/** How many consecutive words copied from the fixed rules make a leak. */
export const LEAK_RUN_WORDS = 8;

/** Phrases about the prompt itself, in English. Word-bounded, any letter case. A reply written TO the customer has no reason to say any of them. */
const META_COMMENTARY: RegExp[] = [
  /<\/?(?:task|facts|conversation|message|ask|customer_message|recent_messages|already_collected)\b/i,
  // Narrow on purpose: "task lighting", "follow these instructions to reach the site", "the facts sheet" and "the society's guidelines" are ordinary replies.
  /\b(?:the|this|per the) task (?:says|is|asks|tells|states|was|here)\b/i,
  /\bper the task\b/i,
  /\bmy (?:instructions?|guidelines|system prompt|prompt|rules)\b/i,
  /\bsystem (?:prompt|message)\b/i,
  /\bthe (?:prompt|instructions?) (?:says?|tells?|states?)\b/i,
  /\b(?:according to|per) the facts\b/i,
  /\bthe facts (?:say|state|show|given|provided)\b/i,
  /\bI(?:'m|’m| am| was|'ve been|’ve been| have been) (?:told|instructed|programmed|configured) (?:to|not to)\b/i,
  /\bthe (?:customer|user)(?:'s|’s)? (?:writes|wrote|is asking|says|latest)\b/i,
];

const wordsOf = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const runsOf = (words: string[]): string[] => (words.length < LEAK_RUN_WORDS ? [] : Array.from({ length: words.length - LEAK_RUN_WORDS + 1 }, (_, i) => words.slice(i, i + LEAK_RUN_WORDS).join(" ")));
/** The rules text is the same for every reply: its runs are worked out once. */
const rulesRuns = new Map<string, Set<string>>();

function leaks(reply: string, rules: string | undefined): boolean {
  if (META_COMMENTARY.some((pattern) => pattern.test(reply))) return true;
  if (!rules) return false;
  let known = rulesRuns.get(rules);
  if (!known) {
    known = new Set(runsOf(wordsOf(rules)));
    rulesRuns.set(rules, known);
  }
  return runsOf(wordsOf(reply)).some((run) => known.has(run));
}

/** Whether the reply is fit to send, and if not, what is wrong with it. `rules` is the fixed rules text the model was given (the first system block), for the copied-run check. */
export function checkReply(reply: string, facts: readonly string[], options: { rules?: string } = {}): PostCheck {
  const problems: PostCheckProblem[] = [];
  if (reply.trim() === "") problems.push("empty");
  if ([...reply].length > REPLY_MAX_CHARS) problems.push("length");
  if ((reply.match(/[?？]/g) ?? []).length > MAX_QUESTIONS) problems.push("questions");

  const factText = facts.join("\n");
  const factAmounts = amountsIn(factText);
  if ([...amountsIn(reply)].some((amount) => !factAmounts.has(amount))) problems.push("amount");
  const factDates = datesIn(factText);
  if (datesIn(reply).some((d) => !factDates.some((f) => sameDate(d, f)))) problems.push("date");
  const factTimes = timesIn(factText);
  if (timesIn(reply).some((t) => !factTimes.some((f) => sameTime(t, f)))) problems.push("time");
  if (leaks(reply, options.rules)) problems.push("leak");
  return { ok: problems.length === 0, problems };
}
