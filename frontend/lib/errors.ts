import { ApiErrorBody, containsSecret, type ErrorCode } from "@pakka/types";

/** What the UI shows for an error. Never contains raw provider messages, stack traces or secrets. */
export interface FormattedError {
  code: ErrorCode | "network" | "auth";
  title: string;
  message: string;
  retryable: boolean;
  fields?: Record<string, string>;
}

/** An error response from one of our API routes, in the `{ error: { code, message } }` envelope. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.error.message);
    this.name = "ApiError";
  }
}

const TITLES: Record<ErrorCode, string> = {
  unauthenticated: "You're signed out",
  forbidden: "You don't have access to this",
  not_found: "Not found",
  validation_failed: "Check the highlighted fields",
  no_membership: "No business on this account",
  whatsapp_not_connected: "WhatsApp isn't connected",
  not_available: "Not available yet",
  upstream_failed: "Couldn't reach the service",
  internal: "Something went wrong",
  outside_window: "Outside the 24-hour window",
  conflict: "That already exists",
  rate_limited: "Too many requests",
  insufficient_credits: "Not enough credits",
  slot_taken: "That slot is taken",
  plan_required: "Not on your plan",
  seat_limit: "No seats left",
};

const GENERIC: FormattedError = {
  code: "internal",
  title: TITLES.internal,
  message: "Something went wrong. Try again in a moment.",
  retryable: true,
};

// Supabase Auth error codes worth a specific message; everything else gets a generic one.
const AUTH_MESSAGES: Record<string, string> = {
  invalid_credentials: "Email or password is incorrect.",
  email_not_confirmed: "Confirm your email address first, then sign in.",
  user_banned: "This account has been disabled. Contact your business owner.",
  over_request_rate_limit: "Too many attempts. Wait a minute and try again.",
  over_email_send_rate_limit: "Too many attempts. Wait a minute and try again.",
  weak_password: "Choose a stronger password: longer, and not one you use elsewhere.",
  same_password: "Choose a password you haven't used for this account before.",
  email_address_invalid: "Use a different email address.",
  signup_disabled: "New accounts can't be created right now. Try again later.",
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Converts anything thrown into a safe, user-facing message. Supabase and unknown errors never show
 * their raw text; API messages are shown because our API writes them for users, but are still
 * dropped if they look like they contain a credential.
 */
export function formatError(err: unknown): FormattedError {
  if (err instanceof ApiError) {
    const { code, message, fields } = err.body.error;
    const safe = message && !containsSecret(message) ? message : GENERIC.message;
    return {
      code,
      title: TITLES[code],
      message: safe,
      retryable: code === "upstream_failed" || code === "internal",
      ...(fields && { fields }),
    };
  }

  // fetch() itself failed: offline, DNS, server down.
  if (err instanceof TypeError && /fetch|network/i.test(err.message)) {
    return { code: "network", title: "You're offline", message: "We couldn't reach Spark Agent. Check your connection and try again.", retryable: true };
  }

  if (isRecord(err)) {
    // Supabase Auth (AuthApiError and friends carry __isAuthError and a string code).
    if (err.__isAuthError === true || (typeof err.name === "string" && err.name.startsWith("Auth"))) {
      const code = typeof err.code === "string" ? err.code : "";
      return {
        code: "auth",
        title: "Couldn't sign you in",
        message: AUTH_MESSAGES[code] ?? "We couldn't sign you in. Try again in a moment.",
        retryable: !(code in AUTH_MESSAGES) || code.startsWith("over_"),
      };
    }
    // PostgREST: { code, message, details, hint }. Database detail never reaches the screen.
    // 42501 is a row-level-security refusal on a write (migration 0028: only owners and admins change the business's setup).
    if (err.code === "42501" && "details" in err && "hint" in err) {
      return { code: "forbidden", title: TITLES.forbidden, message: "Only an owner or admin can change this. Nothing was changed.", retryable: false };
    }
    if (typeof err.code === "string" && "details" in err && "hint" in err) {
      return { code: "upstream_failed", title: TITLES.upstream_failed, message: "We couldn't load this data. Try again in a moment.", retryable: true };
    }
    // Zod (validated before sending).
    if (err.name === "ZodError" && Array.isArray(err.issues)) {
      const fields: Record<string, string> = {};
      for (const issue of err.issues as { path: unknown[]; message: string }[]) {
        const key = String(issue.path[0] ?? "form");
        fields[key] ??= issue.message;
      }
      return { code: "validation_failed", title: TITLES.validation_failed, message: "Check the highlighted fields.", retryable: false, fields };
    }
  }

  return GENERIC;
}

/** An ApiError from a failed response's status and parsed body (falls back to a generic error body). */
export function apiErrorFromBody(status: number, json: unknown): ApiError {
  const parsed = ApiErrorBody.safeParse(json);
  return new ApiError(status, parsed.success ? parsed.data : { error: { code: "internal", message: GENERIC.message } });
}

/** Parses a failed API response into an ApiError (falls back to a generic error body). */
export async function apiErrorFrom(res: Response): Promise<ApiError> {
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // Not JSON (proxy error page, network middlebox): use the generic body.
  }
  return apiErrorFromBody(res.status, json);
}
