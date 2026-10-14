import type { Extraction } from "@pakka/types";

// The language the reply prompt is told the customer writes in (Day 7, found by the live run, chat 84). The extraction model reads a language with a confidence. For "other"
// the reply prompt's task line says "a language other than English: reply in that language"; for a message the model could not read (fake tags, a stray symbol, confidence 0.1)
// that line made the reply talk about the language ("The task says the customer writes in a language other than English...").
//
// So a LOW-CONFIDENCE "other" is decided in code, in this order:
//   1. the message holds Tamil, Devanagari or Malayalam letters: the script with the most letters gives ta, hi or ml (a real Tamil, Hindi or Malayalam message is never answered
//      in English because the model was unsure);
//   2. otherwise the contact's stored language, when it is one the reply can use;
//   3. otherwise null: the task line names no language, and reply rule 5 ("reply in the customer's language and script") applies from the message itself. Never forced to English
//      (Tanglish typed in Latin letters is still answered in Tanglish).
// A high-confidence "other" (a real other language, such as Telugu) and every other reading are passed on as they are. Plain code, no model, no prompt change.

/** An "other" reading below this confidence is not believed. */
export const LOW_CONFIDENCE = 0.5;

const USABLE: readonly Extraction["language"][] = ["en", "ta", "ta-en", "ml", "hi"];

/** The letters (and marks, not digits: a lone Devanagari digit is not a Hindi message) of each script the reply can be written in. */
const SCRIPTS: { language: "ta" | "hi" | "ml"; pattern: RegExp }[] = [
  { language: "ta", pattern: /(?!\p{Nd})\p{Script=Tamil}/gu },
  { language: "hi", pattern: /(?!\p{Nd})\p{Script=Devanagari}/gu },
  { language: "ml", pattern: /(?!\p{Nd})\p{Script=Malayalam}/gu },
];

export function languageForReply(reading: Extraction["language"], confidence: number, customerWords: string | undefined, contactLanguage: string | null | undefined): Extraction["language"] | null {
  if (reading !== "other" || confidence >= LOW_CONFIDENCE) return reading;
  let best: { language: "ta" | "hi" | "ml"; letters: number } | null = null;
  for (const { language, pattern } of SCRIPTS) {
    const letters = (customerWords?.match(pattern) ?? []).length;
    if (letters > 0 && (best === null || letters > best.letters)) best = { language, letters };
  }
  if (best) return best.language;
  const stored = USABLE.find((language) => language === contactLanguage);
  return stored ?? null;
}
