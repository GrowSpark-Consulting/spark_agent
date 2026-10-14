import { createHash } from "node:crypto";
import { maskPhone } from "../../channels/whatsapp/phone";
import { sendToAdmins, type AlertCounts, type AlertMessage, type AlertSendDeps } from "../../channels/whatsapp/connect/health-alert";
import { serverEnv } from "../../lib/env";
import { supabaseAdmin } from "../../lib/supabase-admin";
import { send } from "../../notify/send";
import { staffAlertRecipients } from "../../notify/staff-alerts";

// A customer keeps asking for an area the business has no sites in (Raja, 14 Oct): the assistant has told them there is nothing there for now,
// and the owners and admins are reminded, once, to record it in their CRM. One staff_alert through notify.send (free, behind the staff_alerts
// switch) with our own text, sent the way the connection alerts are (health-alert.ts sendToAdmins). The text is the customer's name or their
// MASKED number, the area as they wrote it (short, one line) and a link to the chat. Nothing here throws: the customer's reply has gone out.

export interface AreaReminderInput {
  tenantId: string;
  conversationId: string;
  leadId: string;
  /** The place as the customer wrote it, tidied and short (never the model's words). */
  area: string;
  /** The place as it is compared (normaliseArea): what "the same place" means for the key. */
  areaKey: string;
}

export interface AreaReminderDeps {
  /** The customer's name, or their masked number, for the business's chat. */
  label: (tenantId: string, conversationId: string) => Promise<string>;
  appUrl: string;
  alert: AlertSendDeps;
}

/** Meta's template variables hold no line break, tab or run of spaces. */
const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export function areaReminderMessage(info: { label: string; area: string }, conversationId: string, appUrl: string): AlertMessage {
  const headline = `${oneLine(info.label, 40)} wants ${oneLine(info.area, 40)}, where you have no sites.`;
  const link = `${appUrl.replace(/\/$/, "")}/dashboard/inbox?chat=${conversationId}`;
  return { text: `${headline}\nThe assistant has told them there is nothing there for now. Please add it to your CRM.\n${link}`, templateParams: [headline, link] };
}

/** Names this lead and this place; with the member's id it is the send's idempotency key (notify.send: 1 to 200 characters), so a repeat sends nothing. */
export const areaReminderKey = (leadId: string, areaKey: string): string => `area_unserved:${leadId}:${createHash("sha256").update(areaKey).digest("hex").slice(0, 16)}`;

export async function sendAreaReminder(input: AreaReminderInput, deps: AreaReminderDeps): Promise<AlertCounts> {
  let label = "A customer";
  try {
    label = (await deps.label(input.tenantId, input.conversationId)) || label;
  } catch {
    // a name that cannot be read is not worth losing the reminder for
  }
  const message = areaReminderMessage({ label, area: input.area }, input.conversationId, deps.appUrl);
  return sendToAdmins(input.tenantId, message, areaReminderKey(input.leadId, input.areaKey), deps.alert);
}

/** The customer's name, or their masked number. Service role: the business and the chat are both named. */
async function customerLabel(tenantId: string, conversationId: string): Promise<string> {
  const { data, error } = await supabaseAdmin().from("conversations").select("contacts(name, phone)").eq("tenant_id", tenantId).eq("id", conversationId).maybeSingle();
  if (error) throw new Error("area reminder: the chat could not be read");
  const contact = (data as { contacts?: { name: string | null; phone: string } | null } | null)?.contacts;
  if (!contact) return "A customer";
  return contact.name?.trim() ? oneLine(contact.name, 40) : maskPhone(contact.phone);
}

/** The real reminder: Dev 2's staffAlertRecipients and notify.send. */
export function createAreaReminder(): (input: AreaReminderInput) => Promise<AlertCounts> {
  return (input) =>
    sendAreaReminder(input, {
      label: customerLabel,
      appUrl: serverEnv().NEXT_PUBLIC_APP_URL,
      alert: { recipients: (tenantId) => staffAlertRecipients(tenantId), send: (tenantId, kind, payload) => send(tenantId, kind, payload) },
    });
}
