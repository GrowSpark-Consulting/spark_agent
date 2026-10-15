import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "../test-support/fake-supabase";
import { errorOf } from "../test-support/http";

// Who may call which route, proved through the REAL route table (ROUTES), the real createApp, the real auth wrappers (tenantRoute, adminRoute,
// requireTenant, requirePlatformAdmin) and the real services' role checks. Only two things are faked: Supabase Auth (which token is whom) and the
// database. The service-role database is a recorder: a denied request must not have read or written anything but the platform_admins lookup, so a
// 403 here means the guard stopped the request, not that a mocked answer said so. This does not prove row-level security, the SQL functions or
// anything about a real database.

const state = vi.hoisted(() => ({ admin: "8f0e0000-0000-4000-8000-000000000001", calls: [] as string[] }));

// Anything that is not the platform_admins lookup is recorded; it answers with empty data, enough for a request that passed its guard to go on.
vi.mock("../lib/supabase-admin", () => {
  const anything = (): unknown =>
    new Proxy(function () {}, {
      get: (_t, prop) => (prop === "then" ? (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }) : anything()),
      apply: () => anything(),
    });
  return {
    supabaseAdmin: () => ({
      from: (table: string) => {
        if (table === "platform_admins") {
          return { select: () => ({ eq: (_c: string, id: string) => ({ maybeSingle: async () => ({ data: id === state.admin ? { user_id: id } : null, error: null }) }) }) };
        }
        state.calls.push(`from:${table}`);
        return anything();
      },
      rpc: async (name: string) => {
        state.calls.push(`rpc:${name}`);
        return { data: [], error: null };
      },
    }),
  };
});

// PayU is switched on, so an owner-only billing route reaches its role check (without it every billing call answers not_available first).
vi.mock("../lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/env")>()),
  serverEnv: () => ({
    PAYU_MERCHANT_KEY: "test-key",
    PAYU_MERCHANT_SALT: "test-salt",
    PAYU_MODE: "test",
    API_PUBLIC_URL: "https://api.example.test",
    NEXT_PUBLIC_APP_URL: "https://app.example.test",
  }),
}));

const { createApp } = await import("./app");
const { ROUTES } = await import("./routes");

const FRONTEND = "https://app.pakkaagent.in";
const REALTY = "10000000-0000-0000-0000-000000000001";
const SALON = "10000000-0000-0000-0000-000000000002";
const ID = "20000000-0000-0000-0000-000000000001";

const tenantRow = (id: string, name: string) => ({ id, name, vertical: "real-estate", timezone: "Asia/Kolkata", status: "active", plan_key: "starter", trial_ends_at: null });
const member = (id: string, name: string, role: string) => ({ tenant_id: id, role, tenants: tenantRow(id, name) });

// Access tokens the fake Supabase Auth knows. `platform` works for the Spark Agent team and belongs to no business.
const ACCOUNTS: Record<string, { id: string; email: string; memberships: unknown[] }> = {
  owner: { id: "u-owner", email: "owner@test.local", memberships: [member(REALTY, "Test Realty", "owner")] },
  admin: { id: "u-admin", email: "admin@test.local", memberships: [member(REALTY, "Test Realty", "admin")] },
  staff: { id: "u-staff", email: "staff@test.local", memberships: [member(REALTY, "Test Realty", "staff")] },
  mixed: { id: "u-mixed", email: "mixed@test.local", memberships: [member(REALTY, "Test Realty", "owner"), member(SALON, "Beta Salon", "staff")] },
  platform: { id: state.admin, email: "team@test.local", memberships: [] },
  nomember: { id: "u-none", email: "none@test.local", memberships: [] },
};
const tokenOf = (name: string) => `${name}.token.sig`;
const ACCOUNT_BY_TOKEN = new Map(Object.keys(ACCOUNTS).map((n) => [tokenOf(n), ACCOUNTS[n]]));

function fakeUserClient(token: string): SupabaseClient {
  const account = ACCOUNT_BY_TOKEN.get(token);
  const { client } = fakeSupabase({ memberships: { data: account?.memberships ?? [], error: null }, whatsapp_connections_public: { data: [], error: null } });
  const getUser = async (jwt: string) => {
    const known = ACCOUNT_BY_TOKEN.get(jwt);
    return known
      ? { data: { user: { id: known.id, email: known.email } }, error: null }
      : { data: { user: null }, error: { __isAuthError: true, name: "AuthApiError", status: 401, message: "invalid JWT" } };
  };
  return Object.assign(client, { auth: { getUser } });
}

const app = createApp({ userClient: fakeUserClient, inngest: async () => Response.json({}), allowedOrigins: new Set([FRONTEND]) });

interface Call {
  method: string;
  path: string;
  body?: unknown;
}
function send({ method, path, body }: Call, who?: string | null, tenant?: string) {
  return app(
    new Request(`http://localhost:4000${path}`, {
      method,
      headers: {
        origin: FRONTEND,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(who ? { authorization: `Bearer ${who === "forged" ? "forged.token.sig" : tokenOf(who)}` } : {}),
        ...(tenant ? { "x-pakka-tenant": tenant } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}
/** Not refused by the guard: a request that passed it goes on and may fail later for other reasons (fake database), but never 401 or 403. */
const passedGuard = (res: Response) => expect([401, 403], `status ${res.status}`).not.toContain(res.status);

beforeEach(() => {
  state.calls.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// --- the Spark Agent team's routes -------------------------------------------------------------------------------------------------------------

const ADMIN_CALLS: Call[] = [
  { method: "GET", path: "/api/admin/tenants" },
  { method: "GET", path: "/api/admin/whatsapp/connections" },
  { method: "POST", path: `/api/admin/tenants/${ID}/extend-trial`, body: { days: 3 } },
  { method: "POST", path: `/api/admin/tenants/${ID}/credits`, body: { amount: 5 } },
  { method: "PATCH", path: "/api/admin/plans/starter", body: { name: "Starter" } },
  { method: "PATCH", path: "/api/admin/features/booking", body: { defaultOn: true } },
  { method: "GET", path: "/api/admin/payments/refunds" },
  { method: "GET", path: "/api/admin/metrics" },
  { method: "POST", path: "/api/admin/whatsapp/manual", body: {} },
];

describe("/api/admin/* billing and connection routes (platform admin only)", () => {
  for (const call of ADMIN_CALLS) {
    const name = `${call.method} ${call.path.replace(ID, ":id")}`;
    describe(name, () => {
      it("answers 401 unauthenticated with no token or a token Supabase does not know, and reads nothing", async () => {
        for (const who of [null, "forged"]) {
          const res = await send(call, who);
          expect(res.status).toBe(401);
          expect((await errorOf(res)).code).toBe("unauthenticated");
        }
        expect(state.calls).toEqual([]);
      });

      it("answers 403 forbidden to an owner, an admin and a staff member of a business, whatever business they name, and reads nothing", async () => {
        for (const who of ["owner", "admin", "staff"]) {
          for (const tenant of [undefined, REALTY, SALON]) {
            const res = await send(call, who, tenant);
            expect(res.status, `${who} ${tenant ?? "no header"}`).toBe(403);
            expect(await errorOf(res)).toEqual({ code: "forbidden", message: "Only the Spark Agent team can do this." });
          }
        }
        expect((await send(call, "nomember")).status).toBe(403);
        expect(state.calls).toEqual([]);
      });

      it("lets a platform admin through the guard", async () => {
        passedGuard(await send(call, "platform"));
      });
    });
  }

  it("a platform admin's list request reaches the service (control: the harness can tell allowed from denied)", async () => {
    const res = await send({ method: "GET", path: "/api/admin/tenants" }, "platform");
    expect(res.status).toBe(200);
    expect(state.calls).toEqual(["rpc:admin_tenants"]);
  });
});

// --- owner-only billing ------------------------------------------------------------------------------------------------------------------------

const OWNER_ONLY: Call[] = [
  { method: "POST", path: "/api/billing/checkout", body: { planKey: "starter", cycle: "monthly" } },
  { method: "POST", path: "/api/billing/topup", body: {} },
  { method: "POST", path: "/api/billing/setup-fee", body: {} },
  { method: "POST", path: "/api/billing/change-plan", body: { planKey: "pro" } },
  { method: "POST", path: "/api/billing/cancel" },
  { method: "POST", path: "/api/billing/resume" },
];

describe("owner-only billing routes", () => {
  for (const call of OWNER_ONLY) {
    describe(`${call.method} ${call.path}`, () => {
      it("answers 401 with no token", async () => {
        expect((await send(call, null)).status).toBe(401);
        expect(state.calls).toEqual([]);
      });

      it("answers 403 to an admin and to staff, naming the owner, before reading or writing anything", async () => {
        for (const who of ["admin", "staff"]) {
          const res = await send(call, who);
          expect(res.status, who).toBe(403);
          const error = await errorOf(res);
          expect(error.code).toBe("forbidden");
          expect(error.message).toMatch(/^Only the business owner can /);
        }
        expect(state.calls).toEqual([]);
      });

      it("lets the owner past the role check", async () => {
        passedGuard(await send(call, "owner"));
      });

      it("takes the role from the business the header names: owner of one business and staff in another is refused for the second", async () => {
        expect((await send(call, "mixed", SALON)).status).toBe(403);
        expect(state.calls).toEqual([]);
        passedGuard(await send(call, "mixed", REALTY));
      });
    });
  }

  it("lets any member read a payment, not only the owner (control: only the owner-only routes refuse)", async () => {
    for (const who of ["owner", "admin", "staff"]) passedGuard(await send({ method: "GET", path: `/api/billing/payments/${ID}` }, who));
  });
});

// --- a customer's data deletion and the feature switches ---------------------------------------------------------------------------------------

const OWNER_OR_ADMIN: Call[] = [
  { method: "GET", path: `/api/contacts/${ID}/deletion` },
  { method: "POST", path: `/api/contacts/${ID}/deletion` },
  { method: "PATCH", path: "/api/features/reminder_24h", body: { enabled: false } },
];

describe("owner-or-admin routes: a customer's data deletion (preview and request) and the feature switches", () => {
  for (const call of OWNER_OR_ADMIN) {
    describe(`${call.method} ${call.path.replace(ID, ":id")}`, () => {
      it("answers 401 with no token", async () => {
        expect((await send(call, null)).status).toBe(401);
        expect(state.calls).toEqual([]);
      });

      it("answers 403 to staff, naming an owner or admin, before reading or writing anything", async () => {
        const res = await send(call, "staff");
        expect(res.status).toBe(403);
        const error = await errorOf(res);
        expect(error.code).toBe("forbidden");
        expect(error.message).toMatch(/^Only an owner or admin can /);
        expect(state.calls).toEqual([]);
      });

      it("lets an owner and an admin past the role check", async () => {
        passedGuard(await send(call, "owner"));
        passedGuard(await send(call, "admin"));
      });

      it("refuses a member who is staff in the business the header names, even if they own another", async () => {
        expect((await send(call, "mixed", SALON)).status).toBe(403);
        expect(state.calls).toEqual([]);
        passedGuard(await send(call, "mixed", REALTY));
      });
    });
  }

  it("a deletion preview acts on the caller's own business only: the contact is looked up with the business from the session, never from the request", async () => {
    await send({ method: "GET", path: `/api/contacts/${ID}/deletion` }, "owner", SALON);
    expect(state.calls).toEqual(["rpc:contact_deletion_preview"]);
  });
});

// --- every route has a decision ----------------------------------------------------------------------------------------------------------------

// Routes that need no user login, with the reason. Their own checks (a signature, a token in the path, a verified PayU answer) are tested elsewhere.
const PUBLIC: Record<string, string> = {
  "GET /api/health": "liveness for Railway",
  "GET /api/webhooks/whatsapp": "Meta's verification handshake (verify token)",
  "POST /api/webhooks/whatsapp": "Meta's messages (signature verified)",
  "POST /api/webhooks/payu": "PayU's webhook (the answer is verified with PayU)",
  "POST /api/billing/payu/return": "the payer's browser comes back from PayU (verified with PayU, then a redirect)",
  "GET /api/inngest": "Inngest's serve endpoint (its own handler; function calls are signed)",
  "PUT /api/inngest": "Inngest's serve endpoint: registration (its own handler; signed)",
  "POST /api/inngest": "Inngest's serve endpoint: function calls (its own handler; signed)",
  "GET /api/connect-links/:token": "the assisted connect page: the token in the path is the credential",
  "GET /h/:token": "a staff alert's button: a signed token says who tapped",
  "GET /api/calendar/google/callback": "Google's redirect: the signed state says who asked",
};

// Routes whose first answer comes before any login, by documented design, so an unauthenticated call is not a 401.
const ANSWERS_BEFORE_LOGIN: Record<string, string> = {
  "POST /api/admin/whatsapp/connect-link": "not_available while EMBEDDED_SIGNUP_ENABLED is off, before anyone is looked up (routes.ts adminConnectLink)",
};

const keyOf = (method: string, path: string) => `${method} ${path}`;
const allRoutes = ROUTES.flatMap((r) => Object.keys(r.methods).filter((m) => m !== "OPTIONS").map((method) => ({ route: r, method, key: keyOf(method, r.path) })));

describe("every registered route has an explicit answer for a caller who is not signed in", () => {
  it("is either listed as public (with a reason) or refuses an unauthenticated call with 401", async () => {
    const stale = [...Object.keys(PUBLIC), ...Object.keys(ANSWERS_BEFORE_LOGIN)].filter((k) => !allRoutes.some((r) => r.key === k));
    expect(stale, "listed here but no longer registered").toEqual([]);

    const unauthenticated: string[] = [];
    for (const { route, method, key } of allRoutes) {
      if (key in PUBLIC || key in ANSWERS_BEFORE_LOGIN) continue;
      const path = route.path.replace(/:[a-zA-Z]+/g, ID);
      const res = await send({ method, path, body: method === "GET" ? undefined : {} }, null);
      if (res.status !== 401) unauthenticated.push(`${key} → ${res.status}`);
    }
    expect(unauthenticated, "a route answers someone who is not signed in: sign-in is required, or list it as public with a reason").toEqual([]);
    expect(state.calls).toEqual([]);
  });

  it("answers the one documented exception with its own refusal, not with data", async () => {
    const res = await send({ method: "POST", path: "/api/admin/whatsapp/connect-link", body: {} }, null);
    expect([401, 404, 501]).toContain(res.status);
    expect(state.calls).toEqual([]);
  });
});
