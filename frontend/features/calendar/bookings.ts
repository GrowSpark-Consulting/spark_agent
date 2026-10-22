import { z } from "zod";
import { maskPhoneForDisplay, Timestamp } from "@/features/inbox/data";

// Bookings as the dashboard shows them (calendar and lead timeline). Rows are read under RLS; the booking
// engine (Dev 2, backend/src/booking, migration 0015) is the only writer, and its statuses and kinds are
// used as they are, never extended here. Nothing in this file decides availability or changes a booking.

/** bookings_status_check after 0015. */
export const BOOKING_STATUSES = ["held", "confirmed", "rescheduled", "cancelled", "completed", "no_show", "expired"] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** bookings.kind (0002). slot, site_visit and field_visit always have a resource; the others may not. */
export const BOOKING_KINDS = ["slot", "site_visit", "field_visit", "callback", "date_range", "reservation"] as const;
export type BookingKind = (typeof BOOKING_KINDS)[number];

const KIND_LABEL: Record<BookingKind, string> = {
  slot: "Appointment",
  site_visit: "Visit at a site",
  field_visit: "Visit at the customer’s place",
  callback: "Callback",
  date_range: "Date range",
  reservation: "Reservation",
};

export function kindLabel(kind: string): string {
  return (KIND_LABEL as Record<string, string>)[kind] ?? "Booking";
}

/**
 * What a booking is now. A hold past hold_expires_at no longer blocks the time (the engine's rule) even
 * before the database marks it expired (pg_cron, every minute), so it is shown as expired, never as an appointment.
 */
export type ShownStatus = BookingStatus | "unknown";

export function effectiveStatus(b: { status: string; holdExpiresAt: string | null }, now: Date): ShownStatus {
  if (!(BOOKING_STATUSES as readonly string[]).includes(b.status)) return "unknown";
  if (b.status === "held" && b.holdExpiresAt !== null && Date.parse(b.holdExpiresAt) <= now.getTime()) return "expired";
  return b.status as BookingStatus;
}

export const STATUS_LABEL: Record<ShownStatus, string> = {
  held: "Held",
  confirmed: "Confirmed",
  rescheduled: "Moved",
  cancelled: "Cancelled",
  completed: "Completed",
  no_show: "No-show",
  expired: "Hold expired",
  unknown: "Unknown status",
};

/** Bookings that take up time: shown on the calendar by default. */
export function isActive(status: ShownStatus): boolean {
  return status === "confirmed" || status === "held" || status === "completed" || status === "no_show";
}

/** Booking blocks in the prototype's legend (features/calendar/pakka-calendar.tsx, STY). */
export const STATUS_STYLE: Record<ShownStatus, { bg: string; fg: string; border: string; strike: boolean }> = {
  confirmed: { bg: "var(--color-surface)", fg: "var(--color-text)", border: "2px solid var(--color-text)", strike: false },
  held: { bg: "var(--color-accent-100)", fg: "var(--color-accent-800)", border: "2px dashed var(--color-accent)", strike: false },
  completed: { bg: "var(--color-text)", fg: "var(--color-bg)", border: "2px solid var(--color-text)", strike: false },
  no_show: { bg: "var(--color-neutral-300)", fg: "var(--color-neutral-800)", border: "2px solid var(--color-neutral-300)", strike: true },
  cancelled: { bg: "var(--color-bg)", fg: "var(--color-neutral-700)", border: "2px dotted var(--color-neutral-400)", strike: true },
  expired: { bg: "var(--color-bg)", fg: "var(--color-neutral-700)", border: "2px dotted var(--color-neutral-400)", strike: true },
  rescheduled: { bg: "var(--color-bg)", fg: "var(--color-neutral-700)", border: "2px dotted var(--color-neutral-400)", strike: true },
  unknown: { bg: "var(--color-bg)", fg: "var(--color-neutral-700)", border: "2px dotted var(--color-neutral-400)", strike: false },
};

// Rows -------------------------------------------------------------------------------------------------

const Details = z.record(z.string(), z.unknown()).catch({});

export const BookingRow = z.object({
  id: z.guid(),
  tenant_id: z.guid(),
  lead_id: z.guid(),
  resource_id: z.guid().nullable(),
  service_id: z.guid().nullable(),
  kind: z.string(),
  status: z.string(),
  start_at: Timestamp,
  end_at: Timestamp,
  hold_expires_at: Timestamp.nullable(),
  details: Details,
  created_at: Timestamp,
  services: z.object({ name: z.string() }).nullable().optional(),
  resources: z.object({ name: z.string() }).nullable().optional(),
  leads: z
    .object({ contacts: z.object({ name: z.string().nullable(), phone: z.string() }).nullable() })
    .nullable()
    .optional(),
});
export type BookingRow = z.input<typeof BookingRow>;

export const BOOKING_COLUMNS =
  "id, tenant_id, lead_id, resource_id, service_id, kind, status, start_at, end_at, hold_expires_at, details, created_at, services (name), resources (name)";
/** The calendar also shows who the booking is for. */
export const CALENDAR_BOOKING_COLUMNS = `${BOOKING_COLUMNS}, leads (contacts (name, phone))`;

export interface Booking {
  id: string;
  leadId: string;
  resourceId: string | null;
  resourceName: string | null;
  serviceName: string | null;
  kind: string;
  /** As stored; see effectiveStatus for what to show. */
  status: string;
  start: string;
  end: string;
  holdExpiresAt: string | null;
  createdAt: string;
  /** details.rescheduled_from: this row replaced an earlier booking. */
  rescheduledFrom: string | null;
  cancelReason: string | null;
  customerName: string | null;
  phoneMasked: string | null;
}

export function toBooking(row: z.output<typeof BookingRow>): Booking {
  const contact = row.leads?.contacts ?? null;
  const text = (key: string) => (typeof row.details[key] === "string" ? (row.details[key] as string) : null);
  return {
    id: row.id,
    leadId: row.lead_id,
    resourceId: row.resource_id,
    resourceName: row.resources?.name ?? null,
    serviceName: row.services?.name ?? null,
    kind: row.kind,
    status: row.status,
    start: row.start_at,
    end: row.end_at,
    holdExpiresAt: row.hold_expires_at,
    createdAt: row.created_at,
    rescheduledFrom: text("rescheduled_from"),
    cancelReason: text("cancel_reason"),
    customerName: contact?.name?.trim() || null,
    phoneMasked: contact ? maskPhoneForDisplay(contact.phone) : null,
  };
}

/** A read whose rows didn't match the expected shape; shown as a generic error. */
export class BookingDataError extends Error {
  constructor(what: string) {
    super(`The ${what} data had an unexpected shape.`);
    this.name = "BookingDataError";
  }
}

export function parseBookings(data: unknown, tenantId: string): Booking[] {
  const parsed = z.array(BookingRow).safeParse(data ?? []);
  if (!parsed.success) throw new BookingDataError("booking");
  return parsed.data.filter((r) => r.tenant_id === tenantId).map(toBooking);
}

/** "Consultation with Asha", or "Callback" when there is no service and no one assigned. */
export function bookingTitle(b: Pick<Booking, "kind" | "serviceName" | "resourceName">): string {
  const what = b.serviceName ?? kindLabel(b.kind);
  return b.resourceName ? `${what} with ${b.resourceName}` : what;
}
