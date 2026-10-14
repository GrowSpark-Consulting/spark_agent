import { describe, expect, it } from "vitest";
import { cleanDisplayText, refusesDisplayText } from "./area-text";

// The looser sibling of the strict place cleaner (area-text.test.ts), for a customer's profile name and for the values and words shown to staff (Day 7, the staff-text cleaning PR).
// Same refusals: no link, no "@", no run of digits that could be a phone number (7 for a name, 10 for an amount-bearing value), invisible characters removed, one line, cut.
// No character whitelist: an emoji, a rupee sign, a percent sign, an underscore or a tag in a name or an amount is fine (it is text shown, never run).

describe("a name or value that passes", () => {
  it.each([
    ["Priya", "Priya"],
    ["Priya 💖", "Priya 💖"],
    ["Raj_K ✨", "Raj_K ✨"],
    ["  Dr.   Anand  Kumar ", "Dr. Anand Kumar"],
    ["வேளச்சேரி குமார்", "வேளச்சேரி குமார்"],
    ["मैं प्रिया", "मैं प्रिया"],
    ["Priya <3", "Priya <3"],
    ["O'Brien & Sons", "O'Brien & Sons"],
    ["Flat 12B, Block 4", "Flat 12B, Block 4"],
  ])("%j is shown as %j", (text, shown) => {
    expect(cleanDisplayText(text, 40, 7)).toBe(shown);
  });

  it("an amount with a rupee sign, a percent sign and Indian digit grouping passes at 10 digits but not at 7", () => {
    expect(cleanDisplayText("₹1,20,00,000 (about 1.2 crore)", 80, 10)).toBe("₹1,20,00,000 (about 1.2 crore)");
    expect(cleanDisplayText("₹1,20,00,000", 80, 7)).toBeNull();
    expect(cleanDisplayText("50% of 80L", 80, 10)).toBe("50% of 80L");
  });

  it("is cut to the given length by code points, never inside an emoji", () => {
    expect([...(cleanDisplayText("A".repeat(100), 40, 7) ?? "")]).toHaveLength(40);
    expect([...(cleanDisplayText("💖".repeat(100), 10, 7) ?? "")]).toHaveLength(10);
  });

  it("is on one line, without control characters", () => {
    expect(cleanDisplayText("Priya\nK\t\u0000\u0007 Kumar", 40, 7)).toBe("Priya K Kumar");
  });
});

describe("a name or value that is not shown", () => {
  it.each([
    ["a link with a scheme", "Priya https://evil.example/pay"],
    ["a link without one", "Priya evil.com"],
    ["a link with www", "www.evil.example"],
    ["an e-mail address", "priya@evil.example"],
    ["a handle with an @", "@priya_offers"],
    ["a ten-digit phone number", "Priya 9876543210"],
    ["a phone number with a country code and spaces", "+91 98765 43210"],
    ["a phone number with dashes", "98765-43210 Priya"],
    ["a phone number split by a zero-width space", "98765​43210"],
    ["a phone number split by a comma", "98765,43210"],
    ["a phone number in Tamil digits", "௯௮௭௬௫-௪௩௨௧௦"],
    ["a seven-digit number in a name", "Priya 1234567"],
    ["nothing", "   "],
    ["only control characters", "\u0000\u0007"],
  ])("%s", (_name, text) => {
    expect(cleanDisplayText(text, 40, 7)).toBeNull();
    expect(refusesDisplayText(text, 7) || text.trim() === "" || /^[\u0000-\u0008]+$/.test(text)).toBe(true);
  });

  it("a ten-digit phone number is still refused at the 10-digit threshold; a seven-digit one is not", () => {
    expect(cleanDisplayText("call 9876543210", 80, 10)).toBeNull();
    expect(cleanDisplayText("order 1234567", 80, 10)).toBe("order 1234567");
  });

  it("a link or number that the cut would leave a part of is looked at again after the cut", () => {
    expect(cleanDisplayText(`${"a".repeat(30)} http://x.y`, 40, 7)).toBeNull();
  });

  it("a very long input is cleaned in a blink (no catastrophic backtracking)", () => {
    const started = Date.now();
    for (const text of ["a-".repeat(10000), "a.".repeat(10000), "1 ".repeat(10000), "x".repeat(20000)]) cleanDisplayText(text, 40, 7);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("refusesDisplayText: the same test, for a value that must be kept whole or dropped (never cut)", () => {
  it("refuses a link, an @ and a long digit run, and passes ordinary text", () => {
    expect(refusesDisplayText("see http://evil.example", 10)).toBe(true);
    expect(refusesDisplayText("me@evil.example", 10)).toBe(true);
    expect(refusesDisplayText("call 9876543210", 10)).toBe(true);
    expect(refusesDisplayText("Velachery, near the station ₹78 lakh", 10)).toBe(false);
    expect(refusesDisplayText("", 10)).toBe(false);
  });
});

describe("dates, times and amounts are not phone numbers, when the caller says so (the third argument): extraction, the card's values and a model's words", () => {
  it.each(["2026-10-14 10:30", "14/10/2026 10:30", "14.10.2026", "Sun 11 Oct 2026, 10:30 am to 11:30 am", "₹1,20,00,000", "120,00,00,000", "6,00,000 - 8,00,000", "80L-90L, ready by 2026-12-01 09:00"])(
    "%j is kept",
    (text) => {
      expect(refusesDisplayText(text, 10, true)).toBe(false);
      expect(cleanDisplayText(text, 80, 10, true)).not.toBeNull();
    },
  );

  it("without the argument they are still refused at 10 digits (nothing changes for a caller that does not ask)", () => {
    expect(refusesDisplayText("2026-10-14 10:30", 10)).toBe(true);
  });

  it.each(["98765,43210", "98765/43210", "98765-43210", "+91 98765 43210", "9876543210", "044-24351234", "call 98765 14/10/2026 43210"])("a phone number is still refused with the argument: %j", (text) => {
    expect(refusesDisplayText(text, 10, true)).toBe(true);
  });
});

describe("a very long input is cleaned in a blink (the link test is bounded)", () => {
  it("separator-heavy input of 20,000 characters, through both cleaners and the refusal test", () => {
    const started = Date.now();
    for (const text of ["-a".repeat(10000), "-".repeat(20000) + "a", "a-".repeat(10000), ".a".repeat(10000)]) {
      cleanDisplayText(text, 60, 7);
      refusesDisplayText(text, 10, true);
    }
    expect(Date.now() - started).toBeLessThan(500);
  });
});
