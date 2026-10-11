import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "../test-support/fake-supabase";

// POST /api/conversations/:id/suggest: how the route is wired (who may call, which business, which id comes from the path, a POST with no body for the browser).
// What the answer holds is agent/leadcard/suggest.test.ts.

const suggestReply = vi.fn();
vi.mock("../agent/leadcard/suggest", () => ({ suggestReply: (...args: unknown[]) => suggestReply(...args) }));

const { createApp } = await import("./app");

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
const post = (headers: Record<string, string> = {}) => app(new Request(`http://localhost:4000/api/conversations/${CHAT}/suggest`, { method: "POST", headers }));

beforeEach(() => {
  suggestReply.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/conversations/:id/suggest", () => {
  it("answers 200 with the suggestion, for the caller's business, handing the service the id from the path (no body needed)", async () => {
    const answer = { reply: "Sure, 3pm works.", language: "en", reason: null };
    suggestReply.mockResolvedValue(answer);
    const res = await post(as("staff.token.sig"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(answer);
    expect(res.headers.get("access-control-allow-origin")).toBe(FRONTEND);
    expect(suggestReply).toHaveBeenCalledWith(expect.objectContaining({ role: "staff", tenant: expect.objectContaining({ id: REALTY }) }), CHAT);
  });

  it("takes the business from X-Pakka-Tenant only if it is one of the caller's own", async () => {
    suggestReply.mockResolvedValue({});
    await post(as("multi.token.sig", { "x-pakka-tenant": SALON }));
    expect(suggestReply.mock.calls[0][0].tenant.id).toBe(SALON);
    suggestReply.mockClear();
    await post(as("staff.token.sig", { "x-pakka-tenant": SALON }));
    expect(suggestReply.mock.calls[0][0].tenant.id).toBe(REALTY);
  });

  it("is refused without a signed-in caller, and never reaches the service", async () => {
    expect((await post({ origin: FRONTEND })).status).toBe(401);
    expect((await post(as("nobody.token.sig"))).status).toBe(401);
    expect(suggestReply).not.toHaveBeenCalled();
  });

  it("is a POST only", async () => {
    expect((await app(new Request(`http://localhost:4000/api/conversations/${CHAT}/suggest`, { method: "GET", headers: as("staff.token.sig") }))).status).toBe(405);
  });
});
