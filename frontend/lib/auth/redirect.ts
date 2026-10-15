// Where to send someone after they sign in, sign up or come back from Google. Pure functions, so the
// login and signup actions, the OAuth callback and their tests all share one set of rules.

/**
 * Only paths inside the app, so `next` can't send someone to another site: `/dashboard…` or
 * `/onboarding…`, optionally with a simple query string. Anything else becomes `fallback`.
 */
export function safeNext(next: unknown, fallback = "/dashboard"): string {
  return typeof next === "string" && (/^\/(dashboard|onboarding)(\/[\w\-/]*)?(\?[\w\-=&%.]*)?$/.test(next) || INVITE_PATH.test(next)) ? next : fallback;
}

/** A team invitation page, /invite/<token> (the token is 32 random bytes, base64url). The only path outside the app proper that sign-in may return to. */
const INVITE_PATH = /^\/invite\/[A-Za-z0-9_-]{43}$/;

/** `next` if it is an invitation page, else null: for sign-up, which otherwise always continues to onboarding. */
export function inviteNext(next: unknown): string | null {
  return typeof next === "string" && INVITE_PATH.test(next) ? next : null;
}

/**
 * After a successful sign-in. An account that isn't linked to any business yet is a new account, so
 * it goes to onboarding. Everyone else goes to the dashboard page they asked for (or its home); an
 * existing member is never sent back into onboarding.
 */
export function destinationAfterAuth(hasBusiness: boolean, next: unknown): string {
  // Someone following an invitation goes back to it, with a business or without: accepting it is what gives them one.
  const invite = inviteNext(next);
  if (invite) return invite;
  if (!hasBusiness) return "/onboarding";
  const safe = safeNext(next);
  return safe.startsWith("/dashboard") ? safe : "/dashboard";
}

/**
 * Where a password reset link lands once /auth/callback has signed the person in. The callback only
 * sends people here when the code was issued for a recovery (see app/auth/callback/route.ts).
 */
export const RESET_PASSWORD_PATH = "/reset-password";

/** Why a sign-in link or Google round trip didn't finish. Shown as fixed copy, never raw provider text. */
export const AUTH_LINK_ERRORS = {
  signin_cancelled: "Sign-in was cancelled. Try again, or use your email and password.",
  link_expired: "That link has expired or was already used. Sign in, or sign up again to get a new one.",
  signin_failed: "We couldn't finish signing you in. Try again in a moment.",
} as const;

export type AuthLinkError = keyof typeof AUTH_LINK_ERRORS;

/** The message for an `?error=` code on /login or /signup; null for anything we didn't send. */
export function authLinkErrorMessage(code: unknown): string | null {
  return typeof code === "string" && Object.hasOwn(AUTH_LINK_ERRORS, code) ? AUTH_LINK_ERRORS[code as AuthLinkError] : null;
}

/** Maps the `error` / `error_code` that Supabase Auth appends to a redirect onto our own codes. */
export function authLinkErrorFrom(error: string | null, errorCode: string | null): AuthLinkError {
  if (errorCode === "otp_expired") return "link_expired";
  if (error === "access_denied") return "signin_cancelled";
  return "signin_failed";
}

/**
 * Back to the page the person started from: "forgot password" for a reset link, signup if they were
 * heading to onboarding, else login.
 */
export function authErrorPath(reason: AuthLinkError, next: unknown): string {
  const page = next === RESET_PASSWORD_PATH ? "/forgot-password" : safeNext(next).startsWith("/onboarding") ? "/signup" : "/login";
  return `${page}?error=${reason}`;
}
