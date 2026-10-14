import { z } from "zod";

/**
 * Error codes the UI branches on. Every API route answers errors as
 * `{ error: { code, message } }` (docs/handover.md, "API and webhook endpoints").
 */
export const ERROR_CODES = [
  "unauthenticated",
  "forbidden",
  "not_found",
  "validation_failed",
  "no_membership",
  "whatsapp_not_connected",
  "not_available",
  "upstream_failed",
  "internal",
  "outside_window",
  "conflict",
  "rate_limited",
  "insufficient_credits",
  "slot_taken",
  "plan_required",
  "seat_limit",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ApiErrorBody = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    /** Field-level validation messages, keyed by input field. */
    fields: z.record(z.string(), z.string()).optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

// Credentials that must never reach a log line or the screen. Matches connection strings with a
// password, JWTs, Supabase API keys, Meta access tokens, bearer headers, Anthropic keys and any other run of
// 32 or more key characters (a connect-link or hand-over token, an app secret, a hash) that is not a UUID.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_PATTERNS: [RegExp, string | ((match: string) => string)][] = [
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]*:[^\s/@]*@/gi, "$1[redacted]@"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, "[redacted-jwt]"],
  [/\bsb_(secret|publishable)_[A-Za-z0-9_-]+/g, "[redacted-key]"],
  [/\bEAA[A-Za-z0-9]{20,}/g, "[redacted-token]"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]"],
  [/\bsk-ant-[A-Za-z0-9_-]+/g, "[redacted-key]"],
  [/[A-Za-z0-9_-]{32,}/g, (run) => (UUID_RE.test(run) ? run : "[redacted]")],
];

/** Removes anything that looks like a credential. Use before logging or displaying text. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((out, [re, sub]) => (typeof sub === "string" ? out.replace(re, sub) : out.replace(re, sub)), text);
}

/** True if the text contains something that looks like a credential. */
export function containsSecret(text: string): boolean {
  return redactSecrets(text) !== text;
}
