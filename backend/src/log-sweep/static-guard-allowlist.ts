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
 * Flagged log calls in files that are NOT Dev 1's (Dev 2's and shared code), by file: how many are flagged today. Reported to their owner in the task note
 * (docs/task-notes/2026-10-14-day7-dev1-log-sweep.md), not edited and not judged here: a flagged line is a candidate, not a proven leak. A NEW flagged
 * line in these files fails the guard until it is added here (so it is seen); a line that is fixed never fails it.
 */
export const FOREIGN_FLAGGED: { file: string; count: number; note: string }[] = [
  { file: "billing/checkout.ts", count: 6, note: "prints an error's message after redactSecrets" },
  { file: "billing/renewals.ts", count: 3, note: "errorText(e): an error's message after redactSecrets" },
  { file: "billing/start-trial.ts", count: 4, note: "errorText(e) and a `${text}`" },
  { file: "billing/trial.ts", count: 1, note: "prints an error's message as it is" },
  { file: "booking/bookings.ts", count: 2, note: "prints an error's message as it is" },
  { file: "booking/google-calendar.ts", count: 3, note: "Google's error text and describe(e)" },
  { file: "booking/google-sync.ts", count: 1, note: "prints an error's message as it is" },
  { file: "consent/deletion.ts", count: 1, note: "prints an error's message after redactSecrets" },
  { file: "conversations/mode.ts", count: 3, note: "prints a database error's message" },
  { file: "notify/send.ts", count: 2, note: "the sender's error message after redactSecrets, and notify_record's database message" },
  { file: "notify/templates.ts", count: 1, note: "prints an error's message as it is" },
  { file: "server/main.ts", count: 5, note: "start-up lines: the environment error message (names variables, not values), the pack-sync report lines, a non-literal line" },
];
