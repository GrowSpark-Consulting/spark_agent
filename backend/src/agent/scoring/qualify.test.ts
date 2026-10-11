import { PackDefinition } from "@pakka/types";
import { describe, expect, it } from "vitest";
import { MAX_ASK_FIELDS, qualify } from "./qualify";
import type { ScoringContext } from "./score";
import { deepFreeze, samplePack } from "../packs/test-packs";

const LAKH = 100_000;

const pack = (over: Record<string, unknown> = {}) =>
  PackDefinition.parse(
    samplePack({
      fields: [
        { key: "budget", label: "Budget", type: "range_inr", required: true },
        { key: "location", label: "Preferred area", type: "text", required: true },
        { key: "timeline", label: "When are you planning to buy?", type: "enum", options: ["0-3m", "3-6m", "6m+"], required: true },
        { key: "funding", label: "Loan or own funds", type: "enum", options: ["loan_approved", "loan_needed", "own_funds"] },
        { key: "decision_maker", label: "Are you the buyer?", type: "boolean" },
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
      },
      ...over,
    }),
  );

const context: ScoringContext = {
  references: { project_bands: [{ min: 50 * LAKH, max: 80 * LAKH }], project_areas: ["Velachery"], min_project_price: 50 * LAKH },
};

describe("what to ask next", () => {
  it("asks for the required details in the pack's order, two at a time at most", () => {
    const result = qualify(pack(), {}, context);
    expect(MAX_ASK_FIELDS).toBe(2);
    expect(result.ask.map((a) => a.key)).toEqual(["budget", "location"]);
    expect(result.missingRequired).toEqual(["budget", "location", "timeline"]);
  });

  it("moves on to the next missing detail once one is given", () => {
    const result = qualify(pack(), { budget: "60L" }, context);
    expect(result.ask.map((a) => a.key)).toEqual(["location", "timeline"]);
    expect(result.missingRequired).toEqual(["location", "timeline"]);
  });

  it("gives the label and the allowed choices for each question", () => {
    const result = qualify(pack(), { budget: "60L", location: "Velachery" }, context);
    expect(result.ask).toEqual([{ key: "timeline", label: "When are you planning to buy?", options: ["0-3m", "3-6m", "6m+"] }]);
  });

  it("a blank answer counts as missing, a false or zero answer does not", () => {
    const p = pack({
      fields: [
        { key: "a", label: "A", type: "text", required: true },
        { key: "b", label: "B", type: "boolean", required: true },
        { key: "c", label: "C", type: "int", required: true },
      ],
      scoring: { rules: [{ field: "b", equals: true, points: 1 }], thresholds: { hot: 70, warm: 40 }, hardFails: [] },
    });
    expect(qualify(p, { a: "  ", b: false, c: 0 }, {}).missingRequired).toEqual(["a"]);
  });

  it("asks nothing when every required detail is in, and never asks for the optional ones", () => {
    const result = qualify(pack(), { budget: "60L", location: "Velachery", timeline: "0-3m" }, context);
    expect(result.ask).toEqual([]);
    expect(result.missingRequired).toEqual([]);
  });

  it("asks nothing for a disqualified lead", () => {
    const result = qualify(pack(), { budget: "20L" }, context);
    expect(result.temperature).toBe("disqualified");
    expect(result.ask).toEqual([]);
  });
});

describe("ready to offer a time", () => {
  const filled = { budget: "60L", location: "Velachery", timeline: "0-3m" };

  it("is ready when every required detail is in and the lead scores warm or better", () => {
    expect(qualify(pack(), filled, context)).toMatchObject({ temperature: "hot", readyForSlots: true });
    expect(qualify(pack(), { ...filled, timeline: "6m+" }, context)).toMatchObject({ temperature: "warm", readyForSlots: true }); // 50 points
  });

  it("is not ready with a required detail missing, however high the score", () => {
    expect(qualify(pack(), { budget: "60L", location: "Velachery", funding: "own_funds", decision_maker: true }, context)).toMatchObject({ score: 75, readyForSlots: false });
  });

  it("is not ready for a cold lead", () => {
    const result = qualify(pack(), { budget: "100L", location: "Anna Nagar", timeline: "6m+" }, context);
    expect(result).toMatchObject({ temperature: "cold", missingRequired: [], readyForSlots: false });
  });

  it("is not ready for a disqualified lead", () => {
    expect(qualify(pack(), { ...filled, budget: "20L" }, context).readyForSlots).toBe(false);
  });
});

describe("it only reads", () => {
  it("does not change the pack or the answers", () => {
    expect(() => qualify(deepFreeze(pack()), deepFreeze({ budget: "60L" }), deepFreeze({ references: { ...context.references } }))).not.toThrow();
  });
});
