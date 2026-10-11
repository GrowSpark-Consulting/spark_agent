import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { maskPhone } from "../channels/whatsapp/phone";
import { oneLine } from "./reminders";
import { localParts, localWindow, slotLabel } from "./time";

// The daily agenda (docs/handover.md, jobs: daily-agenda, "cron, 8 am tenant time: day's bookings to the owner"; a
// Growth and Pro feature, checked by the daily_agenda toggle). The job (inngest/daily-agenda.ts) runs every 15 minutes
// and sends each business its agenda in the quarter hour after 8:00 in the business's own time zone.

export const AGENDA_MINUTE = 8 * 60;
const QUARTER = 15;

export interface AgendaTenant {
  id: string;
  name: string;
  timeZone: string;
}

/** Live businesses (trial or active), with their time zones. */
export async function liveTenants(db: SupabaseClient): Promise<AgendaTenant[]> {
  const { data, error } = await db.from("tenants").select("id, name, timezone").in("status", ["trial", "active"]);
  if (error) throw new Error(`daily agenda: businesses read failed: ${error.message}`);
  return z
    .array(z.object({ id: z.guid(), name: z.string(), timezone: z.string() }))
    .parse(data ?? [])
    .map((t) => ({ id: t.id, name: t.name, timeZone: t.timezone }));
}

/** Whether it is the quarter hour after 8:00 in this time zone (a bad time zone is never due). */
export function isAgendaTime(timeZone: string, now: Date): boolean {
  try {
    const minute = localParts(now, timeZone).minuteOfDay;
    return minute >= AGENDA_MINUTE && minute < AGENDA_MINUTE + QUARTER;
  } catch {
    return false;
  }
}

export interface AgendaItem {
  /** "10:00 am" in the business's time zone. */
  time: string;
  what: string;
  /** The customer's name, or their masked number. */
  who: string;
  /** The person doing it, if any. */
  staff: string | null;
}

const BookingRow = z.object({
  start_at: z.string(),
  services: z.object({ name: z.string() }).nullable(),
  resources: z.object({ name: z.string() }).nullable(),
  leads: z.object({ contacts: z.object({ name: z.string().nullable(), phone: z.string() }).nullable() }).nullable(),
});

/** Today's confirmed bookings in the business's time zone, earliest first. Also returns today's local date. */
export async function todaysBookings(tenant: AgendaTenant, now: Date, db: SupabaseClient): Promise<{ date: string; items: AgendaItem[] }> {
  const { date, from, to } = localWindow(tenant.timeZone, { day: "today" }, now);
  const { data, error } = await db
    .from("bookings")
    .select("start_at, services(name), resources(name), leads(contacts(name, phone))")
    .eq("tenant_id", tenant.id)
    .eq("status", "confirmed")
    .gte("start_at", from.toISOString())
    .lt("start_at", to.toISOString())
    .order("start_at", { ascending: true });
  if (error) throw new Error(`daily agenda: bookings read failed: ${error.message}`);
  const items = z
    .array(BookingRow)
    .parse(data ?? [])
    .map((b) => {
      const contact = b.leads?.contacts;
      return {
        time: slotLabel(new Date(b.start_at), tenant.timeZone).split(", ").pop() ?? "",
        what: oneLine(b.services?.name ?? "Booking", 40),
        who: contact?.name?.trim() ? oneLine(contact.name, 30) : contact ? maskPhone(contact.phone) : "a customer",
        staff: b.resources?.name ? oneLine(b.resources.name, 30) : null,
      };
    });
  return { date, items };
}

const line = (item: AgendaItem) => `${item.time}, ${item.what} with ${item.who}${item.staff ? ` (${item.staff})` : ""}`;

/**
 * The agenda: every booking as a line inside the window, or the daily_agenda template outside it ({{1}} how many,
 * {{2}} the first one, {{3}} the calendar link).
 */
export function agendaMessage(business: string, items: AgendaItem[], appUrl: string): { text: string; templateParams: string[] } {
  const count = `${items.length} booking${items.length === 1 ? "" : "s"}`;
  const link = `${appUrl.replace(/\/$/, "")}/dashboard/calendar`;
  const text = [`Good morning! Today at ${oneLine(business, 40)}: ${count}.`, ...items.map((i) => `• ${line(i)}`), `Calendar: ${link}`].join("\n");
  return { text, templateParams: [count, items[0] ? line(items[0]) : "none", link] };
}
