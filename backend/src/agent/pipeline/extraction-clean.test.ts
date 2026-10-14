import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolvePack } from "../packs/load";
import { interpretExtraction } from "./extraction";

// What a customer types into a detail (an area, a budget, a timeline) is stored on the lead and then read by everything: the lead card, the staff alerts, Dev 2's reads and Dev 3's screens. So a
// value that carries a link, an "@" or a phone number is dropped here, counted with the other values that are refused, and never stored (Day 7, staff-text cleaning). The threshold is a
// run of 10 digits (a phone number; a 6-digit pincode and an amount are untouched). A value that is not refused is kept exactly as before. The model's own words are not touched here.

const PACKS_DIR = fileURLToPath(new URL("../../../../packs", import.meta.url));
const { fieldSchema } = resolvePack(JSON.parse(readFileSync(`${PACKS_DIR}/real-estate.json`, "utf8")));
const base = { language: "en", intent: "give_details", fields: {}, question: null, preferredTime: null, sentiment: "neutral", asksIfHuman: false, confidence: 0.9 };
const run = (fields: Record<string, unknown>) => interpretExtraction(JSON.stringify({ ...base, fields }), fieldSchema);

describe("a detail with a link, an @ or a phone number is dropped", () => {
  it.each([
    ["a link in an area", { location: "Adyar http://evil.example" }],
    ["a link without a scheme", { location: "Adyar evil.com" }],
    ["an e-mail address in an area", { location: "mail priya@evil.example" }],
    ["a phone number in an area", { location: "Adyar 9876543210" }],
    ["a phone number with a country code", { location: "Adyar +91 98765 43210" }],
    ["a phone number split by zero-width characters", { location: "Adyar 98765​43210" }],
    ["a phone number in a budget", { budget: "call me on 9876543210" }],
    ["a link in a budget", { budget: "see www.evil.example" }],
  ])("%s", (_name, fields) => {
    const result = run(fields);
    expect(result).toMatchObject({ ok: true, extraction: { fields: {} }, dropped: { invalidValues: 1 } });
  });

  it("the other details of the same answer are kept", () => {
    const result = run({ location: "Adyar 9876543210", config: "2BHK", budget: "80L", timeline: "0-3m" });
    expect(result).toMatchObject({ ok: true, extraction: { fields: { config: "2BHK", budget: "80L", timeline: "0-3m" } }, dropped: { invalidValues: 1 } });
  });
});

describe("a detail that is fine is kept as before", () => {
  it.each([
    ["an area", { location: "Velachery" }],
    ["an area with a six-digit pincode", { location: "Adyar 600020" }],
    ["a pincode as digits", { location: "641001" }],
    ["a pincode with a space", { location: "641 001" }],
    ["a budget with a rupee sign and grouped digits", { budget: "₹1,20,00,000" }],
    ["a budget range", { budget: "80L-90L" }],
    ["a number given as a number", { budget: 8000000 }],
    ["a place in Tamil", { location: "வேளச்சேரி" }],
    ["a place with an emoji", { location: "Adyar 🏠" }],
  ])("%s", (_name, fields) => {
    const result = run(fields);
    expect(result).toMatchObject({ ok: true, dropped: { invalidValues: 0 } });
    if (result.ok) expect(result.extraction.fields).toEqual(fields);
  });

  it("a seven-to-nine digit number is kept (only a run of ten digits or more is a phone number here; the area echo and the staff reminder use the stricter test)", () => {
    expect(run({ location: "Plot 1234567" })).toMatchObject({ ok: true, extraction: { fields: { location: "Plot 1234567" } } });
  });

  it("a value cut to 200 characters is cut as before, and a link past the cut is not looked for (it is not stored)", () => {
    const result = run({ location: `Adyar ${"a".repeat(300)} http://evil.example` });
    expect(result.ok).toBe(true);
    if (result.ok) expect([...(result.extraction.fields.location as string)].length).toBeLessThanOrEqual(200);
    if (result.ok) expect(result.extraction.fields.location).not.toMatch(/evil/);
  });
});

describe("dates and amounts in a detail are kept (review fixes)", () => {
  it.each([
    ["a date and time", { location: "2026-10-14 10:30" }],
    ["a dd/mm/yyyy date and time", { location: "14/10/2026 10:30" }],
    ["a full-digit amount with grouping", { budget: "120,00,00,000" }],
    ["an amount range", { budget: "6,00,000 - 8,00,000" }],
  ])("%s", (_name, fields) => {
    const result = run(fields);
    expect(result).toMatchObject({ ok: true, dropped: { invalidValues: 0 } });
    if (result.ok) expect(result.extraction.fields).toEqual(fields);
  });

  it("a phone number next to a date is still dropped", () => {
    expect(run({ location: "98765 14/10/2026 43210" })).toMatchObject({ ok: true, extraction: { fields: {} }, dropped: { invalidValues: 1 } });
  });
});
