import { describe, expect, it } from "vitest";
import { isReadablePlace, placeSkeleton, sameAreaInAnotherSpelling } from "./area-match";
import { judge } from "./score";
import { readCoverage } from "./coverage";

// A place the customer wrote in another script or spelling against the places the business listed (fix/agent-live-findings-2).
// Found by a live run: "பெரும்பாக்கம்", "பள்ளிக்கரணை", "ग्रेटर नोएडा वेस्ट" and "gr noida west" were told "we have no site there" although the place WAS on the list.
// Plain code: the customer's words are only ever compared with the business's own list.

const listed = ["Perumbakkam", "Pallikaranai", "Greater Noida West", "Yamuna Expressway", "Medavakkam", "Sholinganallur", "Velachery", "Tambaram", "Adyar"];
const which = (text: string) => listed.find((area) => sameAreaInAnotherSpelling(text, area)) ?? null;

describe("sameAreaInAnotherSpelling: a listed place written another way is the same place", () => {
  it.each([
    // Tamil script
    ["பெரும்பாக்கம்", "Perumbakkam"],
    ["பெரும்பாக்கத்துல", "Perumbakkam"],
    ["பெரும்பாக்கத்தில் வீடு", "Perumbakkam"],
    ["பள்ளிக்கரணை", "Pallikaranai"],
    ["மேடவாக்கம்", "Medavakkam"],
    ["வேளச்சேரி", "Velachery"],
    ["தாம்பரம்", "Tambaram"],
    ["அடையார்", "Adyar"],
    // Devanagari
    ["ग्रेटर नोएडा वेस्ट", "Greater Noida West"],
    ["ग्रेटर नोएडा वेस्ट में", "Greater Noida West"],
    ["यमुना एक्सप्रेसवे", "Yamuna Expressway"],
    // Latin: another spelling, an abbreviation
    ["gr noida west", "Greater Noida West"],
    ["Gr. Noida West", "Greater Noida West"],
    ["greater noida west", "Greater Noida West"],
    ["medavakam", "Medavakkam"],
    ["Perumbakam", "Perumbakkam"],
    ["Sholinganalur", "Sholinganallur"],
    ["pallikarnai", "Pallikaranai"],
    ["somewhere near medavakam please", "Medavakkam"],
  ])("%s is %s", (text, area) => {
    expect(which(text)).toBe(area);
  });

  it.each([
    ["Anna Nagar"],
    ["அண்ணா நகர்"],
    ["Gurgaon"],
    ["गुड़गांव"],
    ["Noida"],
    ["Greater Kailash"],
  ])("%s is not one of the listed places", (text) => {
    expect(which(text)).toBeNull();
  });

  it("an unlisted Tamil place is not listed for a business that has no Adyar", () => {
    expect(sameAreaInAnotherSpelling("அடையாரில்", "Velachery")).toBe(false);
    expect(sameAreaInAnotherSpelling("Adyar", "Velachery")).toBe(false);
  });

  it("a longer word that merely starts like a place is not that place (as for Latin letters before)", () => {
    expect(sameAreaInAnotherSpelling("Adyarpet", "Adyar")).toBe(false);
    expect(sameAreaInAnotherSpelling("Velacherypuram", "Velachery")).toBe(false);
  });

  it("a short name is never matched by sound alone (too many places would collide)", () => {
    expect(sameAreaInAnotherSpelling("Ooty", "Oti")).toBe(false);
  });

  it("a pincode is exact", () => {
    expect(sameAreaInAnotherSpelling("600042", "600042")).toBe(false); // exact digits are the old matcher's job
    expect(sameAreaInAnotherSpelling("600043", "600042")).toBe(false);
  });

  it("an empty text or an empty name matches nothing", () => {
    expect(sameAreaInAnotherSpelling("", "Adyar")).toBe(false);
    expect(sameAreaInAnotherSpelling("Adyar", "")).toBe(false);
    expect(sameAreaInAnotherSpelling("!!!", "Adyar")).toBe(false);
  });
});

describe("placeSkeleton", () => {
  it("is the same for the same sounds in different scripts and spellings", () => {
    expect(placeSkeleton("பள்ளிக்கரணை")).toBe(placeSkeleton("Pallikaranai"));
    expect(placeSkeleton("medavakam")).toBe(placeSkeleton("Medavakkam"));
    expect(placeSkeleton("यमुना")).toBe(placeSkeleton("Yamuna"));
  });
  it("differs for different places", () => {
    expect(placeSkeleton("Anna Nagar")).not.toBe(placeSkeleton("Perumbakkam"));
  });
});

describe("isReadablePlace: only Latin, Tamil and Devanagari letters can be judged", () => {
  it.each([["Adyar", true], ["அடையார்", true], ["गुड़गांव", true], ["600 042", true], ["Anna Nagar 2nd street", true], ["", true]])("%j is %j", (text, readable) => {
    expect(isReadablePlace(text)).toBe(readable);
  });
  it.each([["കൊച്ചി"], ["హైదరాబాద్"], ["ಬೆಂಗಳೂರು"], ["القاهرة"], ["東京"]])("%j is not readable", (text) => {
    expect(isReadablePlace(text)).toBe(false);
  });
});

describe("the area check the scoring and the 'no site there' line both use", () => {
  const refs = { project_areas: ["Perumbakkam", "Pallikaranai", "Greater Noida West", "Yamuna Expressway"] };
  const ctx = { references: refs };
  const rule = { field: "location", match: "in_project_areas" };

  it.each([["பெரும்பாக்கம்"], ["பள்ளிக்கரணை"], ["ग्रेटर नोएडा वेस्ट"], ["gr noida west"], ["Greater Noida West"], ["perumbakam"]])("%s is a listed place (judge)", (text) => {
    expect(judge("in_project_areas", text, ctx)).toBe(true);
  });

  it.each([["Anna Nagar"], ["அண்ணா நகர்"], ["Gurgaon"], ["गुड़गांव"]])("%s is not listed (judge says false, so the options line follows)", (text) => {
    expect(judge("in_project_areas", text, ctx)).toBe(false);
  });

  it("a place nobody can read is unjudged, never 'not listed'", () => {
    expect(judge("in_project_areas", "കൊച്ചി", ctx)).toBeUndefined();
    expect(judge("in_project_areas", "東京", ctx)).toBeUndefined();
  });

  it("readCoverage: a place in another script is served, with the business's own names listed", () => {
    expect(readCoverage(rule, refs, "பெரும்பாக்கம்")).toMatchObject({ served: true });
    expect(readCoverage(rule, refs, "ग्रेटर नोएडा वेस्ट")).toMatchObject({ served: true });
    expect(readCoverage(rule, refs, "gr noida west")).toMatchObject({ served: true });
  });

  it("readCoverage: a place that is truly not listed still gets the areas, in either script", () => {
    expect(readCoverage(rule, refs, "அண்ணா நகர்")).toMatchObject({ served: false, areas: ["Perumbakkam", "Pallikaranai", "Greater Noida West", "Yamuna Expressway"] });
    expect(readCoverage(rule, refs, "गुड़गांव")).toMatchObject({ served: false });
    expect(readCoverage(rule, refs, "Gurgaon")).toMatchObject({ served: false });
  });

  it("readCoverage: a place in a script nobody can read is null, so nobody is told 'no site there'", () => {
    expect(readCoverage(rule, refs, "കൊച്ചി")).toBeNull();
  });

  it("listed places in Latin letters keep working exactly as before", () => {
    expect(judge("in_project_areas", "perumbakkam", ctx)).toBe(true);
    expect(judge("in_project_areas", "I want something in Pallikaranai please", ctx)).toBe(true);
    expect(judge("in_project_areas", "Perumbakkamx", ctx)).toBe(false);
    expect(judge("in_project_areas", "Pallikaranaipet", ctx)).toBe(false);
    expect(judge("in_project_areas", 12, ctx)).toBe(false);
  });
});

// Places that sound alike but are different places must NOT match (they are neighbours in Chennai: a customer in one is not served by a site in the other).
describe("look-alike places are different places", () => {
  it.each([
    ["Velachery", "Valasaravakkam"],
    ["Perungudi", "Perumbakkam"],
    ["Pallikaranai", "Pallavaram"],
  ])("%s is not %s, in either direction and in Tamil script", (a, b) => {
    expect(sameAreaInAnotherSpelling(a, b)).toBe(false);
    expect(sameAreaInAnotherSpelling(b, a)).toBe(false);
    expect(placeSkeleton(a)).not.toBe(placeSkeleton(b));
  });

  it.each([
    ["வேளச்சேரி", "Valasaravakkam"],
    ["வளசரவாக்கம்", "Velachery"],
    ["பெருங்குடி", "Perumbakkam"],
    ["பெரும்பாக்கம்", "Perungudi"],
    ["பள்ளிக்கரணை", "Pallavaram"],
    ["பல்லாவரம்", "Pallikaranai"],
  ])("%s is not %s", (customer, listedArea) => {
    expect(sameAreaInAnotherSpelling(customer, listedArea)).toBe(false);
  });

  it("through the whole area check: each look-alike is 'not listed' when only its neighbour is listed", () => {
    const only = (name: string) => ({ references: { project_areas: [name] } });
    expect(judge("in_project_areas", "Velachery", only("Valasaravakkam"))).toBe(false);
    expect(judge("in_project_areas", "Perungudi", only("Perumbakkam"))).toBe(false);
    expect(judge("in_project_areas", "Pallikaranai", only("Pallavaram"))).toBe(false);
    expect(judge("in_project_areas", "Pallavaram", only("Pallikaranai"))).toBe(false);
    expect(judge("in_project_areas", "பெருங்குடி", only("Perumbakkam"))).toBe(false);
  });
});

describe("a part of a listed name is not the place", () => {
  it("'Noida' alone is not 'Greater Noida West' (all the listed words must be there), so it gets the options line", () => {
    expect(sameAreaInAnotherSpelling("Noida", "Greater Noida West")).toBe(false);
    expect(sameAreaInAnotherSpelling("நொய்டா", "Greater Noida West")).toBe(false);
    expect(sameAreaInAnotherSpelling("नोएडा", "Greater Noida West")).toBe(false);
    expect(judge("in_project_areas", "Noida", { references: { project_areas: ["Greater Noida West", "Yamuna Expressway"] } })).toBe(false);
    expect(readCoverage({ field: "location", match: "in_project_areas" }, { project_areas: ["Greater Noida West", "Yamuna Expressway"] }, "Noida")).toMatchObject({ served: false });
  });

  it("'Greater Noida' without 'West' is not 'Greater Noida West' either", () => {
    expect(sameAreaInAnotherSpelling("Greater Noida", "Greater Noida West")).toBe(false);
  });
});
