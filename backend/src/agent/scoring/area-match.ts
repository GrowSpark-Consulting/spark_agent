// A place the customer wrote in another script or spelling, against a place the business listed (fix/agent-live-findings-2). Plain code, no model.
//
// Found by a live run: "பெரும்பாக்கம்", "பள்ளிக்கரணை", "ग्रेटर नोएडा वेस्ट" and "gr noida west" were told "we have no site there" although the place was on the list,
// because the old check only looks for the listed name, letter for letter, inside the customer's words. Real customers write a place the way they speak it.
//
// How: each word is written as a "sound skeleton": Tamil and Devanagari consonants become Latin ones, vowels are dropped, similar sounds are folded
// (b/p, d/t, g/k, v/w, ch/s ...), a word-final y is dropped and doubled letters become one. "பெரும்பாக்கம்", "Perumbakkam" and "Perumbakam" are all "prmpkm".
// A listed place is found in the customer's words when its words appear one after the other with the same skeleton (an abbreviation such as "gr" for "greater"
// counts, and a Tamil ending such as "-த்துல" on a Tamil word counts). The customer's words are only ever compared with the business's own list: nothing is added to it.
//
// What it does not do: guess. A name whose skeleton is shorter than 3 letters is never matched by sound (too many places would collide), a pincode or any word with a
// digit must be exact, and a place in a script this file cannot read (Malayalam, Telugu, ...) is NOT judged at all (isReadablePlace): the caller must not say "no site there" about it.

const TAMIL: Record<string, string> = { க: "k", ங: "n", ச: "s", ஞ: "n", ட: "t", ண: "n", த: "t", ந: "n", ப: "p", ம: "m", ய: "y", ர: "r", ல: "l", வ: "v", ழ: "l", ள: "l", ற: "r", ன: "n", ஜ: "j", ஷ: "s", ஸ: "s", ஹ: "h" };
const DEVANAGARI: Record<string, string> = {
  क: "k", ख: "k", ग: "g", घ: "g", ङ: "n", च: "s", छ: "s", ज: "j", झ: "j", ञ: "n", ट: "t", ठ: "t", ड: "d", ढ: "d", ण: "n", त: "t", थ: "t", द: "d", ध: "d", न: "n",
  प: "p", फ: "p", ब: "b", भ: "b", म: "m", य: "y", र: "r", ल: "l", व: "v", श: "s", ष: "s", स: "s", ह: "h", "ं": "n", "ँ": "n",
};
const FOLD: Record<string, string> = { b: "p", d: "t", g: "k", c: "k", q: "k", w: "v", z: "s", f: "p", j: "s", x: "ks" };

/** The least letters a name's skeleton must have to be matched by sound. */
const MIN_SKELETON = 3;
/** An abbreviation is at most this many letters ("gr", "grt"). */
const MAX_ABBREVIATION = 3;

const tokensOf = (text: string): string[] =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

/** One word as its sound skeleton: "" for a word with no letters this file knows. */
function tokenSkeleton(token: string): string {
  let mapped = "";
  for (const ch of token.normalize("NFC")) mapped += TAMIL[ch] ?? DEVANAGARI[ch] ?? (/[a-z]/.test(ch) ? ch : "");
  return mapped
    .replace(/y$/, "")
    .replace(/ch/g, "s")
    .replace(/h/g, "")
    .replace(/[aeiou]/g, "")
    .replace(/[bdgcqwzfjx]/g, (c) => FOLD[c])
    .replace(/(.)\1+/gu, "$1");
}

/** The skeleton of a whole place, one word after another. */
export function placeSkeleton(text: string): string {
  return tokensOf(text).map(tokenSkeleton).filter(Boolean).join(" ");
}

const hasDigit = (token: string) => /\p{N}/u.test(token);
const hasTamil = (token: string) => /\p{Script=Tamil}/u.test(token);
const isLatin = (token: string) => /^[a-z]+$/.test(token);

function sameWord(customer: string, listed: string): boolean {
  if (hasDigit(customer) || hasDigit(listed)) return customer === listed;
  const c = tokenSkeleton(customer);
  const l = tokenSkeleton(listed);
  if (!c || !l) return false;
  if (c === l) return true;
  // "gr" for "greater": a short Latin word that is the start of the listed word's skeleton.
  if (isLatin(customer) && customer.length <= MAX_ABBREVIATION && c.length >= 2 && c.length < l.length && l.startsWith(c)) return true;
  // A Tamil ending on a Tamil word ("பெரும்பாக்கத்துல" for "Perumbakkam"): the listed skeleton without its last letter is where the customer's word starts.
  if (hasTamil(customer) && l.length >= MIN_SKELETON + 2 && c.length >= l.length && c.startsWith(l.slice(0, -1))) return true;
  return false;
}

/**
 * Whether the customer's words name this listed place, written another way: another script, a different spelling, an abbreviation. The old exact
 * check (the listed name, letter for letter, as a whole word) is the caller's first try; this is the second.
 */
export function sameAreaInAnotherSpelling(customerText: string, listedArea: string): boolean {
  const said = tokensOf(customerText);
  const listed = tokensOf(listedArea);
  if (said.length === 0 || listed.length === 0) return false;
  const letters = listed.filter((t) => !hasDigit(t)).reduce((sum, t) => sum + tokenSkeleton(t).length, 0);
  if (letters < MIN_SKELETON) return false;
  for (let start = 0; start + listed.length <= said.length; start++) {
    if (listed.every((word, k) => sameWord(said[start + k], word))) return true;
  }
  return false;
}

const READABLE_LETTER = /\p{Script=Latin}|\p{Script=Tamil}|\p{Script=Devanagari}/u;

/** Whether every letter is Latin, Tamil or Devanagari, the scripts this file can compare. Digits, marks and punctuation do not matter. */
export function isReadablePlace(text: string): boolean {
  for (const ch of text.normalize("NFKC")) {
    if (/\p{L}/u.test(ch) && !READABLE_LETTER.test(ch)) return false;
  }
  return true;
}
