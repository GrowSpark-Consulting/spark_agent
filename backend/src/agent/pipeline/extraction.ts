import { Extraction } from "@pakka/types";
import type { z } from "zod";
import { stripUnsafeCharacters } from "../../lib/text";
import { parseJsonObject } from "../llm/json";
import { refusesDisplayText } from "../scoring/area-text";

// From the fast model's text to a checked Extraction (pipeline step 4, docs/handover.md module 2). The model only
// reports what the customer said; this is where code decides what to believe. Every part of its answer is
// validated, the details are limited to the pack's own fields and each is checked against the pack's own type for
// it, and the free-text parts are tidied and shortened. A bad answer is not repaired: it is refused, and the
// pipeline asks the model again once (then falls back to a clarifying question).

/** The knowledge-base gap question limit (docs/contracts.md, section 9): the question is what a gap is recorded as. */
export const QUESTION_MAX_CHARS = 300;
export const TIME_MAX_CHARS = 100;
/** A detail a customer gave (a locality, a budget in words) is short; anything longer is cut. */
export const FIELD_VALUE_MAX_CHARS = 200;
/** A run of this many digits in a detail is a phone number (a 6-digit pincode and an amount such as 1,20,00,000 are not). */
export const STAFF_PHONE_DIGITS = 10;

export type InterpretResult =
  | {
      ok: true;
      extraction: Extraction;
      /** Counts only: what was dropped is never kept. */
      dropped: { unknownKeys: number; invalidValues: number };
    }
  | { ok: false; reason: "not_json" | "schema" };

/** One line, no control characters or lone surrogates, cut to `max` characters (code points: a multi-part emoji can still be cut). */
const tidy = (text: string, max: number): string => [...stripUnsafeCharacters(text).replace(/\s+/g, " ").trim()].slice(0, max).join("").trim();
const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A free-text field: tidied; blank or null is null; anything that is not text is left for the schema to refuse. */
function freeText(value: unknown, max: number): unknown {
  if (typeof value === "string") return tidy(value, max) || null;
  return value;
}

export function interpretExtraction(text: string, fieldSchema: z.ZodObject): InterpretResult {
  const json = parseJsonObject(text);
  if (!json.ok) return { ok: false, reason: "not_json" };
  const raw = json.value;

  // The details may be missing, null or carry odd values: those are dropped one by one, not made to fail the answer.
  // A key that is not one of the pack's own is dropped before anything is built from it (so a key such as
  // "__proto__" never becomes a property); a text value is tidied and cut like any outside text.
  let unknownKeys = 0;
  let invalidValues = 0;
  const offered: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(isPlain(raw.fields) ? raw.fields : {})) {
    if (!Object.hasOwn(fieldSchema.shape, key)) {
      unknownKeys++;
    } else if (typeof value === "string") {
      const cleaned = tidy(value, FIELD_VALUE_MAX_CHARS);
      // A detail with a link, an "@" or a phone number (a run of 10 digits) is never stored: staff, the staff alerts and every screen read it (Day 7, staff-text cleaning).
      if (cleaned && !refusesDisplayText(cleaned, STAFF_PHONE_DIGITS, true)) offered[key] = cleaned;
      else invalidValues++;
    } else if (typeof value === "number" || typeof value === "boolean") {
      offered[key] = value;
    } else {
      invalidValues++;
    }
  }

  const parsed = Extraction.safeParse({
    ...raw,
    fields: offered,
    question: freeText(raw.question, QUESTION_MAX_CHARS),
    preferredTime: freeText(raw.preferredTime, TIME_MAX_CHARS),
  });
  if (!parsed.success) return { ok: false, reason: "schema" };

  // Only the pack's own fields, each as the pack's own type for it.
  const fields: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(parsed.data.fields)) {
    const checked = fieldSchema.shape[key].safeParse(value);
    if (checked.success && checked.data !== undefined) fields[key] = checked.data as string | number | boolean;
    else invalidValues++;
  }
  return { ok: true, extraction: { ...parsed.data, fields }, dropped: { unknownKeys, invalidValues } };
}
