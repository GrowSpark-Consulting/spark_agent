import {
  CHECKS,
  PROFILES,
  type CheckKind,
  type Coex,
  type IndustryKey,
  type ManualMode,
  type WaMethod,
  INDUSTRIES,
  trialChatUrl,
} from "@/features/onboarding/data";
import type { TrialInfo } from "@pakka/types";

/** `pending` is kept from the prototype's state model (“Waiting for Meta approval”). */
export type WaState = "idle" | "checking" | "pending" | "live";

export interface OnboardingState {
  step: number;

  /* step 0 — verify phone */
  phone: string;
  otpSent: boolean;
  otp: string;

  /* step 1 — business */
  biz: string;
  ind: number;
  /** The real trial, once the Business step has created it on the server. */
  trial: TrialInfo | null;
  /** Why the Business step couldn't continue, shown on that step. */
  trialError: string | null;
  /** The account already belongs to a business, so the Business step created nothing. */
  hasBusiness: boolean;

  /* step 4 — WhatsApp */
  wa: WaState;
  waMethod: WaMethod;
  coex: Coex;
  mMode: ManualMode;
  mWaba: string;
  mPhoneId: string;
  copied: string | null;
  /** The connection the API returned for Connect with Facebook, if any. Connected only when `status` is `active`. */
  waConnection: { status: string; displayPhone: string | null } | null;
  chkKind: CheckKind;
  chkStep: number;
  chkFail: number;
  /** Index the current run is scripted to fail at (-1 = none). */
  chkPlannedFail: number;
  /** Bumped on every run so a re-run restarts the timer even if values repeat. */
  chkRun: number;
  waitHi: boolean;

  /* step 5 — team: nothing is kept here. The feature switches are read from and saved to the server (features/onboarding/persistence.ts). */
}

export const initialState: OnboardingState = {
  step: 0,
  phone: "98400 12345",
  otpSent: false,
  otp: "",
  // Typed by the user: it becomes the real business's name. The trade's sample is only a placeholder.
  biz: "",
  ind: 0,
  trial: null,
  trialError: null,
  hasBusiness: false,
  wa: "idle",
  waMethod: "meta",
  coex: "yes",
  mMode: "partner",
  mWaba: "",
  mPhoneId: "",
  copied: null,
  waConnection: null,
  chkKind: "meta",
  chkStep: 0,
  chkFail: -1,
  chkPlannedFail: -1,
  chkRun: 0,
  waitHi: false,
};

export type Patch =
  | Partial<OnboardingState>
  | ((prev: OnboardingState) => Partial<OnboardingState>);

export type SetState = (patch: Patch) => void;

export function industryKey(state: OnboardingState): IndustryKey {
  return INDUSTRIES[state.ind]?.key ?? "re";
}

export function profileOf(state: OnboardingState) {
  return PROFILES[industryKey(state)];
}

/** The number the wizard's first field is pre-filled with. It is a sample, not anyone's number, so it is never sent anywhere. */
export const SAMPLE_PHONE_DIGITS = "9840012345";

/**
 * The WhatsApp number the person typed, as E.164, for the trial route's early "already had a trial" check. Only a ten-digit Indian mobile
 * number that is not the pre-filled sample counts; anything else sends nothing (the route treats a missing number as no check).
 */
export function trialPhoneOf(state: OnboardingState): string | undefined {
  const digits = state.phone.replace(/\D/g, "").replace(/^(91|0)(?=\d{10}$)/, "");
  if (!/^[6-9]\d{9}$/.test(digits) || digits === SAMPLE_PHONE_DIGITS) return undefined;
  return `+91${digits}`;
}

/** The route code the backend returned when it created the trial; null when there is no trial (never a sample code). */
export function trialCodeOf(state: OnboardingState): string | null {
  return state.trial?.routeCode ?? null;
}

/**
 * What the "Try it" step can honestly offer: no trial (the account already had a business, or the API made none) means no test chat;
 * a trial without a configured demo number shows the real code but no link; otherwise the link, built from the backend's route code.
 */
export type TestChat =
  | { kind: "none"; reason: "has_business" | "no_trial" }
  | { kind: "unavailable"; code: string }
  | { kind: "ready"; code: string; url: string };

export function testChatOf(state: OnboardingState, demoNumber: string | null): TestChat {
  // A trial this wizard created stays real even if a repeat submit then finds the business (hasBusiness); only the lack of one matters.
  const code = trialCodeOf(state);
  if (!code) return { kind: "none", reason: state.hasBusiness ? "has_business" : "no_trial" };
  const url = trialChatUrl(demoNumber, code);
  return url ? { kind: "ready", code, url } : { kind: "unavailable", code };
}

/** Display fallback used in copy (“It already knows your business.”). */
export function bizLabel(state: OnboardingState) {
  return state.biz || "your business";
}

/**
 * Which check index fails for a given preview run, based on what the user typed. Only partner access
 * runs checks: the own-app path takes no token or secret in the browser.
 */
export function plannedFailure(kind: CheckKind, s: OnboardingState): number {
  if (kind === "partner") {
    if (!s.mWaba.trim()) return 0;
    if (!s.mPhoneId.trim()) return 1;
  }
  return -1;
}

/** Manual connections pause on the last row until a “hi” arrives. */
export function waitHiIndex(kind: CheckKind) {
  return kind === "meta" ? -1 : CHECKS[kind].length - 1;
}
