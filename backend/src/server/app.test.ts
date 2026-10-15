import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "../test-support/fake-supabase";
import { errorOf } from "../test-support/http";
import type { Route } from "./routes";

const createTrialTenant = vi.fn();
const getBalance = vi.fn();
vi.mock("../billing/trial", () => ({ createTrialTenant: (...args: unknown[]) => createTrialTenant(...args) }));
vi.mock("../billing/credits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../billing/credits")>()),
  getBalance: (...args: unknown[]) => getBalance(...args),
}));

const { bodyLimitFor, createApp, logPathFor } = await import("./app");
const { tenantRoute } = await import("./auth");
const { MAX_BODY_BYTES } = await import("./node");

const FRONTEND = "https://app.pakkaagent.in";
const STAGING = "https://staging.pakkaagent.in";
const REALTY = "10000000-0000-0000-0000-000000000001";
const SALON = "10000000-0000-0000-0000-000000000002";

const tenantRow = (id: string, name: string) => ({
  id, name, vertical: "real-estate", timezone: "Asia/Kolkata", status: "trial", plan_key: "trial", trial_ends_at: null,
});
const member = (id: string, name: string, role: string) => ({ tenant_id: id, role, tenants: tenantRow(id, name) });

// Access tokens the fake Supabase Auth knows, and what each account can see through RLS.
const ACCOUNTS: Record<string, { email: string; memberships: unknown[] }> = {
  "owner.token.sig": { email: "owner@test.local", memberships: [member(REALTY, "Test Realty", "owner")] },
  "staff.token.sig": { email: "staff@test.local", memberships: [member(REALTY, "Test Realty", "staff")] },
  "multi.token.sig": { email: "multi@test.local", memberships: [member(REALTY, "Test Realty", "owner"), member(SALON, "Beta Salon", "admin")] },
  "nomember.token.sig": { email: "nomember@test.local", memberships: [] },
};

let authOutage = false;
const madeFor: string[] = [];

function fakeUserClient(token: string): SupabaseClient {
  madeFor.push(token);
  const account = ACCOUNTS[token];
  const { client } = fakeSupabase({
    memberships: { data: account?.memberships ?? [], error: null },
    whatsapp_connections_public: { data: [], error: null },
  });
  const getUser = async (jwt: string) => {
    if (authOutage) return { data: { user: null }, error: { __isAuthError: true, name: "AuthApiError", status: 503, message: "upstream" } };
    const known = ACCOUNTS[jwt];
    return known
      ? { data: { user: { id: `user-${known.email}`, email: known.email } }, error: null }
      : { data: { user: null }, error: { __isAuthError: true, name: "AuthApiError", status: 401, message: "invalid JWT" } };
  };
  return Object.assign(client, { auth: { getUser } });
}

const inngest = vi.fn(async () => Response.json({ inngest: true }));
const app = createApp({ userClient: fakeUserClient, inngest, allowedOrigins: new Set([FRONTEND, STAGING]) });

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return app(
    new Request(`http://localhost:4000${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: FRONTEND, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}
const as = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
const TEMPLATE = { name: "visit_update_v1", category: "utility", language: "en", body: "Hello {{1}}, your visit is confirmed.", examples: ["Asha"] };

beforeEach(() => {
  authOutage = false;
  madeFor.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/health", () => {
  it("answers 200 without touching Supabase", async () => {
    const res = await app(new Request("http://localhost:4000/api/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, env: "local", commit: null });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(madeFor).toEqual([]);
  });
});

describe("routing", () => {
  it("answers 404 in the error envelope for an unknown path", async () => {
    const res = await app(new Request("http://localhost:4000/api/nope"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "Not found." } });
  });

  it("answers 405 with Allow for a known path and the wrong method", async () => {
    const res = await app(new Request("http://localhost:4000/api/templates"));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST, OPTIONS");
  });

  it("serves only /api paths: the old api.* short paths are gone", async () => {
    expect((await app(new Request("http://localhost:4000/webhooks/whatsapp"))).status).toBe(404);
  });
});

describe("CORS", () => {
  const preflight = (origin: string, method = "POST", path = "/api/messages/test") =>
    app(new Request(`http://localhost:4000${path}`, { method: "OPTIONS", headers: { origin, "access-control-request-method": method } }));

  it.each([FRONTEND, STAGING])("allows the preflight from %s and echoes that origin", async (origin) => {
    const res = await preflight(origin);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    expect(res.headers.get("access-control-allow-headers")).toBe("authorization, content-type, x-pakka-tenant");
    expect(res.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("vary")).toContain("Origin");
  });

  it("refuses the preflight from any other origin, with no CORS headers", async () => {
    for (const origin of ["https://evil.example", "https://pakka-agent-git-x.vercel.app", "null"]) {
      const res = await preflight(origin);
      expect(res.status).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("refuses a preflight for a method the route doesn't have", async () => {
    expect((await preflight(FRONTEND, "DELETE")).status).toBe(403);
  });

  it("never answers with a wildcard origin", async () => {
    const res = await post("/api/templates", TEMPLATE, as("owner.token.sig"));
    expect(res.headers.get("access-control-allow-origin")).toBe(FRONTEND);
  });

  it("refuses a request from a blocked origin before the route runs", async () => {
    const res = await post("/api/messages/test", { to: "+919840012345", body: "hi" }, as("owner.token.sig", { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "forbidden" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(madeFor).toEqual([]);
  });

  it("lets server-to-server callers (no Origin header) through to the auth check", async () => {
    const res = await app(new Request("http://localhost:4000/api/templates", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
  });
});

describe("errors the frontend can read", () => {
  const preflight = (origin: string, method: string, path: string) =>
    app(new Request(`http://localhost:4000${path}`, { method: "OPTIONS", headers: { origin, "access-control-request-method": method } }));

  it("lets the frontend preflight a missing route, so its 404 reads as not_found instead of a network error", async () => {
    const pre = await preflight(FRONTEND, "GET", "/api/not-built-yet");
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(FRONTEND);
    expect(pre.headers.get("access-control-allow-methods")).toContain("GET");
    const res = await app(new Request("http://localhost:4000/api/not-built-yet", { headers: { origin: FRONTEND } }));
    expect(res.status).toBe(404);
    expect(res.headers.get("access-control-allow-origin")).toBe(FRONTEND);
    expect(await errorOf(res)).toEqual({ code: "not_found", message: "Not found." });
  });

  it("still gives other origins nothing on a missing route", async () => {
    const pre = await preflight("https://evil.example", "GET", "/api/not-built-yet");
    expect(pre.status).toBe(403);
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
    const res = await app(new Request("http://localhost:4000/api/not-built-yet", { headers: { origin: "https://evil.example" } }));
    expect(res.status).toBe(404);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("adds CORS to a 405 on a browser route", async () => {
    const res = await app(new Request("http://localhost:4000/api/templates", { headers: { origin: FRONTEND } }));
    expect(res.status).toBe(405);
    expect(res.headers.get("access-control-allow-origin")).toBe(FRONTEND);
  });
});

describe("authentication", () => {
  it.each([
    ["no Authorization header", {}],
    ["a non-Bearer scheme", { authorization: "Basic b3duZXI6cHc=" }],
    ["an empty token", { authorization: "Bearer " }],
    ["a token that isn't a JWT", { authorization: "Bearer not a token" }],
  ])("answers 401 for %s without calling Supabase", async (_label, headers) => {
    const res = await post("/api/templates", TEMPLATE, headers);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "unauthenticated", message: "Your session has ended. Sign in again." } });
    expect(madeFor).toEqual([]);
  });

  it("answers 401 when Supabase Auth rejects the token", async () => {
    const res = await post("/api/messages/test", { to: "+919840012345", body: "hi" }, as("forged.token.sig"));
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe("unauthenticated");
  });

  it("answers 502 when Supabase Auth can't be reached, so the user can retry", async () => {
    authOutage = true;
    const res = await post("/api/templates", TEMPLATE, as("owner.token.sig"));
    expect(res.status).toBe(502);
    expect((await errorOf(res)).code).toBe("upstream_failed");
  });

  it("verifies the token it was given, with a client acting as that user", async () => {
    await post("/api/templates", TEMPLATE, as("owner.token.sig"));
    expect(madeFor).toEqual(["owner.token.sig"]);
  });
});

describe("tenant authorization", () => {
  it("runs the service for an owner (templates answer not_available until Meta submission exists)", async () => {
    const res = await post("/api/templates", TEMPLATE, as("owner.token.sig"));
    expect(res.status).toBe(501);
    expect((await errorOf(res)).code).toBe("not_available");
  });

  it("refuses staff: only an owner or admin can create a template or send a test", async () => {
    const template = await post("/api/templates", TEMPLATE, as("staff.token.sig"));
    expect(template.status).toBe(403);
    expect(await template.json()).toEqual({ error: { code: "forbidden", message: "Only an owner or admin can create a template." } });
    const test = await post("/api/messages/test", { to: "+919840012345", body: "hi" }, as("staff.token.sig"));
    expect(test.status).toBe(403);
  });

  it("answers no_membership for an account with no business", async () => {
    for (const path of ["/api/templates", "/api/messages/test"]) {
      const res = await post(path, {}, as("nomember.token.sig"));
      expect(res.status).toBe(403);
      expect((await errorOf(res)).code).toBe("no_membership");
    }
  });

  it("makes an account with several businesses say which one", async () => {
    const res = await post("/api/templates", TEMPLATE, as("multi.token.sig"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "forbidden", message: "Choose a business first." } });
  });

  it("honours X-Pakka-Tenant only for one of the caller's own businesses", async () => {
    const own = await post("/api/templates", TEMPLATE, as("multi.token.sig", { "x-pakka-tenant": SALON }));
    expect(own.status).toBe(501); // reached the service as the Beta Salon admin

    for (const forged of ["10000000-0000-0000-0000-000000000003", "not-an-id"]) {
      const res = await post("/api/templates", TEMPLATE, as("multi.token.sig", { "x-pakka-tenant": forged }));
      expect(res.status).toBe(403);
      expect((await errorOf(res)).message).toBe("Choose a business first.");
    }
  });

  it("checks the connection with the member's own client before sending", async () => {
    const res = await post("/api/messages/test", { to: "+919840012345", body: "hi" }, as("owner.token.sig"));
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe("whatsapp_not_connected");
  });

  it("validates the body after authorizing", async () => {
    const res = await post("/api/messages/test", "{not json", as("owner.token.sig"));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: { code: "validation_failed", message: "Send the details as JSON." } });
    const fields = await post("/api/messages/test", { to: "12", body: "" }, as("owner.token.sig"));
    expect(fields.status).toBe(422);
    expect((await errorOf(fields)).fields).toHaveProperty("to");
  });
});

describe("GET /api/calendar/google/connect", () => {
  it("is a browser route for signed-in members only", async () => {
    const res = await app(new Request("http://localhost:4000/api/calendar/google/connect?resourceId=x", { headers: { origin: FRONTEND } }));
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe(FRONTEND);
    const pre = await app(
      new Request("http://localhost:4000/api/calendar/google/connect", { method: "OPTIONS", headers: { origin: FRONTEND, "access-control-request-method": "GET" } }),
    );
    expect(pre.status).toBe(204);
  });

  it("refuses staff before anything else", async () => {
    const res = await app(new Request("http://localhost:4000/api/calendar/google/connect?resourceId=x", { headers: as("staff.token.sig", { origin: FRONTEND }) }));
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("forbidden");
  });
});

describe("POST /api/onboarding/trial", () => {
  beforeEach(() => {
    createTrialTenant.mockReset().mockResolvedValue({
      tenantId: "d0000000-0000-0000-0000-0000000000c1", routeCode: "TRIAL-7KQM", trialEndsAt: new Date(Date.now() + 7 * 864e5).toISOString(), created: true,
    });
    getBalance.mockReset().mockResolvedValue({ plan: 300, topup: 0, total: 300 });
  });

  it("refuses a signed-out caller with 401 and creates nothing", async () => {
    const res = await post("/api/onboarding/trial", { name: "Sunrise Homes", industry: "re" });
    expect(res.status).toBe(401);
    expect(createTrialTenant).not.toHaveBeenCalled();
  });

  it("creates the trial for the token's user, with the pack mapped on the server", async () => {
    const res = await post("/api/onboarding/trial", { name: "Sunrise Homes", industry: "re", vertical: "clinic", userId: "someone-else" }, as("nomember.token.sig"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready", trial: { routeCode: "TRIAL-7KQM", trialDays: 7, credits: 300 } });
    expect(createTrialTenant).toHaveBeenCalledWith({ userId: "user-nomember@test.local", name: "Sunrise Homes", vertical: "real-estate" });
  });

  it("answers 409 for an account that already has a business", async () => {
    const res = await post("/api/onboarding/trial", { name: "Sunrise Homes", industry: "re" }, as("staff.token.sig"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ status: "has_business" });
    expect(createTrialTenant).not.toHaveBeenCalled();
  });

  it("answers 422 for invalid input or a trade without a pack", async () => {
    const invalid = await post("/api/onboarding/trial", { name: " ", industry: "re" }, as("nomember.token.sig"));
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({ status: "invalid", fields: { name: "Enter your business name" } });
    const unavailable = await post("/api/onboarding/trial", { name: "Hotel Kaveri", industry: "hotel" }, as("nomember.token.sig"));
    expect(unavailable.status).toBe(422);
    expect(await unavailable.json()).toEqual({ status: "unavailable" });
  });

  it("answers 500 with a safe message when the trial can't be created", async () => {
    createTrialTenant.mockRejectedValue(new Error("create_trial_tenant failed: Bearer abc.def.ghi"));
    const res = await post("/api/onboarding/trial", { name: "Sunrise Homes", industry: "re" }, as("nomember.token.sig"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ status: "failed", message: "We couldn't set up your trial. Try again in a moment." });
  });
});

describe("path parameters, PATCH and DELETE", () => {
  const FAQ = "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f601";
  const routes: Route[] = [
    { path: "/api/kb/faqs/export", methods: { GET: () => Response.json({ fixed: true }) } },
    {
      path: "/api/kb/faqs/:id",
      browser: true,
      methods: {
        PATCH: (r, d, p) => tenantRoute(async ({ context, body, params }) => ({ tenant: context.tenant.id, body, params }))(r, d.userClient, p),
        DELETE: (r, d, p) => tenantRoute(async () => undefined)(r, d.userClient, p),
      },
    },
    { path: "/api/kb/gaps/:id/answer", browser: true, methods: { POST: (_r, _d, params) => Response.json(params) } },
    {
      path: "/api/kb/faqs",
      browser: true,
      maxBodyBytes: 5 * 1024 * 1024,
      methods: { POST: (r, d, p) => tenantRoute(async ({ body }) => body, { status: 201 })(r, d.userClient, p) },
    },
  ];
  const kb = createApp({ userClient: fakeUserClient, inngest, allowedOrigins: new Set([FRONTEND]) }, routes);
  const call = (method: string, path: string, init: RequestInit = {}) =>
    kb(new Request(`http://localhost:4000${path}`, { method, ...init, headers: { origin: FRONTEND, ...(init.headers as Record<string, string>) } }));

  it("passes :name values to the handler, decoded, with the tenant from the token", async () => {
    const res = await call("PATCH", `/api/kb/faqs/${FAQ}`, { headers: as("owner.token.sig"), body: JSON.stringify({ a: "Yes" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenant: REALTY, body: { a: "Yes" }, params: { id: FAQ } });
    expect(res.headers.get("access-control-allow-origin")).toBe(FRONTEND);
    expect(await (await call("POST", "/api/kb/gaps/a%20b/answer")).json()).toEqual({ id: "a b" });
  });

  it("prefers a fixed path over a pattern that also matches", async () => {
    expect(await (await call("GET", "/api/kb/faqs/export")).json()).toEqual({ fixed: true });
  });

  it("answers 404 when a segment is empty, extra, missing or badly encoded", async () => {
    for (const path of ["/api/kb/faqs/", `/api/kb/faqs/${FAQ}/x`, "/api/kb/gaps/answer", "/api/kb/faqs/%E0%A4%A"]) {
      expect((await call("PATCH", path)).status, path).toBe(404);
    }
  });

  it("answers DELETE with 204 and no JSON body read; 201 where the route asks for it", async () => {
    const deleted = await call("DELETE", `/api/kb/faqs/${FAQ}`, { headers: as("owner.token.sig") });
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe("");
    const created = await call("POST", "/api/kb/faqs", { headers: as("owner.token.sig"), body: JSON.stringify({ q: "Parking?" }) });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ q: "Parking?" });
  });

  it("still authenticates DELETE before doing anything", async () => {
    expect((await call("DELETE", `/api/kb/faqs/${FAQ}`)).status).toBe(401);
  });

  it("allows PATCH and DELETE preflights only for routes that have them", async () => {
    const preflight = (method: string, path = `/api/kb/faqs/${FAQ}`) =>
      kb(new Request(`http://localhost:4000${path}`, { method: "OPTIONS", headers: { origin: FRONTEND, "access-control-request-method": method } }));
    for (const method of ["PATCH", "DELETE"]) {
      const res = await preflight(method);
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-methods")).toBe("PATCH, DELETE, OPTIONS");
    }
    expect((await preflight("DELETE", "/api/kb/faqs")).status).toBe(403);
    expect((await preflight("PATCH", "/api/kb/gaps/1/answer")).status).toBe(403);
  });

  it("answers 405 with the pattern route's methods", async () => {
    const res = await call("GET", `/api/kb/faqs/${FAQ}`);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("PATCH, DELETE, OPTIONS");
  });

  it("gives each path its route's body limit, 1 MB by default", () => {
    expect(bodyLimitFor("/api/kb/faqs", routes)).toBe(5 * 1024 * 1024);
    expect(bodyLimitFor(`/api/kb/faqs/${FAQ}`, routes)).toBe(MAX_BODY_BYTES);
    expect(bodyLimitFor("/api/nope", routes)).toBe(MAX_BODY_BYTES);
    expect(bodyLimitFor("/api/templates")).toBe(MAX_BODY_BYTES);
  });
});

describe("logPathFor", () => {
  const routes: Route[] = [
    { path: "/api/connect-links/:token", browser: true, secretParams: ["token"], methods: { GET: () => new Response(null) } },
    { path: "/api/kb/faqs/:id", methods: { PATCH: () => new Response(null) } },
  ];

  it("shows a route's secret params as *** and leaves everything else", () => {
    expect(logPathFor("/api/connect-links/Ab_c-123xyz", routes)).toBe("/api/connect-links/***");
    expect(logPathFor("/api/kb/faqs/3f2a1b4c", routes)).toBe("/api/kb/faqs/3f2a1b4c");
    expect(logPathFor("/api/templates")).toBe("/api/templates");
    expect(logPathFor("/api/nope/anything", routes)).toBe("/api/nope/anything");
  });

  // Day 7 log sweep (Dev 1): a token in a path the route matching does not recognise was logged whole.
  const TOKEN = "7Hk2_mQ9xLp4Rt8Vb1Nc6Zd3Fg5Js0Wy-aEuI";
  it.each([
    ["a double slash in front", `//api/connect-links/${TOKEN}`],
    ["a double slash inside", `/api//connect-links/${TOKEN}`],
    ["a double slash in front of the hand-over link", `//h/${TOKEN}`],
    ["a double slash after the hand-over prefix", `/h//${TOKEN}`],
    ["another letter case", `/API/connect-links/${TOKEN}`],
    ["an encoded slash", `/api/connect-links%2F${TOKEN}`],
    ["a semicolon parameter", `/api/connect-links;v=1/${TOKEN}`],
    ["a trailing segment", `/api/connect-links/${TOKEN}/x`],
  ])("masks a token wherever the path puts it: %s", (_name, path) => {
    expect(logPathFor(path)).not.toContain(TOKEN);
    expect(logPathFor(path)).toContain("***");
  });

  it("keeps ids readable: a UUID is not a token, nor a phone number, even when its last part is all digits", () => {
    expect(logPathFor("/api/conversations/3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f601/lead-card")).toBe("/api/conversations/3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f601/lead-card");
    expect(logPathFor("/api/kb/faqs/10000000-0000-0000-0000-000000000001")).toBe("/api/kb/faqs/10000000-0000-0000-0000-000000000001");
  });

  it.each([
    ["with a +", "/api/whatsapp/+919812345621/x"],
    ["encoded", "/api/whatsapp/%2B919812345621/x"],
    ["without a country code", "/api/contacts/9812345621"],
  ])("masks a phone number typed into a path: %s", (_name, path) => {
    expect(logPathFor(path)).not.toMatch(/9812345621/);
    expect(logPathFor(path)).toContain("***");
  });
});

describe("/api/inngest", () => {
  it.each(["GET", "POST", "PUT"])("hands %s to the Inngest handler, with no CORS", async (method) => {
    inngest.mockClear();
    const res = await app(new Request("http://localhost:4000/api/inngest", { method, headers: { origin: FRONTEND } }));
    expect(inngest).toHaveBeenCalledOnce();
    expect(await res.json()).toEqual({ inngest: true });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
