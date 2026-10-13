import { randomBytes } from "node:crypto";
import type { TenantContext } from "@pakka/types";
import { describe, expect, it, vi } from "vitest";
import { connectionSecretContext, decryptSecret, encryptSecret } from "../../../lib/crypto";
import type { AuditEntry } from "../../../lib/audit";
import { AppError } from "../../../lib/errors";
import type { Check, Graph, GraphAnswer } from "./checks";
import { connectEmbeddedSignup, exchangeCode, type EmbeddedSignupDeps, type ExchangeResult } from "./embedded-signup";
import type { ConnectionRecord, ManualConnectDb, MetaProbe } from "./manual";

vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("base64"));
vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "synthetic-anon-key");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-service-key");
vi.stubEnv("EMBEDDINGS_API_KEY", "synthetic-embeddings-key");
vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-anthropic-key");

const A = "a0000000-0000-4000-8000-00000000000a";
const B = "b0000000-0000-4000-8000-00000000000b";
const NEW_ID = "d0000000-0000-4000-8000-0000000000d1";
const CODE = "AQD-synthetic-es-code";
const TOKEN = "EAAB-synthetic-business-token";
const APP_SECRET = "synthetic0platform0app0secret";
const PIN = "246810";
const NOW = new Date("2026-10-13T00:00:00Z");
const BODY = { code: CODE, wabaId: "100000000000001", phoneNumberId: "200000000000001", coexistence: false };
const GOOD: MetaProbe = {
  state: "ok",
  numberInAccount: true,
  info: { displayPhone: "+91 98765 43210", verifiedName: "Skyline Homes", qualityRating: "GREEN", facts: { nameStatus: "APPROVED", platformType: "CLOUD_API" } },
};
const SIXTH_OK: Check = { key: "test_message_delivered", status: "pass", message: "A test message was sent to the owner's number.", checked_at: "2026-10-13T00:00:00.000Z" };
const answered = (body: unknown, ok = true, status = 200): GraphAnswer => ({ state: "answered", ok, status, body });
const context = (role: "owner" | "admin" | "staff", tenantId = A): TenantContext =>
  ({ user: { id: "user-1", email: "o@example.test" }, tenant: { id: tenantId, name: "Sunrise Homes" }, role }) as unknown as TenantContext;

type Existing = { id: string; tenantId: string; channelId: string; method: string; status: string };
type Call = { method: string; path: string; token: string; body?: unknown };

function setup(
  over: {
    enabled?: boolean;
    appId?: string | undefined;
    appSecret?: string | undefined;
    pin?: string | undefined;
    exchange?: ExchangeResult;
    probe?: MetaProbe;
    existing?: Existing | null;
    subscribeAnswer?: GraphAnswer;
    registerAnswer?: GraphAnswer;
    listedApps?: unknown[];
    limit?: string | null;
    numberLimit?: (tenantId: string, keep: string | null) => Promise<void>;
    sendEvent?: () => Promise<void>;
    audit?: () => Promise<void>;
    sixth?: Check;
    expiresAt?: number;
  } = {},
) {
  const saved: { record: ConnectionRecord; replace: boolean }[] = [];
  const updates: { lastCheck: unknown }[] = [];
  const calls: Call[] = [];
  let subscribed = false;
  const graph: Graph = async (method, path, token, body) => {
    calls.push({ method, path, token, body });
    if (path.startsWith("debug_token")) return answered({ data: { is_valid: true, ...(over.expiresAt === undefined ? {} : { expires_at: over.expiresAt }), scopes: ["whatsapp_business_management", "whatsapp_business_messaging"] } });
    if (path.endsWith("/subscribed_apps") && method === "POST") {
      const a = over.subscribeAnswer ?? answered({ success: true });
      if (a.state === "answered" && a.ok) subscribed = true;
      return a;
    }
    if (path.endsWith("/subscribed_apps")) return answered({ data: over.listedApps ?? (subscribed ? [{ id: "1" }] : []) });
    if (path.endsWith("/register")) return over.registerAnswer ?? answered({ success: true });
    if (path.includes("primary_funding_id")) return answered({ primary_funding_id: "123" });
    return { state: "unreachable" };
  };
  const db: ManualConnectDb = {
    async tenantExists(id) {
      return id === A || id === B;
    },
    async findByPhoneNumberId() {
      return over.existing ?? null;
    },
    async channelIdFor() {
      return "c0000000-0000-4000-8000-0000000000c1";
    },
    async save(record, replace) {
      saved.push({ record, replace });
      return {
        id: record.id, tenant_id: record.tenantId, method: record.method ?? "manual_byo", waba_id: record.wabaId, phone_number_id: record.phoneNumberId,
        display_phone: record.displayPhone, verified_name: record.verifiedName, coexistence: record.coexistence ?? false, status: record.status,
        last_check: record.lastCheck, quality_rating: record.qualityRating, messaging_limit: record.messagingLimit ?? null, created_at: "2026-10-13T00:00:00Z",
      };
    },
    async updateLastCheck(_id, _tenantId, lastCheck) {
      updates.push({ lastCheck });
    },
  };
  const exchange = vi.fn(async () => over.exchange ?? ({ state: "ok", token: TOKEN } as ExchangeResult));
  const probe = vi.fn(async () => over.probe ?? GOOD);
  const audit = vi.fn<(entry: AuditEntry) => Promise<void>>(over.audit ?? (async () => {}));
  const sendEvent = vi.fn(over.sendEvent ?? (async () => {}));
  const testMessage = vi.fn(async () => over.sixth ?? SIXTH_OK);
  const deps: EmbeddedSignupDeps = {
    config: () => ({
      enabled: over.enabled ?? true,
      appId: "appId" in over ? over.appId : "111222333444555",
      appSecret: "appSecret" in over ? over.appSecret : APP_SECRET,
      registerPin: "pin" in over ? over.pin : PIN,
    }),
    db,
    exchange,
    graph,
    probe,
    messagingLimit: async () => ("limit" in over ? (over.limit ?? null) : "TIER_1K"),
    webhookSeen: async () => false,
    testMessage,
    encrypt: encryptSecret,
    now: () => NOW,
    newId: () => NEW_ID,
    audit,
    numberLimit: over.numberLimit,
    sendEvent,
  };
  return { saved, updates, calls, exchange, probe, audit, sendEvent, testMessage, run: (body: unknown = BODY, ctx: TenantContext = context("owner")) => connectEmbeddedSignup(ctx, body, deps) };
}

const codeOf = (p: Promise<unknown>) => p.then(() => "no error", (e) => (e instanceof AppError ? e.code : "other"));

describe("the flag", () => {
  it("answers not_available while off, before the body is read, with no call to Meta or the database", async () => {
    const s = setup({ enabled: false });
    expect(await codeOf(s.run({ nonsense: true }))).toBe("not_available");
    expect(s.exchange).not.toHaveBeenCalled();
    expect(s.calls).toHaveLength(0);
    expect(s.saved).toHaveLength(0);
  });

  it("answers not_available when on but our app id or secret is missing", async () => {
    expect(await codeOf(setup({ appId: undefined }).run())).toBe("not_available");
    expect(await codeOf(setup({ appSecret: undefined }).run())).toBe("not_available");
  });

  it("is off in the environment unless EMBEDDED_SIGNUP_ENABLED is exactly true", async () => {
    const { parseServerEnv } = await import("../../../lib/env");
    const parse = (flag: string | undefined) => parseServerEnv({ ...process.env, EMBEDDED_SIGNUP_ENABLED: flag }).EMBEDDED_SIGNUP_ENABLED;
    expect(parse(undefined)).toBe(false);
    expect(parse("false")).toBe(false);
    expect(parse("true")).toBe(true);
    expect(() => parse("1")).toThrow();
  });
});

describe("who may connect, and what is accepted", () => {
  it("refuses staff", async () => {
    const s = setup();
    expect(await codeOf(s.run(BODY, context("staff")))).toBe("forbidden");
    expect(s.exchange).not.toHaveBeenCalled();
  });

  it.each([
    ["no code", { ...BODY, code: "" }],
    ["a phone number that is not an id", { ...BODY, phoneNumberId: "+91 98765 43210" }],
    ["a missing phone number id (a flow that ended without a number)", { code: CODE, wabaId: BODY.wabaId, coexistence: false }],
    ["a null phone number id (the browser sends null when Meta's finish event had none)", { ...BODY, phoneNumberId: null }],
    ["a waba id with letters", { ...BODY, wabaId: "abc" }],
    ["coexistence that is not a boolean", { ...BODY, coexistence: "yes" }],
    ["a body that is not an object", "code"],
  ])("refuses %s with validation_failed and asks nothing of Meta", async (_name, body) => {
    const s = setup();
    expect(await codeOf(s.run(body))).toBe("validation_failed");
    expect(s.exchange).not.toHaveBeenCalled();
  });

  it("names the field that is wrong", async () => {
    const s = setup();
    const error = await s.run({ ...BODY, phoneNumberId: "nope" }).catch((e) => e);
    expect((error as AppError).fields).toHaveProperty("phoneNumberId");
  });

  it("drops a connectToken: the signed-in function never takes the assisted path (the route does, before it gets here)", async () => {
    const s = setup();
    const result = await s.run({ ...BODY, connectToken: "x".repeat(43) });
    expect(result.status).toBe("active");
    expect(s.saved[0].record.method).toBe("embedded_signup");
  });

  it("takes the business from the caller, never from the body", async () => {
    const s = setup();
    await s.run({ ...BODY, tenantId: B });
    expect(s.saved[0].record.tenantId).toBe(A);
  });
});

describe("the happy path", () => {
  it("exchanges the code, subscribes the app, registers the number, reads it, checks it and saves it active", async () => {
    const s = setup();
    const result = await s.run();
    expect(s.exchange).toHaveBeenCalledWith(CODE);
    expect(result).toMatchObject({ tenant_id: A, method: "embedded_signup", status: "active", coexistence: false, display_phone: "+91 98765 43210", verified_name: "Skyline Homes", quality_rating: "GREEN", messaging_limit: "TIER_1K" });
    const posts = s.calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.path)).toEqual([`${BODY.wabaId}/subscribed_apps`, `${BODY.phoneNumberId}/register`]);
    expect(posts.every((c) => c.token === TOKEN)).toBe(true);
    expect(posts[1].body).toEqual({ messaging_product: "whatsapp", pin: PIN });
    const checks = (result.last_check as { checks: { key: string; status: string }[] }).checks;
    expect(checks.map((c) => c.key)).toEqual(["token_permissions", "number_registered", "webhook_subscribed", "display_name_approved", "payment_method", "test_message_delivered"]);
    expect(checks.every((c) => c.status === "pass")).toBe(true);
  });

  it("subscribes before it registers", async () => {
    const s = setup();
    await s.run();
    const posts = s.calls.filter((c) => c.method === "POST").map((c) => c.path.split("/")[1]);
    expect(posts).toEqual(["subscribed_apps", "register"]);
  });

  it("encrypts the token under its own column, business and connection, and stores no app secret", async () => {
    const s = setup();
    await s.run();
    const { record } = s.saved[0];
    expect(record.method).toBe("embedded_signup");
    expect(record.appSecretEnc).toBeNull();
    expect(record.tokenEnc).not.toContain(TOKEN);
    expect(decryptSecret(record.tokenEnc, connectionSecretContext({ column: "token_enc", tenantId: A, connectionId: NEW_ID }))).toBe(TOKEN);
    expect(record.connectedBy).toBe("user-1");
    expect(record.clientBusinessId).toBeNull();
  });

  it("stores when the token expires, when Meta says", async () => {
    const at = Math.floor(Date.parse("2026-12-01T00:00:00Z") / 1000);
    const s = setup({ expiresAt: at });
    await s.run();
    expect(s.saved[0].record.tokenExpiresAt).toEqual(new Date("2026-12-01T00:00:00Z"));
  });

  it("clears a stored expiry when Meta does not say when this token runs out (a retry in place must not keep the old token's date)", async () => {
    const s = setup();
    await s.run();
    expect(s.saved[0].record.tokenExpiresAt).toBeNull();
  });

  it("runs the sixth check (a test message) once the number is active and saves it", async () => {
    const s = setup();
    await s.run();
    expect(s.testMessage).toHaveBeenCalledWith(A, "user-1");
    expect(s.updates).toHaveLength(1);
  });

  it("keeps the connection as saved when the sixth check cannot be recorded", async () => {
    const s = setup();
    s.testMessage.mockRejectedValueOnce(new Error("boom"));
    expect((await s.run()).status).toBe("active");
  });

  it("returns and logs no token, code or secret", async () => {
    const logs: string[] = [];
    const spies = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log")].map((spy) => spy.mockImplementation((...a: unknown[]) => void logs.push(a.join(" "))));
    const s = setup({ subscribeAnswer: { state: "unreachable" } });
    const result = await s.run();
    const everything = JSON.stringify({ result, audit: s.audit.mock.calls, event: s.sendEvent.mock.calls, logs });
    for (const secret of [TOKEN, CODE, APP_SECRET, PIN]) expect(everything).not.toContain(secret);
    spies.forEach((spy) => spy.mockRestore());
  });
});

describe("registering the number", () => {
  it("does not register a coexistence number, and says so in the connection", async () => {
    const s = setup();
    const result = await s.run({ ...BODY, coexistence: true });
    expect(s.calls.some((c) => c.path.endsWith("/register"))).toBe(false);
    expect(result.coexistence).toBe(true);
  });

  it("skips registering when no pin is set", async () => {
    const s = setup({ pin: undefined });
    await s.run();
    expect(s.calls.some((c) => c.path.endsWith("/register"))).toBe(false);
  });

  it("goes on when Meta refuses the registration, and the audit says it was not registered", async () => {
    const s = setup({ registerAnswer: answered({ error: { message: "nope" } }, false, 400) });
    expect((await s.run()).status).toBe("active");
    expect(s.audit.mock.calls[0][0].diff).toMatchObject({ registered: false });
  });

  it("records that it registered", async () => {
    const s = setup();
    await s.run();
    expect(s.audit.mock.calls[0][0].diff).toMatchObject({ registered: true, method: "embedded_signup", subscribed: true });
  });
});

describe("when Meta says no", () => {
  it("a code Meta refuses is upstream_failed with a restart message, and nothing is saved or sent", async () => {
    const s = setup({ exchange: { state: "rejected" } });
    const error = (await s.run().catch((e) => e)) as AppError;
    expect(error.code).toBe("upstream_failed");
    expect(error.message).toMatch(/start/i);
    expect(s.saved).toHaveLength(0);
    expect(s.calls).toHaveLength(0);
    expect(s.sendEvent).not.toHaveBeenCalled();
  });

  it("an exchange Meta does not answer is upstream_failed", async () => {
    const s = setup({ exchange: { state: "unreachable" } });
    expect(await codeOf(s.run())).toBe("upstream_failed");
    expect(s.saved).toHaveLength(0);
  });

  it("a number Meta cannot be asked about is upstream_failed and nothing is saved", async () => {
    const s = setup({ probe: { state: "unreachable" } });
    expect(await codeOf(s.run())).toBe("upstream_failed");
    expect(s.saved).toHaveLength(0);
    expect(s.sendEvent).not.toHaveBeenCalled();
  });

  it("a token Meta says has expired is saved failed with the expired-token message, and no event is sent", async () => {
    const s = setup({ probe: { state: "rejected", reason: "token_expired" } });
    const result = await s.run();
    expect(result.status).toBe("failed");
    const first = (result.last_check as { checks: { key: string; message: string }[] }).checks[0];
    expect(first.message).toMatch(/expired or is no longer valid/);
    expect(s.sendEvent).not.toHaveBeenCalled();
    expect(s.testMessage).not.toHaveBeenCalled();
  });

  it("a number that is not in the account is refused and nothing is saved (it would hold the id against its real owner)", async () => {
    const s = setup({ probe: { ...GOOD, numberInAccount: false } as MetaProbe });
    const error = (await s.run().catch((e) => e)) as AppError;
    expect(error.code).toBe("validation_failed");
    expect(error.fields).toHaveProperty("phoneNumberId");
    expect(s.saved).toHaveLength(0);
    expect(s.sendEvent).not.toHaveBeenCalled();
  });

  it("a token that cannot read the number is refused the same way, and nothing is saved", async () => {
    const s = setup({ probe: { state: "rejected" } });
    expect(await codeOf(s.run())).toBe("validation_failed");
    expect(s.saved).toHaveLength(0);
  });

  it("when our own subscription fails and another app is listed, the webhook check is a warning, not a pass, and the audit says not subscribed", async () => {
    const s = setup({ subscribeAnswer: answered({ error: {} }, false, 400), listedApps: [{ id: "bsp-app" }] });
    const result = await s.run();
    const webhook = (result.last_check as { checks: { key: string; status: string; message: string }[]; overall: string }).checks.find((c) => c.key === "webhook_subscribed");
    expect(webhook?.status).toBe("warn");
    expect(webhook?.message).toMatch(/couldn.t subscribe/i);
    expect((result.last_check as { overall: string }).overall).toBe("warn");
    expect(result.status).toBe("active");
    expect(s.audit.mock.calls[0][0].diff).toMatchObject({ subscribed: false });
  });

  it("nothing subscribed after the attempt is a warning: the number stays active", async () => {
    const s = setup({ subscribeAnswer: answered({ error: {} }, false, 400) });
    const result = await s.run();
    expect(result.status).toBe("active");
    const webhook = (result.last_check as { checks: { key: string; status: string }[] }).checks.find((c) => c.key === "webhook_subscribed");
    expect(webhook?.status).toBe("warn");
  });
});

describe("the number", () => {
  it("is refused when another business has it", async () => {
    const s = setup({ existing: { id: "x", tenantId: B, channelId: "c", method: "embedded_signup", status: "active" } });
    expect(await codeOf(s.run())).toBe("conflict");
    expect(s.exchange).not.toHaveBeenCalled();
  });

  it("is refused when this business already has it active (a repeat does not spend a second code)", async () => {
    const s = setup({ existing: { id: "x", tenantId: A, channelId: "c", method: "embedded_signup", status: "active" } });
    expect(await codeOf(s.run())).toBe("conflict");
    expect(s.exchange).not.toHaveBeenCalled();
  });

  it("is refused when this business has it by another method and it is active", async () => {
    const s = setup({ existing: { id: "x", tenantId: A, channelId: "c", method: "manual_byo", status: "active" } });
    expect(await codeOf(s.run())).toBe("conflict");
  });

  it("is taken over in place when this business's manual row for it failed", async () => {
    const s = setup({ existing: { id: "e0000000-0000-4000-8000-0000000000e2", tenantId: A, channelId: "c0000000-0000-4000-8000-0000000000c9", method: "manual_byo", status: "failed" } });
    await s.run();
    expect(s.saved[0].replace).toBe(true);
    expect(s.saved[0].record).toMatchObject({ method: "embedded_signup", appSecretEnc: null });
  });

  it("is connected again in place when our own embedded_signup row failed, was disconnected or is pending", async () => {
    for (const status of ["failed", "disconnected", "pending"]) {
      const s = setup({ existing: { id: "e0000000-0000-4000-8000-0000000000e1", tenantId: A, channelId: "c0000000-0000-4000-8000-0000000000c9", method: "embedded_signup", status } });
      await s.run();
      expect(s.saved[0].replace).toBe(true);
      expect(s.saved[0].record.id).toBe("e0000000-0000-4000-8000-0000000000e1");
    }
  });

  it("is refused before Meta is asked when the plan has no room, and the code is not spent", async () => {
    const s = setup({ numberLimit: async () => Promise.reject(new AppError("plan_required", "Your plan allows 1 WhatsApp number.")) });
    expect(await codeOf(s.run())).toBe("plan_required");
    expect(s.exchange).not.toHaveBeenCalled();
  });
});

describe("whatsapp/connected", () => {
  it("is sent once after an active connection is saved, with ids only and the check's ran_at in its id", async () => {
    const s = setup();
    const result = await s.run();
    expect(s.sendEvent).toHaveBeenCalledTimes(1);
    const event = s.sendEvent.mock.calls[0] as unknown as [{ name: string; id: string; data: Record<string, unknown> }];
    expect(event[0]).toEqual({
      name: "whatsapp/connected",
      id: `whatsapp_connected:${NEW_ID}:${(result.last_check as { ran_at: string }).ran_at}`,
      data: { tenantId: A, connectionId: NEW_ID },
    });
  });

  it("a failure to send it does not fail or undo the connection", async () => {
    const s = setup({ sendEvent: async () => Promise.reject(new Error("inngest down")) });
    expect((await s.run()).status).toBe("active");
  });

  it("a failed audit write does not fail the connection", async () => {
    const s = setup({ audit: async () => Promise.reject(new Error("audit down")) });
    expect((await s.run()).status).toBe("active");
  });
});

describe("exchangeCode (the real client, with fetch mocked)", () => {
  const config = { appId: "111222333444555", appSecret: APP_SECRET };
  const respond = (status: number, body: string) => vi.fn(async () => new Response(body, { status }));

  it("asks GET /oauth/access_token with the app id, the app secret and the code, and no redirect_uri", async () => {
    const fetchFn = respond(200, JSON.stringify({ access_token: TOKEN, token_type: "bearer" }));
    expect(await exchangeCode(CODE, config, fetchFn as unknown as typeof fetch)).toEqual({ state: "ok", token: TOKEN });
    const url = new URL(String((fetchFn.mock.calls as unknown as [string, RequestInit][])[0][0]));
    expect(url.origin + url.pathname).toMatch(/^https:\/\/graph\.facebook\.com\/v\d+\.\d+\/oauth\/access_token$/);
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: config.appId, client_secret: APP_SECRET, code: CODE });
    expect((fetchFn.mock.calls as unknown as [string, RequestInit][])[0][1].method).toBe("GET");
  });

  it("also reads a body that is the token alone (as Meta's page shows it)", async () => {
    expect(await exchangeCode(CODE, config, respond(200, `${TOKEN}\n`) as unknown as typeof fetch)).toEqual({ state: "ok", token: TOKEN });
  });

  it("a refused code is rejected, a 5xx or 429 is unreachable, a thrown fetch is unreachable", async () => {
    expect(await exchangeCode(CODE, config, respond(400, JSON.stringify({ error: { code: 100 } })) as unknown as typeof fetch)).toEqual({ state: "rejected" });
    expect(await exchangeCode(CODE, config, respond(500, "") as unknown as typeof fetch)).toEqual({ state: "unreachable" });
    expect(await exchangeCode(CODE, config, respond(429, "") as unknown as typeof fetch)).toEqual({ state: "unreachable" });
    expect(await exchangeCode(CODE, config, (async () => Promise.reject(new Error(`failed ${APP_SECRET}`))) as unknown as typeof fetch)).toEqual({ state: "unreachable" });
  });

  it("a 200 with no usable token is rejected", async () => {
    expect(await exchangeCode(CODE, config, respond(200, JSON.stringify({ nothing: 1 })) as unknown as typeof fetch)).toEqual({ state: "rejected" });
    expect(await exchangeCode(CODE, config, respond(200, "<html>") as unknown as typeof fetch)).toEqual({ state: "rejected" });
  });
});

describe("the real Graph client", () => {
  it("sends a JSON body only when it is given, and none for a read", async () => {
    const { graph } = await import("./checks");
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchFn);
    try {
      await graph("POST", "200000000000001/register", TOKEN, { messaging_product: "whatsapp", pin: PIN });
      await graph("GET", "200000000000001", TOKEN);
      const [post, get] = fetchFn.mock.calls as unknown as [string, RequestInit][];
      expect(post[1].body).toBe(JSON.stringify({ messaging_product: "whatsapp", pin: PIN }));
      expect((post[1].headers as Record<string, string>)["content-type"]).toBe("application/json");
      expect(get[1].body).toBeUndefined();
      expect((get[1].headers as Record<string, string>)["content-type"]).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("a finish event with no number", () => {
  it("asks the person to pick a number, in words they can act on", async () => {
    const error = (await setup().run({ ...BODY, phoneNumberId: null }).catch((e) => e)) as AppError;
    expect(error.fields?.phoneNumberId).toMatch(/Pick or add a phone number/);
  });
});
