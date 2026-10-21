// A rupee amount as the customer wrote it ("60L", "50-60 lakh", "1.2 cr", "₹80,00,000", "65 லட்சம்", "70 लाख") as a range in whole
// rupees. The extraction step hands over a number or the customer's own words (range_inr in the pack format), so
// the scoring code reads both. Anything it cannot read is null, and scoring then gives no points and never fails
// a lead on it.
//
// A number with no unit that is below one lakh ("65", "5000", the 3 of "3 months") is NOT rupees: nobody buys a home for sixty-five
// rupees, it is a lakh or a crore whose unit was not read. It is unreadable (null), never a few rupees that would fail the lead.

export interface AmountRange {
  min: number;
  max: number;
}

const LAKH = 100_000;
const CRORE = 10_000_000;
const THOUSAND = 1_000;

// The unit words, by what they mean. Latin letters as before; then Tanglish, Tamil, Hindi and Hindi in Roman letters. Tamil and Hindi add
// endings to a word ("லட்சத்துக்குள்ள"), so those are read from their stem and take the rest of the word; the stem is followed by the letters
// that really make the word, so "லட்சணம்" (another word) is not a lakh. The dotted Hindi letters (करोड़, हज़ार) are matched with or without the dot.
const WORD = String.raw`[\p{L}\p{M}]*`;
const CRORE_WORDS = String.raw`crores|crore|cr|kodi(?:ku|kku|kulla)?|கோடி${WORD}|करोड${WORD}`;
const LAKH_WORDS = String.raw`lakhs|lakh|lacs|lac|l|latch[a-z]*|latsam[a-z]*|laksham[a-z]*|இலட்ச[மத]${WORD}|லட்ச[மத]${WORD}|लाख${WORD}`;
const THOUSAND_WORDS = String.raw`k|aayiram[a-z]*|ayiram[a-z]*|hazaar[a-z]*|hazar[a-z]*|ஆயிர${WORD}|हज़?ार${WORD}`;
const NUMBER = new RegExp(String.raw`(\d+(?:\.\d+)?)\s*(?:(?<crore>${CRORE_WORDS})|(?<lakh>${LAKH_WORDS})|(?<thousand>${THOUSAND_WORDS}))?(?![\p{L}\p{M}])`, "gu");

const DEVANAGARI_DIGITS = /[०-९]/g;
const TAMIL_DIGITS = /[௦-௯]/g;

function positive(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

export function parseAmountInr(value: unknown): AmountRange | null {
  // A plain number is rupees only from one lakh up; "65" from the extractor is a lakh whose unit was lost.
  if (typeof value === "number") return positive(value) && value >= LAKH ? { min: value, max: value } : null;
  if (typeof value !== "string") return null;

  const text = value
    .normalize("NFC")
    .toLowerCase()
    .replace(DEVANAGARI_DIGITS, (d) => String(d.charCodeAt(0) - 0x0966))
    .replace(TAMIL_DIGITS, (d) => String(d.charCodeAt(0) - 0x0be6))
    .replace(/[₹,]/g, "")
    .replace(/\b(rs|inr)\b\.?/g, " ");
  const found = [...text.matchAll(NUMBER)].map((m) => ({ n: Number(m[1]), unit: m.groups?.crore ? CRORE : m.groups?.lakh ? LAKH : m.groups?.thousand ? THOUSAND : undefined }));
  if (found.length === 0 || found.length > 2) return null;

  // "50-60L": a number with no unit of its own takes the other's unit.
  const sharedUnit = found.find((f) => f.unit !== undefined)?.unit;
  const amounts = found.map((f) => f.n * (f.unit ?? sharedUnit ?? 1));
  if (!amounts.every(positive)) return null;
  // No unit anywhere and under a lakh ("65", "50-60"): not rupees, unreadable.
  if (sharedUnit === undefined && Math.max(...amounts) < LAKH) return null;
  return { min: Math.min(...amounts), max: Math.max(...amounts) };
}
