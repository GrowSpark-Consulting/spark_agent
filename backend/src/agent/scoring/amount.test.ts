import { describe, expect, it } from "vitest";
import { parseAmountInr } from "./amount";

const LAKH = 100_000;
const CRORE = 10_000_000;

describe("parseAmountInr", () => {
  it.each([
    ["a plain number is rupees", 6_000_000, { min: 6_000_000, max: 6_000_000 }],
    ["a number as text", "6000000", { min: 6_000_000, max: 6_000_000 }],
    ["lakh with L", "60L", { min: 60 * LAKH, max: 60 * LAKH }],
    ["lakhs spelled out", "60 lakhs", { min: 60 * LAKH, max: 60 * LAKH }],
    ["lac", "60 lac", { min: 60 * LAKH, max: 60 * LAKH }],
    ["a range with one unit at the end", "50-60L", { min: 50 * LAKH, max: 60 * LAKH }],
    ["a range with units on both", "50L - 60L", { min: 50 * LAKH, max: 60 * LAKH }],
    ["a range with 'to'", "50 to 60 lakh", { min: 50 * LAKH, max: 60 * LAKH }],
    ["crore", "1.2 cr", { min: 1.2 * CRORE, max: 1.2 * CRORE }],
    ["crores spelled out", "2 crores", { min: 2 * CRORE, max: 2 * CRORE }],
    ["a range crossing units", "90L-1.2Cr", { min: 90 * LAKH, max: 1.2 * CRORE }],
    ["the rupee sign and Indian commas", "₹80,00,000", { min: 80 * LAKH, max: 80 * LAKH }],
    ["thousands", "75k", { min: 75_000, max: 75_000 }],
    ["a reversed range is put in order", "60-50L", { min: 50 * LAKH, max: 60 * LAKH }],
    ["capitals and spaces", "  1 CR  ", { min: CRORE, max: CRORE }],
  ])("%s", (_why, input, expected) => {
    const got = parseAmountInr(input);
    expect(got?.min).toBeCloseTo(expected.min, 0);
    expect(got?.max).toBeCloseTo(expected.max, 0);
  });

  it.each([["empty text", ""], ["words only", "around my budget"], ["zero", 0], ["negative", -5], ["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY], ["null", null], ["undefined", undefined], ["an object", {}], ["a boolean", true]])(
    "gives null for %s",
    (_why, input) => {
      expect(parseAmountInr(input)).toBeNull();
    },
  );
});

// Unit words in Tamil, Tanglish and Hindi (fix/agent-budget-unit-words). The extraction keeps the customer's own words, so "65 லட்சம்" reaches
// the reader as text. Before the fix it was read as 65 RUPEES and the lead was disqualified.
describe("parseAmountInr: unit words in Tamil, Tanglish and Hindi", () => {
  const lakh = (n: number) => ({ min: n * LAKH, max: n * LAKH });
  const crore = (n: number) => ({ min: n * CRORE, max: n * CRORE });
  it.each([
    // Tamil script
    ["லட்சம்", "65 லட்சம்", lakh(65)],
    ["லட்சம் with no space", "65லட்சம்", lakh(65)],
    ["லட்சத்து", "65 லட்சத்துல", lakh(65)],
    ["லட்சத்துக்கு", "65 லட்சத்துக்கு", lakh(65)],
    ["லட்சத்துக்குள்ள", "65 லட்சத்துக்குள்ள", lakh(65)],
    ["லட்சம்வரை", "65 லட்சம்வரை", lakh(65)],
    ["இலட்சம்", "65 இலட்சம்", lakh(65)],
    ["கோடி", "1 கோடி", crore(1)],
    ["கோடிக்கு", "1.5 கோடிக்கு", crore(1.5)],
    ["ஆயிரம்", "50 ஆயிரம்", { min: 50_000, max: 50_000 }],
    // Tanglish
    ["latcham", "65 latcham", lakh(65)],
    ["latsam", "65 latsam", lakh(65)],
    ["laksham", "65 laksham", lakh(65)],
    ["latchum", "65 latchum", lakh(65)],
    ["latchathukku", "65 latchathukku", lakh(65)],
    ["kodi", "1 kodi", crore(1)],
    ["aayiram", "50 aayiram", { min: 50_000, max: 50_000 }],
    // Hindi
    ["लाख", "70 लाख", lakh(70)],
    ["लाख तक", "70 लाख तक", lakh(70)],
    ["लाख से", "70 लाख से", lakh(70)],
    ["लाखों", "70 लाखों", lakh(70)],
    ["करोड़ (dotted)", "1 करोड़", crore(1)],
    ["करोड (no dot)", "2 करोड", crore(2)],
    ["हज़ार (dotted)", "50 हज़ार", { min: 50_000, max: 50_000 }],
    ["हजार", "50 हजार", { min: 50_000, max: 50_000 }],
    // Roman Hindi
    ["lakh", "70 lakh", lakh(70)],
    ["lakhs", "70 lakhs", lakh(70)],
    ["crore", "1 crore", crore(1)],
    ["hazaar", "50 hazaar", { min: 50_000, max: 50_000 }],
    ["hazar", "50 hazar", { min: 50_000, max: 50_000 }],
    // Devanagari and Tamil digits
    ["Devanagari digits", "७० लाख", lakh(70)],
    ["Tamil digits", "௬௫ லட்சம்", lakh(65)],
    ["Devanagari digits with a decimal", "१.५ करोड़", crore(1.5)],
  ])("reads %s", (_why, input, expected) => {
    const got = parseAmountInr(input);
    expect(got?.min).toBeCloseTo(expected.min, 0);
    expect(got?.max).toBeCloseTo(expected.max, 0);
  });

  it.each([
    ["Latin dash", "50-60L", 50, 60],
    ["Tamil, முதல்", "50 முதல் 60 லட்சம்", 50, 60],
    ["Tamil, dash", "50-60 லட்சம்", 50, 60],
    ["Hindi, से", "50 से 60 लाख", 50, 60],
    ["Hindi, Devanagari digits", "५० से ६० लाख", 50, 60],
    ["Roman Hindi, se", "50 se 60 lakh", 50, 60],
    ["English, to", "50 to 60 lakh", 50, 60],
    ["unit on both, Tamil", "50 லட்சம் முதல் 60 லட்சம்", 50, 60],
  ])("a range shares its unit and is NOT cut by the safety net: %s", (_why, input, from, to) => {
    expect(parseAmountInr(input)).toEqual({ min: from * LAKH, max: to * LAKH });
  });

  it("a range with no unit anywhere is unreadable", () => {
    expect(parseAmountInr("50-60")).toBeNull();
    expect(parseAmountInr("50 to 60")).toBeNull();
    expect(parseAmountInr("50 से 60")).toBeNull();
  });
});

describe("parseAmountInr: the safety net (a bare number below 1 lakh is never rupees)", () => {
  it.each([["65"], ["70"], ["5000"], ["80000"], ["99999"], ["1.5"], ["3 months"], ["3 மாசம்"], ["2 महीने"], ["௬௫"], ["७०"]])("%s is unreadable", (input) => {
    expect(parseAmountInr(input)).toBeNull();
  });

  it.each([[65], [5000], [99_999]])("the plain number %s is unreadable", (input) => {
    expect(parseAmountInr(input)).toBeNull();
  });

  it.each([
    ["a 7 digit number", "6500000", 6_500_000],
    ["an 8 digit number", "70000000", 70_000_000],
    ["Indian commas", "65,00,000", 6_500_000],
    ["rupee sign and commas", "₹80,00,000", 8_000_000],
    ["exactly one lakh", "100000", 100_000],
    ["2.5 lakh as rupees", "250000", 250_000],
  ])("is still read as rupees: %s", (_why, input, rupees) => {
    expect(parseAmountInr(input)).toEqual({ min: rupees, max: rupees });
  });

  it("the plain number 6000000 is still rupees", () => {
    expect(parseAmountInr(6_000_000)).toEqual({ min: 6_000_000, max: 6_000_000 });
  });

  it("a number WITH a unit below a lakh is still read (the net is for bare numbers only)", () => {
    expect(parseAmountInr("75k")).toEqual({ min: 75_000, max: 75_000 });
    expect(parseAmountInr("50 ஆயிரம்")).toEqual({ min: 50_000, max: 50_000 });
  });
});

describe("parseAmountInr: what must stay unreadable", () => {
  it.each([["2BHK"], ["3bhk"], ["2BHK 3 months 65"], ["60 lakhx"], ["65 லட்சணம்"], ["a b c"], ["50 60 70 lakh"]])("%s is null", (input) => {
    expect(parseAmountInr(input)).toBeNull();
  });

  it("a letter right after a Latin unit still cancels it", () => {
    expect(parseAmountInr("60lakhs")).toEqual({ min: 60 * LAKH, max: 60 * LAKH });
    expect(parseAmountInr("60 lakhsx")).toBeNull();
  });
});

// KNOWN LIMIT (reported, not fixed here): a second number in the same text is taken as the other end of a range and borrows the unit.
describe("parseAmountInr: KNOWN LIMIT, extra numbers in the text", () => {
  it("'70 lakh, 2 months' is read as a range from 2 lakh to 70 lakh (as it was before, with Latin units)", () => {
    expect(parseAmountInr("70 lakh, 2 months")).toEqual({ min: 2 * LAKH, max: 70 * LAKH });
  });
  it("the same with Tamil and Hindi unit words", () => {
    expect(parseAmountInr("65 லட்சம், 2 மாசத்துல")).toEqual({ min: 2 * LAKH, max: 65 * LAKH });
    expect(parseAmountInr("70 लाख, 2 महीने में")).toEqual({ min: 2 * LAKH, max: 70 * LAKH });
  });
});
