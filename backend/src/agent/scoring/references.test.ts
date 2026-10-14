import { PackDefinition } from "@pakka/types";
import { describe, expect, it } from "vitest";
import { samplePack } from "../packs/test-packs";
import { buildReferences, type CatalogRow } from "./references";
import { scoreLead } from "./score";

const LAKH = 100_000;
const pack = (scoring: Record<string, unknown>, catalog?: Record<string, unknown>) => PackDefinition.parse(samplePack({ scoring, ...(catalog ? { catalog } : {}) }));
const scoringWith = (rules: Record<string, unknown>[], hardFails: Record<string, unknown>[] = []) => ({ rules, thresholds: { hot: 70, warm: 40 }, hardFails });

const rows: CatalogRow[] = [
  { type: "property", priceFrom: 60 * LAKH, attributes: { price_to: 80 * LAKH, area: "Velachery" } },
  { type: "property", priceFrom: 90 * LAKH, attributes: { price_to: 120 * LAKH, areas: ["OMR", "Sholinganallur"] } },
  { type: "property", priceFrom: 50 * LAKH, attributes: {} },
];

describe("building the figures a pack's rules need from the business's catalog", () => {
  const real = pack(
    scoringWith(
      [
        { field: "budget", match: "within_project_band", points: 30 },
        { field: "location", match: "in_project_areas", points: 20 },
      ],
      [{ field: "budget", below: "min_project_price" }],
    ),
  );

  it("price bands from price_from and price_to, a band with no top has no ceiling", () => {
    expect(buildReferences(real, rows).project_bands).toEqual([{ min: 60 * LAKH, max: 80 * LAKH }, { min: 90 * LAKH, max: 120 * LAKH }, { min: 50 * LAKH }]);
  });

  it("areas from area and areas, each once", () => {
    expect(buildReferences(real, [...rows, { type: "property", priceFrom: 1, attributes: { area: "velachery" } }]).project_areas).toEqual(["Velachery", "OMR", "Sholinganallur"]);
  });

  it("the cheapest price", () => {
    expect(buildReferences(real, rows).min_project_price).toBe(50 * LAKH);
  });

  it("builds only what the pack's rules name, under the names they use", () => {
    const other = pack(scoringWith([{ field: "budget", match: "within_service_band", points: 10 }, { field: "area", match: "in_service_area", points: 10 }], [{ field: "budget", below: "min_service_price" }]));
    expect(Object.keys(buildReferences(other, rows)).sort()).toEqual(["min_service_price", "service_areas", "service_bands"]);
    expect(Object.keys(buildReferences(pack(scoringWith([{ field: "budget", equals: "x", points: 1 }])), rows))).toEqual([]);
  });

  it("a name with no middle part reads bands", () => {
    expect(buildReferences(pack(scoringWith([{ field: "budget", match: "within_band", points: 10 }])), rows)).toHaveProperty("bands");
  });

  it("leaves out what the catalog cannot give, so the engine reports it instead of guessing", () => {
    expect(buildReferences(real, [])).toEqual({});
    expect(buildReferences(real, [{ type: "property", priceFrom: null, attributes: {} }])).toEqual({});
  });

  it("ignores prices and attributes that are not usable", () => {
    const refs = buildReferences(real, [
      { type: "property", priceFrom: 0, attributes: { price_to: "lots", area: 42 } },
      { type: "property", priceFrom: -5, attributes: { areas: ["", "  ", 7] } },
      { type: "property", priceFrom: 70 * LAKH, attributes: { price_to: 10 * LAKH } }, // a top below the bottom is no ceiling
    ]);
    expect(refs).toEqual({ project_bands: [{ min: 70 * LAKH }], min_project_price: 70 * LAKH });
  });

  it("only items of the pack's catalog type, when the pack names one", () => {
    const typed = pack(scoringWith([{ field: "location", match: "in_project_areas", points: 20 }]), { type: "property", attributes: [], matchOn: [] });
    const refs = buildReferences(typed, [...rows, { type: "portfolio", priceFrom: 1, attributes: { area: "Elsewhere" } }]);
    expect(refs.project_areas).toEqual(["Velachery", "OMR", "Sholinganallur"]);
  });

  it("feeds the scoring engine end to end", () => {
    const refs = buildReferences(real, rows);
    expect(scoreLead(real, { budget: "65L", location: "omr" }, { references: refs })).toMatchObject({ score: 50, temperature: "warm" });
    expect(scoreLead(real, { budget: "10L" }, { references: refs }).temperature).toBe("disqualified");
  });
});

describe("the places a pack says it works in", () => {
  it("are built when the pack's coverage names the matcher, though no scoring rule uses it", () => {
    const covered = PackDefinition.parse(samplePack({ scoring: scoringWith([{ field: "budget", match: "within_project_band", points: 30 }]), coverage: { field: "location", match: "in_branch_areas" } }));
    expect(buildReferences(covered, rows).branch_areas).toEqual(["Velachery", "OMR", "Sholinganallur"]);
  });

  it("are not built, as before, when neither the coverage nor a rule asks for them", () => {
    expect(buildReferences(pack(scoringWith([{ field: "budget", match: "within_project_band", points: 30 }])), rows)).not.toHaveProperty("project_areas");
  });
});
