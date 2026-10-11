import type { PackDefinition } from "@pakka/types";
import { scoreLead, type ScoreResult, type ScoringContext } from "./score";

// Step 5, the qualifying half (docs/handover.md): what is still missing from a lead, what to ask next, and whether the
// lead is ready for a time to be offered. Plain code. The model only words the question later; it never picks the field
// or decides the score.
//
//   ask             the next missing REQUIRED details, in the pack's order, at most two at a time (rule 4 of the reply prompt
//                   allows two questions per message). Optional details are never asked for: the customer is not interviewed.
//   missingRequired every required detail still missing
//   readyForSlots   every required detail is in AND the score is warm or better (the pack's warm threshold is the line a lead
//                   must pass). A customer who asks to book is a different path (a booking intent) and does not need this.

export const MAX_ASK_FIELDS = 2;

export interface AskField {
  key: string;
  label: string;
  options?: string[];
}

export interface Qualification extends ScoreResult {
  ask: AskField[];
  missingRequired: string[];
  readyForSlots: boolean;
}

const isBlank = (value: unknown) => value === undefined || value === null || (typeof value === "string" && value.trim() === "");

export function qualify(pack: Pick<PackDefinition, "fields" | "scoring">, answers: Record<string, unknown>, context: ScoringContext = {}): Qualification {
  const scored = scoreLead(pack, answers, context);
  const missing = pack.fields.filter((field) => field.required && isBlank(answers[field.key]));
  const missingRequired = missing.map((field) => field.key);
  const disqualified = scored.temperature === "disqualified";

  const ask: AskField[] = disqualified
    ? []
    : missing.slice(0, MAX_ASK_FIELDS).map((field) => ({ key: field.key, label: field.label, ...(field.options ? { options: [...field.options] } : {}) }));

  const readyForSlots = missingRequired.length === 0 && (scored.temperature === "hot" || scored.temperature === "warm");
  return { ...scored, ask, missingRequired, readyForSlots };
}
