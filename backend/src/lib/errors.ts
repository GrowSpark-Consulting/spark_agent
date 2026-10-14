import type { ApiErrorBody, ErrorCode } from "@pakka/types";
import { ZodError } from "zod";

/**
 * What kind of error it was, for a log line: its name, and a short code when it has one (a Postgres SQLSTATE, a Node
 * error code). Never its message, which can carry a phone number, a key or a customer's words.
 */
export function errorKind(err: unknown): string {
  if (!(err instanceof Error)) return `a thrown ${err === null ? "null" : typeof err}`;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(code) ? `${err.name} (${code})` : err.name;
}

const STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 422,
  no_membership: 403,
  whatsapp_not_connected: 409,
  not_available: 501,
  upstream_failed: 502,
  internal: 500,
  outside_window: 409,
  conflict: 409,
  rate_limited: 429,
  insufficient_credits: 402,
  slot_taken: 409,
  plan_required: 403,
  seat_limit: 409,
};

/**
 * An error whose message is safe to show the user. Anything else that reaches an API boundary is
 * logged (redacted) and answered with a generic message.
 */
export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "AppError";
    this.status = STATUS[code];
  }
}

/** First message per field, keyed by the top-level input field. */
export function zodFieldErrors(err: ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = String(issue.path[0] ?? "form");
    fields[key] ??= issue.message;
  }
  return fields;
}

/** Converts any thrown value into the API error envelope and its HTTP status. */
export function toErrorResponse(err: unknown, log: (line: string) => void = console.error): {
  status: number;
  body: ApiErrorBody;
} {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: { error: { code: err.code, message: err.message, ...(err.fields && { fields: err.fields }) } },
    };
  }
  if (err instanceof ZodError) {
    return {
      status: 422,
      body: { error: { code: "validation_failed", message: "Check the highlighted fields.", fields: zodFieldErrors(err) } },
    };
  }
  // Unexpected: what kind of error it was, never its message (it can carry a phone number, a key or a customer's words). Never for the user.
  log(`[api] unexpected error: ${errorKind(err)}`);
  return {
    status: 500,
    body: { error: { code: "internal", message: "Something went wrong on our side. Try again in a moment." } },
  };
}
