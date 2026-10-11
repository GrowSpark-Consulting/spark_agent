import { describe, expect, it } from "vitest";
import { buildTimeline, bookingEntry, LeadRow, toLead } from "@/features/leads/data";
import {
  BOOKING_STATUSES,
  bookingTitle,
  effectiveStatus,
  isActive,
  kindLabel,
  parseBookings,
  STATUS_LABEL,
  STATUS_STYLE,
  type Booking,
} from "./bookings";
import { buildColumns, minutesOnDate, NO_RESOURCE, rangeFor, summarize, visibleBookings, type CalendarResource } from "./data";
import { formatSpan, formatTime, formatWhen } from "./time";

// A booking's life as the dashboard reads it: rows shaped like what migration 0015's functions leave behind (hold_slot,
// confirm_booking, reschedule_booking, cancel_booking), parsed, laid out on the calendar and written into a lead's
// timeline. Everything is a unit test over the exported helpers with fixed clocks: no network, no DOM, no Supabase.
//
// The screens' own markup (calendar-screen.tsx, lead-detail.tsx) is not exported and is covered by Playwright against a
// MOCK Supabase (tests/e2e/app/calendar.spec.ts, leads.spec.ts), never against a real database.
//
// What the database does NOT give the dashboard, so nothing here pretends it does (see the todo list at the bottom):
//   - bookings has only `created_at`: no confirmed-at, cancelled-at or updated-at, and the 0015 functions write no audit rows.
//   - a moved booking's new row names the old one only by id (details.rescheduled_from), not by its old time.

const IST = "Asia/Kolkata";
const NY = "America/New_York";
const TENANT = "c0000000-0000-0000-0000-00000000000a";
const LEAD = "d0000000-0000-0000-0000-000000000001";
const ASHA = "a0000000-0000-0000-0000-000000000001";
const RAVI = "a0000000-0000-0000-0000-000000000002";
const id = (n: number) => `b0000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

const resources: CalendarResource[] = [
  { id: ASHA, name: "Asha", type: "staff", active: true },
  { id: RAVI, name: "Ravi", type: "staff", active: true },
];

/** A row as PostgREST returns it for CALENDAR_BOOKING_COLUMNS. Mon 12 Oct 2026, 10:00 am in Chennai, an hour long. */
const row = (over: Record<string, unknown> = {}) => ({
  id: id(1),
  tenant_id: TENANT,
  lead_id: LEAD,
  resource_id: ASHA,
  service_id: "5e000000-0000-0000-0000-000000000001",
  kind: "slot",
  status: "confirmed",
  start_at: "2026-10-12T04:30:00+00:00",
  end_at: "2026-10-12T05:30:00+00:00",
  hold_expires_at: null,
  details: {},
  created_at: "2026-10-10T10:00:00+00:00",
  services: { name: "Consultation" },
  resources: { name: "Asha" },
  leads: { contacts: { name: "Karthik R", phone: "+919812345621" } },
  ...over,
});
const parse = (...rows: Record<string, unknown>[]): Booking[] => parseBookings(rows, TENANT);
const one = (over: Record<string, unknown> = {}): Booking => parse(row(over))[0];

const lead = toLead(
  LeadRow.parse({
    id: LEAD,
    tenant_id: TENANT,
    contact_id: "e0000000-0000-0000-0000-000000000001",
    stage: "booked",
    score: null,
    temperature: null,
    fields: {},
    owner_user_id: null,
    created_at: "2026-10-10T09:00:00+00:00",
    updated_at: "2026-10-10T11:00:00+00:00",
    contacts: { name: "Karthik R", phone: "+919812345621" },
  }),
);
const bookingLines = (bookings: Booking[], now: Date, timeZone = IST) =>
  buildTimeline({ lead, conversations: [], messages: [], bookings, now, timeZone }).filter((e) => e.kind === "booking");

const visible = (bookings: Booking[], now: Date, showInactive = false, resource = "all") => visibleBookings(bookings, { now, showInactive, resource });

// Clocks. The hold below is made at 10:00 UTC on 10 Oct and lasts 10 minutes (HOLD_MINUTES in backend/src/booking).
const HOLD_LIVE = new Date("2026-10-10T10:05:00Z");
const HOLD_LAPSED = new Date("2026-10-10T10:11:00Z");
const LATER = new Date("2026-10-11T12:00:00Z");

describe("held", () => {
  const held = () => one({ status: "held", hold_expires_at: "2026-10-10T10:10:00+00:00" });

  it("is a live hold while the clock is inside the hold, and says so", () => {
    const b = held();
    expect(b).toMatchObject({ status: "held", holdExpiresAt: "2026-10-10T10:10:00.000Z" });
    expect(effectiveStatus(b, HOLD_LIVE)).toBe("held");
    expect(STATUS_LABEL.held).toBe("Held");
    expect(STATUS_STYLE.held.border).toContain("dashed");
    expect(STATUS_STYLE.held.strike).toBe(false);
  });

  it("is drawn on the calendar by default, counted as waiting for the customer, in the staff member's column", () => {
    const shown = visible([held()], HOLD_LIVE);
    expect(shown.map((b) => b.shown)).toEqual(["held"]);
    expect(summarize(shown)).toEqual({ total: 1, held: 1 });
    const cols = buildColumns({ view: "day", range: rangeFor("day", "2026-10-12", IST), resources, bookings: shown, resource: "all", timeZone: IST });
    expect(cols.map((c) => [c.title, c.bookings.map((b) => b.id)])).toEqual([["Asha", [id(1)]], ["Ravi", []]]);
  });

  it("reads in the timeline as a held booking with its service, staff member and local time", () => {
    const [line] = bookingLines([held()], HOLD_LIVE);
    expect(line).toMatchObject({ kind: "booking", label: "Booking", text: "Consultation with Asha for Mon 12 Oct, 10:00 am · Held" });
  });

  it("becomes expired once the hold has passed, even before the release-holds job marks it", () => {
    const b = held(); // the row still says 'held'
    expect(b.status).toBe("held");
    expect(effectiveStatus(b, HOLD_LAPSED)).toBe("expired");
    expect(STATUS_LABEL.expired).toBe("Hold expired");
    expect(visible([b], HOLD_LAPSED)).toEqual([]);
    expect(visible([b], HOLD_LAPSED, true).map((x) => x.shown)).toEqual(["expired"]);
    expect(summarize(visible([b], HOLD_LAPSED, true))).toEqual({ total: 0, held: 0 });
    expect(bookingLines([b], HOLD_LAPSED)[0].text).toMatch(/· Hold expired$/);
  });

  it("is expired at the very moment the hold ends", () => {
    expect(effectiveStatus(held(), new Date("2026-10-10T10:10:00Z"))).toBe("expired");
    expect(effectiveStatus(held(), new Date("2026-10-10T10:09:59Z"))).toBe("held");
  });

  it("shows a status the job already changed to expired the same way", () => {
    expect(effectiveStatus(one({ status: "expired", hold_expires_at: "2026-10-10T10:10:00+00:00" }), LATER)).toBe("expired");
  });

  it("stays held when no expiry is stored (never guesses one)", () => {
    expect(effectiveStatus(one({ status: "held", hold_expires_at: null }), LATER)).toBe("held");
  });
});

describe("confirmed", () => {
  // confirm_booking sets status 'confirmed' and clears hold_expires_at.
  const confirmed = () => one({ status: "confirmed", hold_expires_at: null });

  it("is solid, drawn by default, and not counted as a hold", () => {
    const b = confirmed();
    expect(effectiveStatus(b, LATER)).toBe("confirmed");
    expect(STATUS_LABEL.confirmed).toBe("Confirmed");
    expect(STATUS_STYLE.confirmed.border).toContain("solid");
    expect(summarize(visible([b], LATER))).toEqual({ total: 1, held: 0 });
  });

  it("carries the service and staff labels from the joined rows", () => {
    const b = confirmed();
    expect(b).toMatchObject({ serviceName: "Consultation", resourceName: "Asha", resourceId: ASHA });
    expect(bookingTitle(b)).toBe("Consultation with Asha");
    expect(bookingLines([b], LATER)[0].text).toBe("Consultation with Asha for Mon 12 Oct, 10:00 am · Confirmed");
  });

  it("shows the customer's name, and only a masked number", () => {
    const b = confirmed();
    expect(b).toMatchObject({ customerName: "Karthik R", phoneMasked: "+91 98xxx xxx21" });
    expect(JSON.stringify(b)).not.toContain("9812345621");
  });

  it("reads in the business's zone, whatever zone the viewer is in", () => {
    const b = confirmed();
    expect(formatWhen(b.start, IST)).toBe("Mon 12 Oct, 10:00 am");
    expect(formatTime(b.end, IST)).toBe("11:00 am");
    expect(formatSpan(b.start, b.end)).toBe("1 h");
    // The same instant for a business in New York is a different local time (and the timeline follows the zone it is given).
    expect(formatWhen(b.start, NY)).toBe("Mon 12 Oct, 12:30 am");
    expect(bookingLines([b], LATER, NY)[0].text).toBe("Consultation with Asha for Mon 12 Oct, 12:30 am · Confirmed");
  });

  it("is placed on the business's local day: 1:30 am Tuesday in Chennai is not Monday", () => {
    // 20:00 UTC on Monday 12 Oct is 1:30 am on Tuesday 13 Oct in Chennai.
    const late = one({ start_at: "2026-10-12T20:00:00+00:00", end_at: "2026-10-12T21:00:00+00:00" });
    const shown = visible([late], LATER);
    const monday = buildColumns({ view: "day", range: rangeFor("day", "2026-10-12", IST), resources, bookings: shown, resource: "all", timeZone: IST });
    const tuesday = buildColumns({ view: "day", range: rangeFor("day", "2026-10-13", IST), resources, bookings: shown, resource: "all", timeZone: IST });
    expect(monday.every((c) => c.bookings.length === 0)).toBe(true);
    expect(tuesday.find((c) => c.title === "Asha")?.bookings.map((b) => b.id)).toEqual([id(1)]);
    expect(minutesOnDate(late, "2026-10-13", IST)).toEqual({ start: 90, end: 150 });
    expect(formatWhen(late.start, IST)).toBe("Tue 13 Oct, 1:30 am");
    // Week view puts it in the second column (Tuesday), not the first.
    const week = buildColumns({ view: "week", range: rangeFor("week", "2026-10-12", IST), resources, bookings: shown, resource: "all", timeZone: IST });
    expect(week.map((c) => c.bookings.length)).toEqual([0, 1, 0, 0, 0, 0, 0]);
  });

  it("goes only in the chosen staff member's column when filtered", () => {
    const shown = visible([confirmed()], LATER, false, RAVI);
    expect(shown).toEqual([]);
    expect(visible([confirmed()], LATER, false, ASHA).map((b) => b.id)).toEqual([id(1)]);
  });
});

describe("cancelled", () => {
  // cancel_booking sets status 'cancelled', clears hold_expires_at and writes details.cancel_reason (null when none was given).
  const cancelled = (reason: unknown) => one({ status: "cancelled", hold_expires_at: null, details: { cancel_reason: reason } });

  it("is struck through, hidden from the calendar by default and shown when asked for", () => {
    const b = cancelled("Customer asked to cancel");
    expect(effectiveStatus(b, LATER)).toBe("cancelled");
    expect(STATUS_LABEL.cancelled).toBe("Cancelled");
    expect(STATUS_STYLE.cancelled.strike).toBe(true);
    expect(isActive("cancelled")).toBe(false);
    expect(visible([b], LATER)).toEqual([]);
    expect(visible([b], LATER, true).map((x) => x.shown)).toEqual(["cancelled"]);
    expect(summarize(visible([b], LATER, true))).toEqual({ total: 0, held: 0 });
  });

  it("gives the reason in the timeline", () => {
    expect(bookingLines([cancelled("Customer asked to cancel")], LATER)[0].text).toBe(
      "Consultation with Asha for Mon 12 Oct, 10:00 am · Cancelled (Customer asked to cancel)",
    );
  });

  it("explains 'replaced': a new hold by the same lead cancels the old one", () => {
    // hold_slot cancels the lead's earlier hold with the reason 'replaced'.
    expect(bookingLines([cancelled("replaced")], LATER)[0].text).toMatch(/Cancelled \(the customer picked another time\)$/);
    expect(cancelled("replaced").cancelReason).toBe("replaced");
  });

  it.each([null, "", 5, { why: "x" }, ["x"]])("shows no reason when cancel_reason is %j", (reason) => {
    expect(bookingLines([cancelled(reason)], LATER)[0].text).toBe("Consultation with Asha for Mon 12 Oct, 10:00 am · Cancelled");
  });

  it("still shows the reason when the booking is cancelled after its time has passed", () => {
    expect(bookingLines([cancelled("No longer needed")], new Date("2026-12-01T00:00:00Z"))[0].text).toMatch(/Cancelled \(No longer needed\)$/);
  });
});

describe("rescheduled", () => {
  // reschedule_booking marks the old row 'rescheduled' and inserts a NEW confirmed row with details.rescheduled_from = old id.
  const OLD = id(1);
  const NEW = id(2);
  const oldRow = (over: Record<string, unknown> = {}) => row({ id: OLD, status: "rescheduled", created_at: "2026-10-10T10:00:00+00:00", ...over });
  const newRow = (over: Record<string, unknown> = {}) =>
    row({
      id: NEW,
      status: "confirmed",
      start_at: "2026-10-14T04:30:00+00:00",
      end_at: "2026-10-14T05:30:00+00:00",
      created_at: "2026-10-11T08:00:00+00:00",
      details: { rescheduled_from: OLD },
      ...over,
    });

  it("links the replacement to the booking it replaced", () => {
    const [previous, replacement] = parse(oldRow(), newRow());
    expect(previous.rescheduledFrom).toBeNull();
    expect(replacement.rescheduledFrom).toBe(previous.id);
  });

  it("draws only the replacement by default, and both (the old one struck through) when asked", () => {
    const bookings = parse(oldRow(), newRow());
    expect(visible(bookings, LATER).map((b) => b.id)).toEqual([NEW]);
    expect(visible(bookings, LATER, true).map((b) => [b.id, b.shown])).toEqual([[OLD, "rescheduled"], [NEW, "confirmed"]]);
    expect(STATUS_LABEL.rescheduled).toBe("Moved");
    expect(STATUS_STYLE.rescheduled.strike).toBe(true);
    expect(summarize(visible(bookings, LATER, true))).toEqual({ total: 1, held: 0 });
  });

  it("puts each on its own day in the week view", () => {
    const shown = visible(parse(oldRow(), newRow()), LATER, true);
    const week = buildColumns({ view: "week", range: rangeFor("week", "2026-10-12", IST), resources, bookings: shown, resource: "all", timeZone: IST });
    expect(week.map((c) => c.bookings.map((b) => b.id))).toEqual([[OLD], [], [NEW], [], [], [], []]);
  });

  it("writes two lines in the timeline, oldest record first: the old booking as moved, then the replacement", () => {
    const lines = bookingLines(parse(newRow(), oldRow()), LATER); // read in any order
    expect(lines.map((l) => [l.label, l.text])).toEqual([
      ["Booking", "Consultation with Asha for Mon 12 Oct, 10:00 am · Moved"],
      ["Booking moved", "Consultation with Asha, moved to Wed 14 Oct, 10:00 am · Confirmed"],
    ]);
  });

  it("follows a move to another staff member: the replacement sits in the new person's column", () => {
    const bookings = parse(oldRow(), newRow({ resource_id: RAVI, resources: { name: "Ravi" } }));
    const shown = visible(bookings, LATER, true);
    const monday = buildColumns({ view: "day", range: rangeFor("day", "2026-10-12", IST), resources, bookings: shown, resource: "all", timeZone: IST });
    const wednesday = buildColumns({ view: "day", range: rangeFor("day", "2026-10-14", IST), resources, bookings: shown, resource: "all", timeZone: IST });
    expect(monday.find((c) => c.title === "Asha")?.bookings.map((b) => b.id)).toEqual([OLD]);
    expect(wednesday.find((c) => c.title === "Ravi")?.bookings.map((b) => b.id)).toEqual([NEW]);
    expect(bookingLines(bookings, LATER)[1].text).toBe("Consultation with Ravi, moved to Wed 14 Oct, 10:00 am · Confirmed");
  });

  it("reads the replacement as moved even when the old row cannot be seen", () => {
    expect(bookingLines(parse(newRow()), LATER)[0]).toMatchObject({ label: "Booking moved" });
  });

  it("ignores a rescheduled_from that is not text", () => {
    for (const rescheduled_from of [null, 7, { id: OLD }, ["x"]]) {
      expect(parse(newRow({ details: { rescheduled_from } }))[0].rescheduledFrom).toBeNull();
    }
  });

  it("shows a replacement that was itself cancelled as cancelled, with its reason", () => {
    const b = parse(newRow({ status: "cancelled", details: { rescheduled_from: OLD, cancel_reason: "Changed my mind" } }));
    expect(bookingLines(b, LATER)[0].text).toBe("Consultation with Asha, moved to Wed 14 Oct, 10:00 am · Cancelled (Changed my mind)");
  });
});

describe("missing or odd optional metadata", () => {
  it("shows a callback with no staff member and no service by its kind, in the 'No staff assigned' column", () => {
    const cb = one({ kind: "callback", resource_id: null, service_id: null, services: null, resources: null });
    expect(cb).toMatchObject({ resourceId: null, resourceName: null, serviceName: null });
    expect(bookingTitle(cb)).toBe("Callback");
    expect(bookingLines([cb], LATER)[0].text).toBe("Callback for Mon 12 Oct, 10:00 am · Confirmed");
    const shown = visible([cb], LATER);
    const cols = buildColumns({ view: "day", range: rangeFor("day", "2026-10-12", IST), resources, bookings: shown, resource: "all", timeZone: IST });
    expect(cols.find((c) => c.title === "No staff assigned")?.bookings.map((b) => b.id)).toEqual([id(1)]);
    expect(cols.filter((c) => c.title !== "No staff assigned").every((c) => c.bookings.length === 0)).toBe(true);
    expect(visible([cb], LATER, false, NO_RESOURCE)).toHaveLength(1);
  });

  it("falls back to the kind's words when the service is missing but there is staff", () => {
    const b = one({ kind: "site_visit", services: null });
    expect(bookingTitle(b)).toBe("Visit at a site with Asha");
  });

  it("shows only the service when there is no staff member", () => {
    expect(bookingTitle(one({ resource_id: null, resources: null }))).toBe("Consultation");
  });

  it("puts a booking whose staff member isn't in the list (removed or unreadable) under 'No staff assigned'", () => {
    const orphan = one({ resource_id: "a0000000-0000-0000-0000-0000000000ff", resources: null });
    const cols = buildColumns({ view: "day", range: rangeFor("day", "2026-10-12", IST), resources, bookings: visible([orphan], LATER), resource: "all", timeZone: IST });
    expect(cols.find((c) => c.title === "No staff assigned")?.bookings).toHaveLength(1);
  });

  it("shows no customer when the lead's contact cannot be read", () => {
    for (const leads of [null, { contacts: null }, undefined]) {
      expect(one({ leads })).toMatchObject({ customerName: null, phoneMasked: null });
    }
    // A contact with no name still shows a masked number.
    expect(one({ leads: { contacts: { name: "  ", phone: "+919812345621" } } })).toMatchObject({ customerName: null, phoneMasked: "+91 98xxx xxx21" });
  });

  it("reads missing, malformed and non-object details as no details", () => {
    for (const details of [undefined, null, [], "x", 5]) {
      const b = one({ details });
      expect(b, JSON.stringify(details)).toMatchObject({ rescheduledFrom: null, cancelReason: null });
    }
  });

  it("shows a status it doesn't know as 'Unknown status': hidden by default, never as an appointment", () => {
    const b = one({ status: "pending_review" });
    expect(effectiveStatus(b, LATER)).toBe("unknown");
    expect(STATUS_LABEL.unknown).toBe("Unknown status");
    expect(visible([b], LATER)).toEqual([]);
    expect(visible([b], LATER, true).map((x) => x.shown)).toEqual(["unknown"]);
    expect(bookingLines([b], LATER)[0].text).toMatch(/· Unknown status$/);
  });

  it("calls a kind it doesn't know a Booking", () => {
    expect(kindLabel("something_new")).toBe("Booking");
    expect(bookingTitle(one({ kind: "something_new", services: null, resources: null, resource_id: null }))).toBe("Booking");
  });

  it("refuses a row that is not a booking, and drops another business's row", () => {
    expect(() => parseBookings([{ id: "x" }], TENANT)).toThrow(/unexpected shape/);
    expect(parseBookings([row({ tenant_id: "c0000000-0000-0000-0000-00000000000b" })], TENANT)).toEqual([]);
  });
});

describe("the status tables", () => {
  it("has a label and a style for every status the database allows, and for unknown", () => {
    for (const status of [...BOOKING_STATUSES, "unknown"] as const) {
      expect(STATUS_LABEL[status], status).toBeTruthy();
      expect(STATUS_STYLE[status], status).toBeDefined();
    }
  });

  it("strikes through what is no longer an appointment, and only that", () => {
    const struck = BOOKING_STATUSES.filter((s) => STATUS_STYLE[s].strike).sort();
    expect(struck).toEqual(["cancelled", "expired", "no_show", "rescheduled"]);
  });

  it("counts held, confirmed, completed and no-show as taking up time, and nothing else", () => {
    expect(BOOKING_STATUSES.filter((s) => isActive(s)).sort()).toEqual(["completed", "confirmed", "held", "no_show"]);
    expect(isActive("unknown")).toBe(false);
  });
});

describe("what the database doesn't provide (documented gaps, not behaviour)", () => {
  it("records only when a booking was created: the timeline line is placed at created_at for every status", () => {
    // A confirmed booking and a cancelled one are placed at the time the hold was made, because that is the only time the row has.
    for (const status of ["held", "confirmed", "cancelled", "rescheduled"]) {
      const b = one({ status, created_at: "2026-10-10T10:00:00+00:00" });
      expect(bookingEntry(b, LATER, IST).at, status).toBe("2026-10-10T10:00:00.000Z");
    }
  });

  it("has no confirmed-at, cancelled-at or updated-at to show", () => {
    const keys = Object.keys(one({ status: "cancelled" }));
    expect(keys).not.toContain("confirmedAt");
    expect(keys).not.toContain("cancelledAt");
    expect(keys).not.toContain("updatedAt");
  });

  it("does not show when a booking was confirmed or cancelled in the timeline text", () => {
    const text = bookingLines([one({ status: "cancelled", details: { cancel_reason: "x" } })], LATER)[0].text;
    expect(text).not.toMatch(/\b(confirmed|cancelled) (at|on)\b/i);
  });

  // BACKEND DEPENDENCY (Dev 2): needs a status-change time on bookings (a column or audit rows). Not testable until it exists.
  it.todo("shows when a booking was confirmed");
  it.todo("shows when a booking was cancelled, and by whom");
  // BACKEND DEPENDENCY (Dev 2): the new row stores the old booking's id only. Showing "moved from <old time>" needs that time
  // on the new row's details, or a read of the old row by id (the calendar read is limited to the visible range).
  it.todo("shows the previous time on a moved booking");
  // BACKEND DEPENDENCY (Dev 1 / Dev 2): cancel_booking leaves leads.stage alone, so a lead can read 'Booked' with only a cancelled booking.
  it.todo("shows the lead's stage changing after a cancellation");
});
