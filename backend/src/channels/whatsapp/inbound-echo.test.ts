import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The webhook handler and coexistence echoes (Day 4): the owner's reply from the phone app is kept as a staff message, the chat goes to a person,
// and the 24-hour wait for the AI to come back is started. The database and the queue are injected fakes (echo.ts has its own tests).

const SECRET = "synthetic-meta-app-secret";
vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "synthetic-anon-key");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-service-key");
vi.stubEnv("EMBEDDINGS_API_KEY", "synthetic-embeddings-key");
vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-anthropic-key");
vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "synthetic-route-token");
vi.stubEnv("META_APP_SECRET", SECRET);

const { handleWhatsAppWebhook } = await import("./inbound");
const { WebhookDbError } = await import("./inbound-db");
type Deps = Parameters<typeof handleWhatsAppWebhook>[1] & object;

const TENANT_A = "a0000000-0000-4000-8000-00000000000a";
const WABA = "100000000000001";
const PNID = "200000000000001";
const CONN_A = "c0000000-0000-4000-8000-0000000000a1";
const CHANNEL = "d1000000-0000-4000-8000-0000000000a1";
const CONV = "c0000000-0000-4000-8000-0000000000c1";
const MESSAGE = "a0000000-0000-4000-8000-0000000000e1";

const sign = (raw: Uint8Array | string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
const request = (raw: string | Buffer, secret = SECRET) =>
  new Request("http://localhost:4000/api/webhooks/whatsapp", { method: "POST", body: raw, headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw, secret) } });
const echoFixture = readFileSync(new URL("./__fixtures__/synthetic-echo-text.json", import.meta.url));

type Conn = { id: string; tenantId: string; channelId: string; phoneNumberId: string; wabaId: string; method: string; status: string };
const conn = (over: Partial<Conn> = {}): Conn => ({ id: CONN_A, tenantId: TENANT_A, channelId: CHANNEL, phoneNumberId: PNID, wabaId: WABA, method: "platform", status: "active", ...over });

function fakes(over: { connections?: Conn[]; echo?: unknown; withEcho?: boolean } = {}) {
  const connections = over.connections ?? [conn()];
  const echo = vi.fn(async () => (over.echo ?? { status: "stored", conversationId: CONV, messageId: MESSAGE, switched: true }) as never);
  const deps = {
    findConnections: vi.fn(async (ids: string[]) => connections.filter((c) => ids.includes(c.phoneNumberId))),
    findConnectionsByWaba: vi.fn(async () => []),
    findByoSecrets: vi.fn(async () => []),
    storeInboundMessage: vi.fn(async () => ({ conversationId: "cv", messageId: "m1", inserted: true })),
    applyMessageStatus: vi.fn(async () => true),
    templateBelongsToTenant: vi.fn(async () => true),
    setTemplateStatus: vi.fn(async () => true),
    updateConnectionHealth: vi.fn(async () => undefined),
    ...(over.withEcho === false ? {} : { storeEchoedMessage: echo }),
    sendEvent: vi.fn(async () => undefined),
  };
  return { deps: deps as unknown as Deps, mocks: deps, echo };
}

let log: ReturnType<typeof vi.spyOn>;
const logged = () => log.mock.calls.flat().join("\n");
beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("an echo from a verified, active connection", () => {
  it("is kept for the business and channel of the CONNECTION (never the payload), with the customer, the message and the time", async () => {
    const f = fakes();
    const res = await handleWhatsAppWebhook(request(echoFixture), f.deps);
    expect(res.status).toBe(200);
    expect(f.echo).toHaveBeenCalledOnce();
    expect(f.echo).toHaveBeenCalledWith({
      tenantId: TENANT_A,
      channelId: CHANNEL,
      customerPhone: "+910000000101",
      providerMsgId: "wamid.SYNTHETIC_ECHO_0001",
      kind: "text",
      body: "Sure, I will call you this evening.",
      sentAt: new Date(1759743600 * 1000).toISOString(),
    });
  });

  it("starts the 24-hour wait when the AI's chat went to a person: one event, ids only", async () => {
    const f = fakes();
    await handleWhatsAppWebhook(request(echoFixture), f.deps);
    expect(f.mocks.sendEvent).toHaveBeenCalledOnce();
    expect(f.mocks.sendEvent).toHaveBeenCalledWith({ id: `phone_reply:${MESSAGE}`, name: "chat.phone_reply", data: { tenantId: TENANT_A, conversationId: CONV } });
  });

  it("starts nothing when the chat was not the AI's, or the echo was a repeat", async () => {
    for (const outcome of [{ status: "stored", conversationId: CONV, messageId: MESSAGE, switched: false }, { status: "duplicate" }, { status: "no_contact" }, { status: "no_conversation" }]) {
      const f = fakes({ echo: outcome });
      expect((await handleWhatsAppWebhook(request(echoFixture), f.deps)).status).toBe(200);
      expect(f.mocks.sendEvent).not.toHaveBeenCalled();
    }
  });

  it("is never a customer's message: nothing is stored as inbound and nothing is queued for the AI", async () => {
    const f = fakes();
    await handleWhatsAppWebhook(request(echoFixture), f.deps);
    expect(f.mocks.storeInboundMessage).not.toHaveBeenCalled();
    expect(f.mocks.sendEvent.mock.calls.map((c) => (c as unknown as [{ name: string }])[0].name)).not.toContain("whatsapp/message.received");
  });

  it("is counted in the log without a number, a name or a word of the message", async () => {
    const f = fakes();
    await handleWhatsAppWebhook(request(echoFixture), f.deps);
    expect(logged()).toContain("echoes=1 echoes_stored=1 echoes_switched=1");
    expect(logged()).not.toContain("0000000101");
    expect(logged()).not.toContain("call you");
  });
});

describe("an echo that is not ours to act on", () => {
  it("is skipped for a phone number no connection has, or one that is not active", async () => {
    const unknown = fakes({ connections: [] });
    expect((await handleWhatsAppWebhook(request(echoFixture), unknown.deps)).status).toBe(200);
    expect(unknown.echo).not.toHaveBeenCalled();
    const inactive = fakes({ connections: [conn({ status: "disconnected" })] });
    await handleWhatsAppWebhook(request(echoFixture), inactive.deps);
    expect(inactive.echo).not.toHaveBeenCalled();
  });

  it("is skipped for a connection that belongs to another WhatsApp account", async () => {
    const f = fakes({ connections: [conn({ wabaId: "999999999999999" })] });
    await handleWhatsAppWebhook(request(echoFixture), f.deps);
    expect(f.echo).not.toHaveBeenCalled();
  });

  it("is skipped on a signature that is not the platform's for a connection of our own app (a connection is never served on the other kind's signature)", async () => {
    const f = fakes({ connections: [conn({ method: "manual_byo" })] });
    const res = await handleWhatsAppWebhook(request(echoFixture), f.deps);
    expect(res.status).toBe(200);
    expect(f.echo).not.toHaveBeenCalled();
  });

  it("is refused with no valid signature, before anything is read", async () => {
    const f = fakes();
    await expect(handleWhatsAppWebhook(new Request("http://localhost:4000/api/webhooks/whatsapp", { method: "POST", body: echoFixture, headers: { "x-hub-signature-256": sign(echoFixture, "wrong-secret") } }), f.deps)).rejects.toMatchObject({ code: "unauthenticated" });
    expect(f.echo).not.toHaveBeenCalled();
  });

  it("is served for a business's own Meta app (manual_byo) when its own secret signed it: the phone number in an echo-only body picks the secret", async () => {
    const f = fakes({ connections: [conn({ method: "manual_byo" })] });
    f.mocks.findByoSecrets.mockResolvedValue([{ connectionId: CONN_A, secret: "byo-secret" }] as never);
    const res = await handleWhatsAppWebhook(request(echoFixture, "byo-secret"), f.deps);
    expect(res.status).toBe(200);
    expect(f.mocks.findByoSecrets).toHaveBeenCalledWith([PNID]);
    expect(f.echo).toHaveBeenCalledOnce();
  });
});

describe("when something fails or is missing", () => {
  it("a database failure answers 500, so Meta tries again (the message id is unique, so a repeat is safe)", async () => {
    const f = fakes();
    f.echo.mockRejectedValue(new WebhookDbError("echo insert", "57P01") as never);
    expect((await handleWhatsAppWebhook(request(echoFixture), f.deps)).status).toBe(500);
    expect(logged()).toContain("57P01");
  });

  it("a caller built before coexistence has no echo storage: the echo is counted and skipped, the answer is 200", async () => {
    const f = fakes({ withEcho: false });
    expect((await handleWhatsAppWebhook(request(echoFixture), f.deps)).status).toBe(200);
    expect(logged()).toContain("echoes_skipped=1");
  });

  it("a failure to queue the wait answers 500 too, and the repeat is safe", async () => {
    const f = fakes();
    f.mocks.sendEvent.mockRejectedValue(new Error("queue down"));
    expect((await handleWhatsAppWebhook(request(echoFixture), f.deps)).status).toBe(500);
  });
});
