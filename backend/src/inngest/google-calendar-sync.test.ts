import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleGoogleCalendarSync, type GoogleCalendarSyncDeps } from "./google-calendar-sync";

const TENANT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const BOOKING = "9b2f0a4e-1c3d-4e5f-8a6b-7c8d9e0f1a2b";

const journal: string[] = [];
const step = { run: async <T>(id: string, fn: () => Promise<T>) => (journal.push(id), fn()) };
const add = vi.fn<GoogleCalendarSyncDeps["add"]>();
const remove = vi.fn<GoogleCalendarSyncDeps["remove"]>();
const deps = (): GoogleCalendarSyncDeps => ({ add, remove });

beforeEach(() => {
  journal.length = 0;
  add.mockReset().mockResolvedValue("created");
  remove.mockReset().mockResolvedValue("removed");
});

describe("handleGoogleCalendarSync", () => {
  it("adds a confirmed booking to Google", async () => {
    await expect(handleGoogleCalendarSync({ event: { name: "booking.confirmed", data: { tenantId: TENANT, bookingId: BOOKING } }, step }, deps())).resolves.toEqual({ added: "created" });
    expect(add).toHaveBeenCalledWith(TENANT, BOOKING);
    expect(journal).toEqual(["add"]);
  });

  it.each(["cancelled", "rescheduled"])("takes a %s booking off Google", async (change) => {
    await expect(handleGoogleCalendarSync({ event: { name: "booking.changed", data: { tenantId: TENANT, bookingId: BOOKING, change } }, step }, deps())).resolves.toEqual({ removed: "removed" });
    expect(remove).toHaveBeenCalledWith(TENANT, BOOKING);
  });

  it.each(["completed", "no_show"])("leaves a %s booking's event as it is", async (change) => {
    await expect(handleGoogleCalendarSync({ event: { name: "booking.changed", data: { tenantId: TENANT, bookingId: BOOKING, change } }, step }, deps())).resolves.toEqual({ skipped: "nothing_to_change" });
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  // Exit test 1 (Day 7; inngest/replay-coverage.test.ts). The event's id in Google is the booking's own (googleEventId), so a second add
  // finds it ("already_there") and a second removal finds it gone ("already_gone"): booking/google-sync.test.ts.
  it("replay: the same event twice asks Google for the same booking's fixed event, which is then already there or already gone", async () => {
    const confirmed = { event: { name: "booking.confirmed", data: { tenantId: TENANT, bookingId: BOOKING } }, step };
    add.mockResolvedValueOnce("created").mockResolvedValueOnce("already_there");
    await expect(handleGoogleCalendarSync(confirmed, deps())).resolves.toEqual({ added: "created" });
    await expect(handleGoogleCalendarSync(confirmed, deps())).resolves.toEqual({ added: "already_there" });
    expect(add.mock.calls).toEqual([[TENANT, BOOKING], [TENANT, BOOKING]]);

    const cancelled = { event: { name: "booking.changed", data: { tenantId: TENANT, bookingId: BOOKING, change: "cancelled" } }, step };
    remove.mockResolvedValueOnce("removed").mockResolvedValueOnce("already_gone");
    await handleGoogleCalendarSync(cancelled, deps());
    await expect(handleGoogleCalendarSync(cancelled, deps())).resolves.toEqual({ removed: "already_gone" });
  });

  it("lets a Google error through so Inngest retries, and refuses an event without ids", async () => {
    add.mockRejectedValue(new Error("google sync: adding the event failed (503)"));
    await expect(handleGoogleCalendarSync({ event: { name: "booking.confirmed", data: { tenantId: TENANT, bookingId: BOOKING } }, step }, deps())).rejects.toThrow("503");
    await expect(handleGoogleCalendarSync({ event: { name: "booking.confirmed", data: { tenantId: TENANT } }, step }, deps())).rejects.toMatchObject({ name: "ZodError" });
  });
});
