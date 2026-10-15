import { DashboardSummary, type TenantContext } from "@pakka/types";
import { describe, expect, it } from "vitest";
import { fakeDb } from "../test-support/fake-db";
import { dashboardSummary } from "./summary";

const TENANT = "6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e";
const STAFF = "0f1e2d3c-4b5a-4697-8877-665544332211";
const OTHER = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
// Monday 12 Oct 2026, 10:30 am in Chennai.
const NOW = new Date("2026-10-12T05:00:00Z");
const HOURS = Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [{ start: "09:30", end: "19:00" }]]));

const context = (role: TenantContext["role"] = "owner"): TenantContext => ({
  user: { id: role === "staff" ? STAFF : OTHER, email: null },
  role,
  tenant: { id: TENANT, name: "Skyline Homes", vertical: "real-estate", timezone: "Asia/Kolkata", status: "active", planKey: "growth", trialEndsAt: null },
});

function deps(over: { hours?: unknown; lastMonth?: number } = {}) {
  const db = fakeDb({
    tenants: { data: { business_hours: over.hours ?? HOURS }, error: null },
    leads: [
      // Hot leads (asked first), then this month's leads, then last month's count.
      {
        data: [
          { id: "lead-1", score: 88, temperature: "hot", fields: { location: "Velachery", config: "2BHK", budget: "60L", decision_maker: true }, contact_id: "contact-1", owner_user_id: STAFF, contacts: { name: "Asha  Raman", phone: "+919840012345" } },
          { id: "lead-2", score: 75, temperature: "hot", fields: {}, contact_id: "contact-2", owner_user_id: null, contacts: { name: null, phone: "+919840054321" } },
        ],
        error: null,
      },
      {
        data: [
          { created_at: "2026-10-05T05:00:00Z", stage: "qualified" }, // Mon 10:30 am: inside hours
          { created_at: "2026-10-05T16:00:00Z", stage: "booked" }, // Mon 9:30 pm: after hours
          { created_at: "2026-10-11T22:00:00Z", stage: "new" }, // Mon 3:30 am: after hours
        ],
        error: null,
      },
      { data: null, error: null, count: over.lastMonth ?? 2 },
    ],
    bookings: [
      { data: null, error: null, count: 4 },
      {
        data: [
          { id: "b-1", start_at: "2026-10-12T05:30:00+00:00", status: "confirmed", hold_expires_at: null, details: {}, services: { name: "Site visit" }, resources: { name: "Asha (sales)", user_id: STAFF }, leads: { contacts: { name: "Priya", phone: "+919800000001" } } },
          { id: "b-2", start_at: "2026-10-12T07:00:00+00:00", status: "held", hold_expires_at: "2026-10-12T04:50:00+00:00", details: {}, services: { name: "Site visit" }, resources: { name: "Ravi", user_id: OTHER }, leads: { contacts: { name: "Old hold", phone: "+919800000002" } } },
          { id: "b-3", start_at: "2026-10-12T09:00:00+00:00", status: "held", hold_expires_at: "2026-10-12T05:05:00+00:00", details: { place: "Skyline Towers" }, services: { name: "Site visit" }, resources: { name: "Ravi", user_id: OTHER }, leads: { contacts: { name: "Call 98000 00003 now", phone: "+919800000003" } } },
        ],
        error: null,
      },
    ],
    messages: { data: [{ conversation_id: "c-1" }, { conversation_id: "c-1" }, { conversation_id: "c-2" }], error: null },
    conversations: {
      data: [
        { id: "chat-1-old", contact_id: "contact-1", last_customer_msg_at: "2026-10-01T05:00:00Z", last_message_at: "2026-10-01T05:00:00Z" },
        { id: "chat-1", contact_id: "contact-1", last_customer_msg_at: "2026-10-12T04:40:00+00:00", last_message_at: "2026-10-12T04:41:00+00:00" },
        { id: "chat-2", contact_id: "contact-2", last_customer_msg_at: "2026-10-11T10:00:00+00:00", last_message_at: "2026-10-11T10:00:00+00:00" },
      ],
      error: null,
    },
    handoffs: { data: [{ conversation_id: "chat-1", trigger: "negotiation" }], error: null },
  });
  return { d: { db: db.client, now: () => NOW }, calls: db.calls };
}

describe("GET /api/dashboard/summary", () => {
  it("counts the business's month in its own time zone", async () => {
    const { d, calls } = deps();
    const summary = DashboardSummary.parse(await dashboardSummary(context(), d));
    expect(summary.month).toBe("2026-10");
    expect(summary.stats).toEqual({ enquiries: 3, qualified: 2, booked: 4, afterHours: 2, enquiriesChangePct: 50 });
    // The month starts at midnight in Chennai (18:30 UTC the day before), and last month is compared over the same 11.4 days.
    expect(calls).toContainEqual({ table: "leads", method: "gte", args: ["created_at", "2026-09-30T18:30:00.000Z"] });
    expect(calls).toContainEqual({ table: "leads", method: "gte", args: ["created_at", "2026-08-31T18:30:00.000Z"] });
    expect(calls).toContainEqual({ table: "leads", method: "lt", args: ["created_at", "2026-09-12T05:00:00.000Z"] });
    for (const table of ["tenants", "leads", "bookings", "messages", "conversations", "handoffs"]) {
      expect(calls.some((c) => c.table === table && c.method === "eq" && (c.args[0] === "tenant_id" || c.args[0] === "id") && c.args[1] === TENANT)).toBe(true);
    }
  });

  it("counts the chats the assistant answered last night, 8 pm to 8 am", async () => {
    const { d, calls } = deps();
    expect((await dashboardSummary(context(), d)).overnightHandled).toBe(2);
    expect(calls).toContainEqual({ table: "messages", method: "gte", args: ["created_at", "2026-10-11T14:30:00.000Z"] });
    expect(calls).toContainEqual({ table: "messages", method: "lt", args: ["created_at", "2026-10-12T02:30:00.000Z"] });
    expect(calls).toContainEqual({ table: "messages", method: "eq", args: ["sender", "ai"] });
  });

  it("lists hot leads with their newest chat, why they wait, and what they want", async () => {
    const { hotLeads } = await dashboardSummary(context(), deps().d);
    expect(hotLeads).toEqual([
      {
        leadId: "lead-1",
        conversationId: "chat-1",
        name: "Asha Raman",
        need: "Velachery, 2BHK, 60L",
        score: 88,
        temperature: "hot",
        reason: "Asked for a discount",
        waitingSince: "2026-10-12T04:40:00.000Z",
        assignedTo: STAFF,
      },
      { leadId: "lead-2", conversationId: "chat-2", name: expect.stringMatching(/^\+9198/), need: "", score: 75, temperature: "hot", reason: "Hot lead", waitingSince: null, assignedTo: null },
    ]);
  });

  it("lists today's bookings that stand, leaving out a hold that ran out; a saved name with a number shows the masked number", async () => {
    const { todayBookings } = await dashboardSummary(context(), deps().d);
    expect(todayBookings).toEqual([
      { bookingId: "b-1", startAt: "2026-10-12T05:30:00.000Z", name: "Priya", place: "Site visit", staff: "Asha (sales)", status: "confirmed" },
      { bookingId: "b-3", startAt: "2026-10-12T09:00:00.000Z", name: expect.stringMatching(/^\+9198/), place: "Skyline Towers", staff: "Ravi", status: "held" },
    ]);
  });

  it("gives staff their own hot leads and their own calendar's bookings", async () => {
    const { d, calls } = deps();
    const summary = await dashboardSummary(context("staff"), d);
    expect(calls).toContainEqual({ table: "leads", method: "eq", args: ["owner_user_id", STAFF] });
    expect(summary.todayBookings.map((b) => b.bookingId)).toEqual(["b-1"]);
    // The month's numbers are the business's, for everyone.
    expect(summary.stats.enquiries).toBe(3);
  });

  it("has no after-hours count without business hours, and no change without last month", async () => {
    const summary = await dashboardSummary(context(), deps({ hours: {}, lastMonth: 0 }).d);
    expect(summary.stats).toMatchObject({ afterHours: 0, enquiriesChangePct: null });
  });
});
