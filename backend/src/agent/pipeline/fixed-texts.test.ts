import { describe, expect, it } from "vitest";
import { areaText, consentNotice, FIXED_TEXTS, fixedText, SAFE_FALLBACK_EN, textLanguage, type FixedTextKey, type TextLanguage, EXIT_BUTTON_IDS, exitQuestionButtons } from "./fixed-texts";

// The fixed lines: no model, fixed words, one per language.

const KEYS = Object.keys(FIXED_TEXTS) as FixedTextKey[];
const LANGS: TextLanguage[] = ["en", "ta", "ta-en", "hi"];

describe("the safe fallback", () => {
  it("is exactly the handover's words in English", () => {
    expect(SAFE_FALLBACK_EN).toBe("Let me confirm that with the team");
    expect(fixedText("fallback", "en")).toBe("Let me confirm that with the team");
  });
});

describe("the exit question as reply buttons", () => {
  it("has two buttons in every language, each title within WhatsApp's 20 characters, different from each other, and ids that are unique", () => {
    for (const language of LANGS) {
      const { body, buttons } = exitQuestionButtons(language);
      expect(buttons.map((b) => b.id)).toEqual([EXIT_BUTTON_IDS.talk, EXIT_BUTTON_IDS.continue]);
      for (const b of buttons) expect([...b.title].length, `${language} ${b.title}`).toBeLessThanOrEqual(20);
      expect(new Set(buttons.map((b) => b.title)).size).toBe(2);
      expect(body).toBe(fixedText("exit_prompt", language));
    }
  });

  it("keeps the STOP hint in the text and has NO STOP button and no '1' wording", () => {
    for (const language of LANGS) {
      const { body, buttons } = exitQuestionButtons(language);
      expect(body).toContain("STOP");
      expect(body).not.toMatch(/[0-9]/);
      expect(buttons.some((b) => /stop/i.test(b.title) || /stop/i.test(b.id))).toBe(false);
    }
  });
});

describe("every fixed line", () => {
  it.each(KEYS.flatMap((k) => LANGS.map((l) => [k, l] as const)))("%s in %s is there, short and has no price, date or time", (key, language) => {
    const text = fixedText(key, language);
    expect(text.length).toBeGreaterThan(10);
    expect(text.length).toBeLessThanOrEqual(200); // short enough for the 600-character reply cap with room for a notice
    // The exit question offers "1" as the way to reach the team (until reply buttons exist): that digit is not a price, date or time.
    expect(key === "exit_question" ? text.replace("1", "") : text).not.toMatch(/₹|\d/);
    expect(text.trim()).toBe(text);
  });

  it("is in the script of its language: Tamil lines have Tamil letters, Hindi lines have Devanagari, the rest are Latin", () => {
    for (const key of KEYS) {
      expect(fixedText(key, "ta")).toMatch(/[஀-௿]/);
      expect(fixedText(key, "hi")).toMatch(/[ऀ-ॿ]/);
      expect(fixedText(key, "en")).not.toMatch(/[^\x00-\x7f]/);
      expect(fixedText(key, "ta-en")).not.toMatch(/[஀-௿ऀ-ॿ]/);
    }
  });

  it("differs between languages, so none is a copy of the English line by mistake", () => {
    for (const key of KEYS) expect(new Set(LANGS.map((l) => fixedText(key, l))).size).toBe(LANGS.length);
  });

  it("the stop hint names the word the customer must send", () => {
    for (const l of LANGS) expect(fixedText("stop_hint", l)).toContain("STOP");
  });
});

describe("the privacy notice", () => {
  it("has the link last, in every language, and says how to stop", () => {
    for (const l of LANGS) {
      const text = consentNotice(l, "https://example.test/privacy");
      expect(text.endsWith("https://example.test/privacy")).toBe(true);
      expect(text).toContain("STOP");
      expect(text).not.toContain("{url}");
      expect(text).not.toContain("\n"); // one line
    }
  });

  it("puts the link in as plain text, whatever characters it has", () => {
    expect(consentNotice("en", "https://example.test/p?a=$&b=$1")).toMatch(/https:\/\/example\.test\/p\?a=\$&b=\$1$/);
  });

  it("is a fixed line with a {url} to fill, and never comes from the model", () => {
    for (const l of LANGS) expect(FIXED_TEXTS.consent_notice[l]).toContain("{url}");
  });
});

describe("textLanguage", () => {
  it("takes the first language it can write", () => {
    expect(textLanguage("ta-en", "en")).toBe("ta-en");
    expect(textLanguage("hi")).toBe("hi");
    expect(textLanguage("ta")).toBe("ta");
  });

  it("skips a language it has no lines for, and falls to the next, then English", () => {
    expect(textLanguage("ml", "ta")).toBe("ta");
    expect(textLanguage("other", null, undefined)).toBe("en");
    expect(textLanguage()).toBe("en");
    expect(textLanguage("fr")).toBe("en");
  });
});

describe("the lines about an area the business has no sites in (machine drafts: Raja and a native speaker still to check)", () => {
  const where = { area: "Adyar", areas: ["Velachery", "Tambaram", "Anna Nagar"] };

  it("are there in every language, with the places to fill in", () => {
    for (const language of LANGS) {
      expect(FIXED_TEXTS.area_options[language]).toContain("{area}");
      expect(FIXED_TEXTS.area_options[language]).toContain("{areas}");
      expect(FIXED_TEXTS.area_unavailable[language]).toContain("{area}");
      expect(FIXED_TEXTS.area_unavailable[language]).not.toContain("{areas}");
    }
  });

  it("the first line names the customer's area and lists every area the business has, in the business's order, and offers no time and no visit", () => {
    for (const language of LANGS) {
      const text = areaText("area_options", language, where);
      expect(text).toContain("Adyar");
      expect(text).toContain("Velachery, Tambaram, Anna Nagar");
      expect(text).not.toMatch(/[{}]/);
    }
  });

  it("the second line names the area and says there is nothing there for now, without listing areas again", () => {
    for (const language of LANGS) {
      const text = areaText("area_unavailable", language, where);
      expect(text).toContain("Adyar");
      expect(text).not.toContain("Velachery");
      expect(text).not.toMatch(/[{}]/);
    }
    expect(areaText("area_unavailable", "en", where)).toMatch(/don't have any property in Adyar for now/);
  });

  it("puts what it is given in as plain text (a replacement pattern is never read as one), and shows fixed words for anything outside the cleaner's characters", () => {
    expect(areaText("area_unavailable", "en", { area: "A&B (1) Nagar", areas: [] })).toContain("property in A&B (1) Nagar for now");
    expect(areaText("area_unavailable", "en", { area: "$& $1 {areas}", areas: [] })).toContain("property in the area you mentioned for now");
  });
});
