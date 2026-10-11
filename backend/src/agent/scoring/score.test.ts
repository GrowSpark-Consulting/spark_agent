import { readFileSync } from "node:fs";
import { PackDefinition } from "@pakka/types";
import { describe, expect, it } from "vitest";
import { resolvePack } from "../packs/load";
import { deepFreeze, samplePack } from "../packs/test-packs";
import { scoreLead, type ScoringContext } from "./score";

const LAKH = 100_000;

// A neutral pack in the real-estate shape. No industry names: the engine reads rules, not trades.
const pack = (scoring: Record<string, unknown> = {}) =>
  PackDefinition.parse(
    samplePack({
      fields: [
        { key: "budget", label: "Budget", type: "range_inr", required: true },
        { key: "location", label: "Area", type: "text", required: true },
        { key: "timeline", label: "Timeline", type: "enum", options: ["0-3m", "3-6m", "6m+"], required: true },
        { key: "funding", label: "Funding", type: "enum", options: ["loan_approved", "loan_needed", "own_funds"] },
        { key: "decision_maker", label: "Buyer", type: "boolean" },
        { key: "party", label: "Party size", type: "int" },
      ],
      scoring: {
        rules: [
          { field: "budget", match: "within_project_band", points: 30 },
          { field: "timeline", equals: "0-3m", points: 25 },
          { field: "location", match: "in_project_areas", points: 20 },
          { field: "funding", in: ["loan_approved", "own_funds"], points: 15 },
          { field: "decision_maker", equals: true, points: 10 },
        ],
        thresholds: { hot: 70, warm: 40 },
        hardFails: [{ field: "budget", below: "min_project_price" }],
        ...scoring,
      },
    }),
  );

const context: ScoringContext = {
  references: {
    project_bands: [
      { min: 50 * LAKH, max: 80 * LAKH },
      { min: 90 * LAKH, max: 120 * LAKH },
    ],
    project_areas: ["Velachery", "OMR"],
    min_project_price: 50 * LAKH,
  },
};

const hotFields = { budget: "60L", timeline: "0-3m", location: "Velachery", funding: "own_funds", decision_maker: true };

describe("temperature from the pack's thresholds", () => {
  it("a lead that matches every rule is hot with the full points", () => {
    const result = scoreLead(pack(), hotFields, context);
    expect(result.score).toBe(100);
    expect(result.temperature).toBe("hot");
    expect(result.hardFail).toBeNull();
    expect(result.matched).toEqual([
      { field: "budget", points: 30 },
      { field: "timeline", points: 25 },
      { field: "location", points: 20 },
      { field: "funding", points: 15 },
      { field: "decision_maker", points: 10 },
    ]);
  });

  it("a score at the hot threshold is hot, one under it is warm", () => {
    expect(scoreLead(pack(), { budget: "60L", timeline: "0-3m", location: "Velachery" }, context)).toMatchObject({ score: 75, temperature: "hot" });
    expect(scoreLead(pack({ thresholds: { hot: 76, warm: 40 } }), { budget: "60L", timeline: "0-3m", location: "Velachery" }, context)).toMatchObject({ score: 75, temperature: "warm" });
  });

  it("a score at the warm threshold is warm, one under it is cold", () => {
    expect(scoreLead(pack(), { budget: "60L", funding: "own_funds" }, context)).toMatchObject({ score: 45, temperature: "warm" });
    expect(scoreLead(pack({ thresholds: { hot: 70, warm: 46 } }), { budget: "60L", funding: "own_funds" }, context)).toMatchObject({ score: 45, temperature: "cold" });
    expect(scoreLead(pack({ thresholds: { hot: 70, warm: 45 } }), { budget: "60L", funding: "own_funds" }, context)).toMatchObject({ temperature: "warm" });
  });

  it("a lead with no answers is cold with 0 points", () => {
    expect(scoreLead(pack(), {}, context)).toEqual({ score: 0, temperature: "cold", hardFail: null, matched: [], unscored: [] });
  });

  it("two rules on one field both count", () => {
    const p = pack({ rules: [{ field: "party", gte: 2, points: 5 }, { field: "party", gte: 4, points: 10 }] });
    expect(scoreLead(p, { party: 4 }, context).score).toBe(15);
    expect(scoreLead(p, { party: 2 }, context).score).toBe(5);
  });
});

describe("how a rule reads an answer", () => {
  it("equals ignores case and spaces, and reads true/false typed as text", () => {
    const p = pack({ rules: [{ field: "timeline", equals: "0-3m", points: 1 }, { field: "decision_maker", equals: true, points: 2 }] });
    expect(scoreLead(p, { timeline: " 0-3M ", decision_maker: "true" }, context).score).toBe(3);
    expect(scoreLead(p, { timeline: "3-6m", decision_maker: false }, context).score).toBe(0);
  });

  it("in matches any listed value", () => {
    const p = pack({ rules: [{ field: "funding", in: ["loan_approved", "own_funds"], points: 15 }] });
    expect(scoreLead(p, { funding: "loan_approved" }, context).score).toBe(15);
    expect(scoreLead(p, { funding: "loan_needed" }, context).score).toBe(0);
  });

  it("gte reads a number, or numbers typed as text, and ignores text that is not a number", () => {
    const p = pack({ rules: [{ field: "party", gte: 4, points: 10 }] });
    expect(scoreLead(p, { party: 4 }, context).score).toBe(10);
    expect(scoreLead(p, { party: "5" }, context).score).toBe(10);
    expect(scoreLead(p, { party: 3 }, context).score).toBe(0);
    expect(scoreLead(p, { party: "many" }, context).score).toBe(0);
  });

  it("a rule on an answer not given earns nothing", () => {
    expect(scoreLead(pack(), { budget: "60L" }, context).score).toBe(30);
  });

  it("a rule that lists more than one condition needs all of them", () => {
    const p = pack({ rules: [{ field: "party", gte: 2, in: [2, 3], points: 10 }] });
    expect(scoreLead(p, { party: 3 }, context).score).toBe(10);
    expect(scoreLead(p, { party: 5 }, context).score).toBe(0);
  });
});

describe("named matchers", () => {
  it("within_project_band: the budget touches one of the business's price bands", () => {
    const p = pack({ rules: [{ field: "budget", match: "within_project_band", points: 30 }] });
    expect(scoreLead(p, { budget: "60L" }, context).score).toBe(30);
    expect(scoreLead(p, { budget: "95L" }, context).score).toBe(30);
    expect(scoreLead(p, { budget: "40-55L" }, context).score).toBe(30); // the top of the range reaches the band
    expect(scoreLead(p, { budget: "85L" }, context).score).toBe(0); // between two bands
    expect(scoreLead(p, { budget: "30L" }, context).score).toBe(0);
  });

  it("a band with no upper price has no ceiling", () => {
    const p = pack({ rules: [{ field: "budget", match: "within_project_band", points: 30 }] });
    const open: ScoringContext = { references: { project_bands: [{ min: 50 * LAKH }] } };
    expect(scoreLead(p, { budget: "5Cr" }, open).score).toBe(30);
    expect(scoreLead(p, { budget: "20L" }, open).score).toBe(0);
  });

  it("in_project_areas: the area named is one of the business's, ignoring case, and found inside a longer answer", () => {
    const p = pack({ rules: [{ field: "location", match: "in_project_areas", points: 20 }] });
    expect(scoreLead(p, { location: "velachery" }, context).score).toBe(20);
    expect(scoreLead(p, { location: "somewhere near Velachery station" }, context).score).toBe(20);
    expect(scoreLead(p, { location: "omr" }, context).score).toBe(20);
    expect(scoreLead(p, { location: "Anna Nagar" }, context).score).toBe(0);
  });

  it("an area is a whole word, not a piece of one", () => {
    const p = pack({ rules: [{ field: "location", match: "in_project_areas", points: 20 }] });
    expect(scoreLead(p, { location: "Zoomr" }, context).score).toBe(0);
  });

  it("with no price bands or areas on file the rule earns nothing and is reported, not guessed", () => {
    const result = scoreLead(pack(), { budget: "60L", location: "Velachery" }, {});
    expect(result.score).toBe(0);
    expect(result.unscored).toEqual(["budget", "location"]);
  });

  it("a matcher the engine does not know earns nothing and is reported", () => {
    const p = pack({ rules: [{ field: "budget", match: "made_up_matcher", points: 30 }, { field: "timeline", equals: "0-3m", points: 25 }] });
    const result = scoreLead(p, { budget: "60L", timeline: "0-3m" }, context);
    expect(result.score).toBe(25);
    expect(result.unscored).toEqual(["budget"]);
  });
});

describe("hard fails", () => {
  it("a budget that tops out below the cheapest price disqualifies, whatever else scored", () => {
    const result = scoreLead(pack(), { ...hotFields, budget: "20L" }, context);
    expect(result).toMatchObject({ score: 0, temperature: "disqualified", matched: [] });
    expect(result.hardFail).toEqual({ field: "budget", rule: "below min_project_price" });
  });

  it("only when every part of the budget is below: a range that reaches the minimum is not failed", () => {
    expect(scoreLead(pack(), { ...hotFields, budget: "40-55L" }, context).temperature).toBe("hot");
  });

  it("exactly the minimum is not below it", () => {
    expect(scoreLead(pack(), { ...hotFields, budget: "50L" }, context).temperature).toBe("hot");
  });

  it("never fails a lead it cannot judge: no budget, a budget it cannot read, or no minimum on file", () => {
    expect(scoreLead(pack(), { timeline: "0-3m" }, context).temperature).not.toBe("disqualified");
    expect(scoreLead(pack(), { budget: "whatever works" }, context).temperature).not.toBe("disqualified");
    expect(scoreLead(pack(), { budget: "5L" }, {}).temperature).not.toBe("disqualified");
  });

  it("a number in the hard fail is the limit itself", () => {
    const p = pack({ hardFails: [{ field: "budget", below: 3_000_000 }] });
    expect(scoreLead(p, { budget: "20L" }, context).temperature).toBe("disqualified");
    expect(scoreLead(p, { budget: "40L" }, context).temperature).not.toBe("disqualified");
  });

  it("a hard fail that names a matcher fails when the answer does not match", () => {
    const p = pack({ hardFails: [{ field: "location", match: "in_project_areas" }] });
    expect(scoreLead(p, { location: "Anna Nagar" }, context).temperature).toBe("disqualified");
    expect(scoreLead(p, { location: "Velachery" }, context).temperature).not.toBe("disqualified");
    expect(scoreLead(p, {}, context).temperature).not.toBe("disqualified");
    expect(scoreLead(p, { location: "Anna Nagar" }, {}).temperature).not.toBe("disqualified");
  });

  it("reports the first hard fail when there are several", () => {
    const p = pack({ hardFails: [{ field: "budget", below: 3_000_000 }, { field: "budget", below: 9_000_000 }] });
    expect(scoreLead(p, { budget: "20L" }, context).hardFail).toEqual({ field: "budget", rule: "below 3000000" });
  });
});

describe("the business's own overrides (merged by the pack loader)", () => {
  const raw = () => JSON.parse(readFileSync(new URL("../../../../packs/real-estate.json", import.meta.url), "utf8")) as unknown;
  const real = (overrides?: unknown) => resolvePack(raw(), overrides, { allowScoringOverrides: true }).pack;
  const lead = { budget: "60L", timeline: "0-3m", location: "Velachery" };

  it("scores the shipped real-estate pack", () => {
    expect(scoreLead(real(), lead, context)).toMatchObject({ score: 75, temperature: "hot" });
  });

  it("new weights and thresholds change the result", () => {
    const heavier = real({ scoring: { weights: { timeline: 5 }, thresholds: { hot: 90, warm: 30 } } });
    expect(scoreLead(heavier, lead, context)).toMatchObject({ score: 55, temperature: "warm" });
  });

  it("an override cannot change or remove the hard fail", () => {
    const tampered = real({ scoring: { hardFails: [] } });
    expect(scoreLead(tampered, { ...lead, budget: "20L" }, context).temperature).toBe("disqualified");
  });
});

describe("it only reads", () => {
  it("does not change the pack, the answers or the context", () => {
    const p = deepFreeze(pack());
    const fields = deepFreeze({ ...hotFields });
    const ctx = deepFreeze({ references: { ...context.references } });
    expect(() => scoreLead(p, fields, ctx)).not.toThrow();
  });

  it("gives the same answer every time", () => {
    expect(scoreLead(pack(), hotFields, context)).toEqual(scoreLead(pack(), hotFields, context));
  });
});
