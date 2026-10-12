import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Interactive } from "../notify/interactive";
import { BOOKING_KINDS, type BookingKind } from "./bookings";
import { slotLabel } from "./time";

// The 24 h and 2 h booking reminders (docs/handover.md, jobs: booking-reminders). Each is timed from the booking's start
// (the event anchor), never a fixed clock time: start minus the business's offset (tenant_features.settings.offset_minutes
// of reminder_24h and reminder_2h), else the default. The job (inngest/booking-reminders.ts) waits for each time and
// sends through notify.send, which checks the toggle and plan, opt-out, the 24-hour window and credits.

export const REMINDERS = [
  { kind: "reminder_24h", defaultOffsetMinutes: 24 * 60 },
  { kind: "reminder_2h", defaultOffsetMinutes: 2 * 60 },
] as const;
export type ReminderKind = (typeof REMINDERS)[number]["kind"];

/** A business's offset: whole minutes before the start, at most a week. Anything else falls back to the default. */
export const OffsetSettings = z.object({ offset_minutes: z.number().int().min(1).max(7 * 24 * 60) });

/** Minutes before the start for each reminder, as this business set them. */
export async function reminderOffsets(tenantId: string, db: SupabaseClient): Promise<Record<ReminderKind, number>> {
  const { data, error } = await db
    .from("tenant_features")
    .select("feature_key, settings")
    .eq("tenant_id", tenantId)
    .in(
      "feature_key",
      REMINDERS.map((r) => r.kind),
    );
  if (error) throw new Error(`reminder offsets: read failed: ${error.message}`);
  const rows = z.array(z.object({ feature_key: z.string(), settings: z.unknown() })).parse(data ?? []);
  const offsets = {} as Record<ReminderKind, number>;
  for (const reminder of REMINDERS) {
    const set = OffsetSettings.safeParse(rows.find((row) => row.feature_key === reminder.kind)?.settings);
    offsets[reminder.kind] = set.success ? set.data.offset_minutes : reminder.defaultOffsetMinutes;
  }
  return offsets;
}

/** What the reminder and post-visit jobs need about one booking, read for this business only. */
export interface ReminderBooking {
  bookingId: string;
  status: string;
  /** ISO 8601 UTC. */
  start: string;
  /** ISO 8601 UTC. */
  end: string;
  leadId: string;
  /** The booked resource's staff member (resources.user_id), if it has one. */
  staffUserId: string | null;
  /** The service's name, else the kind of booking in words. */
  what: string;
  business: string;
  timeZone: string;
  /** The customer's open chat, where the reminder goes; null if there is none. */
  conversationId: string | null;
}

const BookingRow = z.object({
  id: z.guid(),
  status: z.string(),
  start_at: z.string(),
  end_at: z.string(),
  kind: z.enum(BOOKING_KINDS),
  lead_id: z.guid(),
  leads: z.object({ contact_id: z.guid() }).nullable(),
  services: z.object({ name: z.string() }).nullable(),
  resources: z.object({ user_id: z.string().nullable() }).nullable(),
});
const TenantRow = z.object({ name: z.string(), timezone: z.string() });

const KIND_WORDS: Record<BookingKind, string> = {
  slot: "appointment",
  site_visit: "site visit",
  field_visit: "visit",
  callback: "call",
  date_range: "booking",
  reservation: "reservation",
};

/** The booking with its chat, names and time zone, or null when this business has no such booking. */
export async function loadReminderBooking(tenantId: string, bookingId: string, db: SupabaseClient): Promise<ReminderBooking | null> {
  const bookingRead = await db
    .from("bookings")
    .select("id, status, start_at, end_at, kind, lead_id, leads(contact_id), services(name), resources(user_id)")
    .eq("tenant_id", tenantId)
    .eq("id", bookingId)
    .limit(1);
  if (bookingRead.error) throw new Error(`reminder: booking read failed: ${bookingRead.error.message}`);
  const [booking] = z.array(BookingRow).max(1).parse(bookingRead.data ?? []);
  if (!booking) return null;

  const tenantRead = await db.from("tenants").select("name, timezone").eq("id", tenantId).limit(1);
  if (tenantRead.error) throw new Error(`reminder: business read failed: ${tenantRead.error.message}`);
  const [tenant] = z.array(TenantRow).max(1).parse(tenantRead.data ?? []);
  if (!tenant) return null;

  let conversationId: string | null = null;
  if (booking.leads) {
    const chatRead = await db
      .from("conversations")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("contact_id", booking.leads.contact_id)
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(1);
    if (chatRead.error) throw new Error(`reminder: conversation read failed: ${chatRead.error.message}`);
    conversationId = z.array(z.object({ id: z.guid() })).max(1).parse(chatRead.data ?? [])[0]?.id ?? null;
  }

  return {
    bookingId: booking.id,
    status: booking.status,
    start: new Date(booking.start_at).toISOString(),
    end: new Date(booking.end_at).toISOString(),
    leadId: booking.lead_id,
    staffUserId: booking.resources?.user_id ?? null,
    what: booking.services?.name ?? KIND_WORDS[booking.kind],
    business: tenant.name,
    timeZone: tenant.timezone,
    conversationId,
  };
}

/** A template variable: one line (Meta 132018 refuses line breaks, tabs and runs of spaces), cut to `max` characters. */
export const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export const BOOKING_BUTTON_ACTIONS = ["confirm", "reschedule", "cancel"] as const;
export type BookingButtonAction = (typeof BOOKING_BUTTON_ACTIONS)[number];

const BUTTON_TITLES: Record<BookingButtonAction, string> = { confirm: "Confirm", reschedule: "Reschedule", cancel: "Cancel" };

/**
 * The reminder: Confirm / Reschedule / Cancel buttons inside the 24-hour window, or the approved reminder template
 * outside it, whose variables are {{1}} what, {{2}} the business, {{3}} the local date and time ("Fri 9 Oct, 5:00 pm").
 */
export function reminderMessage(booking: ReminderBooking): { interactive: Interactive; templateParams: string[] } {
  const what = oneLine(booking.what, 40);
  const business = oneLine(booking.business, 40);
  const when = slotLabel(new Date(booking.start), booking.timeZone);
  return {
    interactive: {
      type: "buttons",
      body: `Reminder: your ${what} with ${business} is on ${when}.`,
      buttons: BOOKING_BUTTON_ACTIONS.map((action) => ({ id: `booking:${booking.bookingId}:${action}`, title: BUTTON_TITLES[action] })),
    },
    templateParams: [what, business, when],
  };
}

const BookingButton = /^booking:([0-9a-f-]{36}):(confirm|reschedule|cancel)$/i;

/** A tap on a reminder button (the inbound message's buttonId), or null for any other id. */
export function parseBookingButton(buttonId: string): { bookingId: string; action: BookingButtonAction } | null {
  const match = BookingButton.exec(buttonId);
  if (!match || !z.guid().safeParse(match[1]).success) return null;
  return { bookingId: match[1].toLowerCase(), action: match[2].toLowerCase() as BookingButtonAction };
}
