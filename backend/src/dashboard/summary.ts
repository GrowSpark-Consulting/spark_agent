import type { DashboardSummary, TenantContext } from "@pakka/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { triggerText } from "../agent/leadcard/card";
import { WeeklyHours } from "../booking/slots";
import { addDays, localParts, zonedTime } from "../booking/time";
import { maskPhone } from "../channels/whatsapp/phone";
import { supabaseAdmin } from "../lib/supabase-admin";

// GET /api/dashboard/summary (docs/dashboard-screen-contracts.md, "Home"): the month's four numbers, the chats the
// assistant answered overnight, the hot leads waiting and today's bookings. Months, nights and days are the business's
// own (its time zone). Any member; staff get their own hot leads (leads.owner_user_id) and their own calendar's
// bookings (resources.user_id); the month's numbers are the business's.

export interface SummaryDeps {
  db: SupabaseClient;
  now: () => Date;
}

const defaults = (): SummaryDeps => ({ db: supabaseAdmin(), now: () => new Date() });

/** Stages a lead reaches once qualified. */
const QUALIFIED_OR_FURTHER = new Set(["qualified", "booked", "visited", "won"]);
/** Stages of a lead still in play. */
const OPEN_STAGES = ["new", "engaged", "qualified", "booked", "nurture", "human"];
/** Bookings that went ahead or stand; a moved booking's old row is "rescheduled" and its new one counts. */
const BOOKED_STATUSES = ["confirmed", "completed", "no_show"];
const HOT_LEADS_SHOWN = 5;
const MONTH_ROWS_MAX = 10_000;
const NIGHT_START_MIN = 20 * 60;
const NIGHT_END_MIN = 8 * 60;

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const Contact = z.object({ name: z.string().nullable(), phone: z.string() }).nullable().catch(null);
const one = <T>(value: T | T[] | null | undefined): T | null => (Array.isArray(value) ? (value[0] ?? null) : (value ?? null));

/** "Velachery, 2BHK, 60L": the lead's scalar answers in the order they were saved, at most three. */
function needOf(fields: unknown): string {
  if (typeof fields !== "object" || fields === null) return "";
  const values = Object.values(fields as Record<string, unknown>)
    .filter((v): v is string | number => (typeof v === "string" && v.trim() !== "") || typeof v === "number")
    .slice(0, 3)
    .map(String);
  return oneLine(values.join(", "), 80);
}

const nameOf = (contact: z.infer<typeof Contact>) => (contact?.name?.trim() ? oneLine(contact.name, 40) : contact ? maskPhone(contact.phone) : "A customer");

/** Whether an instant falls outside the business's hours. No hours set: nothing is after hours. */
function afterHours(instant: Date, hours: WeeklyHours, timeZone: string): boolean {
  if (Object.keys(hours).length === 0) return false;
  const { weekday, minuteOfDay } = localParts(instant, timeZone);
  const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  return !(hours[weekday] ?? []).some((i) => minutes(i.start) <= minuteOfDay && minuteOfDay < minutes(i.end));
}

function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

function check<T>(what: string, result: { data: T | null; error: { message: string } | null }): T | null {
  if (result.error) throw new Error(`dashboard summary: ${what} read failed: ${result.error.message}`);
  return result.data;
}

function counted(what: string, result: { count: number | null; error: { message: string } | null }): number {
  if (result.error) throw new Error(`dashboard summary: ${what} count failed: ${result.error.message}`);
  return result.count ?? 0;
}

const MonthLead = z.object({ created_at: z.string(), stage: z.string() });
const HotLead = z.object({
  id: z.string(),
  score: z.number().nullable(),
  temperature: z.string().nullable(),
  fields: z.unknown(),
  contact_id: z.string(),
  owner_user_id: z.string().nullable(),
  contacts: z.unknown(),
});
const Conversation = z.object({ id: z.string(), contact_id: z.string(), last_customer_msg_at: z.string().nullable(), last_message_at: z.string().nullable() });
const OpenHandoff = z.object({ conversation_id: z.string(), trigger: z.string() });
const TodayBooking = z.object({
  id: z.string(),
  start_at: z.string(),
  status: z.enum(["held", "confirmed"]),
  hold_expires_at: z.string().nullable(),
  details: z.record(z.string(), z.unknown()).catch({}),
  services: z.unknown(),
  resources: z.unknown(),
  leads: z.unknown(),
});
const Named = z.object({ name: z.string() }).nullable().catch(null);
const Resource = z.object({ name: z.string(), user_id: z.string().nullable() }).nullable().catch(null);

export async function dashboardSummary(context: TenantContext, deps: SummaryDeps = defaults()): Promise<DashboardSummary> {
  const { db } = deps;
  const tenantId = context.tenant.id;
  const timeZone = context.tenant.timezone;
  const now = deps.now();
  const mine = context.role === "staff" ? context.user.id : null;

  const today = localParts(now, timeZone).date;
  const month = today.slice(0, 7);
  const monthStart = zonedTime(`${month}-01`, 0, timeZone);
  const lastMonthStart = zonedTime(`${previousMonth(month)}-01`, 0, timeZone);
  // The same stretch of last month as has passed of this one, so a month-to-date count is compared fairly.
  const lastMonthSoFar = new Date(Math.min(lastMonthStart.getTime() + (now.getTime() - monthStart.getTime()), monthStart.getTime()));
  const nightFrom = zonedTime(addDays(today, -1), NIGHT_START_MIN, timeZone);
  const nightTo = new Date(Math.min(zonedTime(today, NIGHT_END_MIN, timeZone).getTime(), now.getTime()));
  const dayFrom = zonedTime(today, 0, timeZone);
  const dayTo = zonedTime(addDays(today, 1), 0, timeZone);

  let hotQuery = db
    .from("leads")
    .select("id, score, temperature, fields, contact_id, owner_user_id, contacts(name, phone)")
    .eq("tenant_id", tenantId)
    .eq("temperature", "hot")
    .in("stage", OPEN_STAGES);
  if (mine) hotQuery = hotQuery.eq("owner_user_id", mine);

  const [business, monthLeads, lastMonth, booked, night, hot, bookings] = await Promise.all([
    db.from("tenants").select("business_hours").eq("id", tenantId).maybeSingle(),
    db.from("leads").select("created_at, stage").eq("tenant_id", tenantId).gte("created_at", monthStart.toISOString()).limit(MONTH_ROWS_MAX),
    db
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .gte("created_at", lastMonthStart.toISOString())
      .lt("created_at", lastMonthSoFar.toISOString()),
    db
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .gte("created_at", monthStart.toISOString())
      .in("status", BOOKED_STATUSES),
    db
      .from("messages")
      .select("conversation_id")
      .eq("tenant_id", tenantId)
      .eq("sender", "ai")
      .gte("created_at", nightFrom.toISOString())
      .lt("created_at", nightTo.toISOString())
      .limit(MONTH_ROWS_MAX),
    hotQuery.order("score", { ascending: false }).limit(HOT_LEADS_SHOWN),
    db
      .from("bookings")
      .select("id, start_at, status, hold_expires_at, details, services(name), resources(name, user_id), leads(contacts(name, phone))")
      .eq("tenant_id", tenantId)
      .in("status", ["held", "confirmed"])
      .gte("start_at", dayFrom.toISOString())
      .lt("start_at", dayTo.toISOString())
      .order("start_at", { ascending: true })
      .limit(50),
  ]);

  const hours = WeeklyHours.safeParse((check("business", business) as { business_hours?: unknown } | null)?.business_hours);
  const leads = z.array(MonthLead).parse(check("month leads", monthLeads) ?? []);
  const lastMonthCount = counted("last month", lastMonth);
  const enquiries = leads.length;

  // The hot leads' chats (the newest per customer) and any handoff still open on them.
  const hotLeads = z.array(HotLead).parse(check("hot leads", hot) ?? []);
  const contactIds = [...new Set(hotLeads.map((l) => l.contact_id))];
  const chats = contactIds.length
    ? z
        .array(Conversation)
        .parse(
          check(
            "chats",
            await db.from("conversations").select("id, contact_id, last_customer_msg_at, last_message_at").eq("tenant_id", tenantId).in("contact_id", contactIds),
          ) ?? [],
        )
    : [];
  const newest = new Map<string, z.infer<typeof Conversation>>();
  for (const c of chats) {
    const kept = newest.get(c.contact_id);
    if (!kept || (c.last_message_at ?? "") > (kept.last_message_at ?? "")) newest.set(c.contact_id, c);
  }
  const chatIds = [...newest.values()].map((c) => c.id);
  const handoffs = chatIds.length
    ? z
        .array(OpenHandoff)
        .parse(check("handoffs", await db.from("handoffs").select("conversation_id, trigger").eq("tenant_id", tenantId).in("conversation_id", chatIds).is("resolved_at", null)) ?? [])
    : [];
  const openHandoff = new Map(handoffs.map((h) => [h.conversation_id, h.trigger]));

  return {
    month,
    stats: {
      enquiries,
      qualified: leads.filter((l) => QUALIFIED_OR_FURTHER.has(l.stage)).length,
      booked: counted("bookings", booked),
      afterHours: hours.success ? leads.filter((l) => afterHours(new Date(l.created_at), hours.data, timeZone)).length : 0,
      enquiriesChangePct: lastMonthCount > 0 ? Math.round(((enquiries - lastMonthCount) / lastMonthCount) * 1000) / 10 : null,
    },
    overnightHandled: new Set(z.array(z.object({ conversation_id: z.string() })).parse(check("overnight", night) ?? []).map((m) => m.conversation_id)).size,
    hotLeads: hotLeads.map((l) => {
      const chat = newest.get(l.contact_id) ?? null;
      const trigger = chat ? openHandoff.get(chat.id) : undefined;
      return {
        leadId: l.id,
        conversationId: chat?.id ?? null,
        name: nameOf(Contact.parse(one(l.contacts as never))),
        need: needOf(l.fields),
        score: l.score,
        temperature: "hot" as const,
        reason: trigger ? (triggerText(trigger) ?? "Hot lead") : "Hot lead",
        waitingSince: trigger && chat?.last_customer_msg_at ? new Date(chat.last_customer_msg_at).toISOString() : null,
        assignedTo: l.owner_user_id,
      };
    }),
    todayBookings: z
      .array(TodayBooking)
      .parse(check("today's bookings", bookings) ?? [])
      .filter((b) => b.status === "confirmed" || (b.hold_expires_at !== null && Date.parse(b.hold_expires_at) > now.getTime()))
      .map((b) => ({ booking: b, resource: Resource.parse(one(b.resources as never)) }))
      .filter(({ resource }) => !mine || resource?.user_id === mine)
      .map(({ booking: b, resource }) => {
        const place = typeof b.details.place === "string" && b.details.place.trim() ? b.details.place : (Named.parse(one(b.services as never))?.name ?? "Booking");
        const lead = one(b.leads as never) as { contacts?: unknown } | null;
        return {
          bookingId: b.id,
          startAt: new Date(b.start_at).toISOString(),
          name: nameOf(Contact.parse(one((lead?.contacts ?? null) as never))),
          place: oneLine(place, 60),
          staff: resource?.name ? oneLine(resource.name, 40) : "",
          status: b.status,
        };
      }),
  };
}
