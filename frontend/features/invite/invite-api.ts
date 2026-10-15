import { InviteAccepted, InvitePreview } from "@pakka/types";
import { getJson, postJson } from "@/lib/api/client";
import { ApiError } from "@/lib/errors";

// The invitation page (/invite/:token, backend/src/team). The token is a credential: it is read from the address, sent only to these two
// routes, kept in memory and never logged or stored. The invited address is never sent to the page; the signed-in user's email is checked on
// the server when they accept.
//   GET  /api/team/invites/:token          public: { status, businessName, role, expiresAt }; unknown or malformed → not_found
//   POST /api/team/invites/:token/accept   signed in: { tenantId, businessName, role, alreadyMember }

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
export const isInviteToken = (text: string): boolean => TOKEN_SHAPE.test(text);

export class InviteDataError extends Error {
  constructor(what: string) {
    super(`The ${what} answer had an unexpected shape.`);
    this.name = "InviteDataError";
  }
}

/** Reads what the page may say. Anonymous: a signed-in visitor's token does not ride along. */
export async function fetchInvite(token: string, signal?: AbortSignal): Promise<InvitePreview> {
  const parsed = InvitePreview.safeParse(await getJson<unknown>(`/api/team/invites/${token}`, { signal, anonymous: true }));
  if (!parsed.success) throw new InviteDataError("invitation");
  return parsed.data;
}

/** Accepts as the signed-in user. Success is the server's 200 with a business; nothing else counts as joined. */
export async function acceptInvitation(token: string): Promise<InviteAccepted> {
  const parsed = InviteAccepted.safeParse(await postJson<unknown>(`/api/team/invites/${token}/accept`, undefined));
  if (!parsed.success) throw new InviteDataError("acceptance");
  return parsed.data;
}

export type PreviewProblem = "invalid" | "rate_limited" | "failed";

export function previewProblem(err: unknown): PreviewProblem {
  if (err instanceof ApiError) {
    if (err.status === 404 || err.body.error.code === "not_found") return "invalid";
    if (err.status === 429 || err.body.error.code === "rate_limited") return "rate_limited";
  }
  return "failed";
}

export type AcceptProblem =
  /** The invitation cannot be used any more (expired, used, cancelled, replaced). */
  | "invalid"
  /** Signed in with a different email than the one invited. */
  | "wrong_email"
  /** Email not confirmed yet. */
  | "unconfirmed"
  | "seat_limit"
  | "rate_limited"
  | "signed_out"
  | "failed";

export function acceptProblem(err: unknown): AcceptProblem {
  if (err instanceof ApiError) {
    const { code, message } = err.body.error;
    if (code === "not_found" || err.status === 404) return "invalid";
    if (code === "forbidden") return /confirm your email/i.test(message) ? "unconfirmed" : "wrong_email";
    if (code === "seat_limit") return "seat_limit";
    if (code === "rate_limited" || err.status === 429) return "rate_limited";
    if (code === "unauthenticated" || err.status === 401) return "signed_out";
  }
  return "failed";
}

/** Where sign-in and sign-up send the person back to. */
export const invitePath = (token: string): string => `/invite/${token}`;
export const signInHref = (token: string): string => `/login?next=${encodeURIComponent(invitePath(token))}`;
export const signUpHref = (token: string): string => `/signup?next=${encodeURIComponent(invitePath(token))}`;
