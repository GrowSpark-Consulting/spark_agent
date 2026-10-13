import { z } from "zod";
import { getJson, postJson } from "@/lib/api/client";
import { ApiError } from "@/lib/errors";
import type { EmbeddedSignupPayload } from "@/lib/whatsapp/embedded-signup";

// The assisted connect page (/connect/:token, docs/whatsapp-connection-contract.md, "Assisted connect link"). A Spark Agent admin makes a
// link for a business (POST /api/admin/whatsapp/connect-link → { url, expiresAt }; valid 24 hours, single use); the business owner opens it
// without signing in and connects their number through Meta's Embedded Signup.
//   GET  /api/connect-links/:token                       public → { tenantName, expiresAt }; unknown, expired or used → not_found (404);
//                                                        not_available (501) while Embedded Signup is switched off on the server
//   POST /api/onboarding/whatsapp/embedded-signup        { code, wabaId, phoneNumberId, coexistence, connectToken } → 201 the connection
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

export type SubmitProblem = "invalid" | "conflict" | "not_available" | "meta_failed" | "failed";

/** Which words a refused exchange gets (contract: not_found, conflict, upstream_failed, not_available, validation_failed). */
export function submitProblem(err: unknown): SubmitProblem {
  if (err instanceof ApiError) {
    const code = err.body.error.code;
    if (code === "not_found") return "invalid";
    if (code === "conflict") return "conflict";
    if (code === "not_available" || err.status === 501) return "not_available";
    if (code === "upstream_failed") return "meta_failed";
  }
  return "failed";
}
