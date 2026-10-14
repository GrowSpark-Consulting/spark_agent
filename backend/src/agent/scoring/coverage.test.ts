import { describe, expect, it } from "vitest";
import { coverageRule, MAX_AREA_NAME_CHARS, MAX_LISTED_AREAS, MAX_SHOWN_CHARS, normaliseArea, readCoverage } from "./coverage";

// Where the customer wants to be, against where the business has sites. Plain code: the pack names the field and the area matcher
// (or, for a pack published before `coverage` existed, its own area scoring rule does), the business's catalog names the places.

const scoring = (rules: { field: string; match?: string; points: number }[]) => ({ rules, thresholds: { hot: 70, warm: 40 }, hardFails: [] });

describe("coverageRule", () => {
  it("is the pack's own coverage block when it has one", () => {
    expect(coverageRule({ coverage: { field: "city", match: "in_branch_areas" }, scoring: scoring([{ field: "location", match: "in_project_areas", points: 20 }]) })).toEqual({ field: "city", match: "in_branch_areas" });
  });

  it("is the pack's first area scoring rule when it has no coverage block, so a pack published before the block still works", () => {
    expect(coverageRule({ scoring: scoring([{ field: "budget", match: "within_project_band", points: 30 }, { field: "location", match: "in_project_areas", points: 20 }]) })).toEqual({ field: "location", match: "in_project_areas" });
    expect(coverageRule({ scoring: scoring([{ field: "pincode", match: "in_service_area", points: 10 }]) })).toEqual({ field: "pincode", match: "in_service_area" });
  });

  it("is null for a pack with no notion of where it works", () => {
    expect(coverageRule({ scoring: scoring([{ field: "budget", match: "within_service_band", points: 30 }]) })).toBeNull();
  });
});

describe("normaliseArea", () => {
  it.each([
    ["  Adyar. ", "adyar"],
    ["ADYAR!!", "adyar"],
    ["Anna   Nagar", "anna nagar"],
    ["600 042", "600042"],
    ["600-042", "600042"],
    ["வேளச்சேரி,", "வேளச்சேரி"],
    ["", ""],
  ])("%j is %j", (text, wanted) => expect(normaliseArea(text)).toBe(wanted));
});

const rule = { field: "location", match: "in_project_areas" };
const refs = { project_areas: ["Velachery", "Tambaram", "Anna Nagar"] };

describe("readCoverage", () => {
  it("is served for an area the business has, in any letter case and with stray words around it", () => {
    expect(readCoverage(rule, refs, "velachery")).toMatchObject({ served: true, area: "velachery" });
    expect(readCoverage(rule, refs, "somewhere in Anna Nagar please")?.served).toBe(true);
  });

  it("is unserved for an area the business does not have, and carries the areas it does have, as the business wrote them", () => {
    expect(readCoverage(rule, refs, "Adyar")).toEqual({ served: false, area: "adyar", shown: "Adyar", areas: ["Velachery", "Tambaram", "Anna Nagar"] });
  });

  it("judges a place whose name has punctuation the customer left out or moved: the catalog's own spelling is compared as the customer's is", () => {
    const dotted = { project_areas: ["T. Nagar", "K.K. Nagar", "Anna Nagar-2"] };
    expect(readCoverage(rule, dotted, "T Nagar")?.served).toBe(true);
    expect(readCoverage(rule, dotted, "t.nagar")?.served).toBe(true);
    expect(readCoverage(rule, dotted, "K K Nagar")?.served).toBe(true);
    expect(readCoverage(rule, dotted, "anna nagar 2")?.served).toBe(true);
    expect(readCoverage(rule, dotted, "T. Nagar")?.areas).toEqual(["T. Nagar", "K.K. Nagar", "Anna Nagar-2"]); // listed as the business wrote them
  });

  it("does not take a part of a word for the area", () => {
    expect(readCoverage(rule, { project_areas: ["Anna"] }, "Annanagar")?.served).toBe(false);
  });

  it("judges a pincode typed with a space or a dash", () => {
    const pin = { field: "pincode", match: "in_service_area" };
    const places = { service_areas: ["600042", "600020"] };
    expect(readCoverage(pin, places, "600 042")?.served).toBe(true);
    expect(readCoverage(pin, places, "600-020")?.served).toBe(true);
    expect(readCoverage(pin, places, "641001")).toMatchObject({ served: false, area: "641001", areas: ["600042", "600020"] });
  });

  it("takes a number the model sent as a number", () => {
    expect(readCoverage({ field: "pincode", match: "in_service_area" }, { service_areas: ["600042"] }, 600042)?.served).toBe(true);
  });

  it("says nothing when the customer gave no area, or only spaces", () => {
    expect(readCoverage(rule, refs, undefined)).toBeNull();
    expect(readCoverage(rule, refs, null)).toBeNull();
    expect(readCoverage(rule, refs, "   ")).toBeNull();
    expect(readCoverage(rule, refs, { place: "Adyar" })).toBeNull();
  });

  it("says nothing when the business has listed no areas: it cannot be judged, so nobody is turned away", () => {
    expect(readCoverage(rule, {}, "Adyar")).toBeNull();
    expect(readCoverage(rule, { project_areas: [] }, "Adyar")).toBeNull();
    expect(readCoverage(rule, { project_areas: ["  "] }, "Adyar")).toBeNull();
  });

  it("says nothing for a matcher that is not an area matcher", () => {
    expect(readCoverage({ field: "location", match: "within_project_band" }, refs, "Adyar")).toBeNull();
  });

  it(`lists at most ${MAX_LISTED_AREAS} areas, in the catalog's order`, () => {
    const many = { project_areas: ["A1", "B2", "C3", "D4", "E5", "F6", "G7", "H8"] };
    expect(readCoverage(rule, many, "Adyar")?.areas).toEqual(["A1", "B2", "C3", "D4", "E5", "F6"]);
  });

  it(`cuts a very long area name the business typed to ${MAX_AREA_NAME_CHARS} characters, so one reply stays short`, () => {
    const read = readCoverage(rule, { project_areas: ["V".repeat(500), "Tambaram"] }, "Adyar");
    expect([...(read?.areas[0] ?? "")]).toHaveLength(MAX_AREA_NAME_CHARS);
    expect(read?.areas[1]).toBe("Tambaram");
  });

  it(`shows the customer's own words cut to ${MAX_SHOWN_CHARS} characters, on one line, without control characters, and never inside an emoji`, () => {
    const long = readCoverage(rule, refs, `${"x".repeat(60)}`);
    expect([...(long?.shown ?? "")]).toHaveLength(MAX_SHOWN_CHARS);
    expect(readCoverage(rule, refs, "Ad\nyar\u0007")?.shown).toBe("Ad yar");
    const emoji = readCoverage(rule, refs, `${"y".repeat(MAX_SHOWN_CHARS - 1)}😀😀`);
    expect(emoji?.shown.endsWith("😀")).toBe(true);
    expect([...(emoji?.shown ?? "")]).toHaveLength(MAX_SHOWN_CHARS);
  });
});
