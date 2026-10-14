import { ContactDeletionPreview, ContactDeletionResult } from "@pakka/types";
import { z } from "zod";
import { getJson, postJson } from "@/lib/api/client";
import { ApiError, formatError, type FormattedError } from "@/lib/errors";

// A customer's request to delete their data (docs/contracts.md, "A customer's data deletion"; backend/src/consent/deletion.ts, 0043). Owner or admin.
//   GET  /api/contacts/:id/deletion  → ContactDeletionPreview  what a deletion would remove, and whether bookings are still to come
//   POST /api/contacts/:id/deletion  (no body) → ContactDeletionResult { status: deleted | already_deleted, removed, calendarEvents { removed, left } }
//                                    `conflict` while a booking is coming up; `forbidden` for staff; `not_found` for another business's contact
// The role is checked by the server on both calls and that is the only check that counts. Nothing here treats a request as done unless the server
// answered with a result in exactly that shape; an answer that is not is an error, never a success.

export class DeletionDataError extends Error {
  constructor(what: string) {
    super(`The ${what} answer was not in the shape the contract promises`);
    this.name = "DeletionDataError";
  }
}

const ContactId = z.guid();

function pathFor(contactId: string): `/api/contacts/${string}/deletion` {
  if (!ContactId.safeParse(contactId).success) throw new DeletionDataError("contact id");
  return `/api/contacts/${encodeURIComponent(contactId)}/deletion`;
}

export async function fetchDeletionPreview(tenantId: string, contactId: string, signal?: AbortSignal): Promise<ContactDeletionPreview> {
  const parsed = ContactDeletionPreview.safeParse(await getJson<unknown>(pathFor(contactId), { tenantId, signal }));
  // An answer about another contact must never be shown as this one's.
  if (!parsed.success || parsed.data.contactId !== contactId) throw new DeletionDataError("preview");
  return parsed.data;
}

export async function requestDeletion(tenantId: string, contactId: string): Promise<ContactDeletionResult> {
  const parsed = ContactDeletionResult.safeParse(await postJson<unknown>(pathFor(contactId), undefined, { tenantId }));
  if (!parsed.success) throw new DeletionDataError("deletion");
  return parsed.data;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;

export interface DeletionOutcome {
  /** What the server confirmed: `deleted` is this request's doing, `already_deleted` means nothing changed now. */
  status: ContactDeletionResult["status"];
  headline: string;
  /** What was removed by this request (empty for already_deleted). */
  removed: string | null;
  calendar: { removed: number; left: number };
  /** Set only when some Google Calendar events could not be taken down and the business must remove them by hand. */
  calendarWarning: string | null;
}

/** The words for a server-confirmed result. Call only with a parsed ContactDeletionResult. */
export function describeOutcome(result: ContactDeletionResult): DeletionOutcome {
  const { removed, calendarEvents } = result;
  const left = calendarEvents.left;
  return {
    status: result.status,
    headline: result.status === "deleted" ? "This customer's data was deleted." : "This customer's data had already been deleted. Nothing changed now.",
    removed:
      result.status === "deleted"
        ? `Removed ${plural(removed.conversations, "chat", "chats")}, ${plural(removed.messages, "message", "messages")}, ${plural(removed.leads, "lead", "leads")} and ${plural(removed.bookings, "booking", "bookings")}.`
        : null,
    calendar: calendarEvents,
    calendarWarning:
      left > 0
        ? `${plural(left, "Google Calendar event", "Google Calendar events")} could not be taken down (Google was unreachable or the calendar is disconnected). They carry the customer's name: remove ${left === 1 ? "it" : "them"} from your calendar by hand.`
        : null,
  };
}

/** What the UI shows for a failed read or request. Only the server's own words are used for a refusal; a malformed answer is never shown as an outcome. */
export function describeDeletionError(err: unknown): FormattedError & { kind: "conflict" | "forbidden" | "not_found" | "malformed" | "other" } {
  if (err instanceof DeletionDataError) {
    return {
      kind: "malformed",
      code: "internal",
      title: "We can't confirm what happened",
      message: "Spark Agent answered something we didn't expect, so we can't say whether the data was deleted. Reload this page and check before trying again.",
      retryable: false,
    };
  }
  if (err instanceof ApiError) {
    const shown = formatError(err);
    const { code } = err.body.error;
    if (code === "conflict") return { ...shown, kind: "conflict", title: "This customer has a booking coming up", retryable: false };
    if (code === "forbidden") return { ...shown, kind: "forbidden", title: "Only an owner or admin can delete a customer's data", retryable: false };
    if (code === "not_found") return { ...shown, kind: "not_found", title: "That customer was not found", retryable: false };
    return { ...shown, kind: "other" };
  }
  return { ...formatError(err), kind: "other" };
}
