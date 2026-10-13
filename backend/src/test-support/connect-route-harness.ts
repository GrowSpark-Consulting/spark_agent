import type { SupabaseClient } from "@supabase/supabase-js";
import { vi } from "vitest";
import { fakeSupabase } from "./fake-supabase";

// The real router with a fresh environment, for the Embedded Signup and connect-link route tests. The env is read once and cached, so every app gets its own module
// graph (vi.resetModules); the caller's test file mocks the service-role client (../lib/supabase-admin) itself, because vi.mock is per file.

export const FRONTEND = "https://app.pakkaagent.in";
export const REALTY = "10000000-0000-0000-0000-000000000001";
export const ADMIN_ID = "user-admin@test.local";

const tenantRow = { id: REALTY, name: "Test Realty", vertical: "real-estate", timezone: "Asia/Kolkata", status: "trial", plan_key: "trial", trial_ends_at: null };
const ACCOUNTS: Record<string, { email: string; role: string }> = {
  "owner.token.sig": { email: "owner@test.local", role: "owner" },
  "staff.token.sig": { email: "staff@test.local", role: "staff" },
  "admin.token.sig": { email: "admin@test.local", role: "none" },
};

function fakeUserClient(token: string): SupabaseClient {
  const account = ACCOUNTS[token];
  const memberships = account && account.role !== "none" ? [{ tenant_id: REALTY, role: account.role, tenants: tenantRow }] : [];
  const { client } = fakeSupabase({ memberships: { data: memberships, error: null } });
  const getUser = async (jwt: string) => {
    const known = ACCOUNTS[jwt];
    return known
      ? { data: { user: { id: `user-${known.email}`, email: known.email } }, error: null }
      : { data: { user: null }, error: { __isAuthError: true, name: "AuthApiError", status: 401, message: "invalid JWT" } };
  };
  return Object.assign(client, { auth: { getUser } });
}

/** `fresh: false` keeps the module graph (for a file that mocks a module of the flow, whose first instance would otherwise outlive the reset); the flag is then the file's own. */
export async function appWith(flag: "true" | "false", options: { fresh?: boolean } = {}) {
  if (options.fresh !== false) vi.resetModules();
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
  const { createApp } = await import("../server/app");
  const app = createApp({ userClient: fakeUserClient, inngest: async () => Response.json({}), allowedOrigins: new Set([FRONTEND]) });
  const call = (method: "GET" | "POST", path: string, opts: { token?: string; body?: unknown; origin?: string } = {}) =>
    app(new Request(`http://localhost:4000${path}`, {
      method,
      headers: { origin: opts.origin ?? FRONTEND, "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
      ...(method === "POST" ? { body: JSON.stringify(opts.body ?? {}) } : {}),
    }));
  return {
    signup: (token: string | undefined, body: unknown, origin?: string) => call("POST", "/api/onboarding/whatsapp/embedded-signup", { ...(token ? { token } : {}), body, ...(origin ? { origin } : {}) }),
    link: (token: string, origin?: string) => call("GET", `/api/connect-links/${token}`, origin ? { origin } : {}),
    makeLink: (token: string | undefined, body: unknown) => call("POST", "/api/admin/whatsapp/connect-link", { ...(token ? { token } : {}), body }),
  };
}

export type RouteApp = Awaited<ReturnType<typeof appWith>>;
