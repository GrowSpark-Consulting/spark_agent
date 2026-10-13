import { z } from "zod";
import { PAID_PLAN_KEYS } from "./features";
import { PhoneInput } from "./whatsapp";

// Billing (PayU, decision 20 in docs/contracts.md): POST /api/billing/checkout, /topup and /setup-fee, and
// GET /api/billing/payments/:id. Prices are GST-extra; the server adds GST and decides every amount. The plans a business
// can buy are PAID_PLAN_KEYS (features.ts): the trial is given, not bought.

export const BILLING_CYCLES = ["monthly", "yearly"] as const;

/** The one top-up pack (docs/handover.md): 1,000 credits for ₹1,199 plus GST, expiring 90 days after purchase. */
export const TOPUP_PACK = { id: "credits_1000", credits: 1000, priceInr: 1199 } as const;
/** The optional assisted-onboarding setup fee, plus GST. Grants no credits. */
export const SETUP_FEE_INR = 4999;

/** A phone for PayU's checkout (it requires one). Optional when the owner has an alert number on the Team screen. */
const PayerPhone = PhoneInput.optional();

export const CheckoutInput = z.object({
  planKey: z.enum(PAID_PLAN_KEYS, "Choose a plan"),
  cycle: z.enum(BILLING_CYCLES, "Choose monthly or yearly"),
  phone: PayerPhone,
});
export type CheckoutInput = z.infer<typeof CheckoutInput>;

export const OneTimePaymentInput = z.object({ phone: PayerPhone });
export type OneTimePaymentInput = z.infer<typeof OneTimePaymentInput>;

/**
 * What the browser does next: POST `fields` to `url` (an auto-submitting form) to open PayU's checkout. PayU sends the
 * payer back to /dashboard/billing?payment=<paymentId>, which polls GET /api/billing/payments/:id.
 */
export const PayuCheckout = z.object({
  paymentId: z.string(),
  payu: z.object({ url: z.string(), fields: z.record(z.string(), z.string()) }),
});
export type PayuCheckout = z.infer<typeof PayuCheckout>;

export const PAYMENT_KINDS = ["subscribe", "renewal", "plan_change", "topup", "setup_fee"] as const;
export const PAYMENT_STATUSES = ["created", "pending", "success", "failed"] as const;

/** GET /api/billing/payments/:id. created and pending are not final yet: keep polling for a minute or so. */
export const PaymentView = z.object({
  id: z.string(),
  kind: z.enum(PAYMENT_KINDS),
  status: z.enum(PAYMENT_STATUSES),
  /** Rupees, GST included (2948.82). */
  amountInr: z.number(),
  /** PayU's reason, for a failed payment. */
  failureReason: z.string().nullable(),
  createdAt: z.string(),
});
export type PaymentView = z.infer<typeof PaymentView>;
