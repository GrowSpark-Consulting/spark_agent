import { z } from "zod";
import { MAX_OFFERED, type OfferedSlot } from "./offer";

// What is waiting for the customer's answer, kept on the chat's own messages (`messages.meta.agent.offer`) the way the count of
// knowledge-base misses is: no table and no migration. Two things can wait:
//   - an offer of times (to book one, or, with `rescheduleBookingId`, to move that booking to one of them)
//   - a question whether to cancel a booking (`cancel`): nothing is cancelled until the customer answers yes
// The turn that makes one writes it; a turn that ends it writes `null`; a turn that does neither writes nothing, so it simply carries on to
// the next message.
//
// It is read back from a database column, so it is checked like any outside input.

/** What waits is forgotten after a day: the customer who answers tomorrow is asked again, not given a time that may be gone. */
export const OFFER_MAX_AGE_MS = 24 * 60 * 60_000;

const Instant = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "not a time");

export const OfferedSlotSchema = z
  .object({ start: Instant, end: Instant, resourceId: z.guid(), serviceId: z.guid(), label: z.string().trim().min(1).max(80) })
  .refine((s) => Date.parse(s.end) > Date.parse(s.start), "ends before it starts");

const OfferStateSchema = z.object({
  slots: z.array(OfferedSlotSchema).min(1).max(MAX_OFFERED),
  at: z.string(),
  rescheduleBookingId: z.guid().optional().catch(undefined),
});
const CancelAskSchema = z.object({ cancel: z.object({ bookingId: z.guid(), label: z.string().trim().min(1).max(80) }), at: z.string() });

export interface OfferState {
  slots: OfferedSlot[];
  /** When the offer was made (ISO 8601 UTC). */
  at: string;
  /** The offer is for moving this booking to one of the times (otherwise a new booking). */
  rescheduleBookingId?: string;
}

/** We asked the customer whether to cancel this booking, and are waiting for yes or no. */
export interface CancelAsk {
  cancel: { bookingId: string; label: string };
  at: string;
}

export type PendingState = OfferState | CancelAsk;

export function parseOfferState(value: unknown): OfferState | null {
  const parsed = OfferStateSchema.safeParse(value);
  if (!parsed.success) return null;
  const { slots, at, rescheduleBookingId } = parsed.data;
  return {
    slots: slots.map(({ start, end, resourceId, serviceId, label }) => ({ start, end, resourceId, serviceId, label })),
    at,
    ...(rescheduleBookingId ? { rescheduleBookingId } : {}),
  };
}

/** What was waiting: an offer of times or a question whether to cancel, or nothing (it ended, or what is kept cannot be read). */
export function parsePendingState(value: unknown): PendingState | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value) && "cancel" in value) {
    if ("slots" in value) return null; // it is one or the other
    const parsed = CancelAskSchema.safeParse(value);
    return parsed.success ? { cancel: { bookingId: parsed.data.cancel.bookingId, label: parsed.data.cancel.label }, at: parsed.data.at } : null;
  }
  return parseOfferState(value);
}

/** What is waiting, if it is still worth answering: not older than a day, and (for times) the first has not passed. */
export function freshOffer(pending: PendingState | null, now: Date): PendingState | null {
  if (!pending) return null;
  const madeAt = Date.parse(pending.at);
  if (Number.isNaN(madeAt) || now.getTime() - madeAt > OFFER_MAX_AGE_MS) return null;
  if ("slots" in pending && pending.slots.some((s) => Date.parse(s.start) <= now.getTime())) return null;
  return pending;
}
