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
  const flat = stripUnsafeCharacters(text.normalize("NFKC")).replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  if (!flat || refused(flat)) return null;
  const cut = [...flat].slice(0, MAX_SHOWN_CHARS).join("").trim();
  // Cutting can leave a fragment of a link or number the whole text had: look again.
  if (!cut || refused(cut)) return null;
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
