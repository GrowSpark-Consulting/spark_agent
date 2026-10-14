import { describe, expect, it } from "vitest";
import { PackDefinition, PackField, Scoring } from "./pack";

// Neutral fixtures shaped like the two examples in docs/handover.md.
const visitPack = {
  key: "sample-pack",
  version: 1,
  bookingType: "site_visit",
  fields: [
    { key: "budget", label: "Budget", type: "range_inr", required: true },
    { key: "config", label: "Type", type: "enum", options: ["a", "b"] },
    { key: "decision_maker", label: "Decision maker", type: "boolean" },
  ],
  scoring: {
    rules: [
      { field: "budget", match: "within_project_band", points: 30 },
      { field: "config", equals: "a", points: 25 },
      { field: "config", in: ["a", "b"], points: 15 },
      { field: "decision_maker", equals: true, points: 10 },
    ],
    thresholds: { hot: 70, warm: 40 },
    hardFails: [{ field: "budget", below: "min_project_price" }],
  },
  handoffTriggers: ["asked_human", "hot_lead"],
  templates: ["booking_confirmed_v1"],
  kbStarter: ["Price bands"],
  extraGuardrails: [],
};

const quotePack = {
  key: "sample-quote",
  version: 2,
  label: "Sample quote pack",
  bookingModes: ["quote", "callback", "date_range"],
  catalog: { type: "package", attributes: ["destination", "nights"], matchOn: ["destination"] },
  fields: [
    { key: "destination", label: "Where to?", type: "text", required: true },
    { key: "travel_dates", label: "Dates", type: "date_range_or_month", required: true },
    { key: "adults", label: "Adults", type: "int", required: true },
  ],
  scoring: {
    rules: [
      { field: "travel_dates", match: "starts_within_days", value: 45, points: 30 },
      { field: "adults", gte: 4, points: 15 },
    ],
    thresholds: { hot: 70, warm: 40 },
    hardFails: [{ field: "travel_dates", match: "in_past" }],
  },
  reminders: [
    { event: "callback", anchor: "start", offset: "-30m", template: "callback_reminder_v1" },
    {
      event: "quote",
      anchor: "quote_sent",
      offset: "+2d",
      template: "quote_followup_v1",
      feature: "quote_followup",
    },
  ],
  feedback: { event: "trip", anchor: "end", offset: "+1d", template: "feedback_v1" },
  handoffTriggers: ["asked_human", "group_above_15", "visa_question"],
  templates: ["quote_sent_v1"],
  kbStarter: ["Destinations"],
  extraGuardrails: ["no_unlisted_prices"],
};

describe("PackDefinition", () => {
  it("parses a pack that uses bookingType", () => {
    const pack = PackDefinition.parse(visitPack);
    expect(pack.bookingType).toBe("site_visit");
    expect(pack.bookingModes).toBeUndefined();
  });

  it("parses a pack that uses bookingModes, a catalog, reminders and feedback", () => {
    const pack = PackDefinition.parse(quotePack);
    expect(pack.bookingModes).toEqual(["quote", "callback", "date_range"]);
    expect(pack.reminders).toHaveLength(2);
  });

  it("keeps pack-specific handoff triggers", () => {
    expect(PackDefinition.parse(quotePack).handoffTriggers).toContain("group_above_15");
  });

  it("does not require decision_maker or any other field named in scoring to be declared", () => {
    const { fields, ...rest } = visitPack;
    const without = { ...rest, fields: fields.filter((f) => f.key !== "decision_maker") };
    expect(PackDefinition.safeParse(without).success).toBe(true);
  });

  it("defaults the optional lists", () => {
    const { reminders: _r, handoffTriggers: _h, templates: _t, ...rest } = quotePack;
    const pack = PackDefinition.parse(rest);
    expect(pack.reminders).toEqual([]);
    expect(pack.handoffTriggers).toEqual([]);
  });

  it("rejects an unknown field type", () => {
    const bad = { ...visitPack, fields: [{ key: "x", label: "X", type: "date" }] };
    expect(PackDefinition.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown booking mode and a bad key or version", () => {
    expect(PackDefinition.safeParse({ ...quotePack, bookingModes: ["walk_in"] }).success).toBe(false);
    expect(PackDefinition.safeParse({ ...visitPack, key: "Sample Pack" }).success).toBe(false);
    expect(PackDefinition.safeParse({ ...visitPack, version: 0 }).success).toBe(false);
  });

  it("rejects a reminder offset that is not relative", () => {
    const bad = {
      ...quotePack,
      reminders: [{ event: "e", anchor: "start", offset: "1h", template: "t" }],
    };
    expect(PackDefinition.safeParse(bad).success).toBe(false);
    const badAnchor = { ...quotePack, feedback: { ...quotePack.feedback, anchor: "noon" } };
    expect(PackDefinition.safeParse(badAnchor).success).toBe(false);
  });
});

describe("PackField", () => {
  it("requires options for enum fields", () => {
    expect(PackField.safeParse({ key: "k", label: "K", type: "enum" }).success).toBe(false);
  });

  it("defaults required to false", () => {
    expect(PackField.parse({ key: "k", label: "K", type: "text" }).required).toBe(false);
  });

  it("rejects keys that are not snake_case", () => {
    expect(PackField.safeParse({ key: "Budget", label: "B", type: "text" }).success).toBe(false);
  });
});

describe("Scoring", () => {
  const rules = [{ field: "a", equals: 1, points: 10 }];

  it("requires hot above warm", () => {
    expect(Scoring.safeParse({ rules, thresholds: { hot: 40, warm: 40 } }).success).toBe(false);
  });

  it("rejects a rule with no condition, a negative score and an unknown key", () => {
    const thresholds = { hot: 70, warm: 40 };
    expect(Scoring.safeParse({ rules: [{ field: "a", points: 5 }], thresholds }).success).toBe(false);
    expect(
      Scoring.safeParse({ rules: [{ field: "a", equals: 1, points: -5 }], thresholds }).success,
    ).toBe(false);
    expect(
      Scoring.safeParse({ rules: [{ field: "a", equals: 1, points: 5, eqauls: 1 }], thresholds })
        .success,
    ).toBe(false);
  });

  it("rejects a hard fail with no condition", () => {
    const thresholds = { hot: 70, warm: 40 };
    expect(Scoring.safeParse({ rules, thresholds, hardFails: [{ field: "a" }] }).success).toBe(false);
  });
});

describe("PackDefinition coverage", () => {
  it("is optional: a pack without it parses as before", () => {
    expect(PackDefinition.parse(visitPack).coverage).toBeUndefined();
  });

  it("names the field that says where the customer is and the area matcher that judges it", () => {
    const pack = PackDefinition.parse({ ...visitPack, coverage: { field: "config", match: "in_project_areas" } });
    expect(pack.coverage).toEqual({ field: "config", match: "in_project_areas" });
    expect(PackDefinition.parse({ ...visitPack, coverage: { field: "config", match: "in_service_area" } }).coverage?.match).toBe("in_service_area");
  });

  it.each([
    ["a matcher that is not about areas", { field: "config", match: "within_project_band" }],
    ["no field", { match: "in_project_areas" }],
    ["an empty field", { field: "", match: "in_project_areas" }],
    ["an unknown key", { field: "config", match: "in_project_areas", extra: true }],
  ])("refuses %s", (_name, coverage) => {
    expect(PackDefinition.safeParse({ ...visitPack, coverage }).success).toBe(false);
  });
});
