import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashConnectLinkToken } from "../lib/connect-link-token";
import { ADMIN_ID, appWith, REALTY } from "../test-support/connect-route-harness";
import { inMemoryClient } from "../test-support/in-memory-admin";
import { errorOf } from "../test-support/http";

// The Embedded Signup route and the two connect-link routes through the REAL router while EMBEDDED_SIGNUP_ENABLED is off (and the signed-in path with it on): they
// answer not_available before any sign-in check, claim or database read. The service-role client is an in-memory one that counts how often it is asked for, so "no
// database read" is checked, not assumed. The assisted flow with the flag on is whatsapp-assisted-link-route.test.ts; the flows are in channels/whatsapp/connect/.

// The first import of the whole router is slow on a cold cache.
vi.setConfig({ testTimeout: 30_000 });

const state = vi.hoisted(() => ({ asked: 0, tables: {} as Record<string, Record<string, unknown>[]> }));
vi.mock("../lib/supabase-admin", () => ({
  supabaseAdmin: () => {
    state.asked += 1;
    return inMemoryClient(state.tables);
  },
}));

const TOKEN = "A".repeat(43);
const BODY = { code: "AQD-synthetic-code", wabaId: "100000000000001", phoneNumberId: "200000000000001", coexistence: false };

beforeEach(() => {
  state.asked = 0;
  state.tables = {
    tenants: [{ id: REALTY, name: "Test Realty" }],
    platform_admins: [{ user_id: ADMIN_ID }],
    connect_links: [{ token_hash: hashConnectLinkToken(TOKEN), tenant_id: REALTY, created_by: ADMIN_ID, expires_at: "2999-01-01T00:00:00.000Z", used_at: null }],
  };
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("flag off", () => {
  it("answers not_available (501) to a signed-in owner on the signed-in Embedded Signup path, whatever the body", async () => {
    const { signup } = await appWith("false");
    for (const body of [BODY, { nonsense: true }]) {
      const res = await signup("owner.token.sig", body);
      expect(res.status).toBe(501);
      expect(await errorOf(res)).toMatchObject({ code: "not_available" });
    }
  });

  it("answers not_available to the assisted path, the public read and the admin route, with no sign-in, no claim and no database read", async () => {
    const { signup, link, makeLink } = await appWith("false");
    for (const res of [await signup(undefined, { ...BODY, connectToken: TOKEN }), await link(TOKEN), await makeLink(undefined, { tenantId: REALTY })]) {
      expect(res.status).toBe(501);
      expect(await errorOf(res)).toMatchObject({ code: "not_available" });
    }
    expect(state.asked).toBe(0);
    expect(state.tables.connect_links).toHaveLength(1);
    expect(state.tables.connect_links[0].used_at).toBeNull();
  });

  it("still needs a signed-in member and the app's origin on the signed-in path", async () => {
    const { signup } = await appWith("false");
    expect((await signup(undefined, BODY)).status).toBe(401);
    expect((await signup("owner.token.sig", BODY, "https://evil.example")).status).toBe(403);
  });

  it("refuses another origin on the public routes too", async () => {
    const { signup, link } = await appWith("false");
    expect((await link(TOKEN, "https://evil.example")).status).toBe(403);
    expect((await signup(undefined, { ...BODY, connectToken: TOKEN }, "https://evil.example")).status).toBe(403);
  });
});

describe("flag on: the signed-in path (the #167 route)", () => {
  it("refuses staff", async () => {
    const { signup } = await appWith("true");
    expect((await signup("staff.token.sig", BODY)).status).toBe(403);
  });

  it("refuses an invalid body with validation_failed and the field", async () => {
    const { signup } = await appWith("true");
    const res = await signup("owner.token.sig", { ...BODY, phoneNumberId: null });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({ code: "validation_failed", fields: { phoneNumberId: expect.stringMatching(/Pick or add a phone number/) } });
  });

  it("without a connectToken it never takes the assisted path: no sign-in is 401 and nothing is read", async () => {
    const { signup } = await appWith("true");
    expect((await signup(undefined, BODY)).status).toBe(401);
    expect(state.asked).toBe(0);
  });
});

describe("the request log", () => {
  it("never shows a connect-link token: the path is logged with *** for it", async () => {
    await appWith("false");
    const { logPathFor } = await import("./app");
    expect(logPathFor(`/api/connect-links/${TOKEN}`)).toBe("/api/connect-links/***");
    expect(logPathFor("/api/admin/whatsapp/connect-link")).toBe("/api/admin/whatsapp/connect-link");
  });

  it("masks the token in a mangled address too (a trailing slash, an extra segment), which is answered 404 but still logged", async () => {
    await appWith("false");
    const { logPathFor } = await import("./app");
    expect(logPathFor(`/api/connect-links/${TOKEN}/`)).toBe("/api/connect-links/***/");
    expect(logPathFor(`/api/connect-links/${TOKEN}/x`)).toBe("/api/connect-links/***/x");
    expect(logPathFor("/api/connect-links/")).toBe("/api/connect-links/");
    expect(logPathFor("/api/connect-linksX")).toBe("/api/connect-linksX");
  });
});
