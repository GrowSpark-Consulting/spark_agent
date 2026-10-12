import type { TenantContext } from "@pakka/types";
import { describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeDbResponse } from "../test-support/fake-db";
import {
  cancelFromCalendar,
  completeFromCalendar,
  MOVE_WINDOW_DAYS,
  noShowFromCalendar,
  rescheduleFromCalendar,
  slotsForMove,
  type BookingActionDeps,
} from "./actions";

const TENANT = "3d2c1b0a-9f8e-4d7c-8b6a-5f4e3d2c1b0a";
const OWNER = "8a7b6c5d-4e3f-4a1b-9c8d-7e6f5a4b3c2d";
const STAFF = "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b";
const OTHER_STAFF = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b";
const BOOKING = "6c5b4a39-2817-4f06-9e5d-4c3b2a190807";
const NEW_BOOKING = "0a1b2c3d-4e5f-4061-8728-394a5b6c7d8e";
const RESOURCE = "2b3c4d5e-6f70-4182-9394-a5b6c7d8e9f0";
const OTHER_RESOURCE = "4d5e6f70-8192-43a4-b5c6-d7e8f9a0b1c2";
const SERVICE = "5e6f7081-92a3-44b5-86c7-d8e9f0a1b2c3";
const LEAD = "7f8091a2-b3c4-45d6-97e8-f9a0b1c2d3e4";

const context = (role: TenantContext["role"] = "owner", userId = role === "staff" ? STAFF : OWNER): TenantContext => ({
  user: { id: userId, email: null },
  role,
  tenant: { id: TENANT, name: "Skyline Homes", vertical: "real-estate", timezone: "Asia/Kolkata", status: "active", planKey: "growth", trialEndsAt: null },
});

const row = (overrides: Record<string, unknown> = {}) => ({
  id: BOOKING,
  tenant_id: TENANT,
  lead_id: LEAD,
  resource_id: RESOURCE,
  service_id: SERVICE,
  kind: "site_visit",
  start_at: "2026-10-12T05:30:00+00:00",
  end_at: "2026-10-12T06:30:00+00:00",
  status: "confirmed",
  hold_expires_at: null,
  details: {},
  ...overrides,
});

function deps(options: { booking?: FakeDbResponse; rpc?: Record<string, FakeDbResponse> } = {}) {
  const responses: Record<string, FakeDbResponse> = {
    bookings: options.booking ?? { data: { id: BOOKING, status: "confirmed", service_id: SERVICE, resource_id: RESOURCE, resources: { user_id: STAFF } }, error: null },
  };
  for (const [name, response] of Object.entries(options.rpc ?? {})) responses[`rpc:${name}`] = response;
  const db = fakeDb(responses);
  const send = vi.fn(async () => undefined);
  const slots = vi.fn(async () => [{ start: "2026-10-13T05:30:00.000Z", end: "2026-10-13T06:30:00.000Z", resourceId: RESOURCE, resourceName: "Asha", serviceId: SERVICE, label: "Tue 13 Oct, 11:00 am" }]);
  const actionDeps: BookingActionDeps = { db: db.client, now: () => new Date("2026-10-12T06:00:00Z"), send, slots };
  return { actionDeps, calls: db.calls, send, slots };
}

const rpcArgs = (calls: { table: string; args: unknown[] }[], name: string) => calls.find((c) => c.table === `rpc:${name}`)?.args[0];

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (e) {
    return e as { code: string; message: string };
  }
  throw new Error("expected a refusal");
}

describe("who may act on a booking", () => {
  it("lets owners and admins act on any booking, and staff only on their own calendar's", async () => {
    const theirs = deps({ booking: { data: { id: BOOKING, status: "confirmed", service_id: SERVICE, resource_id: RESOURCE, resources: { user_id: OTHER_STAFF } }, error: null } });
    expect(await refusal(completeFromCalendar(context("staff"), BOOKING, theirs.actionDeps))).toMatchObject({
      code: "forbidden",
      message: "Staff can change only the bookings in their own calendar.",
    });

    const own = deps({ rpc: { complete_booking: { data: row({ status: "completed" }), error: null } } });
    expect((await completeFromCalendar(context("staff"), BOOKING, own.actionDeps)).status).toBe("completed");

    const admin = deps({ booking: { data: { id: BOOKING, status: "confirmed", service_id: SERVICE, resource_id: RESOURCE, resources: { user_id: OTHER_STAFF } }, error: null }, rpc: { complete_booking: { data: row({ status: "completed" }), error: null } } });
    expect((await completeFromCalendar(context("admin"), BOOKING, admin.actionDeps)).status).toBe("completed");
  });

  it("finds only the business's own bookings", async () => {
    const missing = deps({ booking: { data: null, error: null } });
    expect(await refusal(cancelFromCalendar(context(), BOOKING, {}, missing.actionDeps))).toMatchObject({ code: "not_found", message: "That booking wasn't found." });
    const filters = missing.calls.filter((c) => c.table === "bookings" && c.method === "eq").map((c) => c.args);
    expect(filters).toEqual([["tenant_id", TENANT], ["id", BOOKING]]);
    // An id that is not a uuid never reaches the database.
    const { actionDeps, calls } = deps();
    expect((await refusal(noShowFromCalendar(context(), "../../etc", actionDeps))).code).toBe("not_found");
    expect(calls).toHaveLength(0);
  });
});

describe("POST /api/bookings/:id/reschedule", () => {
  const body = { start: "2026-10-14T05:30:00.000Z", end: "2026-10-14T06:30:00.000Z" };

  it("moves the booking as the member and tells the jobs: the old one changed, the new one is confirmed", async () => {
    const { actionDeps, calls, send } = deps({ rpc: { staff_reschedule_booking: { data: row({ id: NEW_BOOKING, start_at: body.start, end_at: body.end }), error: null } } });
    const moved = await rescheduleFromCalendar(context(), BOOKING, body, actionDeps);
    expect(moved).toMatchObject({ id: NEW_BOOKING, status: "confirmed", start: body.start });
    expect(rpcArgs(calls, "staff_reschedule_booking")).toEqual({
      p_tenant_id: TENANT,
      p_booking_id: BOOKING,
      p_start: body.start,
      p_end: body.end,
      p_resource_id: null,
      p_actor: OWNER,
    });
    expect(send.mock.calls.map((c) => c[0])).toEqual([
      { id: `booking.changed:${BOOKING}:rescheduled`, name: "booking.changed", data: { tenantId: TENANT, bookingId: BOOKING, change: "rescheduled" } },
      { id: `booking.confirmed:${NEW_BOOKING}`, name: "booking.confirmed", data: { tenantId: TENANT, bookingId: NEW_BOOKING } },
    ]);
  });

  it("refuses times that are not ISO 8601 with an offset, and fields it does not know", async () => {
    const { actionDeps } = deps();
    expect((await refusal(rescheduleFromCalendar(context(), BOOKING, { start: "tomorrow", end: body.end }, actionDeps))).code).toBe("validation_failed");
    expect((await refusal(rescheduleFromCalendar(context(), BOOKING, { ...body, status: "confirmed" }, actionDeps))).code).toBe("validation_failed");
  });

  it("keeps staff to their own calendar", async () => {
    const { actionDeps } = deps();
    expect(await refusal(rescheduleFromCalendar(context("staff"), BOOKING, { ...body, resourceId: OTHER_RESOURCE }, actionDeps))).toMatchObject({
      code: "forbidden",
      message: "Staff can move a booking only within their own calendar.",
    });
  });

  it("says a time someone else took is taken, and a booking in the wrong state can't move", async () => {
    const taken = deps({ rpc: { staff_reschedule_booking: { data: null, error: { code: "23P01", message: "conflicting key value violates exclusion constraint" } } } });
    expect(await refusal(rescheduleFromCalendar(context(), BOOKING, body, taken.actionDeps))).toMatchObject({ code: "slot_taken" });
    expect(taken.send).not.toHaveBeenCalled();
    const wrong = deps({ rpc: { staff_reschedule_booking: { data: null, error: { code: "PA409", message: "reschedule_booking: only a confirmed booking can be moved (cancelled)" } } } });
    expect(await refusal(rescheduleFromCalendar(context(), BOOKING, body, wrong.actionDeps))).toMatchObject({
      code: "conflict",
      message: "Only a confirmed booking can be moved (cancelled).",
    });
  });
});

describe("POST /api/bookings/:id/cancel", () => {
  it("cancels with or without a reason and tells the jobs", async () => {
    const { actionDeps, calls, send } = deps({ rpc: { staff_cancel_booking: { data: row({ status: "cancelled" }), error: null } } });
    expect((await cancelFromCalendar(context(), BOOKING, {}, actionDeps)).status).toBe("cancelled");
    expect(rpcArgs(calls, "staff_cancel_booking")).toEqual({ p_tenant_id: TENANT, p_booking_id: BOOKING, p_reason: null, p_actor: OWNER });
    expect(send).toHaveBeenCalledWith({ id: `booking.changed:${BOOKING}:cancelled`, name: "booking.changed", data: { tenantId: TENANT, bookingId: BOOKING, change: "cancelled" } });

    const withReason = deps({ rpc: { staff_cancel_booking: { data: row({ status: "cancelled" }), error: null } } });
    await cancelFromCalendar(context(), BOOKING, { reason: "  Customer called  " }, withReason.actionDeps);
    expect(rpcArgs(withReason.calls, "staff_cancel_booking")).toMatchObject({ p_reason: "Customer called" });
    expect((await refusal(cancelFromCalendar(context(), BOOKING, { reason: "x".repeat(501) }, deps().actionDeps))).code).toBe("validation_failed");
  });
});

describe("POST /api/bookings/:id/complete and /no-show", () => {
  it("marks a visit and tells the jobs (the post-visit run goes on)", async () => {
    const { actionDeps, calls, send } = deps({ rpc: { complete_booking: { data: row({ status: "completed" }), error: null } } });
    await completeFromCalendar(context(), BOOKING, actionDeps);
    expect(rpcArgs(calls, "complete_booking")).toEqual({ p_tenant_id: TENANT, p_booking_id: BOOKING, p_actor: OWNER });
    expect(send).toHaveBeenCalledWith({ id: `booking.changed:${BOOKING}:completed`, name: "booking.changed", data: { tenantId: TENANT, bookingId: BOOKING, change: "completed" } });
  });

  it("marks a no-show and tells the jobs (the rebooking offer follows)", async () => {
    const { actionDeps, send } = deps({ rpc: { mark_booking_no_show: { data: row({ status: "no_show" }), error: null } } });
    expect((await noShowFromCalendar(context(), BOOKING, actionDeps)).status).toBe("no_show");
    expect(send).toHaveBeenCalledWith({ id: `booking.changed:${BOOKING}:no_show`, name: "booking.changed", data: { tenantId: TENANT, bookingId: BOOKING, change: "no_show" } });
  });

  it("says plainly when a booking has not started yet", async () => {
    const { actionDeps, send } = deps({ rpc: { complete_booking: { data: null, error: { code: "PA409", message: "complete_booking: this booking has not started yet" } } } });
    expect(await refusal(completeFromCalendar(context(), BOOKING, actionDeps))).toMatchObject({ code: "conflict", message: "This booking has not started yet." });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("GET /api/bookings/:id/slots", () => {
  it("offers times for the booking's service, a week from now unless asked otherwise", async () => {
    const { actionDeps, slots } = deps();
    const answer = await slotsForMove(context(), BOOKING, new URLSearchParams(), actionDeps);
    expect(answer.slots).toHaveLength(1);
    expect(slots).toHaveBeenCalledWith(TENANT, {
      serviceId: SERVICE,
      from: new Date("2026-10-12T06:00:00Z"),
      to: new Date(Date.parse("2026-10-12T06:00:00Z") + MOVE_WINDOW_DAYS * 24 * 60 * 60_000),
    });

    await slotsForMove(context(), BOOKING, new URLSearchParams({ from: "2026-10-20T00:00:00Z", to: "2026-10-21T00:00:00Z" }), actionDeps);
    expect(slots).toHaveBeenLastCalledWith(TENANT, { serviceId: SERVICE, from: new Date("2026-10-20T00:00:00Z"), to: new Date("2026-10-21T00:00:00Z") });
    expect((await refusal(slotsForMove(context(), BOOKING, new URLSearchParams({ from: "soon" }), actionDeps))).code).toBe("validation_failed");
  });

  it("only for a confirmed booking with a service", async () => {
    const cancelled = deps({ booking: { data: { id: BOOKING, status: "cancelled", service_id: SERVICE, resource_id: RESOURCE, resources: null }, error: null } });
    expect(await refusal(slotsForMove(context(), BOOKING, new URLSearchParams(), cancelled.actionDeps))).toMatchObject({ code: "conflict", message: "Only a confirmed booking can be moved." });
    const callback = deps({ booking: { data: { id: BOOKING, status: "confirmed", service_id: null, resource_id: null, resources: null }, error: null } });
    expect((await refusal(slotsForMove(context(), BOOKING, new URLSearchParams(), callback.actionDeps))).code).toBe("conflict");
  });
});
