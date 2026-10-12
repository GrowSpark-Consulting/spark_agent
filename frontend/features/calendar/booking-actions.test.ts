import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/errors";

const getJson = vi.fn();
const postJson = vi.fn();
vi.mock("@/lib/api/client", () => ({
  getJson: (...args: unknown[]) => getJson(...args),
  postJson: (...args: unknown[]) => postJson(...args),
}));

const { availability, BookingActionDataError, bookingActionService, failureKind, mayAct } = await import("./booking-actions");

const TENANT = "10000000-0000-0000-0000-000000000004";
const BOOKING = "50000000-0000-0000-0000-000000000001";
const RESOURCE = "20000000-0000-0000-0000-000000000001";
const answer = (status: string) => ({ id: BOOKING, tenantId: TENANT, status, start: "2026-10-12T04:30:00.000Z", end: "2026-10-12T05:30:00.000Z", resourceId: RESOURCE, details: {} });

beforeEach(() => {
  getJson.mockReset();
  postJson.mockReset();
});

describe("bookingActionService", () => {
  it("posts each action to its own route, for this business, with no body where the contract has none", async () => {
    postJson.mockResolvedValue(answer("completed"));
    await bookingActionService.complete(TENANT, BOOKING);
    expect(postJson).toHaveBeenLastCalledWith(`/api/bookings/${BOOKING}/complete`, undefined, { tenantId: TENANT });
    await bookingActionService.noShow(TENANT, BOOKING);
    expect(postJson).toHaveBeenLastCalledWith(`/api/bookings/${BOOKING}/no-show`, undefined, { tenantId: TENANT });
  });

  it("cancels with a trimmed reason, or with no body when there is none", async () => {
    postJson.mockResolvedValue(answer("cancelled"));
    await bookingActionService.cancel(TENANT, BOOKING, "  Customer called  ");
    expect(postJson).toHaveBeenLastCalledWith(`/api/bookings/${BOOKING}/cancel`, { reason: "Customer called" }, { tenantId: TENANT });
    await bookingActionService.cancel(TENANT, BOOKING, "   ");
    expect(postJson).toHaveBeenLastCalledWith(`/api/bookings/${BOOKING}/cancel`, undefined, { tenantId: TENANT });
    await bookingActionService.cancel(TENANT, BOOKING);
    expect(postJson).toHaveBeenLastCalledWith(`/api/bookings/${BOOKING}/cancel`, undefined, { tenantId: TENANT });
  });

  it("reschedules with exactly start, end and the slot's resource", async () => {
    postJson.mockResolvedValue(answer("confirmed"));
    await bookingActionService.reschedule(TENANT, BOOKING, { start: "2026-10-13T04:30:00.000Z", end: "2026-10-13T05:30:00.000Z", resourceId: RESOURCE });
    expect(postJson).toHaveBeenCalledWith(
      `/api/bookings/${BOOKING}/reschedule`,
      { start: "2026-10-13T04:30:00.000Z", end: "2026-10-13T05:30:00.000Z", resourceId: RESOURCE },
      { tenantId: TENANT },
    );
  });

  it("encodes the booking id, so a hostile one can't change the path", async () => {
    postJson.mockResolvedValue(answer("completed"));
    await bookingActionService.complete(TENANT, "../x?y=1");
    expect(postJson.mock.calls[0][0]).toBe("/api/bookings/..%2Fx%3Fy%3D1/complete");
  });

  it("reads the offered times, optionally from a date", async () => {
    const slot = { start: "2026-10-13T04:30:00.000Z", end: "2026-10-13T05:30:00.000Z", resourceId: RESOURCE, resourceName: "Asha", serviceId: "x", label: "Tue 13 Oct, 10:00 am" };
    getJson.mockResolvedValue({ slots: [slot] });
    expect(await bookingActionService.slots(TENANT, BOOKING)).toEqual([{ start: slot.start, end: slot.end, resourceId: RESOURCE, resourceName: "Asha", label: slot.label }]);
    expect(getJson).toHaveBeenLastCalledWith(`/api/bookings/${BOOKING}/slots`, { tenantId: TENANT });
    await bookingActionService.slots(TENANT, BOOKING, new Date("2026-10-20T00:00:00.000Z"));
    expect(getJson).toHaveBeenLastCalledWith(`/api/bookings/${BOOKING}/slots?from=2026-10-20T00%3A00%3A00.000Z`, { tenantId: TENANT });
  });

  it.each([
    ["a missing id", { status: "confirmed", start: "a", end: "b", resourceId: null }],
    ["a missing status", { id: BOOKING, start: "a", end: "b", resourceId: null }],
    ["null", null],
  ])("refuses a booking answer with %s", async (_name, body) => {
    postJson.mockResolvedValue(body);
    await expect(bookingActionService.complete(TENANT, BOOKING)).rejects.toBeInstanceOf(BookingActionDataError);
  });

  it("refuses a slots answer that is not a list of slots", async () => {
    getJson.mockResolvedValue({ slots: [{ start: "a" }] });
    await expect(bookingActionService.slots(TENANT, BOOKING)).rejects.toBeInstanceOf(BookingActionDataError);
  });

  it("passes the API's refusal on untouched", async () => {
    const err = new ApiError(409, { error: { code: "slot_taken", message: "That time was just taken." } });
    postJson.mockRejectedValue(err);
    await expect(bookingActionService.reschedule(TENANT, BOOKING, { start: "a", end: "b", resourceId: RESOURCE })).rejects.toBe(err);
  });
});

describe("availability", () => {
  const before = new Date("2026-10-12T04:00:00.000Z");
  const after = new Date("2026-10-12T06:00:00.000Z");
  const start = "2026-10-12T04:30:00.000Z";

  it("a confirmed booking can be moved or cancelled, and marked only once it has started", () => {
    expect(availability("confirmed", start, before)).toEqual({ reschedule: true, cancel: true, complete: "not_started", noShow: "not_started" });
    expect(availability("confirmed", start, after)).toEqual({ reschedule: true, cancel: true, complete: "yes", noShow: "yes" });
  });

  it("a held booking can only be cancelled", () => {
    expect(availability("held", start, after)).toEqual({ reschedule: false, cancel: true, complete: "no", noShow: "no" });
  });

  it.each(["completed", "no_show", "cancelled", "rescheduled", "expired", "unknown"] as const)("a %s booking has nothing to offer", (status) => {
    expect(availability(status, start, after)).toEqual({ reschedule: false, cancel: false, complete: "no", noShow: "no" });
  });
});

describe("mayAct", () => {
  const ME = "u1";
  it("lets owners and admins act on any booking", () => {
    expect(mayAct("owner", ME, null)).toBe(true);
    expect(mayAct("admin", ME, "someone-else")).toBe(true);
  });
  it("lets staff act only on their own calendar's bookings", () => {
    expect(mayAct("staff", ME, ME)).toBe(true);
    expect(mayAct("staff", ME, "someone-else")).toBe(false);
    expect(mayAct("staff", ME, null)).toBe(false);
  });
});

describe("failureKind", () => {
  it("separates a taken time, a stale booking and everything else", () => {
    expect(failureKind(new ApiError(409, { error: { code: "slot_taken", message: "x" } }))).toBe("slot_taken");
    expect(failureKind(new ApiError(409, { error: { code: "conflict", message: "This booking has not started yet." } }))).toBe("stale");
    expect(failureKind(new ApiError(404, { error: { code: "not_found", message: "x" } }))).toBe("stale");
    expect(failureKind(new ApiError(403, { error: { code: "forbidden", message: "x" } }))).toBe("other");
    expect(failureKind(new Error("x"))).toBe("other");
  });
});
