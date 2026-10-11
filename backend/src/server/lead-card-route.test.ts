import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "../test-support/fake-supabase";
import { errorOf } from "../test-support/http";

// GET /api/conversations/:id/lead-card: how the route is wired (who may call, which business, which id comes from the path, that it is a GET read
// for the browser). What the card holds is agent/leadcard/*.test.ts.

const getLeadCard = vi.fn();
vi.mock("../agent/leadcard/route", () => ({ getLeadCard: (...args: unknown[]) => getLeadCard(...args) }));

const { createApp } = await import("./app");
const { AppError } = await import("../lib/errors");

const FRONTEND = "https://app.pakkaagent.in";
const REALTY = "10000000-0000-0000-0000-000000000001";
const SALON = "10000000-0000-0000-0000-000000000002";
const CHAT = "40000000-0000-4000-8000-000000000001";
const tenantRow = (id: string, name: string) => ({ id, name, vertical: "real-estate", timezone: "Asia/Kolkata", status: "trial", plan_key: "trial", trial_ends_at: null });
const member = (id: string, name: string, role: string) => ({ tenant_id: id, role, tenants: tenantRow(id, name) });

const ACCOUNTS: Record<string, { email: string; memberships: unknown[] }> = {
  "staff.token.sig": { email: "staff@test.local", memberships: [member(REALTY, "Test Realty", "staff")] },
  "multi.token.sig": { email: "multi@test.local", memberships: [member(REALTY, "Test Realty", "owner"), member(SALON, "Beta Salon", "admin")] },
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
const as = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, origin: FRONTEND, ...extra });
const get = (path: string, headers: Record<string, string> = {}) => app(new Request(`http://localhost:4000${path}`, { method: "GET", headers }));

beforeEach(() => {
  getLeadCard.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/conversations/:id/lead-card", () => {
  it("answers 200 with the card, for the caller's business, handing the service the id from the path", async () => {
    const card = { need: "Wants a flat in Velachery", isHot: true };
    getLeadCard.mockResolvedValue(card);
    const res = await get(`/api/conversations/${CHAT}/lead-card`, as("staff.token.sig"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(card);
    expect(res.headers.get("access-control-allow-origin")).toBe(FRONTEND);
    expect(getLeadCard).toHaveBeenCalledWith(expect.objectContaining({ role: "staff", tenant: expect.objectContaining({ id: REALTY }) }), CHAT);
  });

  it("takes the business from X-Pakka-Tenant only if it is one of the caller's own", async () => {
    getLeadCard.mockResolvedValue({});
    await get(`/api/conversations/${CHAT}/lead-card`, as("multi.token.sig", { "x-pakka-tenant": SALON }));
    expect(getLeadCard.mock.calls[0][0].tenant.id).toBe(SALON);
    getLeadCard.mockClear();
    await get(`/api/conversations/${CHAT}/lead-card`, as("staff.token.sig", { "x-pakka-tenant": SALON }));
    expect(getLeadCard.mock.calls[0][0].tenant.id).toBe(REALTY);
  });

  it("is refused without a signed-in caller, and never reaches the service", async () => {
    expect((await get(`/api/conversations/${CHAT}/lead-card`, { origin: FRONTEND })).status).toBe(401);
    expect((await get(`/api/conversations/${CHAT}/lead-card`, as("nobody.token.sig"))).status).toBe(401);
    expect(getLeadCard).not.toHaveBeenCalled();
  });

  it("is a 404 for a chat that is not the business's, with the service's own words", async () => {
    getLeadCard.mockRejectedValue(new AppError("not_found", "That conversation was not found."));
    const res = await get(`/api/conversations/${CHAT}/lead-card`, as("staff.token.sig"));
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toMatchObject({ code: "not_found" });
  });

  it("only reads: it is a GET and nothing else", async () => {
    getLeadCard.mockResolvedValue({});
    const res = await app(new Request(`http://localhost:4000/api/conversations/${CHAT}/lead-card`, { method: "POST", headers: { ...as("staff.token.sig"), "content-type": "application/json" }, body: "{}" }));
    expect(res.status).toBe(405);
    expect(getLeadCard).not.toHaveBeenCalled();
  });

  it("an unexpected failure is a 500 with nothing from inside it", async () => {
    getLeadCard.mockRejectedValue(new Error("secret internal detail"));
    const res = await get(`/api/conversations/${CHAT}/lead-card`, as("staff.token.sig"));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("secret internal detail");
  });
});
