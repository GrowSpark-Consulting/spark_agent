import { AccountStatus, AI_PAUSED_REASONS, DashboardSummary } from "@pakka/types";
import { getJson } from "@/lib/api/client";

// Home v1 (docs/dashboard-screen-contracts.md, "Home" and "Shell"). Two read routes, built by Dev 2 (docs/contracts.md, section 6, "Home and
// shell"). The shapes are the shared ones in @pakka/types, not copies, so a contract change fails here; every answer is parsed before it is
// drawn. If a route fails, Home says so for that card; it shows no number it was not given. Nothing is read from fixtures here.
//   GET /api/dashboard/summary → DashboardSummary   (any member; staff see their own hot leads and bookings)
//   GET /api/billing/balance   → AccountStatus

export type SummaryAnswer = DashboardSummary;
export type BalanceAnswer = AccountStatus;
export type AiPausedReason = (typeof AI_PAUSED_REASONS)[number];

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
    const parsed = DashboardSummary.safeParse(await getJson<unknown>("/api/dashboard/summary", { tenantId, signal }));
    if (!parsed.success) throw new HomeDataError("summary");
    return parsed.data;
  },
  async balance(tenantId, signal) {
    const parsed = AccountStatus.safeParse(await getJson<unknown>("/api/billing/balance", { tenantId, signal }));
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
  if (!granted || enquiries === null || enquiries <= 0) return { kind: "unknown" };
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

// Why the assistant is not replying ------------------------------------------------------------------------------

export interface PausedNotice {
  reason: AiPausedReason;
  title: string;
  detail: string;
  /** Where the owner fixes it, when there is a screen for it; null when only the platform can (a pause set by the team at Spark). */
  action: { label: string; href: string } | null;
}

/**
 * What to tell the owner for each reason the server gives (AccountStatus.aiPausedReason). The server decides; this only words it. A chat that
 * arrives while the assistant is paused goes to the inbox for a person, so every notice says that.
 */
export function pausedNotice(reason: AiPausedReason | null): PausedNotice | null {
  switch (reason) {
    case null:
      return null;
    case "no_credits":
      return { reason, title: "Assistant paused: out of credits", detail: "New chats go to your inbox until you top up.", action: { label: "Top up credits", href: "/dashboard/billing" } };
    case "trial_ended":
      return { reason, title: "Assistant paused: your free trial has ended", detail: "New chats go to your inbox until you choose a plan.", action: { label: "Choose a plan", href: "/dashboard/billing" } };
    case "whatsapp_not_connected":
      return { reason, title: "Assistant paused: no WhatsApp number is connected", detail: "New chats go to your inbox, and alerts can't reach you, until a number is connected.", action: { label: "Connect WhatsApp", href: "/dashboard/whatsapp" } };
    case "paused":
      return { reason, title: "Assistant paused: your account is paused", detail: "New chats go to your inbox while the account is paused.", action: { label: "See your plan", href: "/dashboard/billing" } };
    case "cancelled":
      return { reason, title: "Assistant paused: your subscription is cancelled", detail: "New chats go to your inbox until you choose a plan.", action: { label: "Choose a plan", href: "/dashboard/billing" } };
  }
}

/** Whole days from `now` to `endsAt`, rounded up (a trial ending later today is "1 day left"); 0 once it has passed; null for no date. */
export function daysLeft(endsAt: string | null, now: Date): number | null {
  if (!endsAt) return null;
  const end = Date.parse(endsAt);
  if (!Number.isFinite(end)) return null;
  return Math.max(0, Math.ceil((end - now.getTime()) / 86_400_000));
}
