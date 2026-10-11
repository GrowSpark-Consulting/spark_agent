import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { maskPhone } from "../channels/whatsapp/phone";
import { serverEnv } from "../lib/env";
import { supabaseAdmin } from "../lib/supabase-admin";
import { send, type SendOutcome } from "./send";

// Staff alerts (docs/handover.md, module 6): a WhatsApp message from the business's number to the owner and
// admins who set an alert number, through notify.send's staff_alert kind (free, behind the staff_alerts toggle).
// Each alert is one line on what happened plus a dashboard link: the free text inside the staff member's 24-hour
// window, and the staff_alert_vN template's {{1}} and {{2}} outside it. The wording is a placeholder until
// Raja's arrives. Who gets which alert comes with the Team screen; until then owners and admins get every one.

export type StaffAlertKind =
  | "handoff_opened"
  | "handoff_waiting"
  | "credits_exhausted"
  | "setup_problem"
  | "opted_out"
  | "visit_outcome"
  | "low_rating"
  | "own_number_outcome";

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
}

export type AlertRole = "owner" | "admin";

export interface StaffAlertDeps {
  db: SupabaseClient;
  appUrl: string;
  send: typeof send;
}

const defaults = (): StaffAlertDeps => ({ db: supabaseAdmin(), appUrl: serverEnv().NEXT_PUBLIC_APP_URL, send });

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
  return contact.name?.trim() ? oneLine(contact.name, 40) : maskPhone(contact.phone);
}

/** What the alert says: one line, and the dashboard link. */
export async function staffAlertContent(
  tenantId: string,
  alert: StaffAlert,
  deps: StaffAlertDeps = defaults(),
): Promise<{ headline: string; link: string }> {
  const app = deps.appUrl.replace(/\/$/, "");
  if (alert.kind === "credits_exhausted") {
    const { data, error } = await deps.db.from("tenants").select("name").eq("id", tenantId).maybeSingle();
    if (error) throw new Error(`staff alert: business read failed: ${error.message}`);
    const name = oneLine((data as { name?: string } | null)?.name ?? "Your business", 40);
    return { headline: `${name} is out of credits, so the assistant has stopped replying.`, link: `${app}/dashboard/billing` };
  }
  const who = await customerLabel(tenantId, alert.conversationId, deps.db);
  const link = alert.conversationId ? `${app}/dashboard/inbox?conversation=${alert.conversationId}` : `${app}/dashboard/inbox`;
  const what = oneLine(alert.what ?? "visit", 40);
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

/** Sends one alert to one member, through notify.send (staff_alert). */
export async function sendStaffAlert(
  tenantId: string,
  userId: string,
  alert: StaffAlert,
  deps: StaffAlertDeps = defaults(),
): Promise<SendOutcome> {
  const { headline, link } = await staffAlertContent(tenantId, alert, deps);
  return deps.send(tenantId, "staff_alert", { staffUserId: userId, text: `${headline}\n${link}`, templateParams: [headline, link] });
}
