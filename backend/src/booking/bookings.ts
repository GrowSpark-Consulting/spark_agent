import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { inngest } from "../inngest/client";
import { AppError } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase-admin";
import { googleBusyTimes } from "./google-sync";
import { freeSlots, MAX_WINDOW_DAYS, spreadSlots, WeeklyHours, type BusyTime, type SlotResource } from "./slots";
import { slotLabel } from "./time";

// The booking functions (docs/handover.md, module 4; docs/contracts.md, section 4). findSlots reads
// the business's services, resources, hours and bookings and works out free times; the rest call the
// 0015 SQL functions, where the exclusion constraint blocks double booking. Server only (service role);
// every query filters by tenant_id. Confirmed and changed bookings are announced to Inngest for the
// reminder jobs.

export const BOOKING_KINDS = ["slot", "site_visit", "field_visit", "callback", "date_range", "reservation"] as const;
export type BookingKind = (typeof BOOKING_KINDS)[number];

/** How long a tapped slot is kept for the customer to confirm. */
export const HOLD_MINUTES = 10;
/** findSlots offers at most this many times. */
export const MAX_SLOTS = 3;

/** A free time to offer. Times are ISO 8601 UTC; label reads in the business's time zone. */
export interface Slot {
  start: string;
  end: string;
  resourceId: string;
  resourceName: string;
  serviceId: string;
  label: string;
}

export interface Booking {
  id: string;
  tenantId: string;
  leadId: string;
  resourceId: string | null;
  serviceId: string | null;
  kind: BookingKind;
  start: string;
  end: string;
  status: "held" | "confirmed" | "rescheduled" | "cancelled" | "completed" | "no_show" | "expired";
  holdExpiresAt: string | null;
  details: Record<string, unknown>;
}

export interface BookingDeps {
  db: SupabaseClient;
  now: () => Date;
  send: (event: { id: string; name: string; data: Record<string, unknown> }) => Promise<unknown>;
  /** Busy times from the resources' Google Calendars (booking/google-sync.ts); without it only bookings count. */
  googleBusy?: (tenantId: string, resourceIds: string[], from: Date, to: Date) => Promise<BusyTime[]>;
}

const defaults = (): BookingDeps => ({
  db: supabaseAdmin(),
  now: () => new Date(),
  send: (event) => inngest.send(event),
  googleBusy: (tenantId, resourceIds, from, to) => googleBusyTimes(tenantId, resourceIds, from, to),
});

const Id = z.guid();
const DAY_MS = 24 * 60 * 60_000;

export const FindSlotsInput = z
  .object({
    serviceId: z.guid(),
    /** Optional check: the service's resource_type decides who can do it. */
    resourceType: z.string().min(1).optional(),
    from: z.coerce.date(),
    to: z.coerce.date(),
    /** Field visits: only resources whose service area lists this pincode (or that have no area set). */
    pincode: z.string().regex(/^\d{6}$/, "must be a 6-digit pincode").optional(),
  })
  .refine((i) => i.to > i.from, { message: "to must be after from", path: ["to"] })
  .refine((i) => i.to.getTime() - i.from.getTime() <= MAX_WINDOW_DAYS * DAY_MS, {
    message: `the window is at most ${MAX_WINDOW_DAYS} days`,
    path: ["to"],
  });
export type FindSlotsInput = z.input<typeof FindSlotsInput>;

export const SlotChoice = z
  .object({
    start: z.coerce.date(),
    end: z.coerce.date(),
    resourceId: z.guid().nullable().optional(),
    serviceId: z.guid().nullable().optional(),
  })
  .refine((s) => s.end > s.start, { message: "end must be after start", path: ["end"] });
export type SlotChoice = z.input<typeof SlotChoice>;

const ServiceRow = z.object({
  id: z.guid(),
  duration_min: z.number().int().positive(),
  buffer_min: z.number().int().min(0),
  min_notice_min: z.number().int().min(0),
  resource_type: z.string(),
});
const ResourceRow = z.object({
  id: z.guid(),
  name: z.string(),
  working_hours: z.unknown(),
  service_area: z.object({ pincodes: z.array(z.string()).optional() }).passthrough().nullable(),
});
const BusyRow = z.object({
  resource_id: z.guid(),
  start_at: z.string(),
  end_at: z.string(),
  status: z.string(),
  hold_expires_at: z.string().nullable(),
});
const BookingRow = z.object({
  id: z.guid(),
  tenant_id: z.guid(),
  lead_id: z.guid(),
  resource_id: z.guid().nullable(),
  service_id: z.guid().nullable(),
  kind: z.enum(BOOKING_KINDS),
  start_at: z.string(),
  end_at: z.string(),
  status: z.enum(["held", "confirmed", "rescheduled", "cancelled", "completed", "no_show", "expired"]),
  hold_expires_at: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
});

function toBooking(data: unknown): Booking {
  const r = BookingRow.parse(data);
  return {
    id: r.id,
    tenantId: r.tenant_id,
    leadId: r.lead_id,
    resourceId: r.resource_id,
    serviceId: r.service_id,
    kind: r.kind,
    start: new Date(r.start_at).toISOString(),
    end: new Date(r.end_at).toISOString(),
    status: r.status,
    holdExpiresAt: r.hold_expires_at === null ? null : new Date(r.hold_expires_at).toISOString(),
    details: r.details,
  };
}

// The SQL functions' own messages ("hold_slot: that time has already passed") are safe to show.
const readable = (message: string) => {
  const text = message.replace(/^[a-z_]+: /, "");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
};

function bookingError(error: { code?: string; message: string }, what: string): Error {
  switch (error.code) {
    case "23P01":
      return new AppError("slot_taken", "That time was just taken. Pick another one.");
    case "PA404":
      return new AppError("not_found", readable(error.message));
    case "PA409":
      return new AppError("conflict", readable(error.message));
    case "P0001":
      return new AppError("validation_failed", readable(error.message));
    default:
      return new Error(`${what} failed: ${error.message}`);
  }
}

async function announce(deps: BookingDeps, event: { id: string; name: string; data: Record<string, unknown> }): Promise<void> {
  // The booking is already saved; a lost event is logged, and the fixed id makes a retry safe.
  try {
    await deps.send(event);
  } catch (e) {
    console.error(`${event.name} not sent for booking ${String(event.data.bookingId)}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Up to 3 free times for a service, spread across the window (from and to in UTC; use localWindow for
 * "tomorrow evening"). Each comes with one free resource of the service's type. Respects working hours
 * (the resource's, else the business's), service length, the service's buffer and minimum notice, and
 * held or confirmed bookings (an expired hold no longer counts).
 */
export async function findSlots(tenantId: string, rawInput: FindSlotsInput, deps: BookingDeps = defaults()): Promise<Slot[]> {
  const tenant = Id.parse(tenantId);
  const input = FindSlotsInput.parse(rawInput);
  const { db } = deps;

  const [tenantResult, serviceResult] = await Promise.all([
    db.from("tenants").select("timezone, business_hours").eq("id", tenant).maybeSingle(),
    db
      .from("services")
      .select("id, duration_min, buffer_min, min_notice_min, resource_type")
      .eq("tenant_id", tenant)
      .eq("id", input.serviceId)
      .eq("active", true)
      .maybeSingle(),
  ]);
  if (tenantResult.error) throw new Error(`findSlots: tenant read failed: ${tenantResult.error.message}`);
  if (serviceResult.error) throw new Error(`findSlots: service read failed: ${serviceResult.error.message}`);
  if (!tenantResult.data) throw new AppError("not_found", "That business wasn't found.");
  if (!serviceResult.data) throw new AppError("not_found", "That service isn't available.");
  const timeZone = z.string().parse(tenantResult.data.timezone);
  const service = ServiceRow.parse(serviceResult.data);
  if (input.resourceType && input.resourceType !== service.resource_type) {
    throw new AppError("validation_failed", "That service is done by someone else.", { resourceType: `must be ${service.resource_type}` });
  }

  const resourcesResult = await db
    .from("resources")
    .select("id, name, working_hours, service_area")
    .eq("tenant_id", tenant)
    .eq("type", service.resource_type)
    .eq("active", true);
  if (resourcesResult.error) throw new Error(`findSlots: resources read failed: ${resourcesResult.error.message}`);
  const businessHours = WeeklyHours.safeParse(tenantResult.data.business_hours);
  const resources = z
    .array(ResourceRow)
    .parse(resourcesResult.data ?? [])
    .filter((r) => !input.pincode || !r.service_area?.pincodes || r.service_area.pincodes.includes(input.pincode));
  if (resources.length === 0) return [];

  const slotResources: SlotResource[] = resources.map((r) => {
    const own = WeeklyHours.safeParse(r.working_hours);
    const hasOwn = own.success && Object.keys(own.data).length > 0;
    return { id: r.id, hours: hasOwn ? own.data : businessHours.success ? businessHours.data : {} };
  });

  const bufferMs = service.buffer_min * 60_000;
  const busyResult = await db
    .from("bookings")
    .select("resource_id, start_at, end_at, status, hold_expires_at")
    .eq("tenant_id", tenant)
    .in(
      "resource_id",
      resources.map((r) => r.id),
    )
    .in("status", ["held", "confirmed"])
    .lt("start_at", new Date(input.to.getTime() + bufferMs).toISOString())
    .gt("end_at", new Date(input.from.getTime() - bufferMs).toISOString());
  if (busyResult.error) throw new Error(`findSlots: bookings read failed: ${busyResult.error.message}`);
  const now = deps.now();
  const busy: BusyTime[] = z
    .array(BusyRow)
    .parse(busyResult.data ?? [])
    .filter((b) => !(b.status === "held" && b.hold_expires_at !== null && Date.parse(b.hold_expires_at) <= now.getTime()))
    .map((b) => ({ resourceId: b.resource_id, start: new Date(b.start_at), end: new Date(b.end_at) }));
  // Staff with a connected Google Calendar are also busy when Google says so. Google can only take times away; a
  // failure there never stops slot search (googleBusyTimes skips what it can't read, and this catches the rest).
  if (deps.googleBusy) {
    try {
      const windowFrom = new Date(input.from.getTime() - bufferMs);
      const windowTo = new Date(input.to.getTime() + bufferMs);
      busy.push(...(await deps.googleBusy(tenant, resources.map((r) => r.id), windowFrom, windowTo)));
    } catch (e) {
      console.error(`[booking] Google busy times skipped: ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }

  const free = freeSlots({
    timeZone,
    durationMin: service.duration_min,
    bufferMin: service.buffer_min,
    minNoticeMin: service.min_notice_min,
    from: input.from,
    to: input.to,
    now,
    resources: slotResources,
    busy,
  });
  const names = new Map(resources.map((r) => [r.id, r.name]));
  return spreadSlots(free, MAX_SLOTS).map((s) => ({
    start: s.start.toISOString(),
    end: s.end.toISOString(),
    resourceId: s.resourceId,
    resourceName: names.get(s.resourceId) ?? "",
    serviceId: service.id,
    label: slotLabel(s.start, timeZone),
  }));
}

/**
 * Holds a time for a lead for 10 minutes (status 'held'). Pass a Slot from findSlots; callback,
 * date_range and reservation bookings may have no resource and then never clash. A lead holds one time
 * at a time. A time someone else took is slot_taken.
 */
export async function holdSlot(
  tenantId: string,
  slot: SlotChoice,
  leadId: string,
  options: { kind?: BookingKind; details?: Record<string, unknown> } = {},
  deps: BookingDeps = defaults(),
): Promise<Booking> {
  const s = SlotChoice.parse(slot);
  const { data, error } = await deps.db.rpc("hold_slot", {
    p_tenant_id: Id.parse(tenantId),
    p_lead_id: Id.parse(leadId),
    p_kind: z.enum(BOOKING_KINDS).parse(options.kind ?? "slot"),
    p_start: s.start.toISOString(),
    p_end: s.end.toISOString(),
    p_resource_id: s.resourceId ?? null,
    p_service_id: s.serviceId ?? null,
    p_details: options.details ?? {},
    p_hold_minutes: HOLD_MINUTES,
  });
  if (error) throw bookingError(error, "hold_slot");
  return toBooking(data);
}

/** Confirms a held booking, moves the lead to 'booked' and emits booking.confirmed. Safe to repeat. */
export async function confirmBooking(tenantId: string, bookingId: string, deps: BookingDeps = defaults()): Promise<Booking> {
  const { data, error } = await deps.db.rpc("confirm_booking", { p_tenant_id: Id.parse(tenantId), p_booking_id: Id.parse(bookingId) });
  if (error) throw bookingError(error, "confirm_booking");
  const booking = toBooking(data);
  await announce(deps, {
    id: `booking.confirmed:${booking.id}`,
    name: "booking.confirmed",
    data: { tenantId: booking.tenantId, bookingId: booking.id },
  });
  return booking;
}

/**
 * Moves a confirmed booking to a new time (and optionally another resource). The old booking becomes
 * 'rescheduled'; the new one is confirmed. Emits booking.changed for the old and booking.confirmed for
 * the new, so reminders follow.
 */
export async function rescheduleBooking(
  tenantId: string,
  bookingId: string,
  newSlot: SlotChoice,
  deps: BookingDeps = defaults(),
): Promise<Booking> {
  const s = SlotChoice.parse(newSlot);
  const { data, error } = await deps.db.rpc("reschedule_booking", {
    p_tenant_id: Id.parse(tenantId),
    p_booking_id: Id.parse(bookingId),
    p_start: s.start.toISOString(),
    p_end: s.end.toISOString(),
    p_resource_id: s.resourceId ?? null,
  });
  if (error) throw bookingError(error, "reschedule_booking");
  const booking = toBooking(data);
  await announce(deps, {
    id: `booking.changed:${bookingId}:rescheduled`,
    name: "booking.changed",
    data: { tenantId: booking.tenantId, bookingId, change: "rescheduled" },
  });
  await announce(deps, {
    id: `booking.confirmed:${booking.id}`,
    name: "booking.confirmed",
    data: { tenantId: booking.tenantId, bookingId: booking.id },
  });
  return booking;
}

/** Cancels a held or confirmed booking and emits booking.changed. Safe to repeat. */
export async function cancelBooking(tenantId: string, bookingId: string, reason?: string, deps: BookingDeps = defaults()): Promise<void> {
  const { data, error } = await deps.db.rpc("cancel_booking", {
    p_tenant_id: Id.parse(tenantId),
    p_booking_id: Id.parse(bookingId),
    p_reason: reason ?? null,
  });
  if (error) throw bookingError(error, "cancel_booking");
  const booking = toBooking(data);
  await announce(deps, {
    id: `booking.changed:${booking.id}:cancelled`,
    name: "booking.changed",
    data: { tenantId: booking.tenantId, bookingId: booking.id, change: "cancelled" },
  });
}

/** The release-holds job: marks every hold past its expiry 'expired'. Returns how many. */
export async function releaseExpiredHolds(deps: Pick<BookingDeps, "db"> = defaults()): Promise<number> {
  const { data, error } = await deps.db.rpc("release_expired_holds");
  if (error) throw new Error(`release_expired_holds failed: ${error.message}`);
  return z.number().int().parse(data);
}
