import { z } from "zod";

// The shell's account status and Home's month summary (docs/dashboard-screen-contracts.md, "Shell" and "Home"):
// GET /api/billing/balance and GET /api/dashboard/summary (backend/src/billing/account-status.ts, dashboard/summary.ts).

/** Why the assistant is not replying right now, or null when it can. */
export const AI_PAUSED_REASONS = ["paused", "cancelled", "trial_ended", "no_credits"] as const;

export const AccountStatus = z.object({
  status: z.enum(["trial", "active", "paused", "cancelled"]),
  plan: z.object({ key: z.string(), name: z.string(), monthlyCredits: z.number().int() }),
  /** getBalance(): plan (plan, trial and admin grants), top-ups, and both together. */
  credits: z.object({ plan: z.number().int(), topup: z.number().int(), total: z.number().int() }),
  /** The meter's denominator: credits granted in the buckets still live (this month, last month's rollover, top-ups). */
  creditsGranted: z.number().int().nonnegative(),
  /** When the paid plan renews (the subscription's period end); null on a trial or with no subscription. */
  renewsAt: z.string().nullable(),
  trialEndsAt: z.string().nullable(),
  /** True when the assistant cannot reply: the business is paused or cancelled, the trial has ended, or no credits are left. */
  aiPaused: z.boolean(),
  aiPausedReason: z.enum(AI_PAUSED_REASONS).nullable(),
  /** At or below a fifth of the plan's monthly credits (80% used), as the credit alerts use. */
  lowCredits: z.boolean(),
  /** The business's AI-replies switch (isEnabled('ai_auto_reply')). */
  aiAutoReply: z.boolean(),
});
export type AccountStatus = z.infer<typeof AccountStatus>;

export const DashboardSummary = z.object({
  /** The business's current month, "2026-10", in its own time zone. */
  month: z.string(),
  stats: z.object({
    /** Leads that started this month. */
    enquiries: z.number().int().nonnegative(),
    /** Of those, the ones that reached qualified or further (booked, visited, won). */
    qualified: z.number().int().nonnegative(),
    /** Bookings made this month that went ahead or stand (confirmed, completed, no-show); moved ones count once. */
    booked: z.number().int().nonnegative(),
    /** This month's enquiries that started outside the business hours (0 when no hours are set). */
    afterHours: z.number().int().nonnegative(),
    /** Enquiries so far this month against the same stretch of last month, in percent; null when last month had none. */
    enquiriesChangePct: z.number().nullable(),
  }),
  /** Chats the assistant answered last night (8 pm to 8 am, business time). */
  overnightHandled: z.number().int().nonnegative(),
  /** Open hot leads, best score first (staff: their own). */
  hotLeads: z.array(
    z.object({
      leadId: z.string(),
      conversationId: z.string().nullable(),
      name: z.string(),
      need: z.string(),
      score: z.number().nullable(),
      temperature: z.enum(["hot", "warm", "cold"]),
      /** Why it needs someone: the open handoff's reason, else "Hot lead". */
      reason: z.string(),
      /** The customer's last message time while a handoff is open; null otherwise. */
      waitingSince: z.string().nullable(),
      /** The member who owns the lead (user id); names come with the Team data. */
      assignedTo: z.string().nullable(),
    }),
  ),
  /** Today's held and confirmed bookings in start order (staff: their own calendar's). */
  todayBookings: z.array(
    z.object({
      bookingId: z.string(),
      startAt: z.string(),
      name: z.string(),
      place: z.string(),
      staff: z.string(),
      status: z.enum(["held", "confirmed"]),
    }),
  ),
});
export type DashboardSummary = z.infer<typeof DashboardSummary>;
