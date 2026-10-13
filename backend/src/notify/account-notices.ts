import { send, type NotifyPayload, type SendOutcome } from "./send";
import { staffAlertRecipients, type AlertRole } from "./staff-alerts";

// Notices about the account itself (the trial, a plan payment) to the business's owners, and admins where asked: one
// account_notice through notify.send to each with an alert number (memberships.whatsapp_phone). Free, sent even when the
// business is paused or its trial has ended, but not to a business that switched staff alerts off (notify KINDS). The
// wording is fixed text with a dashboard link, like the staff alerts; placeholder until Raja's.

/** {{1}} what happened, {{2}} the link: the staff_alert template's two values, used outside the 24-hour window. */
export type NoticeMessage = { text: string; templateParams: [string, string] };

export type NoticeCounts = { recipients: number; sent: number; skipped: number; failed: number };

export interface NoticeDeps {
  recipients: (tenantId: string, roles: readonly AlertRole[]) => Promise<string[]>;
  send: (tenantId: string, kind: "account_notice", payload: NotifyPayload) => Promise<SendOutcome>;
}

const defaults = (): NoticeDeps => ({
  recipients: (tenantId, roles) => staffAlertRecipients(tenantId, undefined, roles),
  send: (tenantId, kind, payload) => send(tenantId, kind, payload),
});

/**
 * Sends one notice to each owner (and admin, when `roles` says so) with an alert number. `keyBase` names this exact notice;
 * with the person it is the send's idempotency key, so a retry or a repeat run never sends it twice. Never throws: a
 * switch that is off, a closed window and a send that breaks are counted, and the dashboard still shows the state.
 */
export async function sendAccountNotice(
  tenantId: string,
  message: NoticeMessage,
  keyBase: string,
  options: { roles?: readonly AlertRole[]; deps?: NoticeDeps } = {},
): Promise<NoticeCounts> {
  const deps = options.deps ?? defaults();
  let people: string[];
  try {
    people = await deps.recipients(tenantId, options.roles ?? ["owner"]);
  } catch {
    return { recipients: 0, sent: 0, skipped: 0, failed: 1 };
  }
  const counts: NoticeCounts = { recipients: people.length, sent: 0, skipped: 0, failed: 0 };
  for (const userId of people) {
    try {
      const outcome = await deps.send(tenantId, "account_notice", { staffUserId: userId, text: message.text, templateParams: message.templateParams, idempotencyKey: `${keyBase}:${userId}` });
      if (outcome.status === "sent") counts.sent++;
      else if (outcome.status === "skipped") counts.skipped++;
      else counts.failed++;
    } catch {
      counts.failed++;
    }
  }
  return counts;
}
