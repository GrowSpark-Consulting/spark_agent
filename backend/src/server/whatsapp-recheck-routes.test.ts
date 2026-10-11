import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "../test-support/fake-supabase";

// POST /api/whatsapp/connections/:id/recheck and /disconnect: how the routes are wired (who may call, which business, which id comes from the path, browser CORS).
// What they do is channels/whatsapp/connect/recheck.test.ts.

const recheck = vi.fn();
const disconnect = vi.fn();
vi.mock("../channels/whatsapp/connect/recheck", () => ({
  recheckConnection: (...args: unknown[]) => recheck(...args),
  disconnectConnection: (...args: unknown[]) => disconnect(...args),
}));

const { createApp } = await import("./app");

const FRONTEND = "https://app.pakkaagent.in";
const REALTY = "10000000-0000-0000-0000-000000000001";
const SALON = "10000000-0000-0000-0000-000000000002";
const CONN = "d4000000-0000-4000-8000-0000000000a1";
const tenantRow = (id: string, name: string) => ({ id, name, vertical: "real-estate", timezone: "Asia/Kolkata", status: "trial", plan_key: "trial", trial_ends_at: null });
const member = (id: string, name: string, role: string) => ({ tenant_id: id, role, tenants: tenantRow(id, name) });
const ACCOUNTS: Record<string, { email: string; memberships: unknown[] }> = {
  "owner.token.sig": { email: "owner@test.local", memberships: [member(REALTY, "Test Realty", "owner")] },
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
const post = (path: string, headers: Record<string, string> = {}) => app(new Request(`http://localhost:4000${path}`, { method: "POST", headers }));

beforeEach(() => {
  recheck.mockReset();
  disconnect.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe.each([
  ["recheck", recheck],
  ["disconnect", disconnect],
] as const)("POST /api/whatsapp/connections/:id/%s", (name, service) => {
  const path = `/api/whatsapp/connections/${CONN}/${name}`;

  it("answers 200 with the connection, for the caller's business, handing the service the id from the path (no body needed)", async () => {
    const connection = { id: CONN, status: name === "recheck" ? "active" : "disconnected" };
    service.mockResolvedValue(connection);
    const res = await post(path, as("owner.token.sig"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(connection);
    expect(res.headers.get("access-control-allow-origin")).toBe(FRONTEND);
    expect(service).toHaveBeenCalledWith(expect.objectContaining({ role: "owner", tenant: expect.objectContaining({ id: REALTY }) }), CONN);
  });

  it("takes the business from X-Pakka-Tenant only if it is one of the caller's own", async () => {
    service.mockResolvedValue({});
    await post(path, as("multi.token.sig", { "x-pakka-tenant": SALON }));
    expect(service.mock.calls[0][0].tenant.id).toBe(SALON);
    service.mockClear();
    await post(path, as("owner.token.sig", { "x-pakka-tenant": SALON }));
    expect(service.mock.calls[0][0].tenant.id).toBe(REALTY);
  });

  it("is refused without a signed-in caller, and never reaches the service", async () => {
    expect((await post(path, { origin: FRONTEND })).status).toBe(401);
    expect((await post(path, as("nobody.token.sig"))).status).toBe(401);
    expect(service).not.toHaveBeenCalled();
  });

  it("answers the service's refusal in the usual envelope", async () => {
    const { AppError } = await import("../lib/errors");
    service.mockRejectedValue(new AppError("forbidden", "Only an owner or admin can do this."));
    const res = await post(path, as("owner.token.sig"));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "forbidden" } });
  });

  it("is a POST only", async () => {
    expect((await app(new Request(`http://localhost:4000${path}`, { method: "GET", headers: as("owner.token.sig") }))).status).toBe(405);
  });
});
