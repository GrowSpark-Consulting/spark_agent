import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { serverEnv } from "../lib/env";
import { supabaseAdmin } from "../lib/supabase-admin";
import { getGoogleAccessToken } from "./google-calendar";
import type { BusyTime } from "./slots";

// Bookings on the staff member's Google Calendar, and their Google busy times in slot search (9-day plan, Day 4: "Google
// event creation, update and free/busy"). Only for a resource with a connected calendar (google_calendar_connections,
// status connected); everyone else is unaffected and the bookings table stays the source of truth. A confirmed booking
// gets an event; a cancelled or moved one loses it (a reschedule confirms a new booking, which gets its own event).
// Each booking's event id is fixed (googleEventId), so a retried step finds its event instead of adding a second one.

const API = "https://www.googleapis.com/calendar/v3";
const FETCH_TIMEOUT_MS = 10_000;

export interface GoogleSyncDeps {
  db: SupabaseClient;
  fetch: typeof fetch;
  /** The dashboard's address, for the link in the event. */
  appUrl: string;
  /** A fresh access token for the resource's calendar, or null when it has no working connection. */
  accessToken: (tenantId: string, resourceId: string) => Promise<string | null>;
}

const defaults = (): GoogleSyncDeps => ({
  db: supabaseAdmin(),
  fetch: globalThis.fetch,
  appUrl: serverEnv().NEXT_PUBLIC_APP_URL,
  accessToken: (tenantId, resourceId) => getGoogleAccessToken(tenantId, resourceId),
});

/** Google's id for a booking's event: lowercase base32hex (0-9, a-v), so the booking's hex digits work as they are. */
export const googleEventId = (bookingId: string) => `pk${bookingId.replace(/-/g, "").toLowerCase()}`;

const ConnectionRow = z.object({ resource_id: z.guid(), calendar_id: z.string(), status: z.string() });

/** The resources' connected calendars, read for this business only. */
async function connectedCalendars(tenantId: string, resourceIds: string[], db: SupabaseClient) {
  if (resourceIds.length === 0) return [];
  const { data, error } = await db
    .from("google_calendar_connections")
    .select("resource_id, calendar_id, status")
    .eq("tenant_id", tenantId)
    .in("resource_id", resourceIds)
    .eq("status", "connected");
  if (error) throw new Error(`google sync: connection read failed: ${error.message}`);
  return z.array(ConnectionRow).parse(data ?? []);
}

/** One call to the Calendar API with a timeout. The token goes in the header only and is never logged. */
async function callGoogle(deps: GoogleSyncDeps, token: string, method: string, path: string, body?: unknown) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await deps.fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined && { "Content-Type": "application/json" }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

const BookingRow = z.object({
  id: z.guid(),
  status: z.string(),
  start_at: z.string(),
  end_at: z.string(),
  resource_id: z.guid().nullable(),
  calendar_event_id: z.string().nullable(),
  services: z.object({ name: z.string() }).nullable(),
  leads: z.object({ contacts: z.object({ name: z.string().nullable() }).nullable() }).nullable(),
});

async function loadBooking(tenantId: string, bookingId: string, db: SupabaseClient) {
  const { data, error } = await db
    .from("bookings")
    .select("id, status, start_at, end_at, resource_id, calendar_event_id, services(name), leads(contacts(name))")
    .eq("tenant_id", tenantId)
    .eq("id", bookingId)
    .limit(1);
  if (error) throw new Error(`google sync: booking read failed: ${error.message}`);
  return z.array(BookingRow).max(1).parse(data ?? [])[0] ?? null;
}

export type AddResult = "created" | "already_there" | "not_confirmed" | "no_calendar";

/** Puts a confirmed booking on its resource's Google Calendar and keeps the event id on the booking. */
export async function addBookingToGoogle(tenantId: string, bookingId: string, deps: GoogleSyncDeps = defaults()): Promise<AddResult> {
  const booking = await loadBooking(tenantId, bookingId, deps.db);
  if (!booking || booking.status !== "confirmed") return "not_confirmed";
  if (!booking.resource_id) return "no_calendar";
  const [calendar] = await connectedCalendars(tenantId, [booking.resource_id], deps.db);
  if (!calendar) return "no_calendar";
  const token = await deps.accessToken(tenantId, booking.resource_id);
  if (!token) return "no_calendar";

  const what = booking.services?.name ?? "Booking";
  const who = booking.leads?.contacts?.name?.trim();
  const eventId = googleEventId(booking.id);
  const res = await callGoogle(deps, token, "POST", `/calendars/${encodeURIComponent(calendar.calendar_id)}/events`, {
    id: eventId,
    summary: who ? `${what}: ${who}` : what,
    description: `Booked through Pakka Agent. Details: ${deps.appUrl.replace(/\/$/, "")}/dashboard/calendar`,
    start: { dateTime: new Date(booking.start_at).toISOString() },
    end: { dateTime: new Date(booking.end_at).toISOString() },
  });
  // 409: an earlier try already made it (the id is the booking's).
  if (res.status !== 200 && res.status !== 201 && res.status !== 409) throw new Error(`google sync: adding the event failed (${res.status})`);

  const saved = await deps.db.from("bookings").update({ calendar_event_id: eventId }).eq("tenant_id", tenantId).eq("id", booking.id);
  if (saved.error) throw new Error(`google sync: saving the event id failed: ${saved.error.message}`);
  return res.status === 409 ? "already_there" : "created";
}

export type RemoveResult = "removed" | "already_gone" | "no_event" | "no_calendar";

/** Takes a cancelled or moved booking's event off its resource's Google Calendar. */
export async function removeBookingFromGoogle(tenantId: string, bookingId: string, deps: GoogleSyncDeps = defaults()): Promise<RemoveResult> {
  const booking = await loadBooking(tenantId, bookingId, deps.db);
  if (!booking?.calendar_event_id || !booking.resource_id) return "no_event";
  const [calendar] = await connectedCalendars(tenantId, [booking.resource_id], deps.db);
  if (!calendar) return "no_calendar";
  const token = await deps.accessToken(tenantId, booking.resource_id);
  if (!token) return "no_calendar";

  const path = `/calendars/${encodeURIComponent(calendar.calendar_id)}/events/${encodeURIComponent(booking.calendar_event_id)}`;
  const res = await callGoogle(deps, token, "DELETE", path);
  if (res.status === 404 || res.status === 410) return "already_gone";
  if (res.status !== 200 && res.status !== 204) throw new Error(`google sync: removing the event failed (${res.status})`);
  return "removed";
}

const FreeBusyBody = z.object({
  calendars: z.record(z.string(), z.object({ busy: z.array(z.object({ start: z.string(), end: z.string() })).default([]) })),
});

/**
 * Google busy times for the resources that have a connected calendar, for slot search. A calendar that can't be read
 * (no token, Google down) is skipped and logged: slot search never fails because of Google.
 */
export async function googleBusyTimes(
  tenantId: string,
  resourceIds: string[],
  from: Date,
  to: Date,
  deps: GoogleSyncDeps = defaults(),
): Promise<BusyTime[]> {
  const calendars = await connectedCalendars(tenantId, resourceIds, deps.db);
  const busy = await Promise.all(
    calendars.map(async (calendar): Promise<BusyTime[]> => {
      try {
        const token = await deps.accessToken(tenantId, calendar.resource_id);
        if (!token) return [];
        const res = await callGoogle(deps, token, "POST", "/freeBusy", {
          timeMin: from.toISOString(),
          timeMax: to.toISOString(),
          items: [{ id: calendar.calendar_id }],
        });
        if (res.status !== 200) throw new Error(`free/busy answered ${res.status}`);
        const periods = FreeBusyBody.parse(res.json).calendars[calendar.calendar_id]?.busy ?? [];
        return periods.map((p) => ({ resourceId: calendar.resource_id, start: new Date(p.start), end: new Date(p.end) }));
      } catch (e) {
        console.error(`[google] busy times skipped for resource ${calendar.resource_id}: ${e instanceof Error ? e.message : "unknown error"}`);
        return [];
      }
    }),
  );
  return busy.flat();
}
