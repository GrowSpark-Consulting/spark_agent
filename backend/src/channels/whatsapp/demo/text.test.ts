import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectLanguage, menuChoice, replyText, type Lang, type MenuEntry, type ReplyKind } from "./text";

// What a visitor to the shared demo number is told and how their words are read (PR 1b). Code only: no model. The Tamil and Tanglish wording is
// a MACHINE DRAFT that a native speaker must review before real visitors see it (docs/task-notes/2026-10-13-day6-dev1-demo-menu.md).

const MENU: MenuEntry[] = [
  { code: "DEMO-INTERIORS", label: "Interior design" },
  { code: "DEMO-REALESTATE", label: "Real estate" },
  { code: "DEMO-SALON", label: "Beauty parlour" },
];
const APP = "https://app.example.test";
const KINDS: ReplyKind[] = ["menu", "bad_code", "limit", "trial_taken"];
const LANGS: Lang[] = ["en", "ta", "tanglish"];

describe("the language of a visitor's message", () => {
  it("Tamil script is Tamil, even with English words mixed in", () => {
    expect(detectLanguage("வணக்கம்")).toBe("ta");
    expect(detectLanguage("hello வணக்கம் price?")).toBe("ta");
  });

  it("Roman letters with a Tanglish word are Tanglish, in any case", () => {
    for (const text of ["vanakkam", "Price enna?", "Enna rate irukku", "demo venum", "sollunga sir", "ROMBA nandri"]) expect(detectLanguage(text)).toBe("tanglish");
  });

  it("a marker has to be a whole word: it is not found inside another word", () => {
    for (const text of ["Villa for sale", "Hello", "I want a villa", "illusion", "pannuna"]) expect(detectLanguage(text)).toBe("en");
  });

  it("anything else, or nothing, is English", () => {
    expect(detectLanguage("Hi, what are your timings?")).toBe("en");
    expect(detectLanguage("1")).toBe("en");
    expect(detectLanguage("")).toBe("en");
    expect(detectLanguage(undefined)).toBe("en");
  });
});

describe("a menu pick", () => {
  it("a number picks that entry of the list", () => {
    expect(menuChoice("1", MENU)?.code).toBe("DEMO-INTERIORS");
    expect(menuChoice(" 3 ", MENU)?.code).toBe("DEMO-SALON");
    expect(menuChoice("2.", MENU)?.code).toBe("DEMO-REALESTATE");
    expect(menuChoice("02", MENU)?.code).toBe("DEMO-REALESTATE");
  });

  it("a number outside the list picks nothing", () => {
    for (const text of ["0", "4", "99", "-1", "1.5", "10"]) expect(menuChoice(text, MENU)).toBeNull();
  });

  it("the entry's own words pick it: its label, or its code without the prefix", () => {
    expect(menuChoice("salon", MENU)?.code).toBe("DEMO-SALON");
    expect(menuChoice("Real Estate", MENU)?.code).toBe("DEMO-REALESTATE");
    expect(menuChoice("beauty parlour!", MENU)?.code).toBe("DEMO-SALON");
    expect(menuChoice("INTERIORS", MENU)?.code).toBe("DEMO-INTERIORS");
  });

  it("a sentence, a different word, nothing or a very long text picks nothing", () => {
    for (const text of ["salon please", "hello", "", "   ", "x".repeat(500), "real", "demo"]) expect(menuChoice(text, MENU)).toBeNull();
    expect(menuChoice(undefined, MENU)).toBeNull();
  });

  it("two entries with the same words are ambiguous by those words, and a number still picks between them", () => {
    const same: MenuEntry[] = [{ code: "DEMO-A", label: "Beauty parlour" }, { code: "DEMO-B", label: "Beauty parlour" }];
    expect(menuChoice("beauty parlour", same)).toBeNull();
    expect(menuChoice("2", same)?.code).toBe("DEMO-B");
  });

  it("with no menu, nothing can be picked", () => {
    expect(menuChoice("1", [])).toBeNull();
    expect(menuChoice("salon", [])).toBeNull();
  });
});

describe("what the visitor is told", () => {
  it("every message exists in every language, is one string with nothing left unfilled, and has no placeholder text in it", () => {
    for (const kind of KINDS) {
      for (const lang of LANGS) {
        const text = replyText(kind, lang, MENU, APP);
        expect(text.length).toBeGreaterThan(20);
        expect(text).not.toMatch(/undefined|null|\{\w*\}/);
      }
    }
  });

  it("the menu lists each entry with its number, label and code, in the order given, in every language", () => {
    for (const lang of LANGS) {
      const text = replyText("menu", lang, MENU, APP);
      const lines = text.split("\n");
      expect(lines.slice(-3)).toEqual(["1. Interior design: DEMO-INTERIORS", "2. Real estate: DEMO-REALESTATE", "3. Beauty parlour: DEMO-SALON"]);
    }
  });

  it("an invalid code is answered with the menu again", () => {
    for (const lang of LANGS) expect(replyText("bad_code", lang, MENU, APP)).toContain("1. Interior design: DEMO-INTERIORS");
  });

  it("the daily limit and the used trial point to the app, whose root is the link", () => {
    for (const lang of LANGS) {
      expect(replyText("limit", lang, MENU, APP)).toContain(APP);
      expect(replyText("trial_taken", lang, MENU, APP)).toContain(APP);
    }
    expect(replyText("limit", "en", MENU, `${APP}/`)).toContain(`${APP}`);
    expect(replyText("limit", "en", MENU, `${APP}/`)).not.toContain(`${APP}/ `);
    expect(replyText("limit", "en", MENU, APP)).toContain("30");
  });

  it("the Tamil messages are in Tamil script and the Tanglish ones are in Roman letters only", () => {
    for (const kind of KINDS) {
      expect(replyText(kind, "ta", MENU, APP)).toMatch(/[஀-௿]/);
      expect(replyText(kind, "tanglish", MENU, APP)).not.toMatch(/[஀-௿]/);
      expect(replyText(kind, "en", MENU, APP)).not.toMatch(/[஀-௿]/);
    }
  });

  it("without a menu to show (none is set up) the message still reads properly, with no empty list", () => {
    for (const lang of LANGS) {
      const text = replyText("menu", lang, [], APP);
      expect(text.length).toBeGreaterThan(20);
      expect(text).not.toMatch(/^\d+\. /m);
    }
  });

  it("a label or code cannot break the layout: line breaks in them are flattened", () => {
    const text = replyText("menu", "en", [{ code: "DEMO-X", label: "Two\nlines\r\n here" }], APP);
    expect(text.split("\n").slice(-1)[0]).toBe("1. Two lines here: DEMO-X");
  });

  it("the greeting picks up the demo's own name and says it is the Spark Agent demo", () => {
    expect(replyText("menu", "en", MENU, APP)).toContain("Spark Agent");
  });
});

describe("the source", () => {
  it("names no industry: the menu comes from data (the lint rule for code that branches on one is in lint-rules)", () => {
    const source = readFileSync(new URL("./text.ts", import.meta.url), "utf8");
    for (const word of ["real estate", "real-estate", "realestate", "salon", "interiors", "parlour", "clinic", "restaurant"]) expect(source.toLowerCase()).not.toContain(word);
  });

  it("says in its header that the Tamil and Tanglish wording is a draft to be reviewed", () => {
    const source = readFileSync(new URL("./text.ts", import.meta.url), "utf8");
    expect(source).toMatch(/MACHINE DRAFT/);
    expect(source).toMatch(/native speaker/i);
  });
});
