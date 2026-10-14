import { sendToAdmins, type AlertCounts, type AlertMessage, type AlertSendDeps } from "../../channels/whatsapp/connect/health-alert";
import { serverEnv } from "../../lib/env";
import { send } from "../../notify/send";
import { staffAlertRecipients } from "../../notify/staff-alerts";
import { cleanAreaText } from "../scoring/area-text";
import { customerLabel } from "./area-reminder";

// A customer with NO booking on record asks to cancel or move one (Finding 3 of the Day 7 injection sweep, found by the live run). Before, the model said it would check with the
// team and nobody was told. Now the owners and admins are told, once per lead, and nothing else changes: no handover, no mode change, the assistant stays in charge. One
// staff_alert through notify.send (free, behind the staff_alerts switch) with our own text, sent the way the area reminder and the connection alerts are (health-alert.ts
// sendToAdmins). The text holds the customer's CLEANED name (or their masked number) and the kind of change, and nothing the customer typed. Nothing here throws.
//
// One per lead, but a failed one can be tried again by the lead's next message: the send's key is one per lead and member, and notify.send releases a keyed claim when
// WhatsApp refuses a message for certain (migration 0045), so a refused send is tried again; a send that went out is never sent twice, and an unknown outcome is never resent.
// reply.ts adds an audit row after a success, so the reply to a later message can still say the team has been told.
//
// KNOWN LIMIT: outside the 24-hour window a staff alert needs the approved template staff_alert_v1 (not approved on staging yet): the send then fails, and the customer is not told
// anyone knows. A business with booking switched off, or no usable service, never reaches this (there is no scheduling input).

export interface BookingChangeReminderInput {
  tenantId: string;
  conversationId: string;
  leadId: string;
  /** What the customer asked for. */
  kind: "cancel" | "reschedule";
}

export interface BookingChangeReminderDeps {
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

/** Names this lead; with the member's id it is the send's idempotency key (notify.send: 1 to 200 characters), so a repeat that went out sends nothing. */
export const bookingChangeKey = (leadId: string): string => `no_booking_change:${leadId}`;

export function bookingChangeReminderMessage(info: { label: string; kind: "cancel" | "reschedule" }, conversationId: string, appUrl: string): AlertMessage {
  // The name is a stranger's words (a WhatsApp profile name): it passes the strict cleaner (no link, no @, no phone number) or is not shown.
  const name = oneLine(cleanAreaText(info.label) ?? "A customer", 40);
  const headline = `${name} asked to ${info.kind === "cancel" ? "cancel" : "move"} a booking, but none is on record for them in this chat.`;
  const link = `${appUrl.replace(/\/$/, "")}/dashboard/inbox?chat=${conversationId}`;
  return { text: `${headline}\nIt may have been made by phone or by your team. Please check.\n${link}`, templateParams: [headline, link] };
}

export async function sendBookingChangeReminder(input: BookingChangeReminderInput, deps: BookingChangeReminderDeps): Promise<AlertCounts> {
  let label = "A customer";
  try {
    label = (await deps.label(input.tenantId, input.conversationId)) || label;
  } catch {
    // a name that cannot be read is not worth losing the reminder for
  }
  const message = bookingChangeReminderMessage({ label, kind: input.kind }, input.conversationId, deps.appUrl);
  return sendToAdmins(input.tenantId, message, bookingChangeKey(input.leadId), deps.alert);
}

/** The real reminder: Dev 2's staffAlertRecipients and notify.send. */
export function createBookingChangeReminder(): (input: BookingChangeReminderInput) => Promise<AlertCounts> {
  return (input) =>
    sendBookingChangeReminder(input, {
      label: customerLabel,
      appUrl: serverEnv().NEXT_PUBLIC_APP_URL,
      alert: { recipients: (tenantId) => staffAlertRecipients(tenantId), send: (tenantId, kind, payload) => send(tenantId, kind, payload) },
    });
}
