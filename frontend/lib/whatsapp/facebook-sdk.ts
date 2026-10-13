import type { MetaSignupConfig } from "@/lib/env";
import { newSignupSession, parseSignupMessage, reduceSignup, type SignupInput, type SignupOutcome } from "./embedded-signup";

// Meta Embedded Signup, the browser part: loads Facebook's JS SDK on demand and runs one FB.login
// popup, returning what happened. Browser only (call it from a click handler in a client component).
//
// Where it is used: the WhatsApp step of the onboarding wizard (lib/whatsapp/owner-embedded-signup.ts) and the
// assisted /connect/:token page call runEmbeddedSignup when the person clicks "Continue with Facebook". The SDK
// is loaded then, not in a layout, so no page loads Facebook's script unless someone starts the flow. The code
// it returns expires in about 30 seconds and goes straight to POST /api/onboarding/whatsapp/embedded-signup.

export const FACEBOOK_SDK_URL = "https://connect.facebook.net/en_US/sdk.js";
/**
 * The Graph API version the SDK is initialised with. Keep it equal to the API's META_GRAPH_API_VERSION
 * (backend/.env.example); a public NEXT_PUBLIC_ variable could replace this once the team agrees.
 */
export const FACEBOOK_SDK_VERSION = "v26.0";
/** After one half (code or finish message) arrives, how long to wait for the other. */
const OTHER_HALF_TIMEOUT_MS = 10_000;

interface FacebookSdk {
  init(options: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }): void;
  login(callback: (response: unknown) => void, options: Record<string, unknown>): void;
}

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

let sdk: Promise<FacebookSdk> | null = null;

/** Loads and initialises the SDK once per page. Rejects if the script can't load. */
export function loadFacebookSdk(config: Extract<MetaSignupConfig, { status: "ready" }>): Promise<FacebookSdk> {
  sdk ??= new Promise<FacebookSdk>((resolve, reject) => {
    const init = () => {
      const FB = window.FB;
      if (!FB) return reject(new Error("Facebook's sign-in script didn't start."));
      FB.init({ appId: config.appId, autoLogAppEvents: true, xfbml: false, version: FACEBOOK_SDK_VERSION });
      resolve(FB);
    };
    if (window.FB) return init();
    window.fbAsyncInit = init;
    const script = document.createElement("script");
    script.src = FACEBOOK_SDK_URL;
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.onerror = () => {
      sdk = null; // allow a retry
      reject(new Error("Facebook's sign-in script couldn't load. Check your connection and try again."));
    };
    document.body.appendChild(script);
  });
  return sdk;
}

/**
 * Opens Meta's Embedded Signup popup and resolves with the outcome. Only messages from facebook.com
 * origins are read. The resulting payload holds a short-lived code and two ids, never a token.
 */
export async function runEmbeddedSignup(
  config: MetaSignupConfig,
  { coexistence }: { coexistence: boolean },
): Promise<SignupOutcome | { status: "unavailable"; problems: string[] }> {
  if (config.status !== "ready") return { status: "unavailable", problems: config.problems };
  const FB = await loadFacebookSdk(config);

  return new Promise<SignupOutcome>((resolve) => {
    let session = newSignupSession();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const step = (input: SignupInput) => {
      session = reduceSignup(session, input);
      if (session.outcome) {
        window.removeEventListener("message", onMessage);
        clearTimeout(timer);
        resolve(session.outcome);
      } else if ((session.code || session.finish) && !timer) {
        timer = setTimeout(() => step({ type: "timeout" }), OTHER_HALF_TIMEOUT_MS);
      }
    };
    const onMessage = (e: MessageEvent) => {
      const event = parseSignupMessage(e.origin, e.data);
      if (event) step({ type: "message", event });
    };

    window.addEventListener("message", onMessage);
    // FB.login's callback must be a plain function (the SDK rejects async ones).
    FB.login((response) => step({ type: "login", response }), {
      config_id: config.configId,
      response_type: "code",
      override_default_response_type: true,
      // featureType switches to coexistence onboarding (WhatsApp Business app users). Unconfirmed in
      // the pages we read: check Meta's docs for the pinned version before switching this on.
      extras: coexistence ? { setup: {}, featureType: "whatsapp_business_app_onboarding" } : { setup: {} },
    });
  });
}
