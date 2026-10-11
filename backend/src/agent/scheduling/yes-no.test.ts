import { describe, expect, it } from "vitest";
import { readYesNo } from "./yes-no";

describe("a yes or a no to 'shall I cancel it?'", () => {
  it.each([
    ["yes"],
    ["Yes please"],
    ["yeah"],
    ["yep"],
    ["sure"],
    ["ok"],
    ["okay, go ahead"],
    ["cancel it"],
    ["yes cancel it"],
    ["please cancel"],
    ["go ahead"],
    ["confirm"],
    ["haan"],
    ["aama"],
    ["ஆமா"],
    ["சரி"],
    ["yes, please cancel my visit"],
  ])("%s is a yes", (text) => {
    expect(readYesNo(text)).toBe("yes");
  });

  it.each([
    ["no"],
    ["No thanks"],
    ["nope"],
    ["don't cancel"],
    ["do not cancel it"],
    ["dont cancel"],
    ["keep it"],
    ["keep my booking"],
    ["never mind"],
    ["not now"],
    ["leave it"],
    ["illa"],
    ["venam"],
    ["இல்லை"],
    ["no, keep it"],
  ])("%s is a no", (text) => {
    expect(readYesNo(text)).toBe("no");
  });

  it.each([[""], ["   "], ["?"], ["what time is it at"], ["maybe"], ["yes, don't cancel"], ["no, cancel it"], ["hello"], ["2BHK in Velachery"]])("%j is not an answer", (text) => {
    expect(readYesNo(text)).toBe("unclear");
  });

  it("never throws on odd text", () => {
    for (const text of ["😀", "a".repeat(5000), "\u0000", "yes".repeat(1000)]) expect(() => readYesNo(text)).not.toThrow();
  });
});
