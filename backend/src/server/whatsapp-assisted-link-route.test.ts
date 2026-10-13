import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashConnectLinkToken, newConnectLinkToken } from "../lib/connect-link-token";
import { ADMIN_ID, appWith, FRONTEND, REALTY, type RouteApp } from "../test-support/connect-route-harness";
import { errorOf } from "../test-support/http";
import { inMemoryClient } from "../test-support/in-memory-admin";

// The assisted connect link through the REAL router and the real connect-link service, with EMBEDDED_SIGNUP_ENABLED on: making a link, the public read, the single
// neutral answer for a link that cannot be used, the 429, and the single use of a link (a failed attempt releases it). Two things are replaced: the service-role
// client (an in-memory one that counts how often it is asked for) and the Embedded Signup flow itself (`connectNumber`, tested in
// channels/whatsapp/connect/embedded-signup.test.ts), so the caller it is given can be inspected. The flag-off answers are whatsapp-embedded-signup-route.test.ts.

// The first import of the whole router is slow on a cold cache.
vi.setConfig({ testTimeout: 30_000 });

const state = vi.hoisted(() => ({
  asked: 0,
  tables: {} as Record<string, Record<string, unknown>[]>,
  connectNumber: undefined as undefined | ((caller: unknown, input: unknown) => Promise<unknown>),
}));
vi.mock("../lib/supabase-admin", () => ({
  supabaseAdmin: () => {
    state.asked += 1;
    return inMemoryClient(state.tables);
  },
}));
// Only the flow is replaced; the flag, the body parsing and the rest of embedded-signup.ts are the real thing (the flag is on for the whole file, and the module graph
// is never reset here: a reset would leave this mock's first instance of embedded-signup.ts with its own copy of the error class).
vi.mock("../channels/whatsapp/connect/embedded-signup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../channels/whatsapp/connect/embedded-signup")>()),
  connectNumber: (caller: unknown, input: unknown) => (state.connectNumber ? state.connectNumber(caller, input) : Promise.reject(new Error("connectNumber not set"))),
}));
vi.stubEnv("EMBEDDED_SIGNUP_ENABLED", "true");

const OTHER = "10000000-0000-0000-0000-000000000002";
const BODY = { code: "AQD-synthetic-code", wabaId: "100000000000001", phoneNumberId: "200000000000001", coexistence: false };
const NEUTRAL_MESSAGE = "This link isn't valid. Ask for a new one.";
const CONNECTION = (status: string) => ({ id: "d0000000-0000-4000-8000-0000000000d1", tenant_id: REALTY, method: "assisted", status });

/** Makes a link through the real admin route and returns its raw token. */
async function issue(app: RouteApp, tenantId = REALTY) {
  const res = await app.makeLink("admin.token.sig", { tenantId });
  expect(res.status).toBe(201);
  const out = (await res.json()) as { url: string; expiresAt: string };
  return { ...out, token: out.url.split("/").pop() as string };
}
const linkRow = (token: string) => {
  const row = state.tables.connect_links.find((r) => r.token_hash === hashConnectLinkToken(token));
  return row && { ...row, used_at: row.used_at ?? null };
};

beforeEach(async () => {
  (await import("../channels/whatsapp/connect/connect-link-rate-limit")).connectLinkLimiter.reset();
  state.asked = 0;
  state.tables = { tenants: [{ id: REALTY, name: "Test Realty" }], platform_admins: [{ user_id: ADMIN_ID }], connect_links: [] };
  state.connectNumber = async () => CONNECTION("active");
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("making a link", () => {
  it("a platform admin gets { url, expiresAt }, the raw token is only in that answer, and the table holds its hash", async () => {
    const app = await appWith("true", { fresh: false });
    const { url, expiresAt, token } = await issue(app);
    expect(url).toBe(`${FRONTEND}/connect/${token}`);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(23.9 * 3600_000);
    expect(Date.parse(expiresAt) - Date.now()).toBeLessThan(24.1 * 3600_000);
    expect(linkRow(token)).toMatchObject({ tenant_id: REALTY, created_by: ADMIN_ID, used_at: null });
    expect(JSON.stringify(state.tables)).not.toContain(token);
  });

  it("refuses a business owner and a visitor, and an unknown business", async () => {
    const app = await appWith("true", { fresh: false });
    expect((await app.makeLink("owner.token.sig", { tenantId: REALTY })).status).toBe(403);
    expect((await app.makeLink(undefined, { tenantId: REALTY })).status).toBe(401);
    expect((await app.makeLink("admin.token.sig", { tenantId: OTHER })).status).toBe(404);
    expect(state.tables.connect_links).toHaveLength(0);
  });

  it("a live link reads back the business name and expiry without being used up", async () => {
    const app = await appWith("true", { fresh: false });
    const { token, expiresAt } = await issue(app);
    for (let i = 0; i < 2; i++) {
      const res = await app.link(token);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ tenantName: "Test Realty", expiresAt });
    }
    expect(linkRow(token)?.used_at).toBeNull();
  });
});

describe("a link that cannot be used", () => {
  it("malformed, unknown, used and expired tokens get an identical 404 not_found on the public read, and the very same body on the assisted path", async () => {
    const app = await appWith("true", { fresh: false });
    const used = (await issue(app)).token;
    expect((await app.signup(undefined, { ...BODY, connectToken: used })).status).toBe(201); // used up by a real connection
    const expired = newConnectLinkToken();
    state.tables.connect_links.push({ token_hash: expired.tokenHash, tenant_id: REALTY, created_by: ADMIN_ID, expires_at: "2020-01-01T00:00:00.000Z", used_at: null });
    const tokens = ["short", `${"x".repeat(42)}!`, newConnectLinkToken().token, used, expired.token];

    const reads = await Promise.all(tokens.map((t) => app.link(t)));
    const connects = await Promise.all(tokens.map((t) => app.signup(undefined, { ...BODY, connectToken: t })));
    for (const res of [...reads, ...connects]) expect(res.status).toBe(404);
    const bodies = await Promise.all([...reads, ...connects].map((r) => r.text()));
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0])).toEqual({ error: { code: "not_found", message: NEUTRAL_MESSAGE } });
  });

  it("a malformed token is answered without any database read", async () => {
    const app = await appWith("true", { fresh: false });
    await app.link("short");
    await app.signup(undefined, { ...BODY, connectToken: "short" });
    await app.signup(undefined, { ...BODY, connectToken: 42 });
    expect(state.asked).toBe(0);
  });

  it("the 31st request in a minute from one address is a 429 rate_limited, a different answer from the neutral 404", async () => {
    const app = await appWith("true", { fresh: false });
    const statuses: number[] = [];
    let last: Response | undefined;
    for (let i = 0; i < 31; i++) {
      last = await app.link("short");
      statuses.push(last.status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 404)).toBe(true);
    expect(statuses[30]).toBe(429);
    expect(await errorOf(last as Response)).toMatchObject({ code: "rate_limited" });
  });
});

describe("the assisted Embedded Signup path", () => {
  it("connects the link's business with no bearer token, ignores a tenantId in the body, and uses the link up", async () => {
    const app = await appWith("true", { fresh: false });
    const { token } = await issue(app);
    const seen: unknown[][] = [];
    state.connectNumber = async (caller, input) => {
      seen.push([caller, input]);
      return CONNECTION("active");
    };
    const res = await app.signup(undefined, { ...BODY, connectToken: token, tenantId: OTHER });
    expect(res.status).toBe(201);
    expect(seen).toEqual([[{ tenantId: REALTY, actor: `assisted:${ADMIN_ID}`, method: "assisted" }, BODY]]);
    expect(linkRow(token)?.used_at).not.toBeNull();
    // the link is gone for everyone now
    expect((await app.link(token)).status).toBe(404);
    expect((await app.signup(undefined, { ...BODY, connectToken: token })).status).toBe(404);
    expect(seen).toHaveLength(1);
  });

  it("a signed-in caller's bearer token is ignored: the business is still the link's", async () => {
    const app = await appWith("true", { fresh: false });
    const { token } = await issue(app);
    const seen: unknown[] = [];
    state.connectNumber = async (caller) => (seen.push(caller), CONNECTION("active"));
    expect((await app.signup("owner.token.sig", { ...BODY, connectToken: token })).status).toBe(201);
    expect(seen).toEqual([{ tenantId: REALTY, actor: `assisted:${ADMIN_ID}`, method: "assisted" }]);
  });

  it("a failed attempt releases the link, so the client can retry with it, and a later success uses it up", async () => {
    const app = await appWith("true", { fresh: false });
    const { token } = await issue(app);
    const { AppError } = await import("../lib/errors");
    state.connectNumber = async () => Promise.reject(new AppError("upstream_failed", "Facebook did not accept that sign-in."));
    const failed = await app.signup(undefined, { ...BODY, connectToken: token });
    expect(failed.status).toBe(502);
    expect(await errorOf(failed)).toMatchObject({ code: "upstream_failed" });
    expect(linkRow(token)?.used_at).toBeNull();
    expect((await app.link(token)).status).toBe(200);

    state.connectNumber = async () => CONNECTION("active");
    expect((await app.signup(undefined, { ...BODY, connectToken: token })).status).toBe(201);
    expect(linkRow(token)?.used_at).not.toBeNull();
    expect((await app.link(token)).status).toBe(404);
  });

  it("a connection that was saved but failed also releases the link", async () => {
    const app = await appWith("true", { fresh: false });
    const { token } = await issue(app);
    state.connectNumber = async () => CONNECTION("failed");
    const res = await app.signup(undefined, { ...BODY, connectToken: token });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ status: "failed" });
    expect(linkRow(token)?.used_at).toBeNull();
    expect((await app.link(token)).status).toBe(200);
  });

  it("two people at once: exactly one connects, the other gets the neutral 404", async () => {
    const app = await appWith("true", { fresh: false });
    const { token } = await issue(app);
    let calls = 0;
    state.connectNumber = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return CONNECTION("active");
    };
    const results = await Promise.all([app.signup(undefined, { ...BODY, connectToken: token }), app.signup(undefined, { ...BODY, connectToken: token })]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 404]);
    expect(calls).toBe(1);
  });

  it("an invalid body leaves the link untouched", async () => {
    const app = await appWith("true", { fresh: false });
    const { token } = await issue(app);
    const res = await app.signup(undefined, { ...BODY, phoneNumberId: null, connectToken: token });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({ code: "validation_failed", fields: { phoneNumberId: expect.any(String) } });
    expect(linkRow(token)?.used_at).toBeNull();
  });
});
