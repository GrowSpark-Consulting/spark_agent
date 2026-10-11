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
