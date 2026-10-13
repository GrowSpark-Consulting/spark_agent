import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "../test-support/fake-supabase";
import { errorOf } from "../test-support/http";

// How POST /api/onboarding/whatsapp/embedded-signup is wired through the real router: the flag, who may call it, and that a connectToken
// (the assisted flow, not built yet) is refused. The flow itself is tested in channels/whatsapp/connect/embedded-signup.test.ts.

// The first import of the whole router is slow on a cold cache.
vi.setConfig({ testTimeout: 30_000 });

const FRONTEND = "https://app.pakkaagent.in";
const REALTY = "10000000-0000-0000-0000-000000000001";
const tenantRow = { id: REALTY, name: "Test Realty", vertical: "real-estate", timezone: "Asia/Kolkata", status: "trial", plan_key: "trial", trial_ends_at: null };
const ACCOUNTS: Record<string, { email: string; role: string }> = {
  "owner.token.sig": { email: "owner@test.local", role: "owner" },
  "staff.token.sig": { email: "staff@test.local", role: "staff" },
};
const BODY = { code: "AQD-synthetic-code", wabaId: "100000000000001", phoneNumberId: "200000000000001", coexistence: false };

function fakeUserClient(token: string): SupabaseClient {
  const account = ACCOUNTS[token];
  const { client } = fakeSupabase({ memberships: { data: account ? [{ tenant_id: REALTY, role: account.role, tenants: tenantRow }] : [], error: null } });
  const getUser = async (jwt: string) => {
    const known = ACCOUNTS[jwt];
    return known
      ? { data: { user: { id: `user-${known.email}`, email: known.email } }, error: null }
      : { data: { user: null }, error: { __isAuthError: true, name: "AuthApiError", status: 401, message: "invalid JWT" } };
  };
  return Object.assign(client, { auth: { getUser } });
}

/** The router with a fresh environment: the env is read once and cached, so each flag value needs its own module graph. */
async function appWith(flag: "true" | "false") {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", FRONTEND);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "synthetic-anon-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-service-key");
  vi.stubEnv("EMBEDDINGS_API_KEY", "synthetic-embeddings-key");
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-anthropic-key");
  vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("EMBEDDED_SIGNUP_ENABLED", flag);
  vi.stubEnv("NEXT_PUBLIC_META_APP_ID", "111222333444555");
  vi.stubEnv("META_APP_SECRET", "synthetic0platform0app0secret");
  const { createApp } = await import("./app");
  const app = createApp({ userClient: fakeUserClient, inngest: async () => Response.json({}), allowedOrigins: new Set([FRONTEND]) });
  return (token: string | undefined, body: unknown, origin = FRONTEND) =>
    app(new Request("http://localhost:4000/api/onboarding/whatsapp/embedded-signup", {
      method: "POST",
      headers: { origin, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/onboarding/whatsapp/embedded-signup, flag off", () => {
  it("answers not_available (501) to a signed-in owner, whatever the body", async () => {
    const post = await appWith("false");
    for (const body of [BODY, { nonsense: true }, { ...BODY, connectToken: "x".repeat(43) }]) {
      const res = await post("owner.token.sig", body);
      expect(res.status).toBe(501);
      expect(await errorOf(res)).toMatchObject({ code: "not_available" });
    }
  });

  it("still needs a signed-in member and the app's origin", async () => {
    const post = await appWith("false");
    expect((await post(undefined, BODY)).status).toBe(401);
    expect((await post("owner.token.sig", BODY, "https://evil.example")).status).toBe(403);
  });
});

describe("POST /api/onboarding/whatsapp/embedded-signup, flag on", () => {
  it("refuses staff", async () => {
    const post = await appWith("true");
    expect((await post("staff.token.sig", BODY)).status).toBe(403);
  });

  it("refuses a connectToken with validation_failed on that field (the assisted link is not built yet), before Meta is asked", async () => {
    const post = await appWith("true");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await post("owner.token.sig", { ...BODY, connectToken: "x".repeat(43) });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({ code: "validation_failed", fields: { connectToken: expect.any(String) } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses an invalid body with validation_failed and the field", async () => {
    const post = await appWith("true");
    const res = await post("owner.token.sig", { ...BODY, phoneNumberId: null });
    expect(res.status).toBe(422);
    expect(await errorOf(res)).toMatchObject({ code: "validation_failed", fields: { phoneNumberId: expect.stringMatching(/Pick or add a phone number/) } });
  });
});
