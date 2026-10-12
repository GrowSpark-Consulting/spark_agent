import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../lib/errors";
import { fakeSupabase } from "../test-support/fake-supabase";

// The calendar's routes, /api/bookings/:id/(reschedule|cancel|complete|no-show|slots): how they are wired (who may
// call, which business, the id from the path, bodies that may be empty, errors as the envelope). What they do is
// booking/actions.test.ts.

const reschedule = vi.fn();
const cancel = vi.fn();
const complete = vi.fn();
const noShow = vi.fn();
const slots = vi.fn();
vi.mock("../booking/actions", () => ({
  rescheduleFromCalendar: (...args: unknown[]) => reschedule(...args),
  cancelFromCalendar: (...args: unknown[]) => cancel(...args),
  completeFromCalendar: (...args: unknown[]) => complete(...args),
  noShowFromCalendar: (...args: unknown[]) => noShow(...args),
  slotsForMove: (...args: unknown[]) => slots(...args),
}));

const { createApp } = await import("./app");

const FRONTEND = "https://app.pakkaagent.in";
const REALTY = "10000000-0000-0000-0000-000000000001";
const BOOKING = "b5000000-0000-4000-8000-0000000000a1";
const tenantRow = { id: REALTY, name: "Test Realty", vertical: "real-estate", timezone: "Asia/Kolkata", status: "trial", plan_key: "trial", trial_ends_at: null };
const ACCOUNTS: Record<string, { email: string; memberships: unknown[] }> = {
  "staff.token.sig": { email: "staff@test.local", memberships: [{ tenant_id: REALTY, role: "staff", tenants: tenantRow }] },
};

function fakeUserClient(token: string): SupabaseClient {
  const account = ACCOUNTS[token];
  const { client } = fakeSupabase({ memberships: { data: account?.memberships ?? [], error: null } });
  const getUser = async (jwt: string) => {
    const known = ACCOUNTS[jwt];
    return known
      ? { data: { user: { id: `user-${known.email}`, email: known.email } }, error: null }
      : { data: { user: null }, error: { __isAuthError: true, name: "AuthApiError", status: 401, message: "invalid JWT" } };
  };
  return Object.assign(client, { auth: { getUser } });
}

const app = createApp({ userClient: fakeUserClient, inngest: async () => Response.json({}), allowedOrigins: new Set([FRONTEND]) });
const headers = { authorization: "Bearer staff.token.sig", origin: FRONTEND };
const call = (method: string, path: string, body?: string) =>
  app(new Request(`http://localhost:4000${path}`, { method, headers: body === undefined ? headers : { ...headers, "content-type": "application/json" }, body }));

beforeEach(() => {
  for (const fn of [reschedule, cancel, complete, noShow, slots]) fn.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const staffOf = expect.objectContaining({ role: "staff", tenant: expect.objectContaining({ id: REALTY }) });

describe("/api/bookings/:id/...", () => {
  it("reschedule passes the body and the id from the path", async () => {
    reschedule.mockResolvedValue({ id: "new", status: "confirmed" });
    const body = { start: "2026-10-14T05:30:00Z", end: "2026-10-14T06:30:00Z" };
    const res = await call("POST", `/api/bookings/${BOOKING}/reschedule`, JSON.stringify(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "new", status: "confirmed" });
    expect(reschedule).toHaveBeenCalledWith(staffOf, BOOKING, body);
    expect(res.headers.get("access-control-allow-origin")).toBe(FRONTEND);
  });

  it("cancel takes an optional body: none at all, or a reason", async () => {
    cancel.mockResolvedValue({ status: "cancelled" });
    expect((await call("POST", `/api/bookings/${BOOKING}/cancel`)).status).toBe(200);
    expect(cancel).toHaveBeenLastCalledWith(staffOf, BOOKING, {});
    expect((await call("POST", `/api/bookings/${BOOKING}/cancel`, JSON.stringify({ reason: "Customer called" }))).status).toBe(200);
    expect(cancel).toHaveBeenLastCalledWith(staffOf, BOOKING, { reason: "Customer called" });
    const broken = await call("POST", `/api/bookings/${BOOKING}/cancel`, "{reason");
    expect(broken.status).toBe(422);
    expect(await broken.json()).toEqual({ error: { code: "validation_failed", message: "Send the details as JSON." } });
  });

  it.each([
    ["complete", complete],
    ["no-show", noShow],
  ] as const)("%s needs no body", async (name, service) => {
    service.mockResolvedValue({ status: name });
    const res = await call("POST", `/api/bookings/${BOOKING}/${name}`);
    expect(res.status).toBe(200);
    expect(service).toHaveBeenCalledWith(staffOf, BOOKING);
  });

  it("slots reads the window from the query string", async () => {
    slots.mockResolvedValue({ slots: [] });
    const res = await call("GET", `/api/bookings/${BOOKING}/slots?from=2026-10-20T00:00:00Z`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slots: [] });
    expect((slots.mock.calls[0][2] as URLSearchParams).get("from")).toBe("2026-10-20T00:00:00Z");
  });

  it("answers a refusal as the error envelope with its status", async () => {
    complete.mockRejectedValue(new AppError("conflict", "This booking has not started yet."));
    const res = await call("POST", `/api/bookings/${BOOKING}/complete`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "conflict", message: "This booking has not started yet." } });
    reschedule.mockRejectedValue(new AppError("slot_taken", "That time was just taken. Pick another one."));
    expect((await call("POST", `/api/bookings/${BOOKING}/reschedule`, "{}")).status).toBe(409);
  });

  it("is refused without a signed-in caller, and never reaches the service", async () => {
    const res = await app(new Request(`http://localhost:4000/api/bookings/${BOOKING}/complete`, { method: "POST", headers: { origin: FRONTEND } }));
    expect(res.status).toBe(401);
    expect(complete).not.toHaveBeenCalled();
  });
});
