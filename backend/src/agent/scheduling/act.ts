import { z } from "zod";
import { AppError } from "../../lib/errors";
import { searchWindows, toOffered, type OfferedSlot } from "./offer";
import { parsePreferredTime } from "./preferred-time";
import { OfferedSlotSchema } from "./state";

// Step 6, act (docs/handover.md, module 2): the part of a turn that CHANGES something or LOOKS at the calendar. The decision to do it was
// made by code (plan.ts); this carries it out through Dev 2's booking functions, which this file never reimplements: it only calls
// them through a port, so a test can stand in for the calendar and the real one is wired in runtime.ts.
//
// What it returns is small facts (times as the customer will read them), never a person's details. An outage is thrown, so Inngest
// tries the step again; a refusal the booking engine explains (a time just taken, a service not found) is a result the reply can word.

export interface FoundSlot extends OfferedSlot {
  resourceName: string;
}

/** What act needs from the booking engine (booking/bookings.ts, Dev 2) and the calendar. */
export interface SchedulingPort {
  findSlots(tenantId: string, input: { serviceId: string; from: Date; to: Date }): Promise<FoundSlot[]>;
  holdSlot(tenantId: string, slot: OfferedSlot, leadId: string, kind: BookingKind): Promise<{ id: string }>;
  confirmBooking(tenantId: string, bookingId: string): Promise<{ id: string }>;
  /** The lead's next held or confirmed booking that has not ended, or null. Read only. */
  activeBooking(tenantId: string, leadId: string): Promise<{ id: string; start: string; end: string; status: string } | null>;
}

/** The booking kinds that need a time and someone's calendar (booking/bookings.ts BOOKING_KINDS). */
export type BookingKind = "slot" | "site_visit";

export type ActRequest =
  | { kind: "offer"; serviceId: string; /** What the customer said about when, in their words, or null. */ preferredText: string | null }
  | { kind: "book"; serviceId: string; bookingKind: BookingKind; slot: OfferedSlot };

export type ActResult =
  | { kind: "offered"; slots: OfferedSlot[]; /** The times are inside what the customer asked for. */ asked: boolean; /** The time they chose was taken by someone else first. */ retaken?: boolean }
  | { kind: "no_slots" }
  | { kind: "booked"; label: string }
  | { kind: "error" };

/** What the booking step needs from the business and the calendar, beyond the booking functions themselves (all read only). */
export interface SchedulingDeps {
  port: SchedulingPort;
  /** isEnabled(tenantId, "booking"). */
  isEnabled: (tenantId: string, feature: "booking") => Promise<boolean>;
  /** The business's active services (id only). */
  services: (tenantId: string) => Promise<{ id: string }[]>;
  /** tenants.timezone. */
  timeZone: (tenantId: string) => Promise<string>;
}

/** What a turn's act step kept on the message (messages.meta.agent.act), read back with the same care as any outside input. */
export const ActResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("offered"), slots: z.array(OfferedSlotSchema).min(1).max(3), asked: z.boolean(), retaken: z.boolean().optional() }),
  z.object({ kind: z.literal("no_slots") }),
  z.object({ kind: z.literal("booked"), label: z.string().trim().min(1).max(80) }),
  z.object({ kind: z.literal("error") }),
]);

export interface ActContext {
  tenantId: string;
  leadId: string;
  /** The business's own time zone. */
  timeZone: string;
  now: Date;
  port: SchedulingPort;
}

async function offer(serviceId: string, preferredText: string | null, retaken: boolean, ctx: ActContext): Promise<ActResult> {
  const preferred = preferredText ? parsePreferredTime(preferredText, { timeZone: ctx.timeZone, now: ctx.now }) : null;
  for (const window of searchWindows(preferred, ctx.now, ctx.timeZone)) {
    const slots = await ctx.port.findSlots(ctx.tenantId, { serviceId, from: window.from, to: window.to });
    if (slots.length > 0) return { kind: "offered", slots: toOffered(slots), asked: window.kind === "asked" && !retaken, ...(retaken ? { retaken: true } : {}) };
  }
  return { kind: "no_slots" };
}

async function book(request: Extract<ActRequest, { kind: "book" }>, ctx: ActContext): Promise<ActResult> {
  const { slot } = request;
  // A retry of this step, after the booking was made but before the answer was kept: it is already booked, not a second time.
  const existing = await ctx.port.activeBooking(ctx.tenantId, ctx.leadId);
  if (existing && existing.status === "confirmed" && Date.parse(existing.start) === Date.parse(slot.start)) return { kind: "booked", label: slot.label };

  try {
    const held = await ctx.port.holdSlot(ctx.tenantId, slot, ctx.leadId, request.bookingKind);
    await ctx.port.confirmBooking(ctx.tenantId, held.id);
    return { kind: "booked", label: slot.label };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    // Someone else took it a moment before: offer what is free now, and say so.
    if (error.code === "slot_taken") return offer(request.serviceId, null, true, ctx);
    return { kind: "error" };
  }
}

export async function runAct(request: ActRequest, ctx: ActContext): Promise<ActResult> {
  try {
    return request.kind === "offer" ? await offer(request.serviceId, request.preferredText, false, ctx) : await book(request, ctx);
  } catch (error) {
    // A refusal the booking engine explains is an answer; anything else (the database, the network) is for the step's retry.
    if (error instanceof AppError) return { kind: "error" };
    throw error;
  }
}
