import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { BookingDataError, CALENDAR_BOOKING_COLUMNS, effectiveStatus, isActive, parseBookings, type Booking, type ShownStatus } from "./bookings";
import { addDays, localParts, weekStart, zonedTime } from "./time";

// The Day 3 calendar (docs/dashboard-screen-contracts.md, Calendar): bookings and resources read directly
// under RLS for a day or a week, laid out in the business's time zone. Nothing in this file writes: a booking
// is moved, cancelled or marked only through Dev 2's booking routes (booking-actions.ts), and the range is read again.

export type CalendarView = "day" | "week";
/** "all", one resource id, or "none" for bookings with no staff member (callbacks and the like). */
export type ResourceFilter = string;
export const NO_RESOURCE = "none";

/** A busy business can have this many bookings in a week; more says so instead of silently cutting. */
export const BOOKING_LIMIT = 1000;

export interface CalendarResource {
  id: string;
  name: string;
  type: string;
  active: boolean;
  /** resources.user_id: the staff member whose calendar this is, when it is one person's. Decides which bookings staff may change. */
  userId?: string | null;
}

export interface CalendarRange {
  /** Calendar dates shown, in the business's zone. */
  days: string[];
  from: Date;
  to: Date;
}

export function rangeFor(view: CalendarView, date: string, timeZone: string): CalendarRange {
  const first = view === "day" ? date : weekStart(date);
  const days = Array.from({ length: view === "day" ? 1 : 7 }, (_, i) => addDays(first, i));
  return { days, from: zonedTime(days[0], 0, timeZone), to: zonedTime(addDays(days[days.length - 1], 1), 0, timeZone) };
}

// Reads -------------------------------------------------------------------------------------------------

const ResourceRow = z.object({ id: z.guid(), tenant_id: z.guid(), name: z.string(), type: z.string(), active: z.boolean(), user_id: z.guid().nullable().optional() });

export async function fetchResources(client: SupabaseClient, tenantId: string): Promise<CalendarResource[]> {
  const { data, error } = await client.from("resources").select("id, tenant_id, user_id, name, type, active").eq("tenant_id", tenantId).order("name", { ascending: true });
  if (error) throw error;
  const parsed = z.array(ResourceRow).safeParse(data ?? []);
  if (!parsed.success) throw new BookingDataError("resource");
  return parsed.data
    .filter((r) => r.tenant_id === tenantId)
    .map(({ id, name, type, active, user_id }) => ({ id, name, type, active, userId: user_id ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.id.localeCompare(b.id));
}

/** Every booking that overlaps the range, whatever its status (the screen decides what to show). */
export async function fetchBookings(client: SupabaseClient, tenantId: string, range: Pick<CalendarRange, "from" | "to">): Promise<{ bookings: Booking[]; truncated: boolean }> {
  const { data, error } = await client
    .from("bookings")
    .select(CALENDAR_BOOKING_COLUMNS)
    .eq("tenant_id", tenantId)
    .lt("start_at", range.to.toISOString())
    .gt("end_at", range.from.toISOString())
    .order("start_at", { ascending: true })
    .limit(BOOKING_LIMIT);
  if (error) throw error;
  const bookings = parseBookings(data, tenantId);
  return { bookings, truncated: bookings.length >= BOOKING_LIMIT };
}

// What is shown -----------------------------------------------------------------------------------------

export interface ShownBooking extends Booking {
  shown: ShownStatus;
}

/**
 * The bookings to draw: confirmed, live holds, completed and no-shows; cancelled, expired (including
 * lapsed holds) and moved ones only when asked for. Then the resource filter.
 */
export function visibleBookings(bookings: Booking[], opts: { now: Date; showInactive: boolean; resource: ResourceFilter }): ShownBooking[] {
  return bookings
    .map((b) => ({ ...b, shown: effectiveStatus(b, opts.now) }))
    .filter((b) => opts.showInactive || isActive(b.shown))
    .filter((b) => opts.resource === "all" || (opts.resource === NO_RESOURCE ? b.resourceId === null : b.resourceId === opts.resource));
}

export interface Column {
  key: string;
  title: string;
  subtitle: string | null;
  /** The calendar date this column shows. */
  date: string;
  bookings: ShownBooking[];
}

/** Bookings that overlap a local calendar date. */
function onDate(b: Booking, date: string, timeZone: string): boolean {
  return Date.parse(b.start) < zonedTime(addDays(date, 1), 0, timeZone).getTime() && Date.parse(b.end) > zonedTime(date, 0, timeZone).getTime();
}

/**
 * Day view: one column per resource (all of them, or the one picked), plus "No staff assigned" when a
 * shown booking has no resource; a callback without a staff member is never put in someone's column.
 * Week view: one column per day.
 */
export function buildColumns(opts: {
  view: CalendarView;
  range: CalendarRange;
  resources: CalendarResource[];
  bookings: ShownBooking[];
  resource: ResourceFilter;
  timeZone: string;
}): Column[] {
  const { view, range, resources, bookings, resource, timeZone } = opts;
  if (view === "week") {
    return range.days.map((date) => ({ key: date, title: date, subtitle: null, date, bookings: bookings.filter((b) => onDate(b, date, timeZone)) }));
  }
  const date = range.days[0];
  const today = bookings.filter((b) => onDate(b, date, timeZone));
  const known = new Set(resources.map((r) => r.id));
  const shownResources =
    resource === "all"
      ? // Inactive resources only when they still have a booking that day.
        resources.filter((r) => r.active || today.some((b) => b.resourceId === r.id))
      : resources.filter((r) => r.id === resource);
  const columns: Column[] = shownResources.map((r) => ({
    key: r.id,
    title: r.name,
    subtitle: r.active ? r.type : `${r.type} · off`,
    date,
    bookings: today.filter((b) => b.resourceId === r.id),
  }));
  const unassigned = today.filter((b) => b.resourceId === null || !known.has(b.resourceId));
  if ((resource === "all" || resource === NO_RESOURCE) && unassigned.length > 0) {
    columns.push({ key: NO_RESOURCE, title: "No staff assigned", subtitle: "Callbacks and other bookings", date, bookings: unassigned });
  }
  return columns;
}

// Layout ------------------------------------------------------------------------------------------------

export const DEFAULT_START_HOUR = 8;
export const DEFAULT_END_HOUR = 20;

/** The hours the grid shows: 8 am to 8 pm, widened to fit every shown booking (whole hours, 0–24). */
export function gridHours(bookings: Booking[], days: string[], timeZone: string): { start: number; end: number } {
  let start = DEFAULT_START_HOUR * 60;
  let end = DEFAULT_END_HOUR * 60;
  for (const b of bookings) {
    for (const date of days) {
      const span = minutesOnDate(b, date, timeZone);
      if (!span) continue;
      start = Math.min(start, span.start);
      end = Math.max(end, span.end);
    }
  }
  return { start: Math.floor(start / 60), end: Math.min(24, Math.ceil(end / 60)) };
}

/** Where a booking falls on a local date, in minutes from midnight, clipped to that day. */
export function minutesOnDate(b: Pick<Booking, "start" | "end">, date: string, timeZone: string): { start: number; end: number } | null {
  const dayStart = zonedTime(date, 0, timeZone).getTime();
  const dayEnd = zonedTime(addDays(date, 1), 0, timeZone).getTime();
  const s = Math.max(Date.parse(b.start), dayStart);
  const e = Math.min(Date.parse(b.end), dayEnd);
  if (e <= s) return null;
  // Minutes from midnight by the local clock (DST days may be 23 or 25 hours long).
  const startMin = localParts(new Date(s), timeZone).date === date ? localParts(new Date(s), timeZone).minutes : 0;
  const endMin = e >= dayEnd ? 24 * 60 : localParts(new Date(e), timeZone).minutes;
  return { start: startMin, end: Math.max(endMin, startMin + 1) };
}

export interface PlacedBooking {
  booking: ShownBooking;
  start: number;
  end: number;
  /** Side-by-side position among bookings that overlap it. */
  lane: number;
  lanes: number;
}

/**
 * Lays a column's bookings out: overlapping ones (the engine allows them for bookings without a
 * resource, and between resources in week view) sit side by side instead of hiding each other.
 */
export function placeBookings(bookings: ShownBooking[], date: string, timeZone: string): PlacedBooking[] {
  const items = bookings
    .map((booking) => ({ booking, span: minutesOnDate(booking, date, timeZone) }))
    .filter((x): x is { booking: ShownBooking; span: { start: number; end: number } } => x.span !== null)
    .sort((a, b) => a.span.start - b.span.start || b.span.end - a.span.end || a.booking.id.localeCompare(b.booking.id));

  const placed: PlacedBooking[] = [];
  let cluster: PlacedBooking[] = [];
  let clusterEnd = -1;
  const laneEnds: number[] = [];
  const closeCluster = () => {
    const lanes = Math.max(1, ...cluster.map((p) => p.lane + 1));
    for (const p of cluster) p.lanes = lanes;
    cluster = [];
    laneEnds.length = 0;
  };
  for (const { booking, span } of items) {
    if (span.start >= clusterEnd && cluster.length > 0) closeCluster();
    let lane = laneEnds.findIndex((end) => end <= span.start);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = span.end;
    const p: PlacedBooking = { booking, start: span.start, end: span.end, lane, lanes: 1 };
    cluster.push(p);
    placed.push(p);
    clusterEnd = Math.max(clusterEnd, span.end);
  }
  if (cluster.length > 0) closeCluster();
  return placed;
}

/** Agenda order: by start, then resource name. */
export function agendaOrder(bookings: ShownBooking[]): ShownBooking[] {
  return [...bookings].sort((a, b) => a.start.localeCompare(b.start) || (a.resourceName ?? "").localeCompare(b.resourceName ?? "") || a.id.localeCompare(b.id));
}

/** Counts for the subline: shown bookings, and live holds waiting for the customer. */
export function summarize(bookings: ShownBooking[]): { total: number; held: number } {
  return { total: bookings.filter((b) => isActive(b.shown)).length, held: bookings.filter((b) => b.shown === "held").length };
}
