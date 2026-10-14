import { describe, expect, it } from "vitest";
import { AREA_NOT_SHOWN, cleanAreaText, MAX_SHOWN_CHARS } from "./area-text";

// The strict cleaner for a place the customer typed (Day 7, PR C finding 2): no link, no "@", no run of seven or more digits (a six-digit pincode still works), one line, cut to 40.

describe("a place that passes", () => {
  it.each([
    ["Adyar", "Adyar"],
    ["  T.   Nagar ", "T. Nagar"],
    ["Anna Nagar West", "Anna Nagar West"],
    ["641001", "641001"],
    ["641 001", "641 001"],
    ["600-042", "600-042"],
    ["Adyar 600020", "Adyar 600020"],
    ["வேளச்சேரி", "வேளச்சேரி"],
    ["वेलाचेरी", "वेलाचेरी"],
    ["Plot 12, Sector 5", "Plot 12, Sector 5"],
    ["Sector 5.5", "Sector 5.5"],
    ["No. 12/3, 4th Cross", "No. 12/3, 4th Cross"],
    ["R.S. Puram", "R.S. Puram"],
    ["Opp. Co-op Bank", "Opp. Co-op Bank"],
    ["Adyar (near beach) & Besant Nagar", "Adyar (near beach) & Besant Nagar"],
    ["Tambaram near the station", "Tambaram near the station"],
  ])("%j is shown as %j", (text, shown) => {
    expect(cleanAreaText(text)).toBe(shown);
  });

  it("is cut to 40 characters, by code points", () => {
    expect([...(cleanAreaText(`Adyar ${"a".repeat(100)}`) ?? "")]).toHaveLength(MAX_SHOWN_CHARS);
    expect([...(cleanAreaText("வேளச்சேரி ".repeat(20)) ?? "")].length).toBeLessThanOrEqual(MAX_SHOWN_CHARS);
  });

  it("a masked phone number as we write it (the label the reminder falls back to) passes", () => {
    expect(cleanAreaText("+9198xxxxxx21")).toBe("+9198xxxxxx21");
  });

  it("is one line: line breaks, tabs and control characters are gone", () => {
    expect(cleanAreaText("Adyar\n\nnear\tthe\u0000\u0007 river")).toBe("Adyar near the river");
  });
});

describe("a place that is not shown at all", () => {
  it.each([
    ["a link with a scheme", "Adyar https://evil.example/pay now"],
    ["a link without one", "Adyar evil.com"],
    ["a link with www", "www.evil.example Adyar"],
    ["a short domain", "Adyar bit.ly/x"],
    ["an Indian domain", "Adyar shop.co.in"],
    ["an e-mail address", "Adyar me@evil.example"],
    ["an @ on its own", "Adyar @priya"],
    ["a ten-digit phone number", "Adyar 9876543210"],
    ["a phone number with a country code", "Adyar +91 98765 43210"],
    ["a phone number with dashes", "Adyar 98765-43210"],
    ["a phone number with dots", "Adyar 98765.43210"],
    ["a phone number with spaces between every digit", "Adyar 9 8 7 6 5 4 3 2 1 0"],
    ["a seven-digit number", "Adyar 1234567"],
    ["a phone number in Tamil digits", "அடையாறு ௯௮௭௬௫-௪௩௨௧௦"],
    ["a phone number in Devanagari digits", "अड्यार ९८७६५ ४३२१०"],
    ["full-width digits", "Adyar ９８７６５４３２１０"],
    ["a number split by a zero-width space", "Adyar 98765​43210"],
    ["a number split by a zero-width joiner", "Adyar 98765‍43210"],
    ["a number split by a soft hyphen", "Adyar 98765­43210"],
    ["a number split by a comma", "Adyar 98765,43210"],
    ["a number split by a slash", "Adyar 98765/43210"],
    ["a number split by an en dash", "Adyar 98765–43210"],
    ["a number split by a middle dot", "Adyar 98765・43210"],
    ["a number split by an underscore", "Adyar 98765_43210"],
    ["a number split by a direction mark", "Adyar 98765‏43210"],
    ["a number in brackets", "Adyar (987) 654-3210"],
    ["a link with an uncommon domain", "Adyar evil.zip"],
    ["a link on .dev", "evil.dev"],
    ["a link on .ai", "evil.ai"],
    ["a link with an ideographic full stop", "evil。com"],
    ["a link with a zero-width space", "evil​.com"],
    ["a link with a zero-width space inside the domain", "evil.c​om"],
    ["a link with a bracketed dot", "evil[.]com"],
    ["a link percent-encoded", "evil%2ecom"],
    ["an emoji", "Adyar 🏠"],
    ["nothing", "   "],
    ["only control characters", "\u0000\u0007"],
    ["text whose first 40 characters hold part of a link", `${"a".repeat(30)} http://x.y`],
  ])("%s", (_name, text) => {
    expect(cleanAreaText(text)).toBeNull();
  });

  it("a very long input is cleaned in a blink (no catastrophic backtracking)", () => {
    const started = Date.now();
    for (const text of ["a-".repeat(10000), "a.".repeat(10000), "1 ".repeat(10000), "x".repeat(20000)]) cleanAreaText(text);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("the fixed words for the customer exist in every language the fixed lines have", () => {
    expect(Object.keys(AREA_NOT_SHOWN).sort()).toEqual(["en", "hi", "ta", "ta-en"]);
    for (const words of Object.values(AREA_NOT_SHOWN)) expect(cleanAreaText(words)).not.toBeNull();
  });
});
