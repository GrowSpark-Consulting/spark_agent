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
  /** Moves a confirmed booking to another time. */
  rescheduleBooking(tenantId: string, bookingId: string, slot: OfferedSlot): Promise<{ id: string }>;
  /** Cancels a held or confirmed booking. Safe to repeat. */
  cancelBooking(tenantId: string, bookingId: string, reason: string): Promise<void>;
  /** The lead's next held or confirmed booking that has not ended, or null. Read only. */
  activeBooking(tenantId: string, leadId: string): Promise<{ id: string; start: string; end: string; status: string } | null>;
}

/** The booking kinds that need a time and someone's calendar (booking/bookings.ts BOOKING_KINDS). */
export type BookingKind = "slot" | "site_visit";

export type ActRequest =
  | {
      kind: "offer";
      serviceId: string;
      /** What the customer said about when, in their words, or null. */
      preferredText: string | null;
      /** The times are for moving this booking, not for a new one. */
      rescheduleBookingId?: string;
      /** Times (ISO UTC starts) the customer has just turned down: not offered again. */
      exclude?: string[];
    }
  | { kind: "book"; serviceId: string; bookingKind: BookingKind; slot: OfferedSlot }
  | { kind: "reschedule"; serviceId: string; bookingId: string; slot: OfferedSlot }
  /** Asks whether to cancel. Nothing is cancelled by this. */
  | { kind: "ask_cancel"; bookingId: string; label: string }
  | { kind: "cancel"; bookingId: string; label: string }
  /** The customer said no to cancelling: the question is over and the booking stays. */
  | { kind: "keep"; label: string };

export type ActResult =
  | {
      kind: "offered";
      slots: OfferedSlot[];
      /** The times are inside what the customer asked for. */
      asked: boolean;
      /** The time they chose was taken by someone else first. */
      retaken?: boolean;
      /** The times are for moving this booking. */
      rescheduleBookingId?: string;
    }
  | { kind: "no_slots" }
  | { kind: "booked"; label: string }
  | { kind: "rescheduled"; label: string }
  | { kind: "cancel_asked"; bookingId: string; label: string }
  | { kind: "cancelled"; label: string }
  | { kind: "kept"; label: string }
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

const Label = z.string().trim().min(1).max(80);

/** What a turn's act step kept on the message (messages.meta.agent.act), read back with the same care as any outside input. */
export const ActResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("offered"),
    slots: z.array(OfferedSlotSchema).min(1).max(3),
    asked: z.boolean(),
    retaken: z.boolean().optional(),
    rescheduleBookingId: z.guid().optional(),
  }),
  z.object({ kind: z.literal("no_slots") }),
  z.object({ kind: z.literal("booked"), label: Label }),
  z.object({ kind: z.literal("rescheduled"), label: Label }),
  z.object({ kind: z.literal("cancel_asked"), bookingId: z.guid(), label: Label }),
  z.object({ kind: z.literal("cancelled"), label: Label }),
  z.object({ kind: z.literal("kept"), label: Label }),
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

async function offer(
  serviceId: string,
  preferredText: string | null,
  retaken: boolean,
  rescheduleBookingId: string | undefined,
  exclude: string[],
  ctx: ActContext,
): Promise<ActResult> {
  const preferred = preferredText ? parsePreferredTime(preferredText, { timeZone: ctx.timeZone, now: ctx.now }) : null;
  const turnedDown = new Set(exclude.map((start) => Date.parse(start)));
  for (const window of searchWindows(preferred, ctx.now, ctx.timeZone)) {
    const slots = (await ctx.port.findSlots(ctx.tenantId, { serviceId, from: window.from, to: window.to })).filter((s) => !turnedDown.has(Date.parse(s.start)));
    if (slots.length > 0) {
      return {
        kind: "offered",
        slots: toOffered(slots),
        // With no time asked for, the soonest times are what was asked for; only a time that was asked for and not free is "the closest".
        asked: !retaken && (preferred === null || window.kind === "asked"),
        ...(retaken ? { retaken: true } : {}),
        ...(rescheduleBookingId ? { rescheduleBookingId } : {}),
      };
    }
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
    if (error.code === "slot_taken") return offer(request.serviceId, null, true, undefined, [], ctx);
    return { kind: "error" };
  }
}

async function reschedule(request: Extract<ActRequest, { kind: "reschedule" }>, ctx: ActContext): Promise<ActResult> {
  const { slot, bookingId } = request;
  // A retry of this step, after the booking was moved but before the answer was kept: the lead's booking is already at that time.
  const existing = await ctx.port.activeBooking(ctx.tenantId, ctx.leadId);
  if (existing && existing.status === "confirmed" && Date.parse(existing.start) === Date.parse(slot.start)) return { kind: "rescheduled", label: slot.label };

  try {
    await ctx.port.rescheduleBooking(ctx.tenantId, bookingId, slot);
    return { kind: "rescheduled", label: slot.label };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    if (error.code === "slot_taken") return offer(request.serviceId, null, true, bookingId, [], ctx);
    return { kind: "error" };
  }
}

async function cancel(request: Extract<ActRequest, { kind: "cancel" }>, ctx: ActContext): Promise<ActResult> {
  try {
    await ctx.port.cancelBooking(ctx.tenantId, request.bookingId, "Cancelled by the customer in the chat");
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    // A booking that is already gone is what the customer wanted.
    if (error.code !== "not_found") return { kind: "error" };
  }
  return { kind: "cancelled", label: request.label };
}

export async function runAct(request: ActRequest, ctx: ActContext): Promise<ActResult> {
  try {
    switch (request.kind) {
      case "offer":
        return await offer(request.serviceId, request.preferredText, false, request.rescheduleBookingId, request.exclude ?? [], ctx);
      case "book":
        return await book(request, ctx);
      case "reschedule":
        return await reschedule(request, ctx);
      case "ask_cancel":
        return { kind: "cancel_asked", bookingId: request.bookingId, label: request.label };
      case "cancel":
        return await cancel(request, ctx);
      case "keep":
        return { kind: "kept", label: request.label };
    }
  } catch (error) {
    // A refusal the booking engine explains is an answer; anything else (the database, the network) is for the step's retry.
    if (error instanceof AppError) return { kind: "error" };
    throw error;
  }
}
