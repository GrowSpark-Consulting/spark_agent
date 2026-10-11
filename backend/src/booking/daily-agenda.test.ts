import { describe, expect, it } from "vitest";
import { fakeDb } from "../test-support/fake-db";
import { agendaMessage, isAgendaTime, liveTenants, todaysBookings } from "./daily-agenda";

const TENANT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const tenant = { id: TENANT, name: "Skyline Homes", timeZone: "Asia/Kolkata" };

describe("isAgendaTime", () => {
  it("is the quarter hour after 8:00 in the business's time zone", () => {
    // 8:00 in India is 02:30 UTC.
    expect(isAgendaTime("Asia/Kolkata", new Date("2026-10-10T02:30:00Z"))).toBe(true);
    expect(isAgendaTime("Asia/Kolkata", new Date("2026-10-10T02:44:59Z"))).toBe(true);
    expect(isAgendaTime("Asia/Kolkata", new Date("2026-10-10T02:45:00Z"))).toBe(false);
    expect(isAgendaTime("Asia/Kolkata", new Date("2026-10-10T02:29:59Z"))).toBe(false);
    expect(isAgendaTime("Europe/London", new Date("2026-10-10T07:05:00Z"))).toBe(true); // 8:05 summer time
    expect(isAgendaTime("Not/AZone", new Date("2026-10-10T02:30:00Z"))).toBe(false);
  });
});

describe("liveTenants", () => {
  it("lists businesses in trial or active, with their time zones", async () => {
    const db = fakeDb({ tenants: { data: [{ id: TENANT, name: "Skyline Homes", timezone: "Asia/Kolkata" }], error: null } });
    await expect(liveTenants(db.client)).resolves.toEqual([tenant]);
    expect(db.calls).toContainEqual({ table: "tenants", method: "in", args: ["status", ["trial", "active"]] });
  });
});

describe("todaysBookings", () => {
  it("reads today's confirmed bookings in the business's day, for this business, earliest first", async () => {
    const db = fakeDb({
      bookings: {
        data: [
          { start_at: "2026-10-10T04:30:00+00:00", services: { name: "Site visit" }, resources: { name: "Priya" }, leads: { contacts: { name: "Asha", phone: "+919840012345" } } },
          { start_at: "2026-10-10T09:00:00+00:00", services: null, resources: null, leads: { contacts: { name: null, phone: "+919840012345" } } },
        ],
        error: null,
      },
    });
    await expect(todaysBookings(tenant, new Date("2026-10-10T02:30:00Z"), db.client)).resolves.toEqual({
      date: "2026-10-10",
      items: [
        { time: "10:00 am", what: "Site visit", who: "Asha", staff: "Priya" },
        { time: "2:30 pm", what: "Booking", who: "+9198xxxxxx45", staff: null },
      ],
    });
    expect(db.calls).toContainEqual({ table: "bookings", method: "eq", args: ["tenant_id", TENANT] });
    expect(db.calls).toContainEqual({ table: "bookings", method: "eq", args: ["status", "confirmed"] });
    // The business's day: 00:00 to 24:00 in India is 18:30 UTC the day before to 18:30 UTC.
    expect(db.calls).toContainEqual({ table: "bookings", method: "gte", args: ["start_at", "2026-10-09T18:30:00.000Z"] });
    expect(db.calls).toContainEqual({ table: "bookings", method: "lt", args: ["start_at", "2026-10-10T18:30:00.000Z"] });
  });
});

describe("agendaMessage", () => {
  const items = [
    { time: "10:00 am", what: "Site visit", who: "Asha", staff: "Priya" },
    { time: "2:30 pm", what: "Booking", who: "+9198xxxxxx45", staff: null },
  ];

  it("lists every booking in the free text, and gives the template the count, the first and the link", () => {
    expect(agendaMessage("Skyline Homes", items, "https://app.test/")).toEqual({
      text: [
        "Good morning! Today at Skyline Homes: 2 bookings.",
        "• 10:00 am, Site visit with Asha (Priya)",
        "• 2:30 pm, Booking with +9198xxxxxx45",
        "Calendar: https://app.test/dashboard/calendar",
      ].join("\n"),
      templateParams: ["2 bookings", "10:00 am, Site visit with Asha (Priya)", "https://app.test/dashboard/calendar"],
    });
    expect(agendaMessage("Skyline Homes", [items[0]], "https://app.test").templateParams[0]).toBe("1 booking");
  });
});
