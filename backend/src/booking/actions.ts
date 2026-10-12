import type { TenantContext } from "@pakka/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { inngest } from "../inngest/client";
import { AppError, zodFieldErrors } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase-admin";
import { announce, bookingError, findSlots, toBooking, type Booking, type FindSlotsInput, type Slot } from "./bookings";

// The calendar's buttons (docs/dashboard-screen-contracts.md, "Calendar"; 9-day plan, Day 5): staff move, cancel, mark
// visited or mark no-show a booking, and see free times to move it to. Each action is one SQL function (0026) that
// changes the booking and writes its audit row together; then booking.changed (and booking.confirmed for a move's new
// time) goes to Inngest, so the reminder, post-visit, no-show and calendar jobs follow. Owners and admins act on any
// booking of the business; staff only on bookings with their own resource (resources.user_id).

export const RescheduleInput = z
  .object({
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    /** Another person of the same service; leave out to keep the booking's own. */
    resourceId: z.guid().nullable().optional(),
  })
  .strict();
export type RescheduleInput = z.infer<typeof RescheduleInput>;

export const CancelInput = z.object({ reason: z.string().trim().min(1).max(500).optional() }).strict();

/** How far ahead the times to move a booking to are looked for, when the request does not say. */
export const MOVE_WINDOW_DAYS = 7;

export interface BookingActionDeps {
  db: SupabaseClient;
  now: () => Date;
  send: (event: { id: string; name: string; data: Record<string, unknown> }) => Promise<unknown>;
  slots: (tenantId: string, input: FindSlotsInput) => Promise<Slot[]>;
}

const defaults = (): BookingActionDeps => ({
  db: supabaseAdmin(),
  now: () => new Date(),
  send: (event) => inngest.send(event),
  slots: (tenantId, input) => findSlots(tenantId, input),
});

const NOT_FOUND = "That booking wasn't found.";
const Owned = z.object({
  id: z.guid(),
  status: z.string(),
  service_id: z.guid().nullable(),
  resource_id: z.guid().nullable(),
  resources: z.object({ user_id: z.guid().nullable() }).nullable().catch(null),
});
type Owned = z.infer<typeof Owned>;

function parse<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new AppError("validation_failed", "Check the fields and try again.", zodFieldErrors(parsed.error));
  return parsed.data;
}

/** The business's booking, if this member may act on it: owners and admins on any, staff on their own calendar's. */
async function bookingFor(context: TenantContext, bookingId: string, deps: BookingActionDeps): Promise<Owned> {
  if (!z.guid().safeParse(bookingId).success) throw new AppError("not_found", NOT_FOUND);
  const { data, error } = await deps.db
    .from("bookings")
    .select("id, status, service_id, resource_id, resources(user_id)")
    .eq("tenant_id", context.tenant.id)
    .eq("id", bookingId)
    .maybeSingle();
  if (error) throw new Error(`booking actions: booking read failed: ${error.message}`);
  if (!data) throw new AppError("not_found", NOT_FOUND);
  const booking = Owned.parse(data);
  if (context.role === "staff" && (booking.resources?.user_id ?? null) !== context.user.id) {
    throw new AppError("forbidden", "Staff can change only the bookings in their own calendar.");
  }
  return booking;
}

const changed = (deps: BookingActionDeps, tenantId: string, bookingId: string, change: "rescheduled" | "cancelled" | "completed" | "no_show") =>
  announce(deps, { id: `booking.changed:${bookingId}:${change}`, name: "booking.changed", data: { tenantId, bookingId, change } });

/** POST /api/bookings/:id/reschedule: the booking moves to a new time (a new confirmed booking, which is returned). */
export async function rescheduleFromCalendar(context: TenantContext, bookingId: string, body: unknown, deps: BookingActionDeps = defaults()): Promise<Booking> {
  const input = parse(RescheduleInput, body);
  const booking = await bookingFor(context, bookingId, deps);
  if (context.role === "staff" && input.resourceId && input.resourceId !== booking.resource_id) {
    throw new AppError("forbidden", "Staff can move a booking only within their own calendar.");
  }
  const { data, error } = await deps.db.rpc("staff_reschedule_booking", {
    p_tenant_id: context.tenant.id,
    p_booking_id: booking.id,
    p_start: new Date(input.start).toISOString(),
    p_end: new Date(input.end).toISOString(),
    p_resource_id: input.resourceId ?? null,
    p_actor: context.user.id,
  });
  if (error) throw bookingError(error, "staff_reschedule_booking");
  const moved = toBooking(data);
  await changed(deps, context.tenant.id, booking.id, "rescheduled");
  await announce(deps, { id: `booking.confirmed:${moved.id}`, name: "booking.confirmed", data: { tenantId: context.tenant.id, bookingId: moved.id } });
  return moved;
}

/** POST /api/bookings/:id/cancel `{ reason? }`: a held or confirmed booking is cancelled. Cancelling again is harmless. */
export async function cancelFromCalendar(context: TenantContext, bookingId: string, body: unknown, deps: BookingActionDeps = defaults()): Promise<Booking> {
  const input = parse(CancelInput, body);
  const booking = await bookingFor(context, bookingId, deps);
  const { data, error } = await deps.db.rpc("staff_cancel_booking", {
    p_tenant_id: context.tenant.id,
    p_booking_id: booking.id,
    p_reason: input.reason ?? null,
    p_actor: context.user.id,
  });
  if (error) throw bookingError(error, "staff_cancel_booking");
  await changed(deps, context.tenant.id, booking.id, "cancelled");
  return toBooking(data);
}

/** POST /api/bookings/:id/complete: a confirmed booking that has started is marked visited, and its lead moves to visited. */
export async function completeFromCalendar(context: TenantContext, bookingId: string, deps: BookingActionDeps = defaults()): Promise<Booking> {
  const booking = await bookingFor(context, bookingId, deps);
  const { data, error } = await deps.db.rpc("complete_booking", { p_tenant_id: context.tenant.id, p_booking_id: booking.id, p_actor: context.user.id });
  if (error) throw bookingError(error, "complete_booking");
  await changed(deps, context.tenant.id, booking.id, "completed");
  return toBooking(data);
}

/** POST /api/bookings/:id/no-show: a confirmed booking that has started is marked no-show (the rebooking offer follows). */
export async function noShowFromCalendar(context: TenantContext, bookingId: string, deps: BookingActionDeps = defaults()): Promise<Booking> {
  const booking = await bookingFor(context, bookingId, deps);
  const { data, error } = await deps.db.rpc("mark_booking_no_show", { p_tenant_id: context.tenant.id, p_booking_id: booking.id, p_actor: context.user.id });
  if (error) throw bookingError(error, "mark_booking_no_show");
  await changed(deps, context.tenant.id, booking.id, "no_show");
  return toBooking(data);
}

const Window = z.object({ from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional() });

/**
 * GET /api/bookings/:id/slots?from=&to=: up to 3 free times for the booking's service to move it to (findSlots), from
 * now for a week unless the request says otherwise.
 */
export async function slotsForMove(context: TenantContext, bookingId: string, query: URLSearchParams, deps: BookingActionDeps = defaults()): Promise<{ slots: Slot[] }> {
  const window = parse(Window, { from: query.get("from") ?? undefined, to: query.get("to") ?? undefined });
  const booking = await bookingFor(context, bookingId, deps);
  if (booking.status !== "confirmed") throw new AppError("conflict", "Only a confirmed booking can be moved.");
  if (!booking.service_id) throw new AppError("conflict", "This booking has no service, so there are no times to offer.");
  const from = window.from ? new Date(window.from) : deps.now();
  const to = window.to ? new Date(window.to) : new Date(from.getTime() + MOVE_WINDOW_DAYS * 24 * 60 * 60_000);
  return { slots: await deps.slots(context.tenant.id, { serviceId: booking.service_id, from, to }) };
}
