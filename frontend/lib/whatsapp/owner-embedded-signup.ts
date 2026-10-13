import { WhatsAppConnectionPublic } from "@pakka/types";
import { apiFetch } from "@/lib/api/client";
import { metaSignupConfig } from "@/lib/env";
import { apiErrorFrom, formatError, type FormattedError } from "@/lib/errors";
import { runEmbeddedSignup } from "./facebook-sdk";
import { resolveWhatsAppTenant, type WhatsAppTenantResult } from "./manual-connect";

// "Connect with Facebook" for a signed-in owner or admin (the onboarding wizard's WhatsApp step). One click runs Meta's Embedded Signup popup
// (facebook-sdk.ts), then sends what it returned to the API:
//   POST /api/onboarding/whatsapp/embedded-signup  { code, wabaId, phoneNumberId, coexistence }  with X-Pakka-Tenant → 201 the connection
// (docs/whatsapp-connection-contract.md, "Embedded Signup exchange"; backend/src/channels/whatsapp/connect/embedded-signup.ts). No connectToken:
// that is the assisted /connect/:token flow (features/connect/connect-link.ts), and the API ignores one on this signed-in path.
//
// Only a 201 with a valid connection counts as a result, and only a connection whose status is `active` may be called connected (the screen
// decides that from the API's answer). A closed window, a Meta error, the API switched off (not_available, 501, while EMBEDDED_SIGNUP_ENABLED is
// off), a refusal, a network failure or an answer that is not a connection each come back as their own state. Meta's code is sent once, in the
// body, and is not kept, logged or returned; no token ever reaches the browser.
//
// The popup runs before anything else is awaited, so the browser still treats it as the person's click. The business is then worked out again
// (never trusted from earlier) and must be the one the step was opened for.

export type OwnerSignupProblem =
  /** Facebook's script failed to load or start. */
  | "script"
  /** Meta reported an error in its window. */
  | "meta_error"
  /** The window gave a code but no finish message, or the reverse. */
  | "incomplete"
  /** Meta's finish message had no phone number (the API needs one). Nothing was sent. */
  | "no_number"
  /** The business could not be worked out, or is not the one this step was opened for. Nothing was sent. */
  | "business"
  /** The API refused the details (validation_failed, conflict, upstream_failed, forbidden, ...). */
  | "refused"
  /** The API could not be reached. */
  | "network"
  /** The API answered 2xx with something that is not a connection: nothing can be claimed. */
  | "unconfirmed";

export type OwnerSignupResult =
  /** The API saved a connection. Its `status` says whether it is active; only then is the number connected. */
  | { state: "connected"; connection: WhatsAppConnectionPublic }
  | { state: "cancelled"; step: string | null }
  /** This site has no Meta app configured (NEXT_PUBLIC_META_APP_ID / NEXT_PUBLIC_META_ES_CONFIG_ID): the popup never opened. */
  | { state: "not_configured" }
  /** The API has Embedded Signup switched off (501). */
  | { state: "not_available"; message: string }
  | { state: "failed"; problem: OwnerSignupProblem; message: string; retryable: boolean; code?: FormattedError["code"] };

/** The API's body. Exactly these four keys: no tenantId (the business is the caller's), no connectToken (the assisted flow). */
export interface OwnerSignupBody {
  code: string;
  wabaId: string;
  phoneNumberId: string;
  coexistence: boolean;
}

export interface OwnerSignupDeps {
  runSignup: (options: { coexistence: boolean }) => ReturnType<typeof runEmbeddedSignup>;
  resolveTenant: () => Promise<WhatsAppTenantResult>;
  send: (body: OwnerSignupBody, tenantId: string) => Promise<Response>;
}

/** The request itself: the signed-in user's bearer token and the business in X-Pakka-Tenant (lib/api/client.ts). */
export function sendOwnerSignup(body: OwnerSignupBody, tenantId: string): Promise<Response> {
  return apiFetch("/api/onboarding/whatsapp/embedded-signup", { method: "POST", body, tenantId });
}

const defaultDeps: OwnerSignupDeps = {
  runSignup: (options) => runEmbeddedSignup(metaSignupConfig(), options),
  resolveTenant: () => resolveWhatsAppTenant(),
  send: sendOwnerSignup,
};

const SCRIPT = "Facebook’s sign-in couldn’t start. Check your connection and try again.";
const META_ERROR = "Facebook reported a problem, so nothing was connected. Try again.";
const INCOMPLETE = "Facebook’s window didn’t finish, so nothing was connected. Try again.";
// The API's own words for a finish with no number (embedded-signup.ts, Body.phoneNumberId).
const NO_NUMBER = "Pick or add a phone number in the Facebook sign-in, then try again.";
const BUSINESS_CHANGED = "Your business changed since this step opened, so nothing was sent. Reload the page and try again.";
const UNCONFIRMED = "We couldn’t confirm the connection. Check your dashboard’s WhatsApp page before trying again.";
/** Refusals that another attempt cannot fix. */
const PERMANENT: ReadonlySet<FormattedError["code"]> = new Set(["forbidden", "unauthenticated", "no_membership"]);

const failed = (problem: OwnerSignupProblem, message: string, retryable: boolean, code?: FormattedError["code"]): OwnerSignupResult => ({
  state: "failed",
  problem,
  message,
  retryable,
  ...(code && { code }),
});

/** One run: the popup, then the business, then the API. Never throws. */
export async function connectOwnerWithFacebook(
  { coexistence, tenantId }: { coexistence: boolean; tenantId: string },
  deps: OwnerSignupDeps = defaultDeps,
): Promise<OwnerSignupResult> {
  let outcome: Awaited<ReturnType<OwnerSignupDeps["runSignup"]>>;
  try {
    outcome = await deps.runSignup({ coexistence });
  } catch {
    return failed("script", SCRIPT, true);
  }
  if (outcome.status === "unavailable") return { state: "not_configured" };
  if (outcome.status === "cancelled") return { state: "cancelled", step: outcome.step };
  if (outcome.status === "failed") return outcome.reason === "error" ? failed("meta_error", META_ERROR, true) : failed("incomplete", INCOMPLETE, true);

  const { payload } = outcome;
  if (!payload.phoneNumberId) return failed("no_number", NO_NUMBER, true);

  const tenant = await deps.resolveTenant().catch((): WhatsAppTenantResult => ({ state: "error", message: "We couldn’t load your business. Try again in a moment.", retryable: true }));
  if (tenant.state !== "ready") return failed("business", tenant.message, tenant.retryable);
  if (tenant.tenantId !== tenantId) return failed("business", BUSINESS_CHANGED, false);

  const body: OwnerSignupBody = { code: payload.code, wabaId: payload.wabaId, phoneNumberId: payload.phoneNumberId, coexistence: payload.coexistence };
  let res: Response;
  try {
    res = await deps.send(body, tenant.tenantId);
  } catch (err) {
    return failed("network", formatError(err).message, true, "network");
  }
  if (!res.ok) {
    const shown = formatError(await apiErrorFrom(res));
    if (shown.code === "not_available") return { state: "not_available", message: shown.message };
    // A field-level reason (the number isn't in the account, the code was refused) says more than the envelope's summary.
    const reason = shown.fields?.phoneNumberId ?? shown.fields?.wabaId ?? shown.fields?.code ?? shown.message;
    return failed("refused", reason, !PERMANENT.has(shown.code), shown.code);
  }
  const parsed = WhatsAppConnectionPublic.safeParse(await res.json().catch(() => null));
  // Not retryable: the API may have saved a connection, and a second run would spend another code on it.
  if (!parsed.success) return failed("unconfirmed", UNCONFIRMED, false);
  return { state: "connected", connection: parsed.data };
}

/**
 * At most one run at a time. A second start while one is running resolves null and opens nothing: a ref-like flag, because two clicks in
 * the same tick both arrive before React re-renders a disabled button.
 */
export function createOwnerSignup(deps: OwnerSignupDeps = defaultDeps) {
  let running = false;
  return {
    async start(input: { coexistence: boolean; tenantId: string }): Promise<OwnerSignupResult | null> {
      if (running) return null;
      running = true;
      try {
        return await connectOwnerWithFacebook(input, deps);
      } finally {
        running = false;
      }
    },
  };
}
