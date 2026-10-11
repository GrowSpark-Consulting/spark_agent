import type { PackDefinition } from "@pakka/types";
import type { PriceBand } from "./score";

// The figures a pack's scoring rules compare a customer against, built from the business's own catalog (catalog_items).
// Pure: the caller reads the rows. Which figures are built is decided by the names the pack's rules use
// (`within_<x>_band`, `in_<x>_areas`, `min_<x>_price`, see score.ts), so nothing here knows a trade.
//
// What a catalog item carries (the catalog editor saves these; the convention is proposed here and Dev 3 confirms it):
//   price_from (column)        the lowest price of the item
//   attributes.price_to        the highest price (optional: without it the band has no ceiling)
//   attributes.area            where it is, or attributes.areas (a list)
// Anything missing leaves its figure out, and the scoring engine then reports the rule as unjudged instead of guessing.

export const CATALOG_ATTRIBUTES = { priceTo: "price_to", area: "area", areas: "areas" } as const;

export interface CatalogRow {
  type: string;
  priceFrom: number | null;
  attributes: Record<string, unknown>;
}

const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

function wantedNames(pack: Pick<PackDefinition, "scoring">): Set<string> {
  const names = new Set<string>();
  for (const rule of pack.scoring.rules) if (rule.match) names.add(rule.match);
  for (const hardFail of pack.scoring.hardFails) {
    if (hardFail.match) names.add(hardFail.match);
    if (typeof hardFail.below === "string") names.add(hardFail.below);
  }
  return names;
}

function bandsOf(rows: CatalogRow[]): PriceBand[] {
  const bands: PriceBand[] = [];
  for (const row of rows) {
    if (!positive(row.priceFrom)) continue;
    const top = row.attributes[CATALOG_ATTRIBUTES.priceTo];
    bands.push(positive(top) && top >= row.priceFrom ? { min: row.priceFrom, max: top } : { min: row.priceFrom });
  }
  return bands;
}

function areasOf(rows: CatalogRow[]): string[] {
  const seen = new Set<string>();
  const areas: string[] = [];
  const add = (value: unknown) => {
    if (typeof value !== "string" || value.trim() === "") return;
    const key = value.trim().toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    areas.push(value.trim());
  };
  for (const row of rows) {
    add(row.attributes[CATALOG_ATTRIBUTES.area]);
    const list = row.attributes[CATALOG_ATTRIBUTES.areas];
    if (Array.isArray(list)) list.forEach(add);
  }
  return areas;
}

export function buildReferences(pack: Pick<PackDefinition, "scoring" | "catalog">, catalog: CatalogRow[]): Record<string, unknown> {
  const rows = pack.catalog ? catalog.filter((row) => row.type === pack.catalog?.type) : catalog;
  const references: Record<string, unknown> = {};

  for (const name of wantedNames(pack)) {
    const band = /^within_(?:([a-z][a-z0-9]*)_)?band$/.exec(name);
    if (band) {
      const bands = bandsOf(rows);
      if (bands.length > 0) references[`${band[1] ? `${band[1]}_` : ""}bands`] = bands;
      continue;
    }
    const area = /^in_([a-z][a-z0-9]*)_areas?$/.exec(name);
    if (area) {
      const areas = areasOf(rows);
      if (areas.length > 0) references[`${area[1]}_areas`] = areas;
      continue;
    }
    if (/^min_[a-z][a-z0-9]*_price$/.test(name)) {
      const prices = rows.map((row) => row.priceFrom).filter(positive);
      if (prices.length > 0) references[name] = Math.min(...prices);
    }
  }
  return references;
}
