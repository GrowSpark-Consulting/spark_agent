import { stripUnsafeCharacters } from "../../lib/text";

// The customer's own words for a place, as they may be put back in a reply to the customer or in a message to the business's staff (Day 7, PR C finding 2). It is text a
// stranger typed, so it passes a strict cleaner or is not shown at all. Plain code, no model.
//
// What it refuses: a link (a scheme, `www.`, or a name with one of the top-level domains below), an "@", and a phone number: seven or more digits of any script with at most
// two other marks between neighbouring digits (spaces, dots, dashes, commas, slashes; so a six-digit pincode still passes). Invisible characters (zero-width spaces and joiners,
// soft hyphens, direction marks) are removed first, so they cannot split a number or a link. Only letters, marks, digits, spaces and . , ' ’ - / ( ) & # + are allowed at all:
// anything else (a bracketed dot, a percent-encoding, an ideographic full stop, an emoji) means the words are not shown. What passes is on one line and cut to MAX_SHOWN_CHARS.
// It is a defence in depth for a few words, not a link scanner: spelled-out forms ("evil dot com") and a space before the dot are not caught.

/** How much of the customer's own words are put back in a reply. */
export const MAX_SHOWN_CHARS = 40;

const TLDS =
  "com|in|net|org|co|io|me|ly|app|xyz|info|biz|link|site|online|store|shop|top|club|tk|ml|ga|cf|gq|ru|cn|zip|dev|tech|uk|de|ai|us|ca|au|fr|jp|it|es|nl|br|ch|se|no|pl|tv|cc|ws|to|gl|gd|sh|vip|live|cloud|page|pro|work|win|click|support|today|world|digital|email|website|space|fun|icu|buzz|monster|bid|loan|men|date|download|review|stream|party|trade|webcam|science|racing|accountant|cricket|faith|gdn|host|press|rest|bar|cam|run";
const LINK = new RegExp(String.raw`https?:|ftp:|www\.|(?:^|[^\p{L}\p{N}])[\p{L}\p{N}-]+\.(?:${TLDS})(?![\p{L}\p{N}])`, "iu");
/** Seven or more digits of any script, with at most two non-letter, non-digit marks between neighbours: a phone number however it is typed. */
const PHONE = /(?:\p{Nd}[^\p{L}\p{N}]{0,2}){7,}/u;
/** Letters, marks, digits, spaces and a few marks of punctuation. */
const ALLOWED = /^[\p{L}\p{M}\p{N} .,'’\-/()&#+]+$/u;
/** Invisible formatting characters (zero-width space and joiners, soft hyphen, direction marks, the byte-order mark, word joiner). */
const INVISIBLE = /[\p{Cf}­͏ᅟᅠ឴឵᠎ㅤﾠ]/gu;

const refused = (text: string) => text.includes("@") || !ALLOWED.test(text) || LINK.test(text) || PHONE.test(text);

/** The words, tidied to one line and cut, or null when they carry a link, an "@", a phone number, an unusual mark, or nothing. */
export function cleanAreaText(text: string): string | null {
  const flat = stripUnsafeCharacters(text.slice(0, 5000).normalize("NFKC")).replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  if (!flat || refused(flat)) return null;
  const cut = [...flat].slice(0, MAX_SHOWN_CHARS).join("").trim();
  // Cutting can leave a fragment of a link or number the whole text had: look again.
  if (!cut || refused(cut)) return null;
  return cut;
}

/** True when the strict place cleaner would refuse the text (a link, an "@", seven or more digits, a character outside the allowed ones), whatever its length: for a place kept whole on the lead card, never cut. */
export function refusesAreaText(text: string): boolean {
  const flat = stripUnsafeCharacters(text.slice(0, 5000).normalize("NFKC")).replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  return flat === "" || refused(flat);
}

// ---------------------------------------------------------------------------------------------------------------------
// The looser sibling (Day 7, staff-text cleaning): for a customer's profile name and for the values and words shown to staff. The same refusals (a link, an "@", a run of digits that
// could be a phone number: 7 for a name, 10 for a value that may hold an amount such as 1,20,00,000) and the same removal of invisible characters, but NO character whitelist: an
// emoji, a rupee sign, a percent sign, an underscore or a tag is text that is shown, never run.

const phoneAt = new Map<number, RegExp>();
function phoneOf(digits: number): RegExp {
  let pattern = phoneAt.get(digits);
  if (!pattern) {
    pattern = new RegExp(String.raw`(?:\p{Nd}[^\p{L}\p{N}]{0,2}){${digits},}`, "u");
    phoneAt.set(digits, pattern);
  }
  return pattern;
}

/** The most characters any of the cleaners looks at: the link test is quadratic on a long run of separators, and nothing shown to staff is longer. */
const LOOK_AT = 5000;
const tidyLine = (text: string): string => stripUnsafeCharacters(text.slice(0, LOOK_AT).normalize("NFKC")).replace(INVISIBLE, "").replace(/\s+/g, " ").trim();

/** A date (14/10/2026, 2026-10-14), a time (10:30) or a grouped amount (1,20,00,000) is not a phone number: these are taken out before the digit run is looked for. */
const DATES_AND_AMOUNTS = [/(?<!\d)\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}(?!\d)/g, /(?<!\d)\d{1,2}:\d{2}(?!\d)/g, /(?<!\d)\d{1,3}(?:,\d{2,3})+(?:\.\d+)?(?!\d)/g];
const withoutDatesAndAmounts = (flat: string): string => DATES_AND_AMOUNTS.reduce((text, pattern) => text.replace(pattern, ""), flat);
const refusedDisplay = (flat: string, phoneDigits: number, skipDatesAndAmounts: boolean) =>
  flat.includes("@") || LINK.test(flat) || phoneOf(phoneDigits).test(skipDatesAndAmounts ? withoutDatesAndAmounts(flat) : flat);

/** True when the text carries a link, an "@" or a run of `phoneDigits` digits or more (invisible characters ignored): for a value that must be kept whole or dropped, never cut. */
export function refusesDisplayText(text: string, phoneDigits: number, skipDatesAndAmounts = false): boolean {
  return refusedDisplay(tidyLine(text), phoneDigits, skipDatesAndAmounts);
}

/** The text tidied to one line and cut to `max` characters, or null when it carries a link, an "@" or a phone number (`phoneDigits` digits or more), or nothing. */
export function cleanDisplayText(text: string, max: number, phoneDigits: number, skipDatesAndAmounts = false): string | null {
  const flat = tidyLine(text);
  if (!flat || refusedDisplay(flat, phoneDigits, skipDatesAndAmounts)) return null;
  const cut = [...flat].slice(0, max).join("").trim();
  // Cutting can leave a fragment of a link or number the whole text had: look again.
  if (!cut || refusedDisplay(cut, phoneDigits, skipDatesAndAmounts)) return null;
  return cut;
}

/** What is said when the customer's words are not shown (a link, a number, nothing): in the customer's language, ready to follow "We don't have sites in" and the like. */
export const AREA_NOT_SHOWN = {
  en: "the area you mentioned",
  ta: "நீங்கள் குறிப்பிட்ட",
  "ta-en": "neenga sonna area",
  hi: "आपके बताए इलाके",
} as const;

/** What the staff are told when the customer's words are not shown. */
export const AREA_NOT_SHOWN_STAFF = "an area outside your list";
