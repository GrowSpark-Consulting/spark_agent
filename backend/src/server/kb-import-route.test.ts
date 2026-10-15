import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "../test-support/fake-supabase";
import { errorOf } from "../test-support/http";

// POST /api/onboarding/import-site: how the route is wired (who may call, which business, the body, the status, the answers when something is refused). What the
// importer does with a page is kb/website.test.ts, and the address rules and the network are kb/fetch-page.test.ts.

const importWebsite = vi.fn();
vi.mock("../kb/website", () => ({ importWebsite: (...args: unknown[]) => importWebsite(...args) }));

const { createApp } = await import("./app");
const { ROUTES } = await import("./routes");
const { AppError } = await import("../lib/errors");

const FRONTEND = "https://app.pakkaagent.in";
const REALTY = "10000000-0000-4000-8000-000000000001";
const SALON = "10000000-0000-4000-8000-000000000002";
const tenantRow = (id: string, name: string) => ({ id, name, vertical: "real-estate", timezone: "Asia/Kolkata", status: "active", plan_key: "growth", trial_ends_at: null });
const member = (id: string, name: string, role: string) => ({ tenant_id: id, role, tenants: tenantRow(id, name) });

const ACCOUNTS: Record<string, { id: string; memberships: unknown[] }> = {
  "owner.token.sig": { id: "f1000000-0000-4000-8000-000000000001", memberships: [member(REALTY, "Test Realty", "owner")] },
  "staff.token.sig": { id: "f1000000-0000-4000-8000-000000000003", memberships: [member(REALTY, "Test Realty", "staff")] },
  "mixed.token.sig": { id: "f1000000-0000-4000-8000-000000000004", memberships: [member(REALTY, "Test Realty", "owner"), member(SALON, "Beta Salon", "admin")] },
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
const post = (headers: Record<string, string>, body?: unknown) =>
  app(new Request("http://localhost:4000/api/onboarding/import-site", { method: "POST", headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) }));

const IMPORTED = { id: "d1000000-0000-4000-8000-000000000001", title: "About us", sourceType: "website", sourceUrl: "https://www.example.com/about", status: "processing", createdAt: "2026-10-15T10:00:00.000Z", replaced: false };

beforeEach(() => {
  importWebsite.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the route", () => {
  it("is registered as POST /api/onboarding/import-site, for the browser (CORS)", () => {
    const route = ROUTES.find((r) => r.path === "/api/onboarding/import-site");
    expect(route?.browser).toBe(true);
    expect(Object.keys(route?.methods ?? {})).toEqual(["POST"]);
  });

  it("answers the browser's preflight with the tenant header allowed", async () => {
    const res = await app(new Request("http://localhost:4000/api/onboarding/import-site", { method: "OPTIONS", headers: { origin: FRONTEND, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type,x-pakka-tenant" } }));
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("access-control-allow-methods")).toMatch(/POST/);
    expect(res.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("x-pakka-tenant");
  });
});

describe("the answer", () => {
  it("is 202 with what the importer answered, for the caller's business, handing it the body as it came", async () => {
    importWebsite.mockResolvedValue(IMPORTED);
    const res = await post(as("owner.token.sig"), { url: "https://www.example.com/about" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(IMPORTED);
    expect(res.headers.get("access-control-allow-origin")).toBe(FRONTEND);
    expect(importWebsite).toHaveBeenCalledWith(expect.objectContaining({ role: "owner", tenant: expect.objectContaining({ id: REALTY }) }), { url: "https://www.example.com/about" });
  });

  it("takes the business from X-Pakka-Tenant only if it is one of the caller's own", async () => {
    importWebsite.mockResolvedValue(IMPORTED);
    await post(as("mixed.token.sig", { "x-pakka-tenant": SALON }), { url: "https://www.example.com/about" });
    expect(importWebsite.mock.calls[0][0].tenant.id).toBe(SALON);
    importWebsite.mockClear();
    await post(as("owner.token.sig", { "x-pakka-tenant": SALON }), { url: "https://www.example.com/about" });
    expect(importWebsite.mock.calls[0][0].tenant.id).toBe(REALTY);
  });

  it("never takes the business from the body: it is handed on as it is, for the importer to refuse", async () => {
    importWebsite.mockRejectedValue(new AppError("validation_failed", "Check the address and try again.", { tenantId: "That is not something this form takes." }));
    const res = await post(as("owner.token.sig"), { url: "https://www.example.com/about", tenantId: SALON });
    expect(res.status).toBe(422);
    expect(importWebsite.mock.calls[0][0].tenant.id).toBe(REALTY);
  });
});

describe("who is let in", () => {
  it("answers 401 to no token and to a bad one, and never reaches the importer", async () => {
    expect((await post({ origin: FRONTEND, "content-type": "application/json" }, { url: "https://www.example.com" })).status).toBe(401);
    expect((await post(as("nobody.token.sig"), { url: "https://www.example.com" })).status).toBe(401);
    expect(importWebsite).not.toHaveBeenCalled();
  });

  it("answers 403 to a signed-in person with no business", async () => {
    const res = await post(as("nomember.token.sig"), { url: "https://www.example.com" });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("no_membership");
    expect(importWebsite).not.toHaveBeenCalled();
  });

  it("passes the role on: the importer, not the route, refuses staff (with 403 and the usual words)", async () => {
    importWebsite.mockRejectedValue(new AppError("forbidden", "Only an owner or admin can import a web page."));
    const res = await post(as("staff.token.sig"), { url: "https://www.example.com/about" });
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toMatchObject({ code: "forbidden", message: "Only an owner or admin can import a web page." });
    expect(importWebsite.mock.calls[0][0].role).toBe("staff");
  });
});

describe("what is refused, in the usual envelope", () => {
  it.each([
    ["validation_failed", 422, "That address isn't allowed: it points to a private or internal network. Use your website's public address.", { url: "x" }],
    ["conflict", 409, "This page is still being processed from the last import. Try again in a minute.", undefined],
    ["rate_limited", 429, "You've imported a lot of pages in the last hour. Try again later.", undefined],
    ["upstream_failed", 502, "We couldn't open that page. Check the address and that the site is online, then try again.", undefined],
  ] as const)("%s is a %i with the importer's own words and its field errors", async (code, status, message, fields) => {
    importWebsite.mockRejectedValue(new AppError(code, message, fields as Record<string, string> | undefined));
    const res = await post(as("owner.token.sig"), { url: "https://www.example.com/about" });
    expect(res.status).toBe(status);
    const error = await errorOf(res);
    expect(error).toMatchObject({ code, message });
    if (fields) expect(error.fields).toEqual(fields);
  });

  it("answers 422 to a body that is not JSON, without reaching the importer", async () => {
    const res = await post(as("owner.token.sig"), "url=https://www.example.com");
    expect(res.status).toBe(422);
    expect(importWebsite).not.toHaveBeenCalled();
  });

  it("an unexpected failure is a plain 500 without its details", async () => {
    importWebsite.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.1:5432 secret-host"));
    const res = await post(as("owner.token.sig"), { url: "https://www.example.com/about" });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/10\.0\.0\.1|secret-host/);
  });
});
