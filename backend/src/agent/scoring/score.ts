import type { PackDefinition } from "@pakka/types";
import { parseAmountInr } from "./amount";

// The score of a lead, worked out by plain code (docs/handover.md, step 5: "Code decides, the LLM talks"). It reads
// the pack's scoring block, as already merged with the business's own overrides by the pack loader (an override can
// change weights and thresholds, never a hard fail, so nothing here has to defend against that), and the answers
// collected so far. No model is involved and nothing here touches the database: the business's own figures (price
// bands, areas, the cheapest price) come in through `context.references`, built by the caller from the catalog.
//
// Three rules keep it safe:
//   - an answer not given, or one that cannot be read, earns no points and never fails a lead;
//   - a lead is disqualified only when it is CERTAIN: every part of the budget is below the limit, and the limit is on file;
//   - a rule it cannot judge (a matcher it does not know, or no price bands on file) earns nothing and is reported in
//     `unscored`, so staff and tests can see the gap instead of a guessed score.
//
// Matcher names are read by shape, not by trade: `within_<x>_band` reads the references `<x>_bands`, and `in_<x>_area(s)`
// reads `<x>_areas`. A hard fail's `below: "<name>"` reads the number `references[<name>]`.

export type Temperature = "hot" | "warm" | "cold" | "disqualified";

/** A price band in whole rupees. A band with no `max` has no ceiling. */
export interface PriceBand {
  min: number;
  max?: number;
}

export interface ScoringContext {
  /** The business's own figures by name: `<x>_bands` (PriceBand[]), `<x>_areas` (string[]), or a number such as `min_<x>_price`. */
  references?: Record<string, unknown>;
}

export interface ScoreResult {
  score: number;
  temperature: Temperature;
  hardFail: { field: string; rule: string } | null;
  matched: { field: string; points: number }[];
  /** Fields whose rule could not be judged (unknown matcher, or the business's figures are not on file). */
  unscored: string[];
}

type Scoring = Pick<PackDefinition, "scoring">["scoring"];
type Answers = Record<string, unknown>;
type Scalar = string | number | boolean;

/** true / false when judged, undefined when it cannot be judged. */
type Verdict = boolean | undefined;

const isScalar = (v: unknown): v is Scalar => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^\s*-?\d+(?:\.\d+)?\s*$/.test(value)) return Number(value);
  return null;
}

function toBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const t = value.trim().toLowerCase();
    if (t === "true") return true;
    if (t === "false") return false;
  }
  return null;
}

function same(answer: unknown, expected: Scalar): boolean {
  if (!isScalar(answer)) return false;
  if (typeof expected === "boolean") return toBoolean(answer) === expected;
  if (typeof expected === "number") return toNumber(answer) === expected;
  return typeof answer === "string" && answer.trim().toLowerCase() === expected.trim().toLowerCase();
}

function bandsOf(references: Record<string, unknown> | undefined, name: string): PriceBand[] | null {
  const raw = references?.[name];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const bands: PriceBand[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { min, max } = item as Record<string, unknown>;
    if (typeof min !== "number" || !Number.isFinite(min)) continue;
    bands.push(typeof max === "number" && Number.isFinite(max) ? { min, max } : { min });
  }
  return bands.length > 0 ? bands : null;
}

function areasOf(references: Record<string, unknown> | undefined, name: string): string[] | null {
  const raw = references?.[name];
  if (!Array.isArray(raw)) return null;
  const areas = raw.filter((a): a is string => typeof a === "string" && a.trim() !== "").map((a) => a.trim().toLowerCase());
  return areas.length > 0 ? areas : null;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The matcher a pack names, judged against one answer. Also how a pack's coverage is judged (coverage.ts). */
export function judge(match: string, answer: unknown, context: ScoringContext): Verdict {
  const band = /^within_(?:([a-z][a-z0-9]*)_)?band$/.exec(match);
  if (band) {
    const bands = bandsOf(context.references, `${band[1] ? `${band[1]}_` : ""}bands`);
    if (!bands) return undefined;
    const amount = parseAmountInr(answer);
    if (!amount) return false;
    return bands.some((b) => amount.max >= b.min && (b.max === undefined || amount.min <= b.max));
  }

  const area = /^in_([a-z][a-z0-9]*)_areas?$/.exec(match);
  if (area) {
    const areas = areasOf(context.references, `${area[1]}_areas`);
    if (!areas) return undefined;
    if (typeof answer !== "string") return false;
    const said = answer.trim().toLowerCase();
    return areas.some((a) => new RegExp(`(?<![a-z0-9])${escape(a)}(?![a-z0-9])`).test(said));
  }

  return undefined;
}

type Rule = Scoring["rules"][number];

function ruleHolds(rule: Rule, answer: unknown, context: ScoringContext): Verdict {
  if (rule.match !== undefined) {
    const verdict = judge(rule.match, answer, context);
    if (verdict !== true) return verdict;
  }
  if (rule.equals !== undefined && !same(answer, rule.equals)) return false;
  if (rule.in !== undefined && !rule.in.some((v) => same(answer, v))) return false;
  if (rule.gte !== undefined) {
    const n = toNumber(answer);
    if (n === null || n < rule.gte) return false;
  }
  return true;
}

type HardFail = Scoring["hardFails"][number];

/** The rule's text when it fails the lead, otherwise null. Anything it cannot judge does not fail a lead. */
function hardFailed(hardFail: HardFail, answers: Answers, context: ScoringContext): string | null {
  const answer = answers[hardFail.field];
  if (answer === undefined || answer === null) return null;

  if (hardFail.below !== undefined) {
    const limit = typeof hardFail.below === "number" ? hardFail.below : context.references?.[hardFail.below];
    const amount = parseAmountInr(answer);
    if (!amount || typeof limit !== "number" || !Number.isFinite(limit)) return null;
    return amount.max < limit ? `below ${hardFail.below}` : null;
  }

  if (hardFail.match !== undefined) {
    return judge(hardFail.match, answer, context) === false ? `must match ${hardFail.match}` : null;
  }
  return null;
}

export function scoreLead(pack: { scoring: Scoring }, answers: Answers, context: ScoringContext = {}): ScoreResult {
  const { rules, thresholds, hardFails } = pack.scoring;

  for (const hardFail of hardFails) {
    const rule = hardFailed(hardFail, answers, context);
    if (rule !== null) return { score: 0, temperature: "disqualified", hardFail: { field: hardFail.field, rule }, matched: [], unscored: [] };
  }

  const matched: ScoreResult["matched"] = [];
  const unscored: string[] = [];
  let score = 0;
  for (const rule of rules) {
    const answer = answers[rule.field];
    if (answer === undefined || answer === null) continue;
    const verdict = ruleHolds(rule, answer, context);
    if (verdict === undefined) {
      if (!unscored.includes(rule.field)) unscored.push(rule.field);
    } else if (verdict) {
      matched.push({ field: rule.field, points: rule.points });
      score += rule.points;
    }
  }

  const temperature = score >= thresholds.hot ? "hot" : score >= thresholds.warm ? "warm" : "cold";
  return { score, temperature, hardFail: null, matched, unscored };
}
