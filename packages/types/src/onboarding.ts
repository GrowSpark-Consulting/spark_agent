import { z } from "zod";

// The onboarding Business step (frontend) and POST /api/onboarding/trial (backend).

/** The trades the Business step offers. */
export const INDUSTRY_KEYS = ["re", "int", "salon", "hotel", "rest", "fix"] as const;
export type IndustryKey = (typeof INDUSTRY_KEYS)[number];

/**
 * The vertical pack a trial business in each trade runs on. Trades without one can't start a trial
 * yet. The browser sends the trade; only the backend maps it to a pack, so a caller can't pick one.
 */
export const TRIAL_PACKS: Readonly<Partial<Record<IndustryKey, string>>> = {
  re: "real-estate",
  int: "interiors",
  salon: "salon",
};

/** What the wizard shows once the trial exists. */
export const TrialInfo = z.object({
  routeCode: z.string(),
  /** Whole days left in the trial, counted on the server. */
  trialDays: z.number().int().nonnegative(),
  /** The live credit balance; null if it couldn't be read (the trial itself exists). */
  credits: z.number().int().nullable(),
});
export type TrialInfo = z.infer<typeof TrialInfo>;

/** POST /api/onboarding/trial's answer. The HTTP status follows `status`: 200, 409 (has_business, phone_used), 422 or 500. */
export const StartTrialResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), trial: TrialInfo }),
  /** The account already belongs to a business (any role): nothing was created. */
  z.object({ status: z.literal("has_business") }),
  /** The trade has no pack yet: nothing was created. */
  z.object({ status: z.literal("unavailable") }),
  z.object({ status: z.literal("invalid"), fields: z.object({ name: z.string().optional(), industry: z.string().optional(), phone: z.string().optional() }) }),
  /**
   * The WhatsApp number sent with the request (`phone`, E.164) has already had a free trial: nothing was created. An early
   * warning only, since a typed number is not verified; the WhatsApp check on the TRIAL code is the real one (0033).
   */
  z.object({ status: z.literal("phone_used"), message: z.string() }),
  z.object({ status: z.literal("failed"), message: z.string() }),
]);
export type StartTrialResult = z.infer<typeof StartTrialResult>;
