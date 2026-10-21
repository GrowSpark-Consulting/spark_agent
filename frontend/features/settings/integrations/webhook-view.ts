import { WEBHOOK_EVENTS, type WebhookEvent, type WebhookTestResult } from "@pakka/types";
import type { Role } from "@pakka/types";

// Wording for the Integrations screen, and the small decisions it makes, kept out of the component so they can be tested. The server decides
// everything that matters (who may call, the plan, which address is allowed); this only words what it says.

export const EVENT_LABEL: Record<WebhookEvent, { title: string; detail: string }> = {
  "lead.created": { title: "A new lead", detail: "Someone new starts a conversation." },
  "lead.qualified": { title: "A lead is qualified", detail: "The assistant has the answers it needs." },
  "booking.confirmed": { title: "A booking is confirmed", detail: "A visit or appointment is booked." },
  "booking.cancelled": { title: "A booking is cancelled", detail: "A booked visit or appointment is cancelled." },
  "handoff.opened": { title: "A chat is handed to a person", detail: "The assistant asks your team to take over." },
};

export const ALL_EVENTS: readonly WebhookEvent[] = WEBHOOK_EVENTS;

/** Owners and admins manage the webhook; the server refuses everyone else, and staff are not shown a form that can only fail. */
export function canManageWebhook(role: Role): boolean {
  return role === "owner" || role === "admin";
}

/** The server's `lastFailure` (http_<status>, timeout, refused_address, connection_failed), in words. Anything else gets a plain line, never raw text. */
export function failureText(reason: string | null): string | null {
  if (reason === null) return null;
  const http = /^http_(\d{3})$/.exec(reason);
  if (http) return `The receiver answered with an error (HTTP ${http[1]}).`;
  switch (reason) {
    case "timeout":
      return "The receiver took too long to answer.";
    case "refused_address":
      return "We don't send to that address: it is on a private or reserved network.";
    case "connection_failed":
      return "We couldn't connect to the receiver.";
    default:
      return "The last delivery didn't go through.";
  }
}

/** The result of a test ping, from the server's own fields only: delivered or not, the receiver's status when it answered, and why not. */
export function testResultText(result: WebhookTestResult): { ok: boolean; text: string } {
  if (result.delivered) return { ok: true, text: result.status === null ? "Delivered." : `Delivered. The receiver answered HTTP ${result.status}.` };
  const why = failureText(result.error);
  return { ok: false, text: `Not delivered. ${why ?? "The receiver didn't accept it."}` };
}

/** The saved secret is never shown again, only its last four characters. */
export function hintText(secretHint: string): string {
  return `Signing secret ending in ${secretHint}`;
}

export interface FormProblems {
  url?: string;
  events?: string;
}

/** What can be said before asking the server: something typed, and at least one event. The address rules (https, port, network) are the server's. */
export function formProblems(url: string, events: readonly WebhookEvent[]): FormProblems {
  const problems: FormProblems = {};
  if (url.trim() === "") problems.url = "Enter the address that should receive the events.";
  else if (url.trim().length > 500) problems.url = "Use 500 characters or fewer.";
  if (events.length === 0) problems.events = "Choose at least one event.";
  return problems;
}

/** The form's events in the server's order, so an unchanged selection compares equal. */
export function orderedEvents(selected: Iterable<WebhookEvent>): WebhookEvent[] {
  const set = new Set(selected);
  return ALL_EVENTS.filter((e) => set.has(e));
}

export function sameEvents(a: readonly WebhookEvent[], b: readonly WebhookEvent[]): boolean {
  return a.length === b.length && orderedEvents(a).every((e, i) => e === orderedEvents(b)[i]);
}
