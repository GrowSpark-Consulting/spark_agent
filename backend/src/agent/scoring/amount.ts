// A rupee amount as the customer wrote it ("60L", "50-60 lakh", "1.2 cr", "₹80,00,000") as a range in whole
// rupees. The extraction step hands over a number or the customer's own words (range_inr in the pack format), so
// the scoring code reads both. Anything it cannot read is null, and scoring then gives no points and never fails
// a lead on it.

export interface AmountRange {
  min: number;
  max: number;
}

const UNITS: Record<string, number> = { k: 1_000, l: 100_000, lac: 100_000, lacs: 100_000, lakh: 100_000, lakhs: 100_000, cr: 10_000_000, crore: 10_000_000, crores: 10_000_000 };
const NUMBER = /(\d+(?:\.\d+)?)\s*(crores|crore|cr|lakhs|lakh|lacs|lac|l|k)?(?![a-z])/g;

function positive(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

export function parseAmountInr(value: unknown): AmountRange | null {
  if (typeof value === "number") return positive(value) ? { min: value, max: value } : null;
  if (typeof value !== "string") return null;

  const text = value.toLowerCase().replace(/[₹,]/g, "").replace(/\b(rs|inr)\b\.?/g, " ");
  const found = [...text.matchAll(NUMBER)].map((m) => ({ n: Number(m[1]), unit: m[2] }));
  if (found.length === 0 || found.length > 2) return null;

  // "50-60L": a number with no unit of its own takes the other's unit.
  const sharedUnit = found.find((f) => f.unit !== undefined)?.unit;
  const amounts = found.map((f) => f.n * (UNITS[f.unit ?? sharedUnit ?? ""] ?? 1));
  if (!amounts.every(positive)) return null;
  return { min: Math.min(...amounts), max: Math.max(...amounts) };
}
