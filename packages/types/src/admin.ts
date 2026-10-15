import { z } from "zod";
import { ConnectionMethod, ConnectionStatus } from "./connection";

// The internal admin panel (Dev 3, Day 7) and its billing routes (Dev 2; migration 0041). Platform admins only
// (platform_admins); every change is audited with the admin as the actor.
//   GET   /api/admin/tenants                       → AdminTenant[]
//   POST  /api/admin/tenants/:id/extend-trial      ExtendTrialInput → { trialEndsAt }
//   POST  /api/admin/tenants/:id/credits           GrantCreditsInput → { granted, credits }
//   PATCH /api/admin/plans/:key                    AdminPlanInput → AdminPlan
//   PATCH /api/admin/features/:key                 AdminFeatureInput → AdminFeature
//   GET   /api/admin/payments/refunds              → RefundCandidate[]
//   GET   /api/admin/whatsapp/connections          → AdminConnection[] (Day 7)
//   GET   /api/admin/metrics                       → AdminMetrics (Day 8)

export const AdminTenant = z.object({
  id: z.string(),
  name: z.string(),
  vertical: z.string(),
  status: z.enum(["trial", "active", "paused", "cancelled"]),
  planKey: z.string(),
  trialEndsAt: z.string().nullable(),
  createdAt: z.string(),
  /** The setup fee was paid: an assisted onboarding call is owed. */
  setupCallPaidAt: z.string().nullable(),
  /** Live credits (plan, trial, top-up and admin grants not yet expired). */
  credits: z.number().int(),
  /** The live subscription, if any. */
  subscription: z.object({ status: z.enum(["active", "past_due"]), cycle: z.enum(["monthly", "yearly"]), periodEnd: z.string().nullable() }).nullable(),
  members: z.number().int(),
  /** Its own active WhatsApp numbers (our platform numbers are not counted). */
  activeNumbers: z.number().int(),
});
export type AdminTenant = z.infer<typeof AdminTenant>;

/** Days more, counted from the later of the trial's end and now; reopens a trial paused at its end. Trial credits are not extended. */
export const ExtendTrialInput = z.object({ days: z.number().int().min(1, "At least 1 day").max(30, "At most 30 days at a time") });
export type ExtendTrialInput = z.infer<typeof ExtendTrialInput>;

/** `requestId` (a new id per form submission) makes a repeat grant nothing more. Without `expiresInDays` they never expire. */
export const GrantCreditsInput = z.object({
  amount: z.number().int().min(1, "At least 1 credit").max(100000, "At most 100,000 at a time"),
  expiresInDays: z.number().int().min(1).max(365).optional(),
  note: z.string().trim().max(200).optional(),
  requestId: z.guid().optional(),
});
export type GrantCreditsInput = z.infer<typeof GrantCreditsInput>;

/** Fields left out stay as they are. A price change is refused while businesses are subscribed at the old price. */
export const AdminPlanInput = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    priceInr: z.number().int().min(0).optional(),
    monthlyCredits: z.number().int().min(1).optional(),
    seats: z.number().int().min(1).optional(),
    whatsappNumbers: z.number().int().min(1).optional(),
    featureKeys: z.array(z.string().min(1)).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Change at least one field");
export type AdminPlanInput = z.infer<typeof AdminPlanInput>;

export const AdminPlan = z.object({
  key: z.string(),
  name: z.string(),
  priceInr: z.number().int(),
  monthlyCredits: z.number().int(),
  seats: z.number().int(),
  whatsappNumbers: z.number().int(),
  featureKeys: z.array(z.string()),
});
export type AdminPlan = z.infer<typeof AdminPlan>;

export const AdminFeatureInput = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().min(1).max(300).optional(),
    defaultOn: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Change at least one field");
export type AdminFeatureInput = z.infer<typeof AdminFeatureInput>;

export const AdminFeature = z.object({ key: z.string(), name: z.string(), description: z.string(), defaultOn: z.boolean() });
export type AdminFeature = z.infer<typeof AdminFeature>;

/** One window of the admin view's business numbers. The demo and test businesses are not counted. */
export const AdminMetricsWindow = z.object({
  days: z.number().int(),
  /** Credits spent on replies and templates (the gross draw). */
  creditsSpent: z.number().int(),
  /** The models' estimated cost over the window, in dollars and in rupees at `usdInr`; it includes calls that spend no credit. */
  aiCostUsd: z.number(),
  aiCostInr: z.number(),
  aiCalls: z.number().int(),
  /** aiCostInr / creditsSpent, to 3 places; null with no credits spent. */
  costPerCreditInr: z.number().nullable(),
  /** Businesses created in the window, and how many of those have paid for a plan. */
  trialsStarted: z.number().int(),
  trialsPaid: z.number().int(),
  /** trialsPaid / trialsStarted as a percentage, to 1 place; null with no trials. */
  trialToPaidPct: z.number().nullable(),
});
export type AdminMetricsWindow = z.infer<typeof AdminMetricsWindow>;

export const AdminMetrics = z.object({
  windows: z.array(AdminMetricsWindow),
  /** What one credit may cost us (the blueprint's assumption), in rupees. */
  targetCostPerCreditInr: z.number(),
  /** Rupees to the dollar: a stated assumption, not a looked-up rate. */
  usdInr: z.number(),
  asOf: z.string(),
});
export type AdminMetrics = z.infer<typeof AdminMetrics>;

/** A payment kept but flagged for a refund (paid twice, or for a plan no longer the business's). Refund it in PayU's dashboard. */
export const RefundCandidate = z.object({
  paymentId: z.string(),
  tenantId: z.string(),
  tenantName: z.string(),
  kind: z.string(),
  amountInr: z.number(),
  providerPaymentId: z.string().nullable(),
  method: z.string().nullable(),
  paidAt: z.string().nullable(),
  flaggedAt: z.string(),
});
export type RefundCandidate = z.infer<typeof RefundCandidate>;


/** A connection's latest check, as the connection jobs store it (docs/whatsapp-connection-contract.md, last_check). */
export const ConnectionCheckView = z.object({
  ranAt: z.string(),
  overall: z.enum(["pass", "warn", "fail"]),
  checks: z.array(
    z.object({
      key: z.string(),
      status: z.enum(["pass", "warn", "fail", "not_verified", "skipped"]),
      /** Safe for the UI: no token, secret or raw Meta error. */
      message: z.string().nullable(),
    }),
  ),
});
export type ConnectionCheckView = z.infer<typeof ConnectionCheckView>;

/**
 * One WhatsApp connection, of any business, for the admin panel's connection list: method, status and last check. No token
 * or secret is ever read for it. The number is the business's own (not a customer's), shown as Meta displays it.
 */
export const AdminConnection = z.object({
  id: z.string(),
  tenantId: z.string(),
  tenantName: z.string(),
  method: ConnectionMethod,
  status: ConnectionStatus,
  displayPhone: z.string().nullable(),
  verifiedName: z.string().nullable(),
  coexistence: z.boolean(),
  qualityRating: z.string().nullable(),
  messagingLimit: z.string().nullable(),
  /** A manual connection's token runs out then (token-expiry warns 7 days before); null when it does not expire or is unknown. */
  tokenExpiresAt: z.string().nullable(),
  /** Null when it was never checked, or the stored check is in an older shape. */
  lastCheck: ConnectionCheckView.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AdminConnection = z.infer<typeof AdminConnection>;
