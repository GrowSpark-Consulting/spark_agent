import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "../test-support/fake-supabase";
import { errorOf } from "../test-support/http";

// The outbound webhook routes: how they are wired (who may call, which business, which status). What the service does is
// tested in outbound-webhooks/endpoint.test.ts.

const service = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), rotate: vi.fn(), remove: vi.fn(), test: vi.fn() }));
vi.mock("../outbound-webhooks/endpoint", () => ({
  getWebhookSettings: (...args: unknown[]) => service.get(...args),
  saveWebhookEndpoint: (...args: unknown[]) => service.save(...args),
  rotateWebhookSecret: (...args: unknown[]) => service.rotate(...args),
  deleteWebhookEndpoint: (...args: unknown[]) => service.remove(...args),
  testWebhook: (...args: unknown[]) => service.test(...args),
}));

const { createApp } = await import("./app");
const { AppError } = await import("../lib/errors");

const FRONTEND = "https://app.pakkaagent.in";
const PRO = "10000000-0000-0000-0000-000000000001";
const OTHER = "10000000-0000-0000-0000-000000000002";
const tenantRow = (id: string, name: string) => ({ id, name, vertical: "real-estate", timezone: "Asia/Kolkata", status: "active", plan_key: "pro", trial_ends_at: null });
const member = (id: string, name: string, role: string) => ({ tenant_id: id, role, tenants: tenantRow(id, name) });

const ACCOUNTS: Record<string, { email: string; memberships: unknown[] }> = {
  "owner.token.sig": { email: "owner@test.local", memberships: [member(PRO, "Pro Realty", "owner")] },
  "multi.token.sig": { email: "multi@test.local", memberships: [member(PRO, "Pro Realty", "owner"), member(OTHER, "Other", "admin")] },
};

function fakeUserClient(token: string): SupabaseClient {
  const { client } = fakeSupabase({ memberships: { data: ACCOUNTS[token]?.memberships ?? [], error: null } });
  const getUser = async (jwt: string) =>
    ACCOUNTS[jwt]
      ? { data: { user: { id: `user-${ACCOUNTS[jwt].email}`, email: ACCOUNTS[jwt].email } }, error: null }
      : { data: { user: null }, error: { __isAuthError: true, name: "AuthApiError", status: 401, message: "invalid JWT" } };
  return Object.assign(client, { auth: { getUser } });
}

const app = createApp({ userClient: fakeUserClient, inngest: async () => Response.json({}), allowedOrigins: new Set([FRONTEND]) });
const as = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, origin: FRONTEND, ...extra });
const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  app(new Request(`http://localhost:4000${path}`, { method, headers: { ...headers, ...(body !== undefined && { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) }));
const tenantOf = (mock: ReturnType<typeof vi.fn>) => mock.mock.calls[0][0].tenant.id;

beforeEach(() => {
  for (const mock of Object.values(service)) mock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("/api/integrations/webhook", () => {
  it("GET answers the settings for the member's business", async () => {
    service.get.mockResolvedValue({ inPlan: true, sending: false, endpoint: null });
    const res = await call("GET", "/api/integrations/webhook", as("owner.token.sig"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inPlan: true, sending: false, endpoint: null });
    expect(tenantOf(service.get)).toBe(PRO);
  });

  it("PUT hands the body to the service and answers what it saved", async () => {
    service.save.mockResolvedValue({ endpoint: { url: "https://crm.example.in/in" }, secret: "whsec_x" });
    const res = await call("PUT", "/api/integrations/webhook", as("multi.token.sig", { "x-pakka-tenant": OTHER }), { url: "https://crm.example.in/in", events: ["lead.created"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ endpoint: { url: "https://crm.example.in/in" }, secret: "whsec_x" });
    expect(tenantOf(service.save)).toBe(OTHER);
    expect(service.save.mock.calls[0][1]).toEqual({ url: "https://crm.example.in/in", events: ["lead.created"] });
  });

  it("DELETE answers 204 with no body", async () => {
    service.remove.mockResolvedValue(undefined);
    const res = await call("DELETE", "/api/integrations/webhook", as("owner.token.sig"));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("rotate-secret and test need no body", async () => {
    service.rotate.mockResolvedValue({ secret: "whsec_new", secretHint: "_new" });
    service.test.mockResolvedValue({ delivered: true, status: 200, error: null });
    expect(await (await call("POST", "/api/integrations/webhook/rotate-secret", as("owner.token.sig"))).json()).toEqual({ secret: "whsec_new", secretHint: "_new" });
    expect(await (await call("POST", "/api/integrations/webhook/test", as("owner.token.sig"))).json()).toEqual({ delivered: true, status: 200, error: null });
  });

  it("turns the service's refusals into the envelope", async () => {
    service.save.mockRejectedValue(new AppError("plan_required", "Outbound webhooks needs the Pro plan."));
    const res = await call("PUT", "/api/integrations/webhook", as("owner.token.sig"), { url: "https://crm.example.in/in", events: ["lead.created"] });
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toEqual({ code: "plan_required", message: "Outbound webhooks needs the Pro plan." });
  });

  it("needs a signed-in member, and runs nothing otherwise", async () => {
    for (const [method, path] of [
      ["GET", "/api/integrations/webhook"],
      ["PUT", "/api/integrations/webhook"],
      ["DELETE", "/api/integrations/webhook"],
      ["POST", "/api/integrations/webhook/rotate-secret"],
      ["POST", "/api/integrations/webhook/test"],
    ]) {
      expect((await call(method, path, { origin: FRONTEND }, method === "PUT" ? {} : undefined)).status).toBe(401);
    }
    for (const mock of Object.values(service)) expect(mock).not.toHaveBeenCalled();
  });

  it("allows the browser's preflight for PUT and DELETE", async () => {
    const pre = await app(new Request("http://localhost:4000/api/integrations/webhook", { method: "OPTIONS", headers: { origin: FRONTEND, "access-control-request-method": "PUT", "access-control-request-headers": "authorization,x-pakka-tenant,content-type" } }));
    expect(pre.headers.get("access-control-allow-methods")).toContain("PUT");
    expect(pre.headers.get("access-control-allow-methods")).toContain("DELETE");
  });
});
