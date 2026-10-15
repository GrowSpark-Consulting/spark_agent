import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSettingsDb, type Row } from "../test-support/fake-settings-db";
import { fakeSupabase } from "../test-support/fake-supabase";
import { errorOf } from "../test-support/http";

// GET and PATCH /api/agent/settings, through the real route table, the real createApp and the real auth wrappers (token, business from the caller's
// own memberships, role). Only Supabase Auth and the database are faked. What the settings mean and how they merge is agent/settings/agent-settings.test.ts.

const REALTY = "10000000-0000-4000-8000-000000000001";
const SALON = "10000000-0000-4000-8000-000000000002";
const SERVICE = "d6000000-0000-4000-8000-000000000011";
const FRONTEND = "https://app.pakkaagent.in";

const state = vi.hoisted(() => ({ db: null as unknown as SupabaseClient }));
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: () => state.db }));

const { createApp } = await import("./app");
const { ROUTES } = await import("./routes");

const tenantRow = (id: string, name: string) => ({ id, name, vertical: "real-estate", timezone: "Asia/Kolkata", status: "active", plan_key: "growth", trial_ends_at: null });
const member = (id: string, name: string, role: string) => ({ tenant_id: id, role, tenants: tenantRow(id, name) });

const ACCOUNTS: Record<string, { id: string; memberships: unknown[] }> = {
  "owner.token.sig": { id: "f1000000-0000-4000-8000-000000000001", memberships: [member(REALTY, "Test Realty", "owner")] },
  "admin.token.sig": { id: "f1000000-0000-4000-8000-000000000002", memberships: [member(REALTY, "Test Realty", "admin")] },
  "staff.token.sig": { id: "f1000000-0000-4000-8000-000000000003", memberships: [member(REALTY, "Test Realty", "staff")] },
  "mixed.token.sig": { id: "f1000000-0000-4000-8000-000000000004", memberships: [member(REALTY, "Test Realty", "owner"), member(SALON, "Beta Salon", "staff")] },
  "nomember.token.sig": { id: "f1000000-0000-4000-8000-000000000005", memberships: [] },
};

function fakeUserClient(token: string): SupabaseClient {
  const account = ACCOUNTS[token];
  const { client } = fakeSupabase({ memberships: { data: account?.memberships ?? [], error: null } });
  const getUser = async (jwt: string) => {
    const known = ACCOUNTS[jwt];
    return known
      ? { data: { user: { id: known.id, email: `${known.id}@test.local` } }, error: null }
      : { data: { user: null }, error: { __isAuthError: true, name: "AuthApiError", status: 401, message: "invalid JWT" } };
  };
  return Object.assign(client, { auth: { getUser } });
}

const app = createApp({ userClient: fakeUserClient, inngest: async () => Response.json({}), allowedOrigins: new Set([FRONTEND]) });
const as = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, origin: FRONTEND, "content-type": "application/json", ...extra });
const send = (method: string, headers: Record<string, string>, body?: unknown) =>
  app(new Request("http://localhost:4000/api/agent/settings", { method, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) }));

let tables: Record<string, Row[]>;
let calls: { table: string; op: string }[];
beforeEach(() => {
  const t = fakeSettingsDb({
    tenants: [
      { id: REALTY, agent_settings: { persona: "Priya", tone: "friendly", languages: ["en"] } },
      { id: SALON, agent_settings: { persona: "Beta", tone: "formal" } },
    ],
    services: [{ id: SERVICE, tenant_id: REALTY, active: true }],
  });
  state.db = t.db;
  tables = t.tables;
  calls = t.calls;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const settingsOf = (tenant: string) => tables.tenants.find((r) => r.id === tenant)?.agent_settings;
const writes = () => calls.filter((c) => c.op !== "select");

describe("the route is registered for the browser", () => {
  it("has GET and PATCH on /api/agent/settings, as a browser route (CORS)", () => {
    const route = ROUTES.find((r) => r.path === "/api/agent/settings");
    expect(route?.browser).toBe(true);
    expect(Object.keys(route?.methods ?? {}).sort()).toEqual(["GET", "PATCH"]);
  });

  it("answers the browser's preflight for PATCH with the tenant header allowed", async () => {
    const res = await app(new Request("http://localhost:4000/api/agent/settings", { method: "OPTIONS", headers: { origin: FRONTEND, "access-control-request-method": "PATCH", "access-control-request-headers": "authorization,content-type,x-pakka-tenant" } }));
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("access-control-allow-methods")).toMatch(/PATCH/);
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("x-pakka-tenant");
  });
});

describe("who is let in", () => {
  it.each([["GET"], ["PATCH"]])("%s answers 401 to a caller with no token or a bad one, before touching the database", async (method) => {
    const body = method === "PATCH" ? { tone: "formal" } : undefined;
    expect((await send(method, { origin: FRONTEND, "content-type": "application/json" }, body)).status).toBe(401);
    expect((await send(method, as("nobody.token.sig"), body)).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it.each([["GET"], ["PATCH"]])("%s answers 403 to a signed-in person with no business", async (method) => {
    const res = await send(method, as("nomember.token.sig"), method === "PATCH" ? { tone: "formal" } : undefined);
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("no_membership");
    expect(calls).toEqual([]);
  });

  it("GET lets every member read, staff included", async () => {
    for (const token of ["owner.token.sig", "admin.token.sig", "staff.token.sig"]) {
      const res = await send("GET", as(token));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ persona: "Priya", tone: "friendly", privacyNotice: false });
    }
  });

  it("PATCH lets an owner and an admin change it", async () => {
    expect((await send("PATCH", as("owner.token.sig"), { tone: "formal" })).status).toBe(200);
    expect((await send("PATCH", as("admin.token.sig"), { privacyNotice: true })).status).toBe(200);
    expect(settingsOf(REALTY)).toMatchObject({ tone: "formal", privacyNotice: true, persona: "Priya", languages: ["en"] });
  });

  it("PATCH answers 403 to staff in the error envelope, naming an owner or admin, and writes nothing", async () => {
    const res = await send("PATCH", as("staff.token.sig"), { tone: "formal" });
    expect(res.status).toBe(403);
    const error = await errorOf(res);
    expect(error.code).toBe("forbidden");
    expect(error.message).toMatch(/^Only an owner or admin can /);
    expect(calls).toEqual([]);
    expect(settingsOf(REALTY)).toMatchObject({ tone: "friendly" });
  });
});

describe("which business", () => {
  it("is the one X-Pakka-Tenant names, if it is one of the caller's own: staff there may read but not write, an owner elsewhere may", async () => {
    expect((await send("GET", as("mixed.token.sig", { "x-pakka-tenant": SALON }))).status).toBe(200);
    const refused = await send("PATCH", as("mixed.token.sig", { "x-pakka-tenant": SALON }), { tone: "friendly" });
    expect(refused.status).toBe(403);
    expect(writes()).toEqual([]);
    expect(settingsOf(SALON)).toEqual({ persona: "Beta", tone: "formal" });
    const allowed = await send("PATCH", as("mixed.token.sig", { "x-pakka-tenant": REALTY }), { tone: "formal" });
    expect(allowed.status).toBe(200);
    expect(settingsOf(REALTY)).toMatchObject({ tone: "formal" });
    expect(settingsOf(SALON)).toEqual({ persona: "Beta", tone: "formal" });
  });

  it("is never one the caller does not belong to: the header is ignored and their own business is used", async () => {
    const res = await send("GET", as("staff.token.sig", { "x-pakka-tenant": SALON }));
    expect((await res.json()) as { persona: string }).toMatchObject({ persona: "Priya" });
    const patched = await send("PATCH", as("owner.token.sig", { "x-pakka-tenant": SALON }), { persona: "Hijack" });
    expect(patched.status).toBe(200);
    expect(settingsOf(SALON)).toEqual({ persona: "Beta", tone: "formal" });
    expect(settingsOf(REALTY)).toMatchObject({ persona: "Hijack" });
  });

  it("ignores a business named in the body: only the settings keys are accepted", async () => {
    const res = await send("PATCH", as("owner.token.sig"), { tenantId: SALON, tone: "formal" });
    expect(res.status).toBe(422);
    expect(settingsOf(SALON)).toEqual({ persona: "Beta", tone: "formal" });
    expect(writes()).toEqual([]);
  });
});

describe("what comes back", () => {
  it("PATCH answers the settings as they now stand, in the same shape as GET", async () => {
    const patched = await send("PATCH", as("owner.token.sig"), { tone: "formal", handoffTriggers: [{ key: "negotiation", enabled: false }] });
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as { tone: string; handoffTriggers: { key: string; enabled: boolean }[] };
    expect(body.tone).toBe("formal");
    expect(body.handoffTriggers.find((t) => t.key === "negotiation")?.enabled).toBe(false);
    expect(await (await send("GET", as("owner.token.sig"))).json()).toEqual(body);
  });

  it("answers CORS for the allowed origin", async () => {
    expect((await send("GET", as("owner.token.sig"))).headers.get("access-control-allow-origin")).toBe(FRONTEND);
  });

  it("accepts the booking service of the business and refuses another business's", async () => {
    expect((await send("PATCH", as("owner.token.sig"), { bookingServiceId: SERVICE })).status).toBe(200);
    expect(settingsOf(REALTY)).toMatchObject({ bookingServiceId: SERVICE });
    tables.services.push({ id: "d6000000-0000-4000-8000-000000000077", tenant_id: SALON, active: true });
    const res = await send("PATCH", as("owner.token.sig"), { bookingServiceId: "d6000000-0000-4000-8000-000000000077" });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).fields).toHaveProperty("bookingServiceId");
  });
});

describe("what it refuses", () => {
  it("answers 422 validation_failed with a field error in the envelope, and writes nothing", async () => {
    const res = await send("PATCH", as("owner.token.sig"), { tone: "warm", persona: "x".repeat(40) });
    expect(res.status).toBe(422);
    const error = await errorOf(res);
    expect(error.code).toBe("validation_failed");
    expect(Object.keys(error.fields ?? {}).sort()).toEqual(["persona", "tone"]);
    expect(writes()).toEqual([]);
  });

  it("answers 422 for a body that is not JSON, or empty", async () => {
    expect((await send("PATCH", as("owner.token.sig"), "tone=formal")).status).toBe(422);
    expect((await send("PATCH", as("owner.token.sig"), {})).status).toBe(422);
    expect(writes()).toEqual([]);
  });
});

describe("the audit log", () => {
  it("gets one row for a change, naming the member and the business, with no persona text", async () => {
    await send("PATCH", as("admin.token.sig"), { tone: "formal", persona: "Ravi Kumar" });
    expect(tables.audit_logs).toHaveLength(1);
    expect(tables.audit_logs[0]).toMatchObject({ tenant_id: REALTY, actor: ACCOUNTS["admin.token.sig"].id, action: "agent_settings.updated", entity: "tenant", entity_id: REALTY });
    expect(JSON.stringify(tables.audit_logs[0].diff)).not.toMatch(/Ravi|Priya/);
  });

  it("gets none for a read, a refusal, or a change that changes nothing", async () => {
    await send("GET", as("owner.token.sig"));
    await send("PATCH", as("staff.token.sig"), { tone: "formal" });
    await send("PATCH", as("owner.token.sig"), { tone: "bad" });
    await send("PATCH", as("owner.token.sig"), { tone: "friendly" });
    expect(tables.audit_logs).toEqual([]);
  });
});
