import { slotLabel } from "../booking/time";
import { AppError } from "../lib/errors";
import type { FoundSlot, SchedulingPort } from "../agent/scheduling/act";

// A small calendar for the scripted chats (tests/conversations): a list of free times, a booking the customer may already have, and
// the same answers Dev 2's booking engine gives (booking/bookings.ts) where a chat needs them: a time someone else took is `slot_taken`,
// a hold is not a booking until it is confirmed, a lead holds one time at a time, cancelling twice is harmless. It stands in for the
// engine and its database in the runner only; the engine itself is tested by Dev 2's own tests and supabase/tests.

const RESOURCE = "20000000-0000-0000-0000-000000000002";
const HOUR_MS = 3_600_000;
const MAX_OFFERED = 3;

interface Held {
  id: string;
  leadId: string;
  start: string;
  end: string;
  status: "held" | "confirmed" | "cancelled";
}

export interface CalendarOptions {
  /** The business's clock (ISO). */
  now: string;
  timeZone: string;
  /** Free times, ISO UTC starts; each lasts an hour. */
  slots: string[];
  /** Times someone else takes first, once, when the customer chooses one of them. */
  takenWhenChosen: string[];
  /** A confirmed booking the customer already has (ISO UTC start). */
  existing?: string;
  /** The pincodes the chat's technician works in (a resource's service area in Dev 2's findSlots). None: works everywhere. */
  workPincodes?: string[];
  /** A booking was confirmed: the lead is now booked (Dev 2's confirm_booking does this in the database). */
  onConfirm: () => void;
}

export function createCalendar(options: CalendarOptions) {
  const now = Date.parse(options.now);
  const bookings = new Map<string, Held>();
  const taken = new Set<string>();
  const waitingToBeTaken = new Set(options.takenWhenChosen);
  let counter = 0;
  let cancelledCount = 0;
  const nextId = () => `40000000-0000-0000-0000-${String(++counter).padStart(12, "0")}`;
  const endOf = (start: string) => new Date(Date.parse(start) + HOUR_MS).toISOString();
  const occupied = (start: string) => [...bookings.values()].some((b) => b.status !== "cancelled" && Date.parse(b.start) === Date.parse(start));
  const free = (start: string) => options.slots.includes(start) && !taken.has(start) && !occupied(start);
  const LEAD_UNKNOWN = "";

  if (options.existing) bookings.set("existing", { id: nextId(), leadId: LEAD_UNKNOWN, start: options.existing, end: endOf(options.existing), status: "confirmed" });
  const byId = (id: string) => [...bookings.values()].find((b) => b.id === id);

  const port: SchedulingPort = {
    async findSlots(_tenantId, { serviceId, from, to, pincode }): Promise<FoundSlot[]> {
      // As Dev 2's findSlots: a pincode asked for is a filter on the resource's service area; no pincode, no filter.
      if (pincode && options.workPincodes && !options.workPincodes.includes(pincode)) return [];
      return options.slots
        .filter((start) => Date.parse(start) > now && Date.parse(start) >= from.getTime() && Date.parse(start) < to.getTime() && free(start))
        .sort((a, b) => Date.parse(a) - Date.parse(b))
        .slice(0, MAX_OFFERED)
        .map((start) => ({ start, end: endOf(start), resourceId: RESOURCE, resourceName: "Anand", serviceId, label: slotLabel(new Date(start), options.timeZone) }));
    },
    async holdSlot(_tenantId, slot, leadId) {
      if (waitingToBeTaken.delete(slot.start)) taken.add(slot.start);
      if (!free(slot.start)) throw new AppError("slot_taken", "That time was just taken. Pick another one.");
      // A lead holds one time at a time: the earlier hold is replaced.
      for (const b of bookings.values()) if (b.leadId === leadId && b.status === "held") b.status = "cancelled";
      const id = nextId();
      bookings.set(id, { id, leadId, start: slot.start, end: slot.end, status: "held" });
      return { id };
    },
    async confirmBooking(_tenantId, bookingId) {
      const booking = byId(bookingId);
      if (!booking || booking.status === "cancelled") throw new AppError("conflict", "That hold has expired.");
      booking.status = "confirmed";
      options.onConfirm();
      return { id: booking.id };
    },
    async rescheduleBooking(_tenantId, bookingId, slot) {
      const booking = byId(bookingId);
      if (!booking) throw new AppError("not_found", "That booking wasn't found.");
      if (booking.status !== "confirmed") throw new AppError("conflict", "Only a confirmed booking can be moved.");
      if (!free(slot.start)) throw new AppError("slot_taken", "That time was just taken. Pick another one.");
      booking.start = slot.start;
      booking.end = slot.end;
      return { id: booking.id };
    },
    async cancelBooking(_tenantId, bookingId) {
      const booking = byId(bookingId);
      if (!booking) throw new AppError("not_found", "That booking wasn't found.");
      if (booking.status === "cancelled") return; // safe to repeat
      booking.status = "cancelled";
      cancelledCount++;
    },
    async activeBooking() {
      const open = [...bookings.values()].filter((b) => b.status !== "cancelled" && Date.parse(b.end) > now).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
      return open[0] ? { id: open[0].id, start: open[0].start, end: open[0].end, status: open[0].status } : null;
    },
  };

  return {
    port,
    /** The start of every confirmed booking, soonest first. */
    confirmed: () => [...bookings.values()].filter((b) => b.status === "confirmed").map((b) => new Date(b.start).toISOString()).sort(),
    /** How many bookings were cancelled. */
    cancelled: () => cancelledCount,
  };
}
