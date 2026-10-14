// The static guard's allowlists (static-guard.test.ts). One line of reason per entry.

/** Who owns a file: Dev 1's (the agent, the WhatsApp channel, the knowledge base, the message-pipeline and connection jobs) or not. */
const DEV1_PREFIXES = ["agent/", "channels/whatsapp/", "kb/", "lib/connect-link-token.ts", "inngest/process-message.ts", "inngest/demo-reply.ts", "inngest/connection-health.ts", "inngest/token-expiry.ts"];
export const isDev1 = (file: string): boolean => DEV1_PREFIXES.some((p) => file.startsWith(p));

export interface Allowed {
  file: string;
  /** Text that appears in the call (it must match exactly one flagged call of the file). */
  contains: string;
  /** Why it is safe, in one line. */
  reason: string;
}

/** Log calls in Dev 1's files that interpolate something whose NAME looks risky, and why each is safe. A new one must be added here with its reason, or fixed. */
export const DEV1_ALLOWED: Allowed[] = [
  {
    file: "agent/handoff/takeover.ts",
    contains: "error instanceof Trouble",
    reason: "Trouble.message is the fixed label its only constructor call passes (rowsOf's `what`); the other value is the database's error code, never a row.",
  },
  {
    file: "inngest/process-message.ts",
    contains: "understood.summary.intent",
    reason: "intent is a Zod enum of fixed words (packages/types Extraction); status, reason and the search outcome are fixed words too.",
  },
  {
    file: "inngest/process-message.ts",
    contains: "safe line after giving up",
    reason: "answerRunThatGaveUp returns one of five fixed words (sent, opted_out, nothing_to_do, already_replied, not_sent).",
  },
];

/**
 * Splits flagged log calls by owner. Dev 1's files: a call that is not in the allowlist FAILS the guard. Every other file (Dev 2's and shared code) is
 * REPORT-ONLY: its flagged calls are printed with a count in the test output as a warning and never fail anything, so a red check can never land on a PR of
 * someone who cannot easily fix a line in this folder. A flagged line there is a candidate, not a proven leak; the owners are told in the task note.
 */
export function partitionFlagged<T extends { file: string; text: string }>(flagged: readonly T[], allowed: readonly Allowed[] = DEV1_ALLOWED): { dev1Unaccounted: T[]; reportOnly: T[] } {
  return {
    dev1Unaccounted: flagged.filter((c) => isDev1(c.file) && !allowed.some((a) => a.file === c.file && c.text.includes(a.contains))),
    reportOnly: flagged.filter((c) => !isDev1(c.file)),
  };
}
