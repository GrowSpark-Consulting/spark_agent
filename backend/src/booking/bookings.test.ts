import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cancelBooking, confirmBooking, findSlots, holdSlot, releaseExpiredHolds, rescheduleBooking, type BookingDeps } from "./bookings";

type Result = { data: unknown; error: { code?: string; message: string } | null };
const ok = (data: unknown): Result => ({ data, error: null });

const TENANT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const SERVICE = "d6000000-0000-0000-0000-000000000011";
const R1 = "d5000000-0000-0000-0000-000000000011";
const R2 = "d5000000-0000-0000-0000-000000000012";
const LEAD = "6fa459ea-ee8a-4ca4-894e-db77e160355e";
const BOOKING = "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f601";
const NOW = new Date("2026-10-08T03:30:00Z"); // Thu 8 Oct, 9:00 am in India
const FRIDAY = { from: "2026-10-08T18:30:00Z", to: "2026-10-09T18:30:00Z" }; // Fri 9 Oct, whole day in India

const OPEN_ALL_DAY = { fri: [{ start: "10:00", end: "18:00" }] };
const BUSINESS_HOURS = { fri: [{ start: "09:30", end: "19:00" }] };

let tables: Record<string, Result>;
let rpcHandlers: Record<string, (args: Record<string, unknown>) => Result>;
const queries: { table: string; op: string; args: unknown[] }[] = [];
const send = vi.fn<BookingDeps["send"]>(async () => ({}));

function fakeDb(): SupabaseClient {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      for (const op of ["select", "eq", "in", "lt", "gt"]) {
        builder[op] = (...args: unknown[]) => {
          queries.push({ table, op, args });
          return builder;
        };
      }
      builder.maybeSingle = () => Promise.resolve(tables[table]);
      builder.then = (resolve: (v: Result) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(tables[table]).then(resolve, reject);
      return builder;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => rpcHandlers[fn](args),
  } as unknown as SupabaseClient;
}

const deps = (): BookingDeps => ({ db: fakeDb(), now: () => NOW, send });

const bookingRow = (over: Record<string, unknown> = {}) => ({
  id: BOOKING,
  tenant_id: TENANT,
  lead_id: LEAD,
  resource_id: R1,
  service_id: SERVICE,
  kind: "site_visit",
  start_at: "2026-10-09T08:00:00+00:00",
  end_at: "2026-10-09T09:00:00+00:00",
  status: "held",
  hold_expires_at: "2026-10-08T03:40:00+00:00",
  details: {},
  ...over,
});

beforeEach(() => {
  queries.length = 0;
  send.mockReset().mockResolvedValue({});
  tables = {
    tenants: ok({ timezone: "Asia/Kolkata", business_hours: BUSINESS_HOURS }),
    services: ok({ id: SERVICE, duration_min: 60, buffer_min: 0, min_notice_min: 60, resource_type: "staff" }),
    resources: ok([
      { id: R1, name: "Site Executive 1", working_hours: OPEN_ALL_DAY, service_area: null },
      { id: R2, name: "Site Executive 2", working_hours: {}, service_area: null },
    ]),
    bookings: ok([]),
  };
  rpcHandlers = {};
});

describe("findSlots", () => {
  it("offers 3 times spread across the day, in the business's time zone, each with a free person", async () => {
    const slots = await findSlots(TENANT, { serviceId: SERVICE, ...FRIDAY }, deps());
    expect(slots.map((s) => [s.label, s.resourceName])).toEqual([
      ["Fri 9 Oct, 9:30 am", "Site Executive 2"], // only the business's hours start at 9:30
      ["Fri 9 Oct, 1:30 pm", "Site Executive 1"],
      ["Fri 9 Oct, 6:00 pm", "Site Executive 2"],
    ]);
    expect(slots[0]).toEqual({
      start: "2026-10-09T04:00:00.000Z",
      end: "2026-10-09T05:00:00.000Z",
      resourceId: R2,
      resourceName: "Site Executive 2",
      serviceId: SERVICE,
      label: "Fri 9 Oct, 9:30 am",
    });
  });

  it("filters every read by the tenant and asks only for the service's resource type", async () => {
    await findSlots(TENANT, { serviceId: SERVICE, ...FRIDAY }, deps());
    for (const table of ["services", "resources", "bookings"]) {
      expect(queries).toContainEqual({ table, op: "eq", args: ["tenant_id", TENANT] });
    }
    expect(queries).toContainEqual({ table: "resources", op: "eq", args: ["type", "staff"] });
    expect(queries).toContainEqual({ table: "bookings", op: "in", args: ["status", ["held", "confirmed"]] });
  });

  it("skips times taken by confirmed bookings and live holds, but not expired holds", async () => {
    tables.bookings = ok([
      { resource_id: R1, start_at: "2026-10-09T04:30:00Z", end_at: "2026-10-09T12:30:00Z", status: "confirmed", hold_expires_at: null },
      { resource_id: R2, start_at: "2026-10-09T04:00:00Z", end_at: "2026-10-09T08:00:00Z", status: "held", hold_expires_at: "2026-10-08T03:35:00Z" },
      { resource_id: R2, start_at: "2026-10-09T08:00:00Z", end_at: "2026-10-09T13:30:00Z", status: "held", hold_expires_at: "2026-10-08T03:29:00Z" },
    ]);
    const slots = await findSlots(TENANT, { serviceId: SERVICE, ...FRIDAY }, deps());
    // R1 is busy all day and R2 is held 9:30–1:30 (still live); R2's expired hold after that is free again.
    expect(slots.map((s) => s.label)).toEqual(["Fri 9 Oct, 1:30 pm", "Fri 9 Oct, 3:30 pm", "Fri 9 Oct, 6:00 pm"]);
    expect(new Set(slots.map((s) => s.resourceId))).toEqual(new Set([R2]));
  });

  it("also skips times the person's Google Calendar says are busy, and ignores a Google failure", async () => {
    // R1 is free on Friday in the bookings table, but Google says 10 am to 6 pm is taken: only R2 remains.
    const googleBusy = vi.fn<NonNullable<BookingDeps["googleBusy"]>>(async () => [
      { resourceId: R1, start: new Date("2026-10-09T04:30:00Z"), end: new Date("2026-10-09T12:30:00Z") },
    ]);
    const slots = await findSlots(TENANT, { serviceId: SERVICE, ...FRIDAY }, { ...deps(), googleBusy });
    expect(new Set(slots.map((s) => s.resourceId))).toEqual(new Set([R2]));
    expect(googleBusy).toHaveBeenCalledWith(TENANT, [R1, R2], new Date(FRIDAY.from), new Date(FRIDAY.to));
    const failing = vi.fn<NonNullable<BookingDeps["googleBusy"]>>(async () => {
      throw new Error("google down");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(findSlots(TENANT, { serviceId: SERVICE, ...FRIDAY }, { ...deps(), googleBusy: failing })).resolves.toHaveLength(3);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it("keeps field visits to people whose service area has the pincode (or who have none set)", async () => {
    tables.resources = ok([
      { id: R1, name: "Designer 1", working_hours: OPEN_ALL_DAY, service_area: { pincodes: ["600041"] } },
      { id: R2, name: "Designer 2", working_hours: OPEN_ALL_DAY, service_area: { pincodes: ["600096"] } },
    ]);
    const slots = await findSlots(TENANT, { serviceId: SERVICE, ...FRIDAY, pincode: "600096" }, deps());
    expect(new Set(slots.map((s) => s.resourceName))).toEqual(new Set(["Designer 2"]));
    expect(await findSlots(TENANT, { serviceId: SERVICE, ...FRIDAY, pincode: "110001" }, deps())).toEqual([]);
  });

  it("answers not_found for a missing service and refuses a bad window", async () => {
    tables.services = ok(null);
    await expect(findSlots(TENANT, { serviceId: SERVICE, ...FRIDAY }, deps())).rejects.toMatchObject({ code: "not_found" });
    await expect(findSlots(TENANT, { serviceId: SERVICE, from: FRIDAY.to, to: FRIDAY.from }, deps())).rejects.toMatchObject({ name: "ZodError" });
    await expect(
      findSlots(TENANT, { serviceId: SERVICE, from: "2026-10-09T00:00:00Z", to: "2026-10-30T00:00:00Z" }, deps()),
    ).rejects.toMatchObject({ name: "ZodError" });
  });

  it("checks the resource type the caller expects", async () => {
    await expect(findSlots(TENANT, { serviceId: SERVICE, resourceType: "stylist", ...FRIDAY }, deps())).rejects.toMatchObject({
      code: "validation_failed",
    });
  });
});

describe("holdSlot", () => {
  const slot = { start: "2026-10-09T08:00:00Z", end: "2026-10-09T09:00:00Z", resourceId: R1, serviceId: SERVICE };

  it("holds the slot for 10 minutes through hold_slot and returns the booking", async () => {
    const seen: Record<string, unknown>[] = [];
    rpcHandlers.hold_slot = (args) => {
      seen.push(args);
      return ok(bookingRow());
    };
    const booking = await holdSlot(TENANT, slot, LEAD, { kind: "site_visit" }, deps());
    expect(seen[0]).toEqual({
      p_tenant_id: TENANT,
      p_lead_id: LEAD,
      p_kind: "site_visit",
      p_start: "2026-10-09T08:00:00.000Z",
      p_end: "2026-10-09T09:00:00.000Z",
      p_resource_id: R1,
      p_service_id: SERVICE,
      p_details: {},
      p_hold_minutes: 10,
    });
    expect(booking).toMatchObject({ id: BOOKING, status: "held", start: "2026-10-09T08:00:00.000Z", holdExpiresAt: "2026-10-08T03:40:00.000Z" });
  });

  it("turns database answers into API errors", async () => {
    const cases: [string, string, string][] = [
      ["23P01", 'conflicting key value violates exclusion constraint "bookings_resource_id_tstzrange_excl"', "slot_taken"],
      ["PA404", "hold_slot: lead not found", "not_found"],
      ["P0001", "hold_slot: that time has already passed", "validation_failed"],
    ];
    for (const [code, message, expected] of cases) {
      rpcHandlers.hold_slot = () => ({ data: null, error: { code, message } });
      await expect(holdSlot(TENANT, slot, LEAD, {}, deps())).rejects.toMatchObject({ code: expected });
    }
    rpcHandlers.hold_slot = () => ({ data: null, error: { code: "P0001", message: "hold_slot: that time has already passed" } });
    await expect(holdSlot(TENANT, slot, LEAD, {}, deps())).rejects.toThrow("That time has already passed.");
    rpcHandlers.hold_slot = () => ({ data: null, error: { code: "57014", message: "statement timeout" } });
    await expect(holdSlot(TENANT, slot, LEAD, {}, deps())).rejects.toThrow("hold_slot failed");
  });

  it("lets a callback have no resource", async () => {
    rpcHandlers.hold_slot = (args) => ok(bookingRow({ kind: args.p_kind, resource_id: args.p_resource_id, service_id: null }));
    const booking = await holdSlot(TENANT, { start: slot.start, end: slot.end }, LEAD, { kind: "callback" }, deps());
    expect(booking).toMatchObject({ kind: "callback", resourceId: null });
  });
});

describe("confirm, reschedule and cancel", () => {
  it("confirm emits booking.confirmed with a fixed id", async () => {
    rpcHandlers.confirm_booking = () => ok(bookingRow({ status: "confirmed", hold_expires_at: null }));
    const booking = await confirmBooking(TENANT, BOOKING, deps());
    expect(booking.status).toBe("confirmed");
    expect(send).toHaveBeenCalledWith({ id: `booking.confirmed:${BOOKING}`, name: "booking.confirmed", data: { tenantId: TENANT, bookingId: BOOKING } });
  });

  it("keeps a confirmed booking even if the event can't be sent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    send.mockRejectedValue(new Error("inngest down"));
    rpcHandlers.confirm_booking = () => ok(bookingRow({ status: "confirmed", hold_expires_at: null }));
    await expect(confirmBooking(TENANT, BOOKING, deps())).resolves.toMatchObject({ status: "confirmed" });
  });

  it("an expired hold can't be confirmed", async () => {
    rpcHandlers.confirm_booking = () => ({ data: null, error: { code: "PA409", message: "confirm_booking: this booking is no longer held (expired)" } });
    await expect(confirmBooking(TENANT, BOOKING, deps())).rejects.toMatchObject({ code: "conflict" });
    expect(send).not.toHaveBeenCalled();
  });

  it("reschedule announces the old booking as changed and the new one as confirmed", async () => {
    const NEW = "4a2b1b4c-5d6e-4f70-8a91-b2c3d4e5f602";
    rpcHandlers.reschedule_booking = () => ok(bookingRow({ id: NEW, status: "confirmed", hold_expires_at: null, details: { rescheduled_from: BOOKING } }));
    const moved = await rescheduleBooking(TENANT, BOOKING, { start: "2026-10-10T08:00:00Z", end: "2026-10-10T09:00:00Z" }, deps());
    expect(moved.id).toBe(NEW);
    expect(send.mock.calls.map(([e]) => e)).toEqual([
      { id: `booking.changed:${BOOKING}:rescheduled`, name: "booking.changed", data: { tenantId: TENANT, bookingId: BOOKING, change: "rescheduled" } },
      { id: `booking.confirmed:${NEW}`, name: "booking.confirmed", data: { tenantId: TENANT, bookingId: NEW } },
    ]);
  });

  it("cancel keeps the reason and emits booking.changed", async () => {
    const seen: Record<string, unknown>[] = [];
    rpcHandlers.cancel_booking = (args) => {
      seen.push(args);
      return ok(bookingRow({ status: "cancelled", details: { cancel_reason: args.p_reason } }));
    };
    await cancelBooking(TENANT, BOOKING, "customer asked", deps());
    expect(seen[0]).toEqual({ p_tenant_id: TENANT, p_booking_id: BOOKING, p_reason: "customer asked" });
    expect(send).toHaveBeenCalledWith({
      id: `booking.changed:${BOOKING}:cancelled`,
      name: "booking.changed",
      data: { tenantId: TENANT, bookingId: BOOKING, change: "cancelled" },
    });
  });

  it("release-holds returns how many holds expired", async () => {
    rpcHandlers.release_expired_holds = () => ok(3);
    await expect(releaseExpiredHolds({ db: fakeDb() })).resolves.toBe(3);
  });
});
