import {
  CHECKS,
  PROFILES,
  type CheckKind,
  type Coex,
  type IndustryKey,
  type ManualMode,
  type StaffMember,
  type WaMethod,
  INDUSTRIES,
  TRIAL_CODE,
} from "@/features/onboarding/data";
import type { TrialInfo } from "@pakka/types";

export type ImportState = "idle" | "run" | "done";
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

  /* step 2 — teach */
  site: string;
  imp: ImportState;
  impStep: number;
  faq: boolean[];

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

  /* step 5 — team */
  staff: StaffMember[];
  cal: boolean;
  feats: boolean[];
}

export const DEFAULT_FAQ = [true, true, true, true, true, false];

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
  site: "skylinehomes.in",
  imp: "idle",
  impStep: 0,
  faq: [...DEFAULT_FAQ],
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
  staff: PROFILES.re.staff.map((p) => ({ ...p })),
  cal: false,
  feats: [true, true, true, true, true, true],
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

/** The real trial code once the trial exists; the prototype's sample code before that. */
export function trialCodeOf(state: OnboardingState) {
  return state.trial?.routeCode ?? TRIAL_CODE;
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
