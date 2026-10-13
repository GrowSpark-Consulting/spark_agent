import type { NotifyPayload, SendOutcome } from "../../../notify/send";

// What the owners of a manual WhatsApp connection are told when it stops working or its token is about to run out (Day 6), and how it is
// sent: one staff_alert through notify.send (free, behind the staff_alerts switch) to each owner and admin with an alert number. The wording is
// fixed text: the failing check's own message (checks.ts, safe for a customer to read), never what Meta said and never a token. Until
// Raja's wording arrives this is a placeholder, like the other staff alerts.
//
// KNOWN LIMIT. notify.send sends staff alerts from the business's own active connection (notify_staff_target, 0019). A connection that has just
// failed is not active, and one with a dead token cannot send, so an alert about it reaches only a business that has a second active number.
// Anyone else sees the failure in the dashboard (the connection's status and last_check). Needs Dev 2: see the task note.

export type AlertMessage = { text: string; templateParams: [string, string] };

/** Meta's template variables hold no line break, tab or run of spaces, and a long one is refused. */
const oneLine = (text: string, max = 400) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const dashboard = (appUrl: string) => `${appUrl.replace(/\/$/, "")}/dashboard/whatsapp`;
/** `phoneMasked` is the number already masked (phone.ts maskPhone): a full number never leaves the job's own read, so none is kept in a step's stored result. */
const label = (phoneMasked: string | null) => (phoneMasked ? `Your WhatsApp number ${phoneMasked}` : "Your WhatsApp number");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The date in India's calendar, "19 Oct 2026" (written out here so it does not depend on the machine's locale data). */
function indiaDate(at: Date): string {
  const shifted = new Date(at.getTime() + 5.5 * 3_600_000);
  return `${shifted.getUTCDate()} ${MONTHS[shifted.getUTCMonth()]} ${shifted.getUTCFullYear()}`;
}

/** A connection that has stopped working: which number, why (one failing check's own words) and where to fix it. */
export function failureMessage(info: { phoneMasked: string | null; detail: string }, appUrl: string): AlertMessage {
  const headline = oneLine(`${label(info.phoneMasked)} stopped working. ${info.detail}`);
  const link = dashboard(appUrl);
  return { text: `${headline}\nThe assistant can't reply on it until this is fixed.\n${link}`, templateParams: [headline, link] };
}

/** A token that runs out soon: the date, and that the number must be connected again before then. */
export function expiryMessage(info: { phoneMasked: string | null; expiresAt: Date }, appUrl: string): AlertMessage {
  const headline = oneLine(`${label(info.phoneMasked)}: its access token expires on ${indiaDate(info.expiresAt)}.`);
  const link = dashboard(appUrl);
  return {
    text: `${headline}\nCreate a new one in Meta and connect the number again before then, or the assistant will stop replying.\n${link}`,
    templateParams: [headline, link],
  };
}

export interface AlertSendDeps {
  /** Owners and admins with an alert number (Dev 2's staffAlertRecipients). */
  recipients: (tenantId: string) => Promise<string[]>;
  /** notify.send, kind staff_alert. */
  send: (tenantId: string, kind: "staff_alert", payload: NotifyPayload) => Promise<SendOutcome>;
}

export type AlertCounts = { recipients: number; sent: number; skipped: number; failed: number };

/**
 * Sends one alert to each owner and admin. `keyBase` names this exact alert; with the person it is the send's idempotency key, so a retry or a
 * repeat run never sends it twice. Nothing here throws: a switch that is off, a number that cannot send and a send that breaks are counted, and
 * the dashboard still shows the problem.
 */
export async function sendToAdmins(tenantId: string, message: AlertMessage, keyBase: string, deps: AlertSendDeps): Promise<AlertCounts> {
  let people: string[];
  try {
    people = await deps.recipients(tenantId);
  } catch {
    return { recipients: 0, sent: 0, skipped: 0, failed: 1 };
  }
  const counts: AlertCounts = { recipients: people.length, sent: 0, skipped: 0, failed: 0 };
  for (const userId of people) {
    try {
      const outcome = await deps.send(tenantId, "staff_alert", { staffUserId: userId, text: message.text, templateParams: message.templateParams, idempotencyKey: `${keyBase}:${userId}` });
      if (outcome.status === "sent") counts.sent++;
      else if (outcome.status === "skipped") counts.skipped++;
      else counts.failed++;
    } catch {
      counts.failed++;
    }
  }
  return counts;
}
