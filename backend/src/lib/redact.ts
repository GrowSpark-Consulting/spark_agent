import { redactSecrets } from "@pakka/types";
import { maskPersonalData } from "../agent/llm/mask";

/**
 * Text for a log line: credentials removed (redactSecrets) and phone numbers and emails masked (maskPersonalData). Not for what the
 * dashboard shows: redactSecrets alone decides that (frontend containsSecret), so a message that names a number is not hidden there.
 */
export function redactForLog(text: string): string {
  return maskPersonalData(redactSecrets(text));
}

/** An error's message for a log line, redacted; a non-Error value as text, redacted. */
export const errorTextForLog = (e: unknown): string => redactForLog(e instanceof Error ? e.message : String(e));
