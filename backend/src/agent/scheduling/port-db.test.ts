import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { Booking, Slot } from "../../booking/bookings";
import { createSchedulingDeps, type BookingFunctions } from "./port-db";

const T = "e0000000-0000-0000-0000-00000000000a";
const LEAD = "10000000-0000-0000-0000-0000000000f1";
const SERVICE = "30000000-0000-0000-0000-000000000003";
const RES = "20000000-0000-0000-0000-000000000002";
const BOOKING = "40000000-0000-0000-0000-000000000004";
const NEW_BOOKING = "60000000-0000-0000-0000-000000000006";
const NOW = new Date("2026-10-10T04:30:00.000Z");

// A query builder that records what was asked and answers with `result`, like the supabase client (every call returns the builder; awaiting it gives the result).
function fakeDb(results: Record<string, { data?: unknown; error?: { code?: string } | null }>) {
  const calls: { table: string; select: string; filters: [string, string, unknown][]; limit?: number; order?: string }[] = [];
  const db = {
    from(table: string) {
      const call: (typeof calls)[number] = { table, select: "", filters: [] };
      calls.push(call);
      const builder = {
        select: (columns: string) => ((call.select = columns), builder),
        eq: (column: string, value: unknown) => (call.filters.push([column, "eq", value]), builder),
        in: (column: string, value: unknown) => (call.filters.push([column, "in", value]), builder),
        gt: (column: string, value: unknown) => (call.filters.push([column, "gt", value]), builder),
        order: (column: string) => ((call.order = column), builder),
        limit: (n: number) => ((call.limit = n), builder),
        abortSignal: () => builder,
        maybeSingle: () => builder,
        then: (resolve: (value: unknown) => unknown) => resolve({ data: results[table]?.data ?? null, error: results[table]?.error ?? null }),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { db, calls };
}

const slot: Slot = { start: "2026-10-11T04:30:00.000Z", end: "2026-10-11T05:30:00.000Z", resourceId: RES, resourceName: "Anand", serviceId: SERVICE, label: "Sun 11 Oct, 10:00 am" };
const booking = { id: BOOKING, tenantId: T, leadId: LEAD } as Booking;

function build(results: Parameters<typeof fakeDb>[0] = {}, functions: Partial<BookingFunctions> = {}, enabled = true) {
  const { db, calls } = fakeDb(results);
  const fns: BookingFunctions = {
    findSlots: vi.fn(async () => [slot]),
    holdSlot: vi.fn(async () => booking),
    confirmBooking: vi.fn(async () => booking),
    rescheduleBooking: vi.fn(async () => ({ ...booking, id: NEW_BOOKING })),
    cancelBooking: vi.fn(async () => undefined),
    ...functions,
  };
  const deps = createSchedulingDeps({ db, functions: fns, isEnabled: vi.fn(async () => enabled), now: () => NOW });
  return { deps, calls, fns };
}

describe("the calendar, through Dev 2's booking functions", () => {
  it("finds times with the booking engine, for this business, and gives them as they are", async () => {
    const { deps, fns } = build();
    const from = new Date("2026-10-11T03:30:00.000Z");
    const to = new Date("2026-10-11T06:30:00.000Z");
    expect(await deps.port.findSlots(T, { serviceId: SERVICE, from, to })).toEqual([slot]);
    expect(fns.findSlots).toHaveBeenCalledWith(T, { serviceId: SERVICE, from, to });
  });

  it("holds a time for the lead as the kind of booking the business takes, then confirms it", async () => {
    const { deps, fns } = build();
    expect(await deps.port.holdSlot(T, { start: slot.start, end: slot.end, resourceId: RES, serviceId: SERVICE, label: slot.label }, LEAD, "site_visit")).toEqual({ id: BOOKING });
    expect(fns.holdSlot).toHaveBeenCalledWith(T, { start: slot.start, end: slot.end, resourceId: RES, serviceId: SERVICE }, LEAD, { kind: "site_visit" });
    expect(await deps.port.confirmBooking(T, BOOKING)).toEqual({ id: BOOKING });
    expect(fns.confirmBooking).toHaveBeenCalledWith(T, BOOKING);
  });

  it("moves a booking to the time the customer picked, and cancels one with the reason it is given", async () => {
    const { deps, fns } = build();
    expect(await deps.port.rescheduleBooking(T, BOOKING, { start: slot.start, end: slot.end, resourceId: RES, serviceId: SERVICE, label: slot.label })).toEqual({ id: NEW_BOOKING });
    expect(fns.rescheduleBooking).toHaveBeenCalledWith(T, BOOKING, { start: slot.start, end: slot.end, resourceId: RES });
    await deps.port.cancelBooking(T, BOOKING, "asked in chat");
    expect(fns.cancelBooking).toHaveBeenCalledWith(T, BOOKING, "asked in chat");
  });

  it("is switched on by the business's booking feature", async () => {
    expect(await build({}, {}, true).deps.isEnabled(T, "booking")).toBe(true);
    expect(await build({}, {}, false).deps.isEnabled(T, "booking")).toBe(false);
  });
});

describe("what is read about the business (read only, always for this business)", () => {
  it("its active services, by id", async () => {
    const { deps, calls } = build({ services: { data: [{ id: SERVICE, name: "Site visit" }, { id: "30000000-0000-0000-0000-000000000009" }] } });
    expect(await deps.services(T)).toEqual([{ id: SERVICE }, { id: "30000000-0000-0000-0000-000000000009" }]);
    expect(calls[0]).toMatchObject({ table: "services", select: "id" });
    expect(calls[0].filters).toEqual([["tenant_id", "eq", T], ["active", "eq", true]]);
    expect(calls[0].limit).toBeLessThanOrEqual(5);
  });

  it("services that are not rows are left out, and a database error is thrown with its code only", async () => {
    expect(await build({ services: { data: [{ id: 5 }, null, "x", { id: SERVICE }] } }).deps.services(T)).toEqual([{ id: SERVICE }]);
    await expect(build({ services: { error: { code: "42501" } } }).deps.services(T)).rejects.toThrow("database error 42501");
  });

  it("its time zone", async () => {
    const { deps, calls } = build({ tenants: { data: { timezone: "Asia/Kolkata" } } });
    expect(await deps.timeZone(T)).toBe("Asia/Kolkata");
    expect(calls[0]).toMatchObject({ table: "tenants", select: "timezone" });
    expect(calls[0].filters).toEqual([["id", "eq", T]]);
  });

  it("a business with no usable time zone falls back to Asia/Kolkata (the product's default), never the server's", async () => {
    expect(await build({ tenants: { data: null } }).deps.timeZone(T)).toBe("Asia/Kolkata");
    expect(await build({ tenants: { data: { timezone: "Not/AZone" } } }).deps.timeZone(T)).toBe("Asia/Kolkata");
    expect(await build({ tenants: { data: { timezone: 5 } } }).deps.timeZone(T)).toBe("Asia/Kolkata");
  });
});

describe("the lead's next booking", () => {
  const row = (over: Record<string, unknown> = {}) => ({ id: BOOKING, status: "confirmed", start_at: "2026-10-11T04:30:00.000Z", end_at: "2026-10-11T05:30:00.000Z", hold_expires_at: null, ...over });

  it("is asked for this lead of this business, among held and confirmed bookings that have not ended, soonest first", async () => {
    const { deps, calls } = build({ bookings: { data: [row()] } });
    expect(await deps.port.activeBooking(T, LEAD)).toEqual({ id: BOOKING, start: "2026-10-11T04:30:00.000Z", end: "2026-10-11T05:30:00.000Z", status: "confirmed" });
    expect(calls[0]).toMatchObject({ table: "bookings", order: "start_at" });
    expect(calls[0].filters).toEqual([["tenant_id", "eq", T], ["lead_id", "eq", LEAD], ["status", "in", ["held", "confirmed"]], ["end_at", "gt", NOW.toISOString()]]);
  });

  it("a hold that has run out is not a booking", async () => {
    const expired = row({ status: "held", hold_expires_at: "2026-10-10T04:00:00.000Z" });
    expect(await build({ bookings: { data: [expired] } }).deps.port.activeBooking(T, LEAD)).toBeNull();
    const live = row({ status: "held", hold_expires_at: "2026-10-10T04:40:00.000Z" });
    expect(await build({ bookings: { data: [live] } }).deps.port.activeBooking(T, LEAD)).toMatchObject({ status: "held" });
  });

  it("none, or rows that are not rows, is null; a database error is thrown with its code only", async () => {
    expect(await build({ bookings: { data: [] } }).deps.port.activeBooking(T, LEAD)).toBeNull();
    expect(await build({ bookings: { data: [{ id: 1 }, null] } }).deps.port.activeBooking(T, LEAD)).toBeNull();
    await expect(build({ bookings: { error: { code: "42501" } } }).deps.port.activeBooking(T, LEAD)).rejects.toThrow("database error 42501");
  });
});
