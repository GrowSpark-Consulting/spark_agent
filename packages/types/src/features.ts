import { z } from "zod";

// The Features screen (docs/dashboard-screen-contracts.md, "Features"): GET /api/features and
// PATCH /api/features/:key (backend/src/features/toggles.ts).

/** The plans a business can buy, cheapest first. The trial is not one of them. */
export const PAID_PLAN_KEYS = ["starter", "growth", "pro"] as const;
export type PaidPlanKey = (typeof PAID_PLAN_KEYS)[number];

/**
 * on / off: the business's switch, for a feature its plan includes. locked: the plan does not include it (show Upgrade
 * with `requiredPlan`). disabled: in the plan but it cannot work right now; `disabledReason` says why in plain words.
 */
export const FEATURE_ROW_STATES = ["on", "off", "locked", "disabled"] as const;
export type FeatureRowState = (typeof FEATURE_ROW_STATES)[number];

export const FeatureRow = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  state: z.enum(FEATURE_ROW_STATES),
  /** The business's own switch, whatever the state: a locked or disabled feature keeps it. */
  enabled: z.boolean(),
  /** The cheapest plan that includes it, when `state` is locked; null otherwise (or when no plan does). */
  requiredPlan: z.enum(PAID_PLAN_KEYS).nullable(),
  disabledReason: z.string().nullable(),
  /** Credits the feature spent in the last 30 days; null when it costs nothing extra (see `creditNote`). */
  creditsPerMonth: z.number().int().nonnegative().nullable(),
  /** "No extra credits", "Part of replies" or "Only when used" instead of a number; null when `creditsPerMonth` is set. */
  creditNote: z.string().nullable(),
  /** tenant_features.settings, e.g. { offset_minutes: 1440 } (docs/contracts.md, section 3). */
  settings: z.record(z.string(), z.unknown()),
  control: z.enum(["switch", "segmented", "timing"]),
});
export type FeatureRow = z.infer<typeof FeatureRow>;

export const FeatureList = z.object({
  plan: z.object({ key: z.string(), name: z.string(), monthlyCredits: z.number().int() }),
  /** The sum of `creditsPerMonth` over the features that are on. */
  estimatedCreditsPerMonth: z.number().int().nonnegative(),
  groups: z.array(z.object({ name: z.string(), features: z.array(FeatureRow) })),
});
export type FeatureList = z.infer<typeof FeatureList>;

/**
 * PATCH /api/features/:key. `settings` is merged into the saved settings key by key, and a key sent as null is removed;
 * the result must be what the feature's job reads (docs/contracts.md, section 3). Answers the updated FeatureRow.
 */
export const UpdateFeatureInput = z
  .object({
    enabled: z.boolean().optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((input) => input.enabled !== undefined || input.settings !== undefined, { message: "Send enabled, settings or both." });
export type UpdateFeatureInput = z.infer<typeof UpdateFeatureInput>;
