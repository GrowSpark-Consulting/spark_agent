import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "../test-support/fake-supabase";
import { addBookingToGoogle, googleBusyTimes, googleEventId, removeBookingFromGoogle, type GoogleSyncDeps } from "./google-sync";

const TENANT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const BOOKING = "9b2f0a4e-1c3d-4e5f-8a6b-7c8d9e0f1a2b";
const RESOURCE = "d5000000-0000-0000-0000-000000000011";
const OTHER = "d5000000-0000-0000-0000-000000000012";
const TOKEN = "ya29.synthetic-google-token-never-log";
const EVENT_ID = "pk9b2f0a4e1c3d4e5f8a6b7c8d9e0f1a2b";

const bookingRow = (over: Record<string, unknown> = {}) => ({
  id: BOOKING,
  status: "confirmed",
  start_at: "2026-10-10T11:30:00+00:00",
  end_at: "2026-10-10T12:30:00+00:00",
  resource_id: RESOURCE,
  calendar_event_id: null,
  services: { name: "Site visit" },
  leads: { contacts: { name: "Asha" } },
  ...over,
});
const connection = (resourceId = RESOURCE) => ({ resource_id: resourceId, calendar_id: "primary", status: "connected" });
const tables = (booking: Record<string, unknown> | null = {}, connections = [connection()]) => ({
  bookings: { data: booking === null ? [] : [bookingRow(booking)], error: null },
  google_calendar_connections: { data: connections, error: null },
});
const reply = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });

let logs: unknown[][];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logs.push(args);
  });
});
afterEach(() => vi.restoreAllMocks());

function setup(t: ReturnType<typeof tables>, answer: () => Promise<Response> | Response, token: string | null = TOKEN) {
  const db = fakeSupabase(t);
  const f = vi.fn<typeof fetch>(async () => answer());
  const deps: GoogleSyncDeps = { db: db.client, fetch: f, appUrl: "https://app.test/", accessToken: async () => token };
  return { db, f, deps };
}

describe("googleEventId", () => {
  it("is the booking's id in Google's allowed characters", () => {
    expect(googleEventId(BOOKING)).toBe(EVENT_ID);
    expect(googleEventId(BOOKING)).toMatch(/^[0-9a-v]{5,1024}$/);
  });
});

describe("addBookingToGoogle", () => {
  it("adds the event to the staff member's calendar with a fixed id, and keeps the id on the booking", async () => {
    const { db, f, deps } = setup(tables(), () => reply(200, { id: EVENT_ID }));
    await expect(addBookingToGoogle(TENANT, BOOKING, deps)).resolves.toBe("created");
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" });
    expect(JSON.parse(init?.body as string)).toEqual({
      id: EVENT_ID,
      summary: "Site visit: Asha",
      description: "Booked through Pakka Agent. Details: https://app.test/dashboard/calendar",
      start: { dateTime: "2026-10-10T11:30:00.000Z" },
      end: { dateTime: "2026-10-10T12:30:00.000Z" },
    });
    expect(db.calls).toContainEqual({ table: "bookings", method: "update", args: [{ calendar_event_id: EVENT_ID }] });
    for (const table of ["bookings", "google_calendar_connections"]) expect(db.calls).toContainEqual({ table, method: "eq", args: ["tenant_id", TENANT] });
  });

  it("treats Google's 'that id exists' as done, so a retry adds nothing twice", async () => {
    const { db, deps } = setup(tables(), () => reply(409, { error: { code: 409 } }));
    await expect(addBookingToGoogle(TENANT, BOOKING, deps)).resolves.toBe("already_there");
    expect(db.calls).toContainEqual({ table: "bookings", method: "update", args: [{ calendar_event_id: EVENT_ID }] });
  });

  it("leaves alone a booking that isn't confirmed, has no person, or whose person has no working calendar", async () => {
    for (const [t, token, expected] of [
      [tables({ status: "cancelled" }), TOKEN, "not_confirmed"],
      [tables(null), TOKEN, "not_confirmed"],
      [tables({ resource_id: null }), TOKEN, "no_calendar"],
      [tables({}, []), TOKEN, "no_calendar"],
      [tables(), null, "no_calendar"],
    ] as const) {
      const { f, deps } = setup(t, () => reply(200, {}), token);
      await expect(addBookingToGoogle(TENANT, BOOKING, deps)).resolves.toBe(expected);
      expect(f).not.toHaveBeenCalled();
    }
  });

  it("throws on a Google error so the job retries, without the token in the message", async () => {
    const { deps } = setup(tables(), () => reply(503, { error: "backendError" }));
    const err = await addBookingToGoogle(TENANT, BOOKING, deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).not.toContain(TOKEN);
  });
});

describe("removeBookingFromGoogle", () => {
  it("deletes the booking's event", async () => {
    const { f, deps } = setup(tables({ status: "cancelled", calendar_event_id: EVENT_ID }), () => reply(204));
    await expect(removeBookingFromGoogle(TENANT, BOOKING, deps)).resolves.toBe("removed");
    expect(f.mock.calls[0][0]).toBe(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${EVENT_ID}`);
    expect(f.mock.calls[0][1]?.method).toBe("DELETE");
  });

  it("is done when the event is already gone, and does nothing for a booking that never had one", async () => {
    const gone = setup(tables({ calendar_event_id: EVENT_ID }), () => reply(410));
    await expect(removeBookingFromGoogle(TENANT, BOOKING, gone.deps)).resolves.toBe("already_gone");
    const none = setup(tables(), () => reply(204));
    await expect(removeBookingFromGoogle(TENANT, BOOKING, none.deps)).resolves.toBe("no_event");
    expect(none.f).not.toHaveBeenCalled();
  });
});

describe("googleBusyTimes", () => {
  const from = new Date("2026-10-09T18:30:00Z");
  const to = new Date("2026-10-10T18:30:00Z");

  it("returns Google's busy periods for staff with a connected calendar", async () => {
    const { f, deps } = setup(tables({}, [connection()]), () =>
      reply(200, { calendars: { primary: { busy: [{ start: "2026-10-10T04:30:00Z", end: "2026-10-10T06:00:00Z" }] } } }),
    );
    await expect(googleBusyTimes(TENANT, [RESOURCE, OTHER], from, to, deps)).resolves.toEqual([
      { resourceId: RESOURCE, start: new Date("2026-10-10T04:30:00Z"), end: new Date("2026-10-10T06:00:00Z") },
    ]);
    expect(f.mock.calls[0][0]).toBe("https://www.googleapis.com/calendar/v3/freeBusy");
    expect(JSON.parse(f.mock.calls[0][1]?.body as string)).toEqual({ timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: "primary" }] });
  });

  it("skips a calendar Google can't answer for, and logs no token", async () => {
    const down = setup(tables({}, [connection()]), () => reply(500, {}));
    await expect(googleBusyTimes(TENANT, [RESOURCE], from, to, down.deps)).resolves.toEqual([]);
    const offline = setup(tables({}, [connection()]), () => Promise.reject(new Error("network down")));
    await expect(googleBusyTimes(TENANT, [RESOURCE], from, to, offline.deps)).resolves.toEqual([]);
    expect(logs.length).toBe(2);
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });

  it("asks Google nothing when no one has a connected calendar", async () => {
    const { f, deps } = setup(tables({}, []), () => reply(200, {}));
    await expect(googleBusyTimes(TENANT, [RESOURCE], from, to, deps)).resolves.toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });
});
