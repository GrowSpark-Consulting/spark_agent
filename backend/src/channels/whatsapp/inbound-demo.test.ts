import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The shared demo number in the webhook: a customer's message on it is stored under the business its route code names, on the
// number's own channel, and the queued event names that business. Every other number is unchanged. The database and the queue
// are injected fakes; the routing rules are in demo/route.test.ts and the real SQL in supabase/tests.

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
type Deps = Parameters<typeof handleWhatsAppWebhook>[1] & object;

const OWNER = "a0000000-0000-4000-8000-00000000000a"; // owns the demo number's connection row
const ROUTED = "b0000000-0000-4000-8000-00000000000b"; // the business a code names
const WABA = "100000000000001";
const DEMO_PNID = "200000000000001";
const OTHER_PNID = "200000000000002";
const CHANNEL = "ch-demo";
const PHONE_DIGITS = "919812345621";

const sign = (raw: string) => `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;
const textBody = (text: string, pnid = DEMO_PNID, wamid = "wamid.DEMO1") =>
  JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: WABA,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "910000000001", phone_number_id: pnid },
              contacts: [{ profile: { name: "Visitor" }, wa_id: PHONE_DIGITS }],
              messages: [{ from: PHONE_DIGITS, id: wamid, timestamp: "1759743000", type: "text", text: { body: text } }],
            },
          },
        ],
      },
    ],
  });
const imageBody = () =>
  JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: WABA,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "910000000001", phone_number_id: DEMO_PNID },
              messages: [{ from: PHONE_DIGITS, id: "wamid.DEMO2", timestamp: "1759743000", type: "image", image: { id: "media1", mime_type: "image/jpeg" } }],
            },
          },
        ],
      },
    ],
  });
const request = (raw: string) =>
  new Request("http://localhost:4000/api/webhooks/whatsapp", { method: "POST", body: raw, headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw) } });

type Conn = { id: string; tenantId: string; channelId: string; phoneNumberId: string; wabaId: string; method: string; status: string };
const conn = (over: Partial<Conn> = {}): Conn => ({ id: "c1", tenantId: OWNER, channelId: CHANNEL, phoneNumberId: DEMO_PNID, wabaId: WABA, method: "platform", status: "active", ...over });

type Decision = Awaited<ReturnType<NonNullable<Deps["demo"]>["route"]>>;
function fakes(over: { connections?: Conn[]; decision?: Decision | Error; withDemo?: boolean; inserted?: boolean } = {}) {
  const connections = over.connections ?? [conn()];
  const route = vi.fn(async () => {
    if (over.decision instanceof Error) throw over.decision;
    return over.decision ?? { action: "store" as const, tenantId: ROUTED };
  });
  const deps = {
    findConnections: vi.fn(async (ids: string[]) => connections.filter((c) => ids.includes(c.phoneNumberId))),
    findConnectionsByWaba: vi.fn(async () => []),
    findByoSecrets: vi.fn(async () => []),
    storeInboundMessage: vi.fn(async () => ({ conversationId: "cv", messageId: "m1", inserted: over.inserted ?? true })),
    applyMessageStatus: vi.fn(async () => true),
    templateBelongsToTenant: vi.fn(async () => true),
    setTemplateStatus: vi.fn(async () => true),
    updateConnectionHealth: vi.fn(async () => undefined),
    sendEvent: vi.fn(async () => undefined),
    ...(over.withDemo === false ? {} : { demo: { phoneNumberId: DEMO_PNID, route } }),
  };
  return { deps: deps as unknown as Deps, mocks: deps, route };
}

let log: ReturnType<typeof vi.spyOn>;
const logged = () => log.mock.calls.flat().join("\n");
beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("a message on the shared demo number", () => {
  it("is stored under the business its code names, on the number's own channel, and the event names that business", async () => {
    const f = fakes({ decision: { action: "store", tenantId: ROUTED, body: "haircut price?", routeCode: "DEMO-SALON" } });
    expect((await handleWhatsAppWebhook(request(textBody("DEMO-SALON haircut price?")), f.deps)).status).toBe(200);
    expect(f.mocks.storeInboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: ROUTED, channelId: CHANNEL, phone: `+${PHONE_DIGITS}`, providerMsgId: "wamid.DEMO1", kind: "text", body: "haircut price?", meta: { routeCode: "DEMO-SALON" } }),
    );
    expect(f.mocks.sendEvent).toHaveBeenCalledWith({
      id: "message_received:m1",
      name: "whatsapp/message.received",
      data: { tenantId: ROUTED, conversationId: "cv", messageId: "m1" },
    });
  });

  it("asks the router with the sender, the message id and the text, only for a verified message", async () => {
    const f = fakes();
    await handleWhatsAppWebhook(request(textBody("hello")), f.deps);
    expect(f.route).toHaveBeenCalledWith({ from: `+${PHONE_DIGITS}`, providerMsgId: "wamid.DEMO1", text: "hello" });
  });

  it("a visitor on a route keeps their text as sent", async () => {
    const f = fakes({ decision: { action: "store", tenantId: ROUTED } });
    await handleWhatsAppWebhook(request(textBody("what are your timings?")), f.deps);
    expect(f.mocks.storeInboundMessage).toHaveBeenCalledWith(expect.objectContaining({ tenantId: ROUTED, body: "what are your timings?", meta: {} }));
  });

  it("gives the router no text for a photo, which follows the route", async () => {
    const f = fakes();
    await handleWhatsAppWebhook(request(imageBody()), f.deps);
    expect(f.route).toHaveBeenCalledWith({ from: `+${PHONE_DIGITS}`, providerMsgId: "wamid.DEMO2", text: undefined });
    expect(f.mocks.storeInboundMessage).toHaveBeenCalledWith(expect.objectContaining({ tenantId: ROUTED, kind: "image" }));
  });

  it("stores and queues nothing for a message the router drops, and still answers 200", async () => {
    for (const reason of ["limit", "no_route", "bad_code"] as const) {
      const f = fakes({ decision: { action: "drop", reason } });
      expect((await handleWhatsAppWebhook(request(textBody("hello")), f.deps)).status).toBe(200);
      expect(f.mocks.storeInboundMessage).not.toHaveBeenCalled();
      expect(f.mocks.sendEvent).not.toHaveBeenCalled();
    }
    expect(logged()).toContain("demo_dropped=1");
  });

  it("stores a replay again and sends the same event id, which Inngest drops", async () => {
    const f = fakes({ inserted: false });
    await handleWhatsAppWebhook(request(textBody("hello")), f.deps);
    expect(f.mocks.sendEvent).toHaveBeenCalledWith(expect.objectContaining({ id: "message_received:m1", data: expect.objectContaining({ tenantId: ROUTED }) }));
    expect(logged()).toContain("duplicates=1");
  });

  it("answers 500 when routing fails, so Meta tries again, and queues nothing", async () => {
    const f = fakes({ decision: new Error("database down") });
    expect((await handleWhatsAppWebhook(request(textBody("hello")), f.deps)).status).toBe(500);
    expect(f.mocks.sendEvent).not.toHaveBeenCalled();
    expect(logged()).not.toContain("database down");
  });

  it("logs counts only: no number, name, text, code or business", async () => {
    const f = fakes({ decision: { action: "store", tenantId: ROUTED, body: "haircut price?", routeCode: "DEMO-SALON" } });
    await handleWhatsAppWebhook(request(textBody("DEMO-SALON haircut price?")), f.deps);
    const out = logged();
    expect(out).toContain("demo_routed=1");
    for (const secret of [PHONE_DIGITS, "Visitor", "haircut", "DEMO-SALON", ROUTED, OWNER]) expect(out).not.toContain(secret);
  });
});

describe("every other number", () => {
  it("is not routed: a platform number that is not the demo number keeps its own business", async () => {
    const f = fakes({ connections: [conn({ phoneNumberId: OTHER_PNID })] });
    await handleWhatsAppWebhook(request(textBody("DEMO-SALON hi", OTHER_PNID)), f.deps);
    expect(f.route).not.toHaveBeenCalled();
    expect(f.mocks.storeInboundMessage).toHaveBeenCalledWith(expect.objectContaining({ tenantId: OWNER, body: "DEMO-SALON hi" }));
    expect(f.mocks.sendEvent).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ tenantId: OWNER }) }));
  });

  it("is not routed when the connection on the demo number's id is not a platform one", async () => {
    const f = fakes({ connections: [conn({ method: "embedded_signup" })] });
    await handleWhatsAppWebhook(request(textBody("DEMO-SALON hi")), f.deps);
    expect(f.route).not.toHaveBeenCalled();
    expect(f.mocks.storeInboundMessage).toHaveBeenCalledWith(expect.objectContaining({ tenantId: OWNER }));
  });

  it("behaves as before when no demo number is set", async () => {
    const f = fakes({ withDemo: false });
    await handleWhatsAppWebhook(request(textBody("DEMO-SALON hi")), f.deps);
    expect(f.mocks.storeInboundMessage).toHaveBeenCalledWith(expect.objectContaining({ tenantId: OWNER, body: "DEMO-SALON hi" }));
  });

  it("never routes a message that was not signed by our app", async () => {
    const f = fakes();
    const raw = textBody("DEMO-SALON hi");
    const answer = await handleWhatsAppWebhook(
      new Request("http://localhost:4000/api/webhooks/whatsapp", { method: "POST", body: raw, headers: { "x-hub-signature-256": `sha256=${"0".repeat(64)}` } }),
      f.deps,
    ).catch((e: unknown) => e);
    // refused either by throwing the API's unauthenticated error or by answering 401
    expect(answer instanceof Response ? answer.status : (answer as { code?: string }).code).toSatisfy((v: unknown) => v === 401 || v === "unauthenticated");
    expect(f.route).not.toHaveBeenCalled();
    expect(f.mocks.storeInboundMessage).not.toHaveBeenCalled();
  });
});
