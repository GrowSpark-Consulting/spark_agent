import { z } from "zod";
import { getJson, postJson } from "@/lib/api/client";
import { containsSecret } from "@pakka/types";
import { ApiError } from "@/lib/errors";
import type { EmbeddedSignupPayload } from "@/lib/whatsapp/embedded-signup";

// The assisted connect page (/connect/:token, docs/whatsapp-connection-contract.md, "Assisted connect link"). A Spark Agent admin makes a
// link for a business (POST /api/admin/whatsapp/connect-link → { url, expiresAt }; valid 24 hours, single use); the business owner opens it
// without signing in and connects their number through Meta's Embedded Signup.
//   GET  /api/connect-links/:token                       public → { tenantName, expiresAt }; unknown, expired or used → not_found (404);
//                                                        not_available (501) while Embedded Signup is switched off on the server
//   POST /api/onboarding/whatsapp/embedded-signup        { code, wabaId, phoneNumberId, coexistence, connectToken } → 201 the connection
//                                                        not_available (501) while EMBEDDED_SIGNUP_ENABLED is off. Until the assisted-link
//                                                        PR it takes only { code, wabaId, phoneNumberId, coexistence } and answers
//                                                        validation_failed to connectToken, which this page reads as "failed"
// The token is a credential: it is read from the address, sent only to these two routes, kept in memory and never logged or stored. The
// Meta login code is sent once, in the POST body, and is not kept anywhere (embedded-signup.ts).

/** A link token: 32 random bytes as base64url (backend/src/lib/connect-link-token.ts). Anything else can't be a link, so no request is made. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
export const isLinkToken = (text: string): boolean => TOKEN_SHAPE.test(text);

export const ConnectLinkAnswer = z.object({ tenantName: z.string().min(1), expiresAt: z.string().refine((s) => Number.isFinite(Date.parse(s)), "not a date") });
export type ConnectLink = z.infer<typeof ConnectLinkAnswer>;

/** The connection the exchange answers with; only what the page says about it. */
const ConnectedAnswer = z.object({ id: z.string(), status: z.string() });
export type ConnectedNumber = z.infer<typeof ConnectedAnswer>;

export class ConnectDataError extends Error {
  constructor(what: string) {
    super(`The ${what} answer had an unexpected shape.`);
    this.name = "ConnectDataError";
  }
}

/** Reads the link's business and expiry. Throws ApiError for the server's refusals (not_found, not_available, rate_limited). */
export async function fetchConnectLink(token: string, signal?: AbortSignal): Promise<ConnectLink> {
  const parsed = ConnectLinkAnswer.safeParse(await getJson<unknown>(`/api/connect-links/${token}`, { signal, anonymous: true }));
  if (!parsed.success) throw new ConnectDataError("connect link");
  return parsed.data;
}

/** Sends the Embedded Signup result for this link. 201 is the backend's confirmation; nothing else is treated as connected. */
export async function submitEmbeddedSignup(token: string, payload: EmbeddedSignupPayload): Promise<ConnectedNumber> {
  const parsed = ConnectedAnswer.safeParse(await postJson<unknown>("/api/onboarding/whatsapp/embedded-signup", { ...payload, connectToken: token }, { anonymous: true }));
  if (!parsed.success) throw new ConnectDataError("connection");
  return parsed.data;
}

export type LinkProblem =
  /** Unknown, expired or already used: the server doesn't say which, and neither does the page. */
  | "invalid"
  /** Embedded Signup is switched off on the server. */
  | "not_available"
  | "rate_limited"
  /** Anything else: the page offers Try again. */
  | "failed";

/** Which words a refused link read gets. */
export function linkProblem(err: unknown): LinkProblem {
  if (err instanceof ApiError) {
    if (err.status === 404 || err.body.error.code === "not_found") return "invalid";
    if (err.status === 501 || err.body.error.code === "not_available") return "not_available";
    if (err.status === 429 || err.body.error.code === "rate_limited") return "rate_limited";
  }
  return "failed";
}

export type SubmitProblem =
  /** 404: unknown, expired or used. The link can't be tried again. */
  | "invalid"
  | "conflict"
  | "not_available"
  | "rate_limited"
  /** validation_failed: the server names the field (for example phoneNumberId when Meta returned no number). */
  | "validation"
  | "meta_failed"
  | "failed";

/** Which words a refused exchange gets (contract: not_found, conflict, upstream_failed, not_available, rate_limited, validation_failed). */
export function submitProblem(err: unknown): SubmitProblem {
  if (err instanceof ApiError) {
    const code = err.body.error.code;
    if (code === "not_found" || err.status === 404) return "invalid";
    if (code === "conflict") return "conflict";
    if (code === "not_available" || err.status === 501) return "not_available";
    if (code === "rate_limited" || err.status === 429) return "rate_limited";
    if (code === "validation_failed") return "validation";
    if (code === "upstream_failed") return "meta_failed";
  }
  return "failed";
}

/** The per-field messages of a validation_failed answer (the API writes them for the person), or none. Anything that looks like a credential is dropped. */
export function submitFields(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || err.body.error.code !== "validation_failed") return {};
  const out: Record<string, string> = {};
  for (const [field, message] of Object.entries(err.body.error.fields ?? {})) if (!containsSecret(message)) out[field] = message;
  return out;
}

/**
 * What the page may say after a 201. Only a connection the server reports `active` is connected. A number that was saved but did not pass its
 * checks (`failed`, or anything else that is not live) or is still being checked (`pending`, `validating`) is not.
 */
export type ConnectionOutcome = "connected" | "check_failed" | "checking";
export function connectionOutcome(status: string): ConnectionOutcome {
  if (status === "active") return "connected";
  if (status === "pending" || status === "validating") return "checking";
  return "check_failed";
}

export type SubmitResult =
  | { kind: "connected" }
  | { kind: "checking" }
  /** The link itself can't be used (404): the page becomes the invalid-link page. */
  | { kind: "invalid" }
  | { kind: "failed"; problem: Exclude<SubmitProblem, "invalid"> | "check_failed"; fields: Record<string, string> };

/**
 * Sends the Embedded Signup result and turns the answer into what the page may say. Success needs the server's 201 AND a connection that is
 * `active`; every refusal leaves the link usable again (a failed attempt does not consume it), except a 404.
 */
export async function sendSignup(token: string, payload: EmbeddedSignupPayload): Promise<SubmitResult> {
  try {
    const connected = await submitEmbeddedSignup(token, payload);
    const outcome = connectionOutcome(connected.status);
    return outcome === "connected" ? { kind: "connected" } : outcome === "checking" ? { kind: "checking" } : { kind: "failed", problem: "check_failed", fields: {} };
  } catch (err) {
    const problem = submitProblem(err);
    return problem === "invalid" ? { kind: "invalid" } : { kind: "failed", problem, fields: submitFields(err) };
  }
}
