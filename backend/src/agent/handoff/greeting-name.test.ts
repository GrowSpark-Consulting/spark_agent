import { describe, expect, it } from "vitest";
import { externalNotice, ownNumberGreeting, ownNumberNotice } from "./texts";

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

  // Nameless wording: the staff member's name is not known, so the words name the business and never put "A team member" in the sentence.
  // The Tamil, Tanglish and Hindi lines are drafts that no native speaker has read.
  it.each(["en", "ta", "ta-en", "hi", null])("a staff member with no name: the greeting and the notice name the business, in %s", (language) => {
    const text = [ownNumberGreeting(language, { name: null, business: "Sunrise Homes" }, "Priya"), ownNumberGreeting(language, { name: null, business: "Sunrise Homes" }, null), ownNumberNotice(language, { name: null, business: "Sunrise Homes", phone: "+919876500001" }), externalNotice(language, null)];
    for (const line of text) expect(line).not.toMatch(/team member|null|\{/i);
    for (const line of text.slice(0, 3)) expect(line).toContain("Sunrise Homes");
    expect(text[2]).toContain("+919876500001");
    expect(text[0]).toContain("Priya");
    expect(text[1]).not.toContain("Priya");
  });

  it("the English wording", () => {
    expect(ownNumberGreeting("en", { name: null, business: "Sunrise Homes" }, null)).toBe("Hi, this is the team at Sunrise Homes. How can I help you?");
    expect(ownNumberNotice("en", { name: null, business: "Sunrise Homes", phone: "+919876500001" })).toBe("Someone from Sunrise Homes will message you from +919876500001 shortly.");
    expect(externalNotice("en", null)).toBe("Our team is looking after your chat and will reply to you shortly.");
  });

  it("a placeholder in a name is not filled in", () => {
    expect(ownNumberGreeting("en", WHO, "{business}")).toBe("Hi {business}, this is Anand from Sunrise Homes. How can I help you?");
  });
});
