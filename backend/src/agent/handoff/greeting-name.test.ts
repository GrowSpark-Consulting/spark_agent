import { describe, expect, it } from "vitest";
import { ownNumberGreeting } from "./texts";

// The greeting a staff member sends from their own number (the wa.me link of takeover.ts) names the customer by the first word of their WhatsApp profile name. The name is a stranger's
// words that staff then send IN THEIR OWN VOICE, so a name with a link, an @ or a phone number is never put in it: the plain greeting goes instead (Day 7, staff-text cleaning).

const WHO = { name: "Anand", business: "Sunrise Homes" };

describe("the greeting with a customer's name", () => {
  it("names a clean first name, in each language", () => {
    expect(ownNumberGreeting("en", WHO, "Priya Kumar")).toBe("Hi Priya, this is Anand from Sunrise Homes. How can I help you?");
    expect(ownNumberGreeting("ta-en", WHO, "Priya")).toContain("Vanakkam Priya");
    expect(ownNumberGreeting("hi", WHO, "प्रिया")).toContain("नमस्ते प्रिया");
  });

  it("keeps an emoji name", () => {
    expect(ownNumberGreeting("en", WHO, "Priya 💖")).toBe("Hi Priya, this is Anand from Sunrise Homes. How can I help you?");
  });

  it.each([
    "http://evil.example/pay",
    "Priya https://evil.example",
    "evil.com Priya",
    "priya@evil.example",
    "@priya_offers",
    "9876543210",
    "Priya 9876543210",
    "+91 98765 43210",
    "98765​43210",
  ])("a name that carries a link, an @ or a phone number gets the plain greeting, not the name: %j", (name) => {
    const text = ownNumberGreeting("en", WHO, name);
    expect(text).toBe("Hi, this is Anand from Sunrise Homes. How can I help you?");
    expect(text).not.toMatch(/evil|@|98765|http/);
  });

  it("a name with nothing in it, or none, gets the plain greeting", () => {
    expect(ownNumberGreeting("en", WHO, null)).toBe("Hi, this is Anand from Sunrise Homes. How can I help you?");
    expect(ownNumberGreeting("en", WHO, "   ")).toBe("Hi, this is Anand from Sunrise Homes. How can I help you?");
    expect(ownNumberGreeting("en", WHO, "\u0000")).toBe("Hi, this is Anand from Sunrise Homes. How can I help you?");
  });

  it("only the first word is used, and a long one is cut", () => {
    expect(ownNumberGreeting("en", WHO, "Priya Sharma Kumar")).toContain("Hi Priya,");
    expect(ownNumberGreeting("en", WHO, "P".repeat(200))).toMatch(/^Hi P{1,40}, this is/);
  });

  it("a placeholder in a name is not filled in", () => {
    expect(ownNumberGreeting("en", WHO, "{business}")).toBe("Hi {business}, this is Anand from Sunrise Homes. How can I help you?");
  });
});
