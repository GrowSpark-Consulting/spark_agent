import { z } from "zod";
import { MAX_OFFERED, type OfferedSlot } from "./offer";

// The offer that is waiting for the customer's answer, kept on the chat's own messages (`messages.meta.agent.offer`) the way the
// count of knowledge-base misses is: no table and no migration. The turn that offers times writes it; a turn that books one writes
// `null`; a turn that does neither writes nothing, so the offer simply carries on to the next message.
//
// It is read back from a database column, so it is checked like any outside input.

/** An offer is forgotten after a day: the customer who answers tomorrow is asked again, not given a time that may be gone. */
export const OFFER_MAX_AGE_MS = 24 * 60 * 60_000;

const Instant = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "not a time");

export const OfferedSlotSchema = z
  .object({ start: Instant, end: Instant, resourceId: z.guid(), serviceId: z.guid(), label: z.string().trim().min(1).max(80) })
  .refine((s) => Date.parse(s.end) > Date.parse(s.start), "ends before it starts");

const OfferStateSchema = z.object({ slots: z.array(OfferedSlotSchema).min(1).max(MAX_OFFERED), at: z.string() });

export interface OfferState {
  slots: OfferedSlot[];
  /** When the offer was made (ISO 8601 UTC). */
  at: string;
}

export function parseOfferState(value: unknown): OfferState | null {
  const parsed = OfferStateSchema.safeParse(value);
  if (!parsed.success) return null;
  return { slots: parsed.data.slots.map(({ start, end, resourceId, serviceId, label }) => ({ start, end, resourceId, serviceId, label })), at: parsed.data.at };
}

/** The offer if it is still worth answering: not older than a day, and its first time has not passed. */
export function freshOffer(offer: OfferState | null, now: Date): OfferState | null {
  if (!offer) return null;
  const madeAt = Date.parse(offer.at);
  if (Number.isNaN(madeAt) || now.getTime() - madeAt > OFFER_MAX_AGE_MS) return null;
  if (offer.slots.some((s) => Date.parse(s.start) <= now.getTime())) return null;
  return offer;
}
