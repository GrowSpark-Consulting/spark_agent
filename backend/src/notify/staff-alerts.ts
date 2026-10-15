import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { createHandoffLinks, type HandoffLinkClaims } from "../agent/handoff/token";
import { buildLeadCard } from "../agent/leadcard/build";
import { cleanDisplayText } from "../agent/scoring/area-text";
import type { LeadCard } from "../agent/leadcard/card";
import { maskPhone } from "../channels/whatsapp/phone";
import { isEnabled } from "../features/is-enabled";
import { serverEnv } from "../lib/env";
import { AppError } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase-admin";
import { send, type SendOutcome } from "./send";

// Staff alerts (docs/handover.md, module 6): a WhatsApp message from the business's number to the owner and
// admins who set an alert number, through notify.send's staff_alert kind (free, behind the staff_alerts toggle).
// Each alert is one line on what happened plus a dashboard link: the free text inside the staff member's 24-hour
// window, and the staff_alert_vN template's {{1}} and {{2}} outside it. A chat handed to a person also carries the
// lead card (Dev 1's buildLeadCard: why, a short summary, a discount asked for, the next step) and that member's two
// take-over links (Dev 1's createHandoffLinks: the inbox, and their own WhatsApp on a plan with it); a hot lead carries
// the card. Free text cannot carry two URL buttons (Meta allows one per message), so the links are lines; outside
// the window the template carries the inbox link. The wording is a placeholder until Raja's arrives. Who gets which
// alert comes with the Team screen; until then owners and admins get every one.

export type StaffAlertKind =
  | "handoff_opened"
  | "handoff_waiting"
  | "credits_exhausted"
  | "credits_low"
  | "setup_problem"
  | "opted_out"
  | "visit_outcome"
  | "low_rating"
  | "own_number_outcome"
  | "hot_lead"
  | "voice_note"
  | "external_waiting";

export interface StaffAlert {
  kind: StaffAlertKind;
  /** The customer chat the alert is about (not needed for credits_exhausted). */
  conversationId?: string;
  /** handoff_waiting: how long the customer has waited for a person. */
  waitedMinutes?: number;
  /** visit_outcome and low_rating: what was booked ("site visit"). */
  what?: string;
  /** low_rating: the customer's rating, 1 to 5. */
  rating?: number;
  /** credits_low: the credits left, and the plan's credits a month. */
  credits?: { left: number; monthly: number };
  /** handoff_opened and setup_problem: the handoff, for the member's take-over links. */
  handoffId?: string;
  /** handoff_opened and setup_problem: a high-priority handoff (a discount request, credits out) says so first. */
  priority?: "high" | "normal";
}

export type AlertRole = "owner" | "admin";

export interface StaffAlertDeps {
  db: SupabaseClient;
  appUrl: string;
  send: typeof send;
  /** The lead card for a chat (Dev 1's buildLeadCard), or null when there is none. Without it, alerts carry no card. */
  card?: (tenantId: string, conversationId: string) => Promise<LeadCard | null>;
  /** A member's two take-over links for a handoff (Dev 1's createHandoffLinks); not_available without API_PUBLIC_URL. */
  links?: (claims: HandoffLinkClaims, ownNumber: boolean) => { inbox: string; own: string | null };
  /** Whether the business's plan has own-number takeover (handoff_own_number). */
  ownNumber?: (tenantId: string) => Promise<boolean>;
}

const defaults = (): StaffAlertDeps => ({
  db: supabaseAdmin(),
  appUrl: serverEnv().NEXT_PUBLIC_APP_URL,
  send,
  card: (tenantId, conversationId) => buildLeadCard(tenantId, conversationId),
  links: (claims, ownNumber) => createHandoffLinks(claims, serverEnv(), new Date(), { ownNumber }),
  ownNumber: (tenantId) => isEnabled(tenantId, "handoff_own_number"),
});

// Template variables may not hold a newline, a tab or a run of spaces (Meta 132018), and a name can be long.
const oneLine = (text: string, max = 60) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Members who get staff alerts: owners and admins with an alert number (`roles` narrows it, e.g. owners only). */
export async function staffAlertRecipients(
  tenantId: string,
  deps: StaffAlertDeps = defaults(),
  roles: readonly AlertRole[] = ["owner", "admin"],
): Promise<string[]> {
  const { data, error } = await deps.db
    .from("memberships")
    .select("user_id")
    .eq("tenant_id", tenantId)
    .in("role", [...roles])
    .not("whatsapp_phone", "is", null);
  if (error) throw new Error(`staff alert recipients: ${error.message}`);
  return z
    .array(z.object({ user_id: z.string() }))
    .parse(data ?? [])
    .map((r) => r.user_id)
    .sort();
}

// The customer's name, or their masked number when the chat has no name.
async function customerLabel(tenantId: string, conversationId: string | undefined, db: SupabaseClient): Promise<string> {
  if (!conversationId) return "A customer";
  const { data, error } = await db
    .from("conversations")
    .select("contacts(name, phone)")
    .eq("tenant_id", tenantId)
    .eq("id", conversationId)
    .maybeSingle();
  if (error) throw new Error(`staff alert: conversation read failed: ${error.message}`);
  const contact = (data as { contacts?: { name: string | null; phone: string } | null } | null)?.contacts;
  if (!contact) return "A customer";
  // A profile name saved before names were cleaned can carry a link, an @ or a number: the masked number is shown instead.
  return (contact.name ? cleanDisplayText(contact.name, 40, 7) : null) ?? maskPhone(contact.phone);
}

/** What the alert says: one line, and the dashboard link. */
export async function staffAlertContent(
  tenantId: string,
  alert: StaffAlert,
  deps: StaffAlertDeps = defaults(),
): Promise<{ headline: string; link: string }> {
  const app = deps.appUrl.replace(/\/$/, "");
  if (alert.kind === "credits_exhausted" || alert.kind === "credits_low") {
    const { data, error } = await deps.db.from("tenants").select("name").eq("id", tenantId).maybeSingle();
    if (error) throw new Error(`staff alert: business read failed: ${error.message}`);
    const name = oneLine((data as { name?: string } | null)?.name ?? "Your business", 40);
    const link = `${app}/dashboard/billing`;
    if (alert.kind === "credits_low") {
      const { left, monthly } = alert.credits ?? { left: 0, monthly: 0 };
      return { headline: `${name} has ${left} credit${left === 1 ? "" : "s"} left of its ${monthly} a month. Top up so the assistant keeps replying.`, link };
    }
    return { headline: `${name} is out of credits, so the assistant has stopped replying.`, link };
  }
  const who = await customerLabel(tenantId, alert.conversationId, deps.db);
  const link = alert.conversationId ? `${app}/dashboard/inbox?chat=${alert.conversationId}` : `${app}/dashboard/inbox`;
  const what = oneLine(alert.what ?? "visit", 40);
  if (alert.kind === "hot_lead") {
    return { headline: `Hot lead: ${who} is ready to move.`, link };
  }
  if (alert.kind === "voice_note") {
    return { headline: `${who} sent a voice note. The assistant asked them to type; you can listen to it in the inbox.`, link };
  }
  if (alert.kind === "external_waiting") {
    return { headline: `${who} wrote again while you have the chat on your own WhatsApp. Reply to them from your number.`, link };
  }
  if (alert.kind === "own_number_outcome") {
    return { headline: `How did your WhatsApp chat with ${who} go? Update the lead.`, link };
  }
  if (alert.kind === "opted_out") {
    return { headline: `${who} sent STOP, so the assistant won't message them again. Call them if you need to.`, link };
  }
  if (alert.kind === "visit_outcome") {
    return { headline: `How did the ${what} with ${who} go? Update the lead so follow-ups stay right.`, link };
  }
  if (alert.kind === "low_rating") {
    return { headline: `${who} rated their ${what} ${alert.rating ?? "?"} out of 5.`, link };
  }
  if (alert.kind === "handoff_waiting") {
    const waited = alert.waitedMinutes ? `${alert.waitedMinutes} minute${alert.waitedMinutes === 1 ? "" : "s"}` : "a while";
    return { headline: `${who} has waited ${waited} and no one has picked up the chat yet.`, link };
  }
  return alert.kind === "handoff_opened"
    ? { headline: `${who} is waiting for a person on WhatsApp.`, link }
    : { headline: `The assistant couldn't continue the chat with ${who}.`, link };
}

/** Alerts that carry the lead card, and those that carry the member's take-over links (a chat handed to a person). */
const CARD_KINDS: ReadonlySet<StaffAlertKind> = new Set(["handoff_opened", "setup_problem", "hot_lead"]);
const TAKEOVER_KINDS: ReadonlySet<StaffAlertKind> = new Set(["handoff_opened", "setup_problem"]);
const SUMMARY_LINES = 5;

// The card in a few lines: why staff are told (for a handoff), the summary, a discount asked for, and the next step.
function cardLines(card: LeadCard, withReason: boolean): string[] {
  const summary = card.summary
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(0, SUMMARY_LINES);
  return [...(withReason && card.trigger ? [card.trigger] : []), ...summary, ...(card.discount ? [card.discount] : []), `Next: ${card.nextStep}`];
}

/**
 * The whole alert for one member: the free text (the headline, the lead card when the alert carries one, then the
 * links) and the staff_alert template's two variables (the headline, and the take-over link or the dashboard link).
 * A card that cannot be built, or take-over links that are not switched on (no API_PUBLIC_URL), leave the alert as it
 * was: the headline and the dashboard link.
 */
export async function staffAlertMessage(
  tenantId: string,
  userId: string,
  alert: StaffAlert,
  deps: StaffAlertDeps = defaults(),
): Promise<{ text: string; templateParams: [string, string] }> {
  const content = await staffAlertContent(tenantId, alert, deps);
  const takeover = TAKEOVER_KINDS.has(alert.kind);
  const headline = takeover && alert.priority === "high" ? `Priority: ${content.headline}` : content.headline;

  const lines = [headline];
  if (CARD_KINDS.has(alert.kind) && alert.conversationId && deps.card) {
    try {
      const card = await deps.card(tenantId, alert.conversationId);
      if (card) lines.push(...cardLines(card, takeover));
    } catch (e) {
      console.error(`[staff-alerts] the lead card could not be added (business ${tenantId}): ${e instanceof Error ? e.name : "unknown error"}`);
    }
  }

  if (takeover && alert.handoffId && deps.links && deps.ownNumber) {
    try {
      const links = deps.links({ tenantId, handoffId: alert.handoffId, userId }, await deps.ownNumber(tenantId));
      lines.push(`Take over in the inbox: ${links.inbox}`);
      if (links.own) lines.push(`Reply from your own WhatsApp: ${links.own}`);
      return { text: lines.join("\n"), templateParams: [headline, links.inbox] };
    } catch (e) {
      if (!(e instanceof AppError && e.code === "not_available")) throw e;
    }
  }
  lines.push(content.link);
  return { text: lines.join("\n"), templateParams: [headline, content.link] };
}

/**
 * Sends one alert to one member, through notify.send (staff_alert). `idempotencyKey` names this exact alert, so a job's
 * retry or a repeat run never sends it twice (notify.send).
 */
export async function sendStaffAlert(
  tenantId: string,
  userId: string,
  alert: StaffAlert,
  deps: StaffAlertDeps = defaults(),
  options: { idempotencyKey?: string } = {},
): Promise<SendOutcome> {
  const { text, templateParams } = await staffAlertMessage(tenantId, userId, alert, deps);
  return deps.send(tenantId, "staff_alert", {
    staffUserId: userId,
    text,
    templateParams,
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
  });
}
