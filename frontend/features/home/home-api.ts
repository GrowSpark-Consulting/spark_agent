import { z } from "zod";
import { getJson } from "@/lib/api/client";

// Home v1 (docs/dashboard-screen-contracts.md, "Home" and "Shell"). Two read routes, both PROPOSED and owned by Dev 2: they are not built
// on main or on any branch yet (docs/contracts.md, section 6, "Read routes (Proposed)"). The shapes below are the ones the screen contracts
// propose, narrowed to the fields Home uses, and every answer is parsed before it is drawn. Until the routes exist the server answers 404 and
// Home says "not available yet" for that card; it shows no number it was not given. Nothing is read from fixtures here.
//   GET /api/dashboard/summary → DashboardSummary
//   GET /api/billing/balance   → AccountStatus

export const SummaryAnswer = z.object({
  month: z.string(),
  stats: z.object({
    enquiries: z.number().int().nonnegative(),
    qualified: z.number().int().nonnegative(),
    booked: z.number().int().nonnegative(),
    /** After-hours enquiries the assistant handled this month. */
    afterHours: z.number().int().nonnegative(),
    enquiriesChangePct: z.number().nullable().optional(),
  }),
  overnightHandled: z.number().int().nonnegative().optional(),
});
export type SummaryAnswer = z.infer<typeof SummaryAnswer>;

export const BalanceAnswer = z.object({
  credits: z.object({ plan: z.number().int(), topup: z.number().int(), total: z.number().int() }),
  /** The meter's denominator this cycle. */
  creditsGranted: z.number().int().nonnegative().optional(),
  renewsAt: z.string().nullable().optional(),
  aiPaused: z.boolean().optional(),
  lowCredits: z.boolean().optional(),
});
export type BalanceAnswer = z.infer<typeof BalanceAnswer>;

export class HomeDataError extends Error {
  constructor(what: string) {
    super(`The ${what} answer had an unexpected shape.`);
    this.name = "HomeDataError";
  }
}

export interface HomeService {
  summary: (tenantId: string, signal?: AbortSignal) => Promise<SummaryAnswer>;
  balance: (tenantId: string, signal?: AbortSignal) => Promise<BalanceAnswer>;
}

export const homeService: HomeService = {
  async summary(tenantId, signal) {
    const parsed = SummaryAnswer.safeParse(await getJson<unknown>("/api/dashboard/summary", { tenantId, signal }));
    if (!parsed.success) throw new HomeDataError("summary");
    return parsed.data;
  },
  async balance(tenantId, signal) {
    const parsed = BalanceAnswer.safeParse(await getJson<unknown>("/api/billing/balance", { tenantId, signal }));
    if (!parsed.success) throw new HomeDataError("balance");
    return parsed.data;
  },
};

// The credit meter, in leads -------------------------------------------------------------------------------------

export type LeadsLeft =
  /** About `leads` more at this month's pace: credits spent this cycle per enquiry so far. */
  | { kind: "estimate"; leads: number; creditsPerLead: number }
  /** Not enough this cycle to say (no credits spent, or no enquiries yet). Credits are still shown. */
  | { kind: "unknown" };

/**
 * Credits left shown as leads: credits left divided by the credits each enquiry has cost this cycle (granted minus left, over the
 * month's enquiries). It is arithmetic on the two answers, labelled "about", and says nothing when either is missing or zero.
 * Top-up credits make "spent" a slight undercount, so the estimate leans generous; the word is "about".
 */
export function leadsLeft(balance: BalanceAnswer, enquiries: number | null): LeadsLeft {
  const granted = balance.creditsGranted;
  if (granted === undefined || enquiries === null || enquiries <= 0) return { kind: "unknown" };
  const spent = granted - balance.credits.total;
  if (spent <= 0) return { kind: "unknown" };
  const creditsPerLead = spent / enquiries;
  return { kind: "estimate", leads: Math.max(0, Math.floor(balance.credits.total / creditsPerLead)), creditsPerLead };
}

/** Share of this cycle's credits left, 0 to 100, or null when the denominator isn't known. */
export function meterShare(balance: BalanceAnswer): number | null {
  const granted = balance.creditsGranted;
  if (!granted) return null;
  return Math.max(0, Math.min(100, Math.round((balance.credits.total / granted) * 100)));
}

/** "+18% vs last month", "-4% vs last month", or null when there's nothing to compare. */
export function changeNote(pct: number | null | undefined): string | null {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return null;
  const rounded = Math.round(pct);
  return `${rounded > 0 ? "+" : ""}${rounded}% vs last month`;
}
