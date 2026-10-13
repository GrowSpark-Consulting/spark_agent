import { describe, expect, it } from "vitest";
import { CODE_SEARCH_CHARS, findRouteCode, GREETING } from "./code";

describe("the route code in a message to the demo number", () => {
  it("finds a demo code and a trial code", () => {
    expect(findRouteCode("DEMO-SALON")).toEqual({ code: "DEMO-SALON", rest: GREETING });
    expect(findRouteCode("TRIAL-7F3K")).toEqual({ code: "TRIAL-7F3K", rest: GREETING });
    expect(findRouteCode("DEMO-REALESTATE")?.code).toBe("DEMO-REALESTATE");
  });

  it("finds it in lower case and writes it as stored", () => {
    expect(findRouteCode("demo-interiors")).toEqual({ code: "DEMO-INTERIORS", rest: GREETING });
    expect(findRouteCode("trial-7f3k")?.code).toBe("TRIAL-7F3K");
  });

  it("finds it inside what a person says, and keeps the rest", () => {
    expect(findRouteCode("Hi, I want to try TRIAL-7F3K")).toEqual({ code: "TRIAL-7F3K", rest: "Hi, I want to try" });
    expect(findRouteCode("DEMO-SALON, do you have bridal packages?")).toEqual({ code: "DEMO-SALON", rest: "do you have bridal packages?" });
    expect(findRouteCode("வணக்கம் DEMO-SALON haircut price என்ன?")).toEqual({ code: "DEMO-SALON", rest: "வணக்கம் haircut price என்ன?" });
  });

  it("accepts the longer dashes a phone's keyboard makes", () => {
    expect(findRouteCode("DEMO–SALON")?.code).toBe("DEMO-SALON");
    expect(findRouteCode("TRIAL‑7F3K")?.code).toBe("TRIAL-7F3K");
  });

  it("does not take a code out of a longer word, number or code", () => {
    expect(findRouteCode("TRIAL-7F3KX")).toBeNull();
    expect(findRouteCode("TRIAL-7F3")).toBeNull();
    expect(findRouteCode("XDEMO-SALON")).toBeNull();
    expect(findRouteCode("MYTRIAL-7F3K")).toBeNull();
    expect(findRouteCode("DEMO-")).toBeNull();
    expect(findRouteCode("DEMO")).toBeNull();
  });

  it("finds nothing in an ordinary message", () => {
    expect(findRouteCode("Hello, what are your timings?")).toBeNull();
    expect(findRouteCode("")).toBeNull();
    expect(findRouteCode("demo please")).toBeNull();
  });

  it("takes the first of two codes", () => {
    expect(findRouteCode("DEMO-SALON or TRIAL-7F3K")).toEqual({ code: "DEMO-SALON", rest: "or TRIAL-7F3K" });
  });

  it("only looks at the start of a long message", () => {
    expect(findRouteCode(`${"a ".repeat(CODE_SEARCH_CHARS / 2)}DEMO-SALON`)).toBeNull();
    expect(findRouteCode(`DEMO-SALON ${"a".repeat(5000)}`)?.code).toBe("DEMO-SALON");
  });

  it("leaves the rest of the message as the person wrote it: line breaks, dashes and spacing", () => {
    expect(findRouteCode("DEMO-SALON\nline one\n\nline two  spaced")?.rest).toBe("line one\n\nline two  spaced");
    expect(findRouteCode("DEMO-SALON price – how much?")?.rest).toBe("price – how much?");
    expect(findRouteCode(`DEMO-SALON ${"x ".repeat(2000)}`.trimEnd())?.rest).toBe("x ".repeat(2000).trimEnd());
  });

  it("accepts a code followed by a dash", () => {
    expect(findRouteCode("DEMO-SALON-")).toEqual({ code: "DEMO-SALON", rest: GREETING });
    expect(findRouteCode("TRIAL-7F3K—hello")).toEqual({ code: "TRIAL-7F3K", rest: "hello" });
  });

  it("handles awkward text without throwing", () => {
    expect(findRouteCode("DEMO-SALON\u0000\u0007")?.code).toBe("DEMO-SALON");
    expect(findRouteCode("😀 TRIAL-7F3K 😀")).toEqual({ code: "TRIAL-7F3K", rest: GREETING });
    expect(findRouteCode("!!! DEMO-SALON ???")?.rest).toBe(GREETING); // only punctuation is left
    expect(() => findRouteCode("DEMO-" + "A".repeat(100000))).not.toThrow();
  });
});
