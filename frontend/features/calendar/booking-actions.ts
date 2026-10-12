import type { Role } from "@pakka/types";
import { z } from "zod";
import { getJson, postJson } from "@/lib/api/client";
import { ApiError } from "@/lib/errors";
import type { ShownStatus } from "./bookings";

// The calendar's buttons (docs/contracts.md, section 4, "The calendar's actions"). Built by Dev 2 and on main (#115):
// backend/src/booking/actions.ts and migration 0026. Request and answer shapes were checked against that file on 12 Oct 2026.
//   POST /api/bookings/:id/reschedule  { start, end, resourceId? } → Booking (the new, confirmed one)
//   POST /api/bookings/:id/cancel      { reason? } or no body     → Booking
//   POST /api/bookings/:id/complete    no body                    → Booking (its lead moves to visited)
//   POST /api/bookings/:id/no-show     no body                    → Booking (the rebooking offer follows)
//   GET  /api/bookings/:id/slots?from=&to=                        → { slots: Slot[] } (up to 3 free times)
// Each answers the booking as the server now has it; the calendar then re-reads its range, so what stays on screen is what
// the database says, not what was asked for. A customer is NOT messaged about a cancel or a move made here (the contract
// says so; it is an open question for Raja), and the screen says that too.
//
// The shapes are mirrored from the backend (not in @pakka/types) and parsed before use. Owners and admins may act on any
// booking of the business, staff only on their own calendar's (resources.user_id); the server checks it again.

export const ActionBooking = z.object({
  id: z.guid(),
  status: z.string(),
  start: z.string(),
  end: z.string(),
  resourceId: z.guid().nullable(),
});
export type ActionBooking = z.infer<typeof ActionBooking>;

export const MoveSlot = z.object({
  start: z.string(),
  end: z.string(),
  resourceId: z.guid(),
  resourceName: z.string(),
  label: z.string(),
});
export type MoveSlot = z.infer<typeof MoveSlot>;

const SlotsAnswer = z.object({ slots: z.array(MoveSlot) });

export class BookingActionDataError extends Error {
  constructor() {
    super("The booking answer had an unexpected shape.");
    this.name = "BookingActionDataError";
  }
}

const parse = <S extends z.ZodType>(schema: S, answer: unknown): z.infer<S> => {
  const parsed = schema.safeParse(answer);
  if (!parsed.success) throw new BookingActionDataError();
  return parsed.data;
};

const path = (bookingId: string, action: string) => `/api/bookings/${encodeURIComponent(bookingId)}/${action}` as const;

export interface BookingActionService {
  slots: (tenantId: string, bookingId: string, from?: Date) => Promise<MoveSlot[]>;
  reschedule: (tenantId: string, bookingId: string, slot: Pick<MoveSlot, "start" | "end" | "resourceId">) => Promise<ActionBooking>;
  cancel: (tenantId: string, bookingId: string, reason?: string) => Promise<ActionBooking>;
  complete: (tenantId: string, bookingId: string) => Promise<ActionBooking>;
  noShow: (tenantId: string, bookingId: string) => Promise<ActionBooking>;
}

export const bookingActionService: BookingActionService = {
  async slots(tenantId, bookingId, from) {
    const query = from ? `?from=${encodeURIComponent(from.toISOString())}` : "";
    return parse(SlotsAnswer, await getJson<unknown>(`${path(bookingId, "slots")}${query}` as `/api/${string}`, { tenantId })).slots;
  },
  async reschedule(tenantId, bookingId, slot) {
    const body = { start: slot.start, end: slot.end, resourceId: slot.resourceId };
    return parse(ActionBooking, await postJson<unknown>(path(bookingId, "reschedule"), body, { tenantId }));
  },
  async cancel(tenantId, bookingId, reason) {
    const text = reason?.trim();
    // `{}` and no body are the same to the server; a reason is only sent when there is one.
    return parse(ActionBooking, await postJson<unknown>(path(bookingId, "cancel"), text ? { reason: text } : undefined, { tenantId }));
  },
  async complete(tenantId, bookingId) {
    return parse(ActionBooking, await postJson<unknown>(path(bookingId, "complete"), undefined, { tenantId }));
  },
  async noShow(tenantId, bookingId) {
    return parse(ActionBooking, await postJson<unknown>(path(bookingId, "no-show"), undefined, { tenantId }));
  },
};

// Which buttons ----------------------------------------------------------------------------------------------------

export const CANCEL_REASON_MAX = 500;

export type VisitAction = "yes" | "not_started" | "no";

export interface Availability {
  reschedule: boolean;
  cancel: boolean;
  /** Mark visited and mark no-show: only a confirmed booking that has started (contract); before that they are shown, off. */
  complete: VisitAction;
  noShow: VisitAction;
}

/** What can be done to a booking in this state. The server decides again; this only avoids offering what it will refuse. */
export function availability(shown: ShownStatus, start: string, now: Date): Availability {
  const confirmed = shown === "confirmed";
  const visit: VisitAction = !confirmed ? "no" : Date.parse(start) <= now.getTime() ? "yes" : "not_started";
  return { reschedule: confirmed, cancel: confirmed || shown === "held", complete: visit, noShow: visit };
}

/** Owners and admins act on any booking; staff only where the booking's resource is their own (resources.user_id). */
export function mayAct(role: Role, userId: string, resourceUserId: string | null): boolean {
  return role !== "staff" || (resourceUserId !== null && resourceUserId === userId);
}

// Errors ---------------------------------------------------------------------------------------------------------------

export type ActionFailure =
  /** Someone took the time first: show fresh times. */
  | "slot_taken"
  /** The booking changed under the screen (not found, or the wrong state): re-read it. */
  | "stale"
  | "other";

export function failureKind(err: unknown): ActionFailure {
  if (!(err instanceof ApiError)) return "other";
  const code = err.body.error.code;
  if (code === "slot_taken") return "slot_taken";
  if (code === "not_found" || code === "conflict") return "stale";
  return "other";
}
