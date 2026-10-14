import type { PackDefinition } from "@pakka/types";
import { stripUnsafeCharacters } from "../../lib/text";
import { judge } from "./score";

// Where the business works, against where the customer wants to be (Raja, 14 Oct: an area the business has no sites in is answered by
// listing the areas it does have). Plain code. The pack says which field holds the place and which area matcher judges it (`coverage`,
// or, for a pack published before that existed, its own first area scoring rule: a published version is never edited); the business's
// catalog says which places it has (references.ts builds them for scoring, and they are reused as they are). Nothing here knows a trade.

/** How many of the business's areas one reply lists. */
export const MAX_LISTED_AREAS = 6;
/** How much of one of the business's own area names is put in a reply. */
export const MAX_AREA_NAME_CHARS = 60;
/** How much of the customer's own words are put back in a reply. */
export const MAX_SHOWN_CHARS = 40;

export interface CoverageRule {
  field: string;
  match: string;
}

const AREA_MATCHER = /^in_([a-z][a-z0-9]*)_areas?$/;

/** The pack's own coverage, else its first area scoring rule, else null (the pack has no notion of where it works). */
export function coverageRule(pack: Pick<PackDefinition, "scoring"> & { coverage?: PackDefinition["coverage"] }): CoverageRule | null {
  if (pack.coverage) return { field: pack.coverage.field, match: pack.coverage.match };
  const rule = pack.scoring.rules.find((r) => r.match !== undefined && AREA_MATCHER.test(r.match));
  return rule?.match ? { field: rule.field, match: rule.match } : null;
}

/**
 * A place as it is compared: lower case, punctuation and extra spaces gone, and a pincode typed with spaces or dashes ("600 042") as digits.
 * Letters of every script and their combining marks are kept (a Tamil place name is not cut apart).
 */
export function normaliseArea(text: string): string {
  const words = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim();
  return /^[\d ]+$/.test(words) ? words.replace(/ /g, "") : words;
}

export interface CoverageReading {
  /** The business has sites there. */
  served: boolean;
  /** The place as it is compared (normaliseArea): what "the same area again" means. */
  area: string;
  /** The customer's own words for the place, tidied and short, for putting back in a reply. */
  shown: string;
  /** Where the business does have sites, as it wrote them: at most MAX_LISTED_AREAS. */
  areas: string[];
}

const cutChars = (text: string, max: number) => [...text].slice(0, max).join("");

/** The places the business listed, as it wrote them, for the matcher a rule names (`in_<x>_area(s)` reads `<x>_areas`). */
function listedAreas(match: string, references: Record<string, unknown>): string[] {
  const name = AREA_MATCHER.exec(match)?.[1];
  const raw = name ? references[`${name}_areas`] : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.filter((a): a is string => typeof a === "string" && a.trim() !== "").map((a) => cutChars(a.trim(), MAX_AREA_NAME_CHARS));
}

/**
 * Whether the place the customer gave is one the business has. Null when it cannot be judged: no place given (or not a word or a number),
 * not an area matcher, or the business has listed no areas. Nobody is turned away on a guess.
 */
export function readCoverage(rule: CoverageRule, references: Record<string, unknown>, answer: unknown): CoverageReading | null {
  const text = typeof answer === "string" ? answer : typeof answer === "number" && Number.isFinite(answer) ? String(answer) : "";
  const area = normaliseArea(text);
  if (!area) return null;
  const areas = listedAreas(rule.match, references);
  if (areas.length === 0) return null;
  // Both sides are compared as normaliseArea writes them ("T. Nagar" in the catalog and "T Nagar" typed are the same place).
  const name = AREA_MATCHER.exec(rule.match)?.[1];
  const verdict = judge(rule.match, area, { references: { ...references, ...(name ? { [`${name}_areas`]: areas.map(normaliseArea).filter(Boolean) } : {}) } });
  if (verdict === undefined) return null;
  const shown = cutChars(stripUnsafeCharacters(text).replace(/\s+/g, " ").trim(), MAX_SHOWN_CHARS).trim();
  return { served: verdict, area, shown, areas: areas.slice(0, MAX_LISTED_AREAS) };
}
