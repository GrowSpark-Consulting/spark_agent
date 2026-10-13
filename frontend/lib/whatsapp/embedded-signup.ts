import { z } from "zod";

// Meta Embedded Signup, the pure part: which window messages to trust, what they mean, and how the
// login code and the finish message combine into the one payload the API will need. No DOM, no
// network, so it runs under Vitest. The browser part (SDK loading, FB.login) is facebook-sdk.ts.
//
// Field and event names follow Meta's Embedded Signup implementation page (checked October 2026):
// FB.login returns authResponse.code (valid about 30 seconds); a message of type WA_EMBEDDED_SIGNUP
// reports FINISH { phone_number_id, waba_id, business_id }, CANCEL { current_step } or
// ERROR { error_message, error_code }. Coexistence (WhatsApp Business app users) finishes with
// FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING, whose example carries waba_id only. FINISH_ONLY_WABA is
// unconfirmed in the pages we read and is treated as a finish without a number. Re-check against
// Meta's docs before switching the flow on.
//
// The payload is shaped like handover module 10, step 3 ({ code, wabaId, phoneNumberId, coexistence }
// to POST /api/onboarding/whatsapp/embedded-signup, which answers not_available while
// EMBEDDED_SIGNUP_ENABLED is off). Nothing here sends anything; features/connect/connect-link.ts does.

const MESSAGE_TYPE = "WA_EMBEDDED_SIGNUP";
const META_ID = z.string().regex(/^\d{1,32}$/);

/** True only for https pages on facebook.com or one of its subdomains (www., web., business.). */
export function isMetaOrigin(origin: string): boolean {
  if (!URL.canParse(origin)) return false;
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.port !== "" || url.origin !== origin) return false;
  return url.hostname === "facebook.com" || url.hostname.endsWith(".facebook.com");
}

const Message = z.object({
  type: z.literal(MESSAGE_TYPE),
  event: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export type SignupEvent =
  | { kind: "finish"; wabaId: string; phoneNumberId: string | null; coexistence: boolean }
  | { kind: "cancel"; step: string | null }
  /** Meta's error text is never shown or kept; only its code, for support. */
  | { kind: "error"; errorCode: string | null };

const FINISH_EVENTS: Record<string, { coexistence: boolean; needsNumber: boolean }> = {
  FINISH: { coexistence: false, needsNumber: true },
  FINISH_ONLY_WABA: { coexistence: false, needsNumber: false },
  FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING: { coexistence: true, needsNumber: false },
};

const shortText = (value: unknown, max = 120) =>
  typeof value === "string" && value.trim() !== "" && value.length <= max ? value.trim() : null;
const idText = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value);

/**
 * The Embedded Signup event in a window message, or null when the message isn't one we trust or
 * understand. Messages from other origins, other message types and malformed ids are all ignored.
 */
export function parseSignupMessage(origin: string, data: unknown): SignupEvent | null {
  if (!isMetaOrigin(origin)) return null;
  let raw = data;
  if (typeof raw === "string") {
    if (raw.length > 10_000) return null;
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const parsed = Message.safeParse(raw);
  if (!parsed.success) return null;
  const { event, data: fields = {} } = parsed.data;

  const finish = FINISH_EVENTS[event];
  if (finish) {
    const waba = META_ID.safeParse(idText(fields.waba_id));
    if (!waba.success) return null;
    const phone = META_ID.safeParse(idText(fields.phone_number_id));
    if (finish.needsNumber && !phone.success) return null;
    return {
      kind: "finish",
      wabaId: waba.data,
      phoneNumberId: phone.success ? phone.data : null,
      coexistence: finish.coexistence,
    };
  }
  if (event === "CANCEL") return { kind: "cancel", step: shortText(fields.current_step) };
  if (event === "ERROR") return { kind: "error", errorCode: shortText(idText(fields.error_code), 32) };
  return null;
}

/** What the browser will post once the API endpoint exists (handover module 10, step 3). */
export const EmbeddedSignupPayload = z.object({
  code: z.string().min(1).max(2048),
  wabaId: META_ID,
  /** Null when Meta's finish event carried no number (coexistence; see the note at the top). */
  phoneNumberId: META_ID.nullable(),
  coexistence: z.boolean(),
});
export type EmbeddedSignupPayload = z.infer<typeof EmbeddedSignupPayload>;

export type SignupOutcome =
  | { status: "finished"; payload: EmbeddedSignupPayload }
  | { status: "cancelled"; step: string | null }
  /** `error`: Meta reported one. `incomplete`: a code arrived but no finish message, or the reverse. */
  | { status: "failed"; reason: "error" | "incomplete"; errorCode: string | null };

/** One popup run: the login code and the finish message arrive separately, in either order. */
export interface SignupSession {
  code: string | null;
  finish: Extract<SignupEvent, { kind: "finish" }> | null;
  outcome: SignupOutcome | null;
}

export type SignupInput =
  | { type: "message"; event: SignupEvent }
  /** FB.login's callback argument, untrusted. */
  | { type: "login"; response: unknown }
  /** The wait for the other half ran out. */
  | { type: "timeout" };

export const newSignupSession = (): SignupSession => ({ code: null, finish: null, outcome: null });

const LoginResponse = z.object({ authResponse: z.object({ code: z.string().min(1).max(2048) }).nullish() });

/** Folds one input into the session. Once there is an outcome, later inputs change nothing. */
export function reduceSignup(session: SignupSession, input: SignupInput): SignupSession {
  if (session.outcome) return session;
  let { code, finish } = session;

  if (input.type === "timeout") {
    return { ...session, outcome: { status: "failed", reason: "incomplete", errorCode: null } };
  }
  if (input.type === "login") {
    const parsed = LoginResponse.safeParse(input.response);
    code = parsed.success ? (parsed.data.authResponse?.code ?? null) : null;
    // Closed without a code: the CANCEL message (with its step) may already have ended the run.
    if (!code) return { code: null, finish, outcome: { status: "cancelled", step: null } };
  } else if (input.event.kind === "cancel") {
    return { ...session, outcome: { status: "cancelled", step: input.event.step } };
  } else if (input.event.kind === "error") {
    return { ...session, outcome: { status: "failed", reason: "error", errorCode: input.event.errorCode } };
  } else {
    finish = input.event;
  }

  if (code && finish) {
    const payload = EmbeddedSignupPayload.parse({
      code,
      wabaId: finish.wabaId,
      phoneNumberId: finish.phoneNumberId,
      coexistence: finish.coexistence,
    });
    return { code, finish, outcome: { status: "finished", payload } };
  }
  return { code, finish, outcome: null };
}
