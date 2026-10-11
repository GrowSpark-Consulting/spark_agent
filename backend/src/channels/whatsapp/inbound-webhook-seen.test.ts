import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A request signed with a manual_byo connection's OWN app secret is proof that its Meta app delivers webhooks: the connection's webhook check waits for it
// (connect/webhook-seen.ts). A request signed by our own app is not that proof, and neither is one that fails verification.

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

const TENANT_A = "a0000000-0000-4000-8000-00000000000a";
const WABA = "100000000000001";
const PNID = "200000000000001";
const CONN_A = "c0000000-0000-4000-8000-0000000000a1";
const body = readFileSync(new URL("./__fixtures__/synthetic-echo-text.json", import.meta.url));
const sign = (secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const request = (secret: string) => new Request("http://localhost:4000/api/webhooks/whatsapp", { method: "POST", body, headers: { "content-type": "application/json", "x-hub-signature-256": sign(secret) } });

function fakes(method: string) {
  const connections = [{ id: CONN_A, tenantId: TENANT_A, channelId: "ch", phoneNumberId: PNID, wabaId: WABA, method, status: "active" }];
  const deps = {
    findConnections: vi.fn(async (ids: string[]) => connections.filter((c) => ids.includes(c.phoneNumberId))),
    findConnectionsByWaba: vi.fn(async () => []),
    findByoSecrets: vi.fn(async () => [{ connectionId: CONN_A, secret: "byo-secret" }]),
    storeInboundMessage: vi.fn(async () => ({ conversationId: "cv", messageId: "m1", inserted: true })),
    applyMessageStatus: vi.fn(async () => true),
    templateBelongsToTenant: vi.fn(async () => true),
    setTemplateStatus: vi.fn(async () => true),
    updateConnectionHealth: vi.fn(async () => undefined),
    storeEchoedMessage: vi.fn(async () => ({ status: "stored", conversationId: "cv", messageId: "m", switched: false }) as never),
    sendEvent: vi.fn(async () => undefined),
    noteWebhookSeen: vi.fn(async () => undefined),
  };
  return { deps: deps as unknown as Deps, mocks: deps };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("proof that a business's own app delivers webhooks", () => {
  it("is noted, for the business of the connection, when the connection's own app secret signed the request", async () => {
    const f = fakes("manual_byo");
    expect((await handleWhatsAppWebhook(request("byo-secret"), f.deps)).status).toBe(200);
    expect(f.mocks.noteWebhookSeen).toHaveBeenCalledOnce();
    expect(f.mocks.noteWebhookSeen).toHaveBeenCalledWith(TENANT_A, CONN_A);
  });

  it("is not noted when our own app signed it (that proves nothing about the business's app)", async () => {
    const f = fakes("platform");
    expect((await handleWhatsAppWebhook(request(SECRET), f.deps)).status).toBe(200);
    expect(f.mocks.noteWebhookSeen).not.toHaveBeenCalled();
  });

  it("is not noted when the signature fails", async () => {
    const f = fakes("manual_byo");
    f.mocks.findByoSecrets.mockResolvedValue([]);
    await expect(handleWhatsAppWebhook(request("wrong-secret"), f.deps)).rejects.toThrow();
    expect(f.mocks.noteWebhookSeen).not.toHaveBeenCalled();
  });

  it("a failure to note it never changes the answer", async () => {
    const f = fakes("manual_byo");
    f.mocks.noteWebhookSeen.mockRejectedValue(new Error("down"));
    expect((await handleWhatsAppWebhook(request("byo-secret"), f.deps)).status).toBe(200);
  });

  it("a caller without the hook still works", async () => {
    const f = fakes("manual_byo");
    delete (f.mocks as { noteWebhookSeen?: unknown }).noteWebhookSeen;
    expect((await handleWhatsAppWebhook(request("byo-secret"), f.deps)).status).toBe(200);
  });
});
