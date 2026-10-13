import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionSecretContext, encryptSecret } from "../../lib/crypto";
import { fakeSupabase } from "../../test-support/fake-supabase";

// The sender notify.send uses in production: the connection loader, the adapter wrapper and the startup
// registration. The last block runs notify.send itself through the registered sender, with only the
// database and Meta faked, so the whole send path is covered (audit items D2-24 and D2-27).

type RpcResult = { data: unknown; error: { code?: string; message: string } | null };
const rpcHandlers: Record<string, (args: Record<string, unknown>) => RpcResult> = {};
const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => rpcHandlers[fn](args));
let db = fakeSupabase({});
vi.mock("../../lib/supabase-admin", () => ({ supabaseAdmin: () => ({ rpc, from: (table: string) => db.client.from(table) }) }));
vi.mock("../../features/is-enabled", () => ({ isEnabled: async () => true }));

const { send } = await import("../../notify/send");
const { OutsideWindowError, registerSender, SendError, senderFactory } = await import("../../notify/sender");
const { loadSendConnection, registerWhatsAppSender, whatsAppSender, whatsAppSenderFactory } = await import("./message-sender");

// Synthetic values only: nothing here is a real token, number or Meta response.
const env = { ENCRYPTION_KEY: randomBytes(32).toString("base64"), META_GRAPH_API_VERSION: "v26.0" };
const TENANT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const CONNECTION = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
const CONVERSATION = "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f601";
const PHONE_NUMBER_ID = "200000000000001";
const TOKEN = "EAAB-synthetic-token-never-leak-0002";
const GRAPH_URL = `https://graph.facebook.com/v26.0/${PHONE_NUMBER_ID}/messages`;
const WAMID = "wamid.SYNTHETIC_OUT_0002";

const tokenEnc = () => encryptSecret(TOKEN, connectionSecretContext({ column: "token_enc", tenantId: TENANT, connectionId: CONNECTION }), env);
const row = (over: Record<string, unknown> = {}) => ({ tenant_id: TENANT, method: "manual_byo", phone_number_id: PHONE_NUMBER_ID, token_enc: tokenEnc(), status: "active", ...over });
const PLATFORM_TENANT = "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b";
const ids = { tenantId: TENANT, connectionId: CONNECTION };

const reply = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const okSend = () => reply(200, { messaging_product: "whatsapp", messages: [{ id: WAMID }] });
const metaError = (code: number) => ({ error: { message: "MARKER-meta-message", type: "OAuthException", code, fbtrace_id: "MARKER-trace" } });

let meta: ReturnType<typeof vi.fn<typeof fetch>>;
let logs: unknown[][];
beforeEach(() => {
  db = fakeSupabase({ whatsapp_connections: { data: [row()], error: null } });
  meta = vi.fn<typeof fetch>(async () => okSend());
  logs = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args);
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  registerSender(undefined);
});

describe("loadSendConnection", () => {
  it("reads one active connection of this business by its id", async () => {
    await expect(loadSendConnection(db.client, ids)).resolves.toEqual({
      tenantId: TENANT,
      connectionId: CONNECTION,
      phoneNumberId: PHONE_NUMBER_ID,
      tokenEnc: expect.any(String),
    });
    expect(db.calls).toContainEqual({ table: "whatsapp_connections", method: "select", args: ["tenant_id, method, phone_number_id, token_enc, status"] });
    expect(db.calls).toContainEqual({ table: "whatsapp_connections", method: "eq", args: ["id", CONNECTION] });
  });

  it("uses one of our platform numbers for a routed business, decrypting with the number's own business (0030)", async () => {
    const { client } = fakeSupabase({ whatsapp_connections: { data: [row({ tenant_id: PLATFORM_TENANT, method: "platform" })], error: null } });
    await expect(loadSendConnection(client, ids)).resolves.toMatchObject({ tenantId: PLATFORM_TENANT, connectionId: CONNECTION });
  });

  it.each([
    ["no row", []],
    ["a pending connection", [row({ status: "pending" })]],
    ["a failed connection", [row({ status: "failed" })]],
    ["a disconnected number", [row({ status: "disconnected" })]],
    ["another business's own number", [row({ tenant_id: PLATFORM_TENANT })]],
    ["an inactive platform number", [row({ tenant_id: PLATFORM_TENANT, method: "platform", status: "failed" })]],
  ])("refuses %s as whatsapp_not_connected", async (_why, data) => {
    const { client } = fakeSupabase({ whatsapp_connections: { data, error: null } });
    const err = await loadSendConnection(client, ids).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendError);
    expect(err).toMatchObject({ code: "whatsapp_not_connected", retryable: false, outcomeUnknown: false });
  });

  it("throws a plain error when the database fails, so notify.send logs it", async () => {
    const { client } = fakeSupabase({ whatsapp_connections: { data: null, error: { code: "57014", message: "statement timeout" } } });
    const err = await loadSendConnection(client, ids).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SendError);
  });
});

describe("whatsAppSender", () => {
  const connection = () => ({ ...ids, phoneNumberId: PHONE_NUMBER_ID, tokenEnc: tokenEnc() });
  const sender = () => whatsAppSender(connection(), { fetch: meta, env, timeoutMs: 20 });

  it("returns Meta's id for text and templates", async () => {
    await expect(sender().sendText("+919840012345", "Hi")).resolves.toEqual({ providerMsgId: WAMID });
    await expect(sender().sendTemplate("+919840012345", "booking_confirmed_v1", "en", ["4 pm"])).resolves.toEqual({ providerMsgId: WAMID });
    expect(JSON.parse(meta.mock.calls[1][1]?.body as string).template).toMatchObject({ name: "booking_confirmed_v1", language: { code: "en" } });
  });

  it("returns Meta's id for reply buttons, sent as an interactive message", async () => {
    const message = { type: "buttons" as const, body: "Visit tomorrow at 5 pm?", buttons: [{ id: "booking:b1:confirm", title: "Confirm" }] };
    await expect(sender().sendInteractive("+919840012345", message)).resolves.toEqual({ providerMsgId: WAMID });
    expect(JSON.parse(meta.mock.calls[0][1]?.body as string)).toMatchObject({ type: "interactive", interactive: { type: "button" } });
  });

  it("throws OutsideWindowError when Meta says the 24-hour window has closed", async () => {
    meta.mockImplementation(async () => reply(400, metaError(131047)));
    await expect(sender().sendText("+919840012345", "Hi")).rejects.toBeInstanceOf(OutsideWindowError);
    const message = { type: "buttons" as const, body: "Visit tomorrow?", buttons: [{ id: "b", title: "Confirm" }] };
    await expect(sender().sendInteractive("+919840012345", message)).rejects.toBeInstanceOf(OutsideWindowError);
  });

  it.each([
    ["a rate limit", async () => reply(429, metaError(130429)), { code: "rate_limited", retryable: true, outcomeUnknown: false }],
    ["an expired token", async () => reply(401, metaError(190)), { code: "whatsapp_not_connected", retryable: false, outcomeUnknown: false }],
    ["an unknown template", async () => reply(404, metaError(132001)), { code: "upstream_failed", retryable: false, outcomeUnknown: false }],
    ["no answer in time", () => new Promise<Response>(() => {}), { code: "upstream_failed", retryable: true, outcomeUnknown: true }],
  ] as const)("throws a SendError with the adapter's code and flags for %s", async (_why, answer, expected) => {
    meta.mockImplementation(answer);
    const err = await sender().sendTemplate("+919840012345", "booking_confirmed_v1", "en", ["4 pm"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendError);
    expect(err).not.toBeInstanceOf(OutsideWindowError);
    expect(err).toMatchObject(expected);
    expect(JSON.stringify(err) + String((err as Error).message)).not.toMatch(/MARKER|EAAB/);
  });
});

describe("registerWhatsAppSender", () => {
  it("makes notify.send's factory the WhatsApp one, which loads the business's connection", async () => {
    registerSender(undefined);
    registerWhatsAppSender();
    const factory = senderFactory();
    expect(factory).toBeTypeOf("function");
    const sender = await factory!(ids);
    expect(sender).toMatchObject({ sendText: expect.any(Function), sendTemplate: expect.any(Function), sendInteractive: expect.any(Function) });
    expect(db.calls).toContainEqual({ table: "whatsapp_connections", method: "eq", args: ["id", CONNECTION] });
  });
});

describe("notify.send through the registered WhatsApp sender", () => {
  const target = (over: Record<string, unknown> = {}) => ({
    connection_id: CONNECTION,
    conversation_id: CONVERSATION,
    contact_id: "6fa459ea-ee8a-4ca4-894e-db77e160355e",
    to_phone: "+919840012345",
    opted_out: false,
    last_customer_msg_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1 hour ago
    language: "en",
    recent_test_messages: 0,
    ...over,
  });
  const ok = (data: unknown): RpcResult => ({ data, error: null });
  const calls = (fn: string) => rpc.mock.calls.filter(([name]) => name === fn).map(([, args]) => args);
  const graphBodies = () => meta.mock.calls.map(([, init]) => JSON.parse(init?.body as string));

  beforeEach(() => {
    rpc.mockClear();
    rpcHandlers.notify_target = () => ok([target()]);
    rpcHandlers.notify_template = () => ok([{ name: "booking_confirmed_v1", language: "en", category: "utility" }]);
    rpcHandlers.notify_record = () => ok(null);
    rpcHandlers.spend_credits = () => ok(true);
    rpcHandlers.refund_credits = () => ok(1);
    registerSender(whatsAppSenderFactory({ fetch: meta, env, timeoutMs: 50 }));
  });

  it("sends an AI reply inside the window to Meta, charges 1 credit and records it with Meta's id", async () => {
    const outcome = await send(TENANT, "ai_reply", { conversationId: CONVERSATION, text: "Aster 3BHKs start at ₹88 L." });
    expect(outcome).toMatchObject({ status: "sent", providerMsgId: WAMID, creditsCharged: 1, usedTemplate: false });
    if (outcome.status !== "sent") throw new Error("not sent");

    expect(meta).toHaveBeenCalledTimes(1);
    const [url, init] = meta.mock.calls[0];
    expect(url).toBe(GRAPH_URL);
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(graphBodies()[0]).toMatchObject({ to: "+919840012345", type: "text", text: { body: "Aster 3BHKs start at ₹88 L." } });

    expect(calls("spend_credits")).toEqual([expect.objectContaining({ p_amount: 1, p_reason: "ai_reply", p_ref_id: outcome.messageId })]);
    expect(calls("refund_credits")).toHaveLength(0);
    expect(calls("notify_record")).toEqual([
      expect.objectContaining({
        p_tenant_id: TENANT,
        p_message_id: outcome.messageId,
        p_conversation_id: CONVERSATION,
        p_provider_msg_id: WAMID,
        p_body: "Aster 3BHKs start at ₹88 L.",
        p_template_name: null,
        p_credits: 1,
        p_sender: "ai",
        p_actor: "ai",
        p_kind: "ai_reply",
      }),
    ]);
  });

  it("sends the approved template with its variables outside the window", async () => {
    rpcHandlers.notify_target = () => ok([target({ last_customer_msg_at: null, language: "ta" })]);
    rpcHandlers.notify_template = () => ok([{ name: "booking_confirmed_v1", language: "ta", category: "utility" }]);
    const outcome = await send(TENANT, "booking_confirmation", { conversationId: CONVERSATION, templateParams: ["கார்த்திக்", "4 pm"] });
    expect(outcome).toMatchObject({ status: "sent", usedTemplate: true, creditsCharged: 1 });

    expect(graphBodies()).toEqual([
      expect.objectContaining({
        type: "template",
        template: {
          name: "booking_confirmed_v1",
          language: { code: "ta" },
          components: [{ type: "body", parameters: [{ type: "text", text: "கார்த்திக்" }, { type: "text", text: "4 pm" }] }],
        },
      }),
    ]);
    expect(calls("spend_credits")[0]).toMatchObject({ p_reason: "template_utility" });
    expect(calls("notify_record")[0]).toMatchObject({ p_template_name: "booking_confirmed_v1", p_body: null, p_provider_msg_id: WAMID });
  });

  it("falls back to the template when Meta says the window has closed, refunding the free-text attempt", async () => {
    meta.mockImplementationOnce(async () => reply(400, metaError(131047)));
    const outcome = await send(TENANT, "booking_confirmation", { conversationId: CONVERSATION, text: "See you at 4 pm.", templateParams: ["4 pm"] });
    expect(outcome).toMatchObject({ status: "sent", usedTemplate: true });

    expect(graphBodies().map((body) => body.type)).toEqual(["text", "template"]);
    const [first, second] = calls("spend_credits");
    expect(calls("refund_credits")).toEqual([expect.objectContaining({ p_ref_id: first.p_ref_id })]);
    expect(calls("notify_record")).toEqual([expect.objectContaining({ p_message_id: second.p_ref_id, p_template_name: "booking_confirmed_v1" })]);
  });

  it("passes Meta's rate limit through as retryable and refunds", async () => {
    meta.mockImplementation(async () => reply(429, metaError(130429)));
    await expect(send(TENANT, "ai_reply", { conversationId: CONVERSATION, text: "Hi" })).resolves.toMatchObject({
      status: "failed",
      error: { code: "rate_limited", retryable: true, outcomeUnknown: false },
    });
    expect(calls("refund_credits")).toHaveLength(1);
    expect(calls("notify_record")).toHaveLength(0);
  });

  // Decision 16 in docs/contracts.md: holding the credit instead of refunding waits for Raja.
  it("reports a timeout as an unknown outcome, refunds it for now and sends only once", async () => {
    meta.mockImplementation(() => new Promise<Response>(() => {}));
    await expect(send(TENANT, "ai_reply", { conversationId: CONVERSATION, text: "Hi" })).resolves.toMatchObject({
      status: "failed",
      error: { code: "upstream_failed", retryable: true, outcomeUnknown: true },
    });
    expect(meta).toHaveBeenCalledTimes(1);
    expect(calls("refund_credits")).toHaveLength(1);
    expect(calls("notify_record")).toHaveLength(0);
  });

  it("never calls Meta or spends credits for a connection that is no longer active", async () => {
    db = fakeSupabase({ whatsapp_connections: { data: [row({ status: "failed" })], error: null } });
    await expect(send(TENANT, "ai_reply", { conversationId: CONVERSATION, text: "Hi" })).resolves.toMatchObject({
      status: "failed",
      error: { code: "whatsapp_not_connected" },
    });
    expect(meta).not.toHaveBeenCalled();
    expect(calls("spend_credits")).toHaveLength(0);
  });

  it("keeps the token out of every outcome, database write and log line", async () => {
    const outcomes = [await send(TENANT, "ai_reply", { conversationId: CONVERSATION, text: "Hi" })];
    meta.mockImplementation(async () => reply(401, metaError(190)));
    outcomes.push(await send(TENANT, "ai_reply", { conversationId: CONVERSATION, text: "Hi" }));
    expect(outcomes.map((o) => o.status)).toEqual(["sent", "failed"]);
    expect(JSON.stringify(outcomes)).not.toContain(TOKEN);
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });
});
