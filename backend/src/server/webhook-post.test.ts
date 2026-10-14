import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/webhooks/whatsapp through the whole app. The database boundary (inbound-db) is replaced by
// an in-memory fake that follows the same rules as the SQL in 0013 (tenant filter, dedupe on the
// wamid, one open conversation per contact and channel, status ranking). The real SQL is tested in
// supabase/tests/inbound_messages.test.sql (pnpm db:test). Inngest is a spy. The fixtures are the
// synthetic bodies in channels/whatsapp/__fixtures__.

const SECRET = "synthetic-meta-app-secret";
vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "synthetic-anon-key");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-service-key");
vi.stubEnv("EMBEDDINGS_API_KEY", "synthetic-embeddings-key");
vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-anthropic-key");
vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "synthetic-route-token");
vi.stubEnv("META_APP_SECRET", SECRET);

const TENANT_A = "a0000000-0000-4000-8000-00000000000a";
const TENANT_B = "b0000000-0000-4000-8000-00000000000b";
const CHANNEL_A = "a1000000-0000-4000-8000-00000000000a";
const CHANNEL_B = "b1000000-0000-4000-8000-00000000000b";

const db = vi.hoisted(() => {
  type Connection = { id: string; tenantId: string; channelId: string; phoneNumberId: string; wabaId: string; method: string; status: string };
  type StoreArgs = {
    tenantId: string; channelId: string; phone: string; contactName?: string; providerMsgId: string;
    kind: string; body: string | null; media?: { id: string; mime: string }; meta: Record<string, unknown>; sentAt: string;
  };
  type Msg = {
    id: string; tenantId: string; conversationId: string; direction: "in" | "out"; sender: string; kind?: string;
    body: string | null; media?: unknown; meta?: unknown; providerMsgId: string; deliveryStatus: string | null; createdAt: string;
  };
  const RANK: Record<string, number> = { accepted: 0, sent: 1, failed: 1.5, delivered: 2, read: 3 };

  const state = {
    connections: [] as Connection[],
    contacts: [] as { id: string; tenantId: string; phone: string; name?: string }[],
    conversations: [] as { id: string; tenantId: string; contactId: string; channelId: string; status: string; lastCustomerMsgAt?: string }[],
    messages: [] as Msg[],
    byoSecrets: {} as Record<string, string>,
    failFind: null as null | Error,
    failStore: null as null | ((args: StoreArgs) => Error | null),
    failStatus: null as null | Error,
    reset() {
      state.connections = []; state.contacts = []; state.conversations = []; state.messages = [];
      state.byoSecrets = {}; state.failFind = null; state.failStore = null; state.failStatus = null;
    },
  };

  class WebhookDbError extends Error {
    constructor(operation: string, readonly code: string) {
      super(`${operation} failed`);
    }
  }

  return {
    state,
    WebhookDbError,
    async findConnections(ids: string[]) {
      if (state.failFind) throw state.failFind;
      return state.connections.filter((c) => ids.includes(c.phoneNumberId));
    },
    async findByoSecrets(ids: string[]) {
      return state.connections
        .filter((c) => c.method === "manual_byo" && ids.includes(c.phoneNumberId) && state.byoSecrets[c.id] !== undefined)
        .map((c) => ({ connectionId: c.id, secret: state.byoSecrets[c.id] }));
    },
    async storeInboundMessage(args: StoreArgs) {
      const failure = state.failStore?.(args);
      if (failure) throw failure;
      let contact = state.contacts.find((c) => c.tenantId === args.tenantId && c.phone === args.phone);
      if (!contact) {
        contact = { id: crypto.randomUUID(), tenantId: args.tenantId, phone: args.phone };
        state.contacts.push(contact);
      }
      if (!contact.name && args.contactName) contact.name = args.contactName;
      let conversation = state.conversations.find(
        (c) => c.tenantId === args.tenantId && c.contactId === contact.id && c.channelId === args.channelId && c.status === "open",
      );
      if (!conversation) {
        conversation = { id: crypto.randomUUID(), tenantId: args.tenantId, contactId: contact.id, channelId: args.channelId, status: "open" };
        state.conversations.push(conversation);
      }
      const existing = state.messages.find((m) => m.providerMsgId === args.providerMsgId);
      if (existing) {
        if (existing.tenantId !== args.tenantId) throw new Error("provider message id belongs to another business");
        return { conversationId: existing.conversationId, messageId: existing.id, inserted: false };
      }
      const createdAt = new Date(Math.min(Date.parse(args.sentAt), Date.now())).toISOString();
      const message: Msg = {
        id: crypto.randomUUID(), tenantId: args.tenantId, conversationId: conversation.id, direction: "in", sender: "customer",
        kind: args.kind, body: args.body, media: args.media, meta: args.meta, providerMsgId: args.providerMsgId, deliveryStatus: null, createdAt,
      };
      state.messages.push(message);
      if (!conversation.lastCustomerMsgAt || conversation.lastCustomerMsgAt < args.sentAt) conversation.lastCustomerMsgAt = args.sentAt;
      return { conversationId: conversation.id, messageId: message.id, inserted: true };
    },
    // Template and quality events (covered in channels/whatsapp/inbound.test.ts): nothing here is a business's, so nothing changes.
    async findConnectionsByWaba(ids: string[]) {
      return state.connections.filter((c) => ids.includes(c.wabaId));
    },
    async templateBelongsToTenant() {
      return false;
    },
    async setTemplateStatus() {
      return false;
    },
    async updateConnectionHealth() {},
    async applyMessageStatus(args: { tenantId: string; providerMsgId: string; status: string }) {
      if (state.failStatus) throw state.failStatus;
      const row = state.messages.find((m) => m.tenantId === args.tenantId && m.providerMsgId === args.providerMsgId && m.direction === "out");
      if (!row) return false;
      const current = row.deliveryStatus === null ? -1 : (RANK[row.deliveryStatus] ?? -1);
      if (RANK[args.status] <= current) return false;
      row.deliveryStatus = args.status;
      return true;
    },
  };
});

vi.mock("../channels/whatsapp/inbound-db", () => ({
  WebhookDbError: db.WebhookDbError,
  findConnections: db.findConnections,
  findConnectionsByWaba: db.findConnectionsByWaba,
  findByoSecrets: db.findByoSecrets,
  templateBelongsToTenant: db.templateBelongsToTenant,
  setTemplateStatus: db.setTemplateStatus,
  updateConnectionHealth: db.updateConnectionHealth,
  storeInboundMessage: db.storeInboundMessage,
  applyMessageStatus: db.applyMessageStatus,
}));

const { inngest } = await import("../inngest/client");
const send = vi.fn();

const { bodyLimitFor, createApp } = await import("./app");
const { createHttpServer } = await import("./node");
const app = createApp();

const URL_ = "http://localhost:4000/api/webhooks/whatsapp";
const PNID_A = "200000000000001";
const WABA_A = "100000000000001";
const PNID_B = "200000000000002";
const WABA_B = "100000000000002";

const fixture = (name: string) => readFileSync(new URL(`../channels/whatsapp/__fixtures__/${name}.json`, import.meta.url));
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const sign = (raw: Uint8Array | string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
type Body = { entry: { changes: { value: { metadata: { phone_number_id: string }; messages: Record<string, unknown>[] } }[] }[] };
const edit = (raw: Buffer, change: (body: Body) => void) => {
  const body = JSON.parse(raw.toString("utf8")) as Body;
  change(body);
  return Buffer.from(JSON.stringify(body));
};
const forTenantB = (raw: Buffer) => Buffer.from(raw.toString("utf8").replaceAll(PNID_A, PNID_B).replaceAll(WABA_A, WABA_B));

function post(raw: Uint8Array | string, headers: Record<string, string> = { "x-hub-signature-256": sign(raw) }) {
  return app(new Request(URL_, { method: "POST", body: raw, headers: { "content-type": "application/json", ...headers } }));
}

const connection = (overrides: Partial<{ tenantId: string; channelId: string; phoneNumberId: string; wabaId: string; method: string; status: string }> = {}) => ({
  id: crypto.randomUUID(), tenantId: TENANT_A, channelId: CHANNEL_A, phoneNumberId: PNID_A, wabaId: WABA_A, method: "embedded_signup", status: "active", ...overrides,
});

const logged: string[] = [];
const allLogs = () => logged.join("\n");

beforeEach(() => {
  db.state.reset();
  db.state.connections.push(connection(), connection({ tenantId: TENANT_B, channelId: CHANNEL_B, phoneNumberId: PNID_B, wabaId: WABA_B }));
  send.mockReset();
  send.mockResolvedValue({ ids: ["x"] });
  vi.spyOn(inngest, "send").mockImplementation(send as never);
  logged.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
  }
});
afterEach(() => vi.restoreAllMocks());

const outbound = (tenantId: string, providerMsgId: string, deliveryStatus = "sent") =>
  db.state.messages.push({
    id: crypto.randomUUID(), tenantId, conversationId: "c", direction: "out", sender: "ai", body: "hi", providerMsgId, deliveryStatus, createdAt: iso(1),
  });

describe("signature", () => {
  it("rejects a missing signature with 401: nothing stored, nothing sent", async () => {
    const res = await post(fixture("synthetic-text-message"), {});
    expect(res.status).toBe(401);
    expect(db.state.messages).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a malformed header and a signature made with another secret", async () => {
    const raw = fixture("synthetic-text-message");
    for (const header of ["", "abc", "sha256=zz", `sha1=${"a".repeat(40)}`, sign(raw, "another-secret")]) {
      expect((await post(raw, { "x-hub-signature-256": header })).status).toBe(401);
    }
    expect(db.state.messages).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a signature computed over different bytes (the JSON re-serialised)", async () => {
    const raw = fixture("synthetic-text-message");
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw.toString("utf8"))));
    expect(reserialised.equals(raw)).toBe(false);
    const res = await post(reserialised, { "x-hub-signature-256": sign(raw) });
    expect(res.status).toBe(401);
    expect(db.state.messages).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a body changed by one character after it was signed", async () => {
    const raw = fixture("synthetic-text-message");
    const tampered = Buffer.from(raw.toString("utf8").replace("wamid.SYNTHETIC_TEXT_0001", "wamid.SYNTHETIC_TEXT_0002"));
    expect((await post(tampered, { "x-hub-signature-256": sign(raw) })).status).toBe(401);
    expect(db.state.messages).toEqual([]);
  });

  it("answers 401 the same way for a bad signature on a number we don't know (no hint which numbers exist)", async () => {
    const raw = edit(fixture("synthetic-text-message"), (b) => (b.entry[0].changes[0].value.metadata.phone_number_id = "299999999999999"));
    const known = await post(fixture("synthetic-text-message"), { "x-hub-signature-256": "sha256=" + "0".repeat(64) });
    const unknown = await post(raw, { "x-hub-signature-256": "sha256=" + "0".repeat(64) });
    expect(unknown.status).toBe(known.status);
    expect(await unknown.text()).toBe(await known.text());
  });

  it("answers 500 when META_APP_SECRET is not set, and stores nothing", async () => {
    vi.resetModules();
    vi.stubEnv("META_APP_SECRET", "");
    try {
      const { createApp: createFreshApp } = await import("./app");
      const raw = fixture("synthetic-text-message");
      const res = await createFreshApp()(new Request(URL_, { method: "POST", body: raw, headers: { "x-hub-signature-256": sign(raw) } }));
      expect(res.status).toBe(500);
      expect(db.state.messages).toEqual([]);
      expect(send).not.toHaveBeenCalled();
    } finally {
      vi.stubEnv("META_APP_SECRET", SECRET);
    }
  });
});

describe("storing a message", () => {
  it("stores the contact, the open conversation and the message for the right business, and queues one event with ids only", async () => {
    const raw = fixture("synthetic-text-message");
    const res = await post(raw);
    expect(res.status).toBe(200);

    expect(db.state.contacts).toEqual([{ id: expect.any(String), tenantId: TENANT_A, phone: "+910000000101", name: "Test Customer" }]);
    expect(db.state.conversations).toHaveLength(1);
    expect(db.state.conversations[0]).toMatchObject({ tenantId: TENANT_A, channelId: CHANNEL_A, status: "open", lastCustomerMsgAt: iso(1759743000) });
    expect(db.state.messages).toHaveLength(1);
    const message = db.state.messages[0];
    expect(message).toMatchObject({
      tenantId: TENANT_A, direction: "in", sender: "customer", kind: "text", providerMsgId: "wamid.SYNTHETIC_TEXT_0001", createdAt: iso(1759743000),
    });
    expect(message.body).toContain("2BHK");

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      id: `message_received:${message.id}`,
      name: "whatsapp/message.received",
      data: { tenantId: TENANT_A, conversationId: message.conversationId, messageId: message.id },
    });
    const sent = JSON.stringify(send.mock.calls[0][0]);
    expect(sent).not.toContain("2BHK");
    expect(sent).not.toContain("910000000101");
    expect(sent).not.toContain("SYNTHETIC_TEXT");
  });

  it("creates nothing the second time the same payload arrives, and queues the same event id again", async () => {
    const raw = fixture("synthetic-text-message");
    expect((await post(raw)).status).toBe(200);
    expect((await post(raw)).status).toBe(200);

    expect(db.state.messages).toHaveLength(1);
    expect(db.state.contacts).toHaveLength(1);
    expect(db.state.conversations).toHaveLength(1);
    // Re-sent on purpose: the replay may be Meta's retry after a failed send. Inngest drops the duplicate by id.
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toEqual(send.mock.calls[0][0]);
  });

  it("puts a customer's next message in the same open conversation", async () => {
    await post(fixture("synthetic-text-message"));
    await post(fixture("synthetic-image-message"));
    expect(db.state.messages).toHaveLength(2);
    expect(db.state.conversations).toHaveLength(1);
    expect(db.state.messages[0].conversationId).toBe(db.state.messages[1].conversationId);
  });

  it("handles a batch: two customers, two conversations, two events, and the status in it", async () => {
    outbound(TENANT_A, "wamid.SYNTHETIC_OUT_0003", "delivered");
    const res = await post(fixture("synthetic-batch-2-messages-1-status"));
    expect(res.status).toBe(200);
    expect(db.state.contacts.map((c) => c.name).sort()).toEqual(["Second Customer", "Test Customer"]);
    expect(db.state.conversations).toHaveLength(2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(db.state.messages.find((m) => m.providerMsgId === "wamid.SYNTHETIC_OUT_0003")?.deliveryStatus).toBe("read");
  });

  it("removes NUL and control characters from the text and the contact name, so the insert cannot fail and Meta does not resend", async () => {
    const raw = edit(fixture("synthetic-text-message"), (b) => {
      const value = b.entry[0].changes[0].value as unknown as { messages: { text: { body: string } }[]; contacts: { profile: { name: string } }[] };
      value.messages[0].text.body = "Hello\u0000 there\u0001, 9am?\tok\uD83D";
      value.contacts[0].profile.name = "Test\u0000 Customer";
    });
    const res = await post(raw);
    expect(res.status).toBe(200);
    expect(db.state.messages[0].body).toBe("Hello there, 9am?\tok");
    expect(db.state.contacts[0].name).toBe("Test Customer");
  });

  it("cleans the button id and the media id and type too, since they are stored as JSON", async () => {
    const button = edit(fixture("synthetic-button-reply"), (b) => {
      const message = b.entry[0].changes[0].value.messages[0] as unknown as { interactive: { button_reply: { id: string } } };
      message.interactive.button_reply.id = "slot\u0000_1";
    });
    expect((await post(button)).status).toBe(200);
    expect(db.state.messages[0].meta).toMatchObject({ buttonId: "slot_1" });

    const image = edit(fixture("synthetic-image-message"), (b) => {
      const message = b.entry[0].changes[0].value.messages[0] as unknown as { image: { id: string; mime_type: string } };
      message.image.id = "media\u0000-1";
      message.image.mime_type = "image/\u0001jpeg";
    });
    expect((await post(image)).status).toBe(200);
    expect(db.state.messages[1].media).toEqual({ id: "media-1", mime: "image/jpeg" });
  });

  it("stores a button reply as interactive with the button id in meta", async () => {
    await post(fixture("synthetic-button-reply"));
    expect(db.state.messages[0]).toMatchObject({ kind: "interactive", meta: expect.objectContaining({ buttonId: "slot_1" }) });
    expect(db.state.messages[0].body).toEqual(expect.any(String));
  });

  it("stores an image with its media id and mime type, and the caption as the body", async () => {
    await post(fixture("synthetic-image-message"));
    expect(db.state.messages[0]).toMatchObject({ kind: "image", body: "Kitchen photo", media: { id: "synthetic-media-0001", mime: "image/jpeg" } });
  });

  it("stores a voice note as audio, not as unsupported", async () => {
    const raw = edit(fixture("synthetic-image-message"), (b) => {
      const m = b.entry[0].changes[0].value.messages[0];
      m.type = "audio";
      m.audio = { id: "synthetic-voice-0001", mime_type: "audio/ogg; codecs=opus" };
      delete m.image;
    });
    await post(raw);
    expect(db.state.messages[0]).toMatchObject({ kind: "audio", body: null, media: { id: "synthetic-voice-0001", mime: "audio/ogg; codecs=opus" } });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps a sticker as unsupported: no body, the original type in meta, and the event still sent", async () => {
    const raw = edit(fixture("synthetic-image-message"), (b) => {
      const m = b.entry[0].changes[0].value.messages[0];
      m.type = "sticker";
      m.sticker = { id: "synthetic-sticker-0001", mime_type: "image/webp" };
      delete m.image;
    });
    await post(raw);
    expect(db.state.messages[0]).toMatchObject({ kind: "unsupported", body: null, meta: expect.objectContaining({ unsupportedType: "sticker" }) });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("routing", () => {
  it("answers 200 and stores nothing for a number we don't have, and logs it without the id", async () => {
    db.state.connections = [];
    const res = await post(fixture("synthetic-text-message"));
    expect(res.status).toBe(200);
    expect(db.state.messages).toEqual([]);
    expect(db.state.contacts).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(allLogs()).toMatch(/unknown=1/);
    expect(allLogs()).not.toContain(PNID_A);
  });

  it("never lets a message for one business's number land in another's", async () => {
    await post(fixture("synthetic-text-message"));
    expect(db.state.messages.map((m) => m.tenantId)).toEqual([TENANT_A]);

    // The same customer writes to the other business's number.
    const other = forTenantB(edit(fixture("synthetic-text-message"), (b) => (b.entry[0].changes[0].value.messages[0].id = "wamid.SYNTHETIC_TEXT_0099")));
    expect((await post(other)).status).toBe(200);
    const forB = db.state.messages.filter((m) => m.tenantId === TENANT_B);
    expect(forB).toHaveLength(1);
    expect(db.state.conversations.find((c) => c.id === forB[0].conversationId)).toMatchObject({ tenantId: TENANT_B, channelId: CHANNEL_B });
    // The same customer number is a separate contact in each business.
    expect(db.state.contacts.filter((c) => c.phone === "+910000000101").map((c) => c.tenantId).sort()).toEqual([TENANT_A, TENANT_B]);
  });

  it.each(["platform", "assisted"])("serves a %s connection: it is signed with our own app secret", async (method) => {
    db.state.connections = [connection({ method })];
    expect((await post(fixture("synthetic-text-message"))).status).toBe(200);
    expect(db.state.messages).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("treats a connection with a method it does not know as unknown, so a new method is never trusted by default", async () => {
    db.state.connections = [connection({ method: "some_future_method" })];
    expect((await post(fixture("synthetic-text-message"))).status).toBe(200);
    expect(db.state.messages).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(allLogs()).toMatch(/unknown=1/);
  });

  it("treats a manual_byo connection as unknown: 200, nothing stored", async () => {
    db.state.connections = [connection({ method: "manual_byo" })];
    expect((await post(fixture("synthetic-text-message"))).status).toBe(200);
    expect(db.state.messages).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(allLogs()).toMatch(/unknown=1/);
  });

  it.each(["pending", "validating", "failed", "disconnected"])("stores nothing for a %s connection, and still answers 200", async (status) => {
    db.state.connections = [connection({ status })];
    expect((await post(fixture("synthetic-text-message"))).status).toBe(200);
    expect(db.state.messages).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("treats a payload whose account id doesn't match the connection as unknown", async () => {
    db.state.connections = [connection({ wabaId: "100000000009999" })];
    expect((await post(fixture("synthetic-text-message"))).status).toBe(200);
    expect(db.state.messages).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("delivery statuses", () => {
  it("updates the delivery status of that business's message", async () => {
    outbound(TENANT_A, "wamid.SYNTHETIC_OUT_0001", "sent");
    expect((await post(fixture("synthetic-status-delivered"))).status).toBe(200);
    expect(db.state.messages[0].deliveryStatus).toBe("delivered");
    expect(send).not.toHaveBeenCalled();
  });

  it("records a failed delivery", async () => {
    outbound(TENANT_A, "wamid.SYNTHETIC_OUT_0002", "sent");
    await post(fixture("synthetic-status-failed"));
    expect(db.state.messages[0].deliveryStatus).toBe("failed");
  });

  it("never changes another business's message, even with the same message id", async () => {
    outbound(TENANT_B, "wamid.SYNTHETIC_OUT_0001", "sent");
    expect((await post(fixture("synthetic-status-delivered"))).status).toBe(200);
    expect(db.state.messages[0].deliveryStatus).toBe("sent");
  });

  it("ignores a status for a message we don't have", async () => {
    expect((await post(fixture("synthetic-status-delivered"))).status).toBe(200);
    expect(db.state.messages).toEqual([]);
  });
});

describe("other events", () => {
  it("logs template-status events and answers 200, storing nothing", async () => {
    for (const name of ["synthetic-template-approved", "synthetic-template-rejected"]) {
      expect((await post(fixture(name))).status).toBe(200);
    }
    expect(db.state.messages).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(allLogs()).toMatch(/\[whatsapp-webhook\].*templates=1/);
  });

  it("logs an unknown field and still stores the real message in the same body", async () => {
    expect((await post(fixture("synthetic-unknown-field"))).status).toBe(200);
    expect(db.state.messages.map((m) => m.providerMsgId)).toEqual(["wamid.SYNTHETIC_UNKNOWN_0001"]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(allLogs()).toMatch(/stored=1.*ignored=1/);
  });

  it("answers 200 to a correctly signed body that isn't JSON (retrying cannot help)", async () => {
    expect((await post("not json at all")).status).toBe(200);
    expect(db.state.messages).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("failures", () => {
  it("answers 500 when the connection lookup fails, and stores nothing", async () => {
    db.state.failFind = new Error("connection refused");
    expect((await post(fixture("synthetic-text-message"))).status).toBe(500);
    expect(db.state.messages).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("answers 500 when storing fails, still handles the rest of the batch, and a retry completes it without duplicates", async () => {
    db.state.failStore = (args) => (args.providerMsgId.endsWith("0001") ? new Error("db down") : null);
    const raw = fixture("synthetic-batch-2-messages-1-status");
    expect((await post(raw)).status).toBe(500);
    expect(db.state.messages.map((m) => m.providerMsgId)).toEqual(["wamid.SYNTHETIC_BATCH_0002"]);
    expect(send).toHaveBeenCalledTimes(1);

    db.state.failStore = null;
    expect((await post(raw)).status).toBe(200);
    expect(db.state.messages.map((m) => m.providerMsgId).sort()).toEqual(["wamid.SYNTHETIC_BATCH_0001", "wamid.SYNTHETIC_BATCH_0002"]);
    const eventIds = send.mock.calls.map(([event]) => event.id);
    expect(new Set(eventIds).size).toBe(2);
  });

  it("answers 500 when the event can't be queued; the message stays stored and the retry sends it", async () => {
    send.mockRejectedValueOnce(new Error("inngest unreachable"));
    const raw = fixture("synthetic-text-message");
    expect((await post(raw)).status).toBe(500);
    expect(db.state.messages).toHaveLength(1);

    expect((await post(raw)).status).toBe(200);
    expect(db.state.messages).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].id).toBe(send.mock.calls[0][0].id);
  });

  it("answers 500 when a status update fails", async () => {
    db.state.failStatus = new Error("db down");
    expect((await post(fixture("synthetic-status-delivered"))).status).toBe(500);
  });
});

describe("the route", () => {
  it("sends no CORS headers: Meta calls it server to server", async () => {
    const raw = fixture("synthetic-text-message");
    const res = await post(raw, { "x-hub-signature-256": sign(raw), origin: "http://localhost:3000" });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("keeps the default 1 MB body limit, which the HTTP server enforces before the route runs", async () => {
    expect(bodyLimitFor("/api/webhooks/whatsapp")).toBe(1024 * 1024);
    const server = createHttpServer(app, { maxBodyBytes: (pathname) => bodyLimitFor(pathname), log: () => {} });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const body = Buffer.alloc(1024 * 1024 + 1, "x");
      const res = await fetch(`http://127.0.0.1:${port}/api/webhooks/whatsapp`, {
        method: "POST",
        body,
        headers: { "x-hub-signature-256": sign(body) },
      });
      expect(res.status).toBe(413);
      expect(db.state.messages).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("what gets logged", () => {
  it("has no full phone number, message text, message id, id of the number or secret, after a stored message", async () => {
    const raw = fixture("synthetic-text-message");
    const signature = sign(raw);
    await post(raw, { "x-hub-signature-256": signature });
    const logs = allLogs();
    expect(logs).toMatch(/\[whatsapp-webhook\].*stored=1/);
    for (const secret of ["910000000101", "+910000000101", "2BHK", "Test Customer", "SYNTHETIC_TEXT_0001", PNID_A, SECRET, signature]) {
      expect(logs).not.toContain(secret);
    }
  });

  it("has no phone number or message text when the database fails with a message that contains them", async () => {
    db.state.failStore = () => new Error('duplicate key value violates unique constraint (tenant_id, phone)=(a0000000, +910000000101) 2BHK');
    expect((await post(fixture("synthetic-text-message"))).status).toBe(500);
    const logs = allLogs();
    expect(logs).toMatch(/\[whatsapp-webhook\].*failed=1/);
    for (const secret of ["910000000101", "2BHK", "duplicate key"]) expect(logs).not.toContain(secret);
  });

  it("has no phone number when Inngest fails with a message that contains one", async () => {
    send.mockRejectedValueOnce(new Error("rejected event for 910000000101"));
    await post(fixture("synthetic-text-message"));
    expect(allLogs()).not.toContain("910000000101");
  });
});

describe("a client's own Meta app (manual_byo)", () => {
  const BYO_SECRET = "synthetic-client-app-secret";

  // The business-A fixture, but the number is a manual_byo connection with its own app secret.
  const withByoConnection = (secret: string | null = BYO_SECRET) => {
    db.state.connections.length = 0;
    const byo = connection({ method: "manual_byo" });
    db.state.connections.push(byo);
    if (secret !== null) db.state.byoSecrets[byo.id] = secret;
    return byo;
  };

  it("stores and queues a message signed with the connection's own app secret", async () => {
    withByoConnection();
    const raw = fixture("synthetic-text-message");
    const res = await post(raw, { "x-hub-signature-256": sign(raw, BYO_SECRET) });
    expect(res.status).toBe(200);
    expect(db.state.messages).toHaveLength(1);
    expect(db.state.messages[0].tenantId).toBe(TENANT_A);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: the same delivery twice stores one message", async () => {
    withByoConnection();
    const raw = fixture("synthetic-text-message");
    await post(raw, { "x-hub-signature-256": sign(raw, BYO_SECRET) });
    await post(raw, { "x-hub-signature-256": sign(raw, BYO_SECRET) });
    expect(db.state.messages).toHaveLength(1);
  });

  it("refuses a signature made with another secret: 401, nothing stored", async () => {
    withByoConnection();
    const raw = fixture("synthetic-text-message");
    expect((await post(raw, { "x-hub-signature-256": sign(raw, "someone-elses-secret") })).status).toBe(401);
    expect(db.state.messages).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not serve a manual_byo number on OUR app's signature", async () => {
    withByoConnection();
    const raw = fixture("synthetic-text-message");
    expect((await post(raw)).status).toBe(200); // signed correctly, but the number is not one of ours
    expect(db.state.messages).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not let one client's secret act for another client's number", async () => {
    const a = withByoConnection();
    const b = connection({ tenantId: TENANT_B, channelId: CHANNEL_B, phoneNumberId: PNID_B, wabaId: WABA_B, method: "manual_byo" });
    db.state.connections.push(b);
    db.state.byoSecrets[b.id] = "tenant-b-secret";
    const raw = forTenantB(fixture("synthetic-text-message"));
    expect((await post(raw, { "x-hub-signature-256": sign(raw, db.state.byoSecrets[a.id]) })).status).toBe(401);
    expect(db.state.messages).toEqual([]);
  });

  it("a manual_byo number with no stored secret can never verify", async () => {
    withByoConnection(null);
    const raw = fixture("synthetic-text-message");
    expect((await post(raw, { "x-hub-signature-256": sign(raw, BYO_SECRET) })).status).toBe(401);
    expect(db.state.messages).toEqual([]);
  });
});

describe("a customer's photo or document (Day 7, PR F: saving the file)", () => {
  const mediaMessage = (type: string, media: Record<string, unknown>, id = "wamid.SYNTHETIC_MEDIA_0001") =>
    edit(fixture("synthetic-image-message"), (b) => {
      const m = b.entry[0].changes[0].value.messages[0];
      m.id = id;
      m.type = type;
      delete m.image;
      m[type] = media;
    });
  const names = () => send.mock.calls.map(([event]) => event.name);

  it("queues the reply first and then the download, each under its own fixed id, with ids only", async () => {
    expect((await post(fixture("synthetic-image-message"))).status).toBe(200);
    const message = db.state.messages[0];
    expect(names()).toEqual(["whatsapp/message.received", "whatsapp/media.received"]);
    expect(send.mock.calls[1][0]).toEqual({
      id: `media_received:${message.id}`,
      name: "whatsapp/media.received",
      data: { tenantId: TENANT_A, conversationId: message.conversationId, messageId: message.id },
    });
    const sent = JSON.stringify(send.mock.calls[1][0]);
    for (const secret of ["synthetic-media-0001", "image/jpeg", "Kitchen photo", "910000000101", "SYNTHETIC"]) expect(sent).not.toContain(secret);
  });

  it("does the same for a document", async () => {
    await post(mediaMessage("document", { id: "doc-1", mime_type: "application/pdf", caption: "Floor plan" }));
    expect(names()).toEqual(["whatsapp/message.received", "whatsapp/media.received"]);
  });

  it.each([
    ["a voice note", () => mediaMessage("audio", { id: "voice-1", mime_type: "audio/ogg; codecs=opus" })],
    ["a text", () => fixture("synthetic-text-message")],
    ["a button reply", () => fixture("synthetic-button-reply")],
    ["a sticker", () => mediaMessage("sticker", { id: "s-1", mime_type: "image/webp" })],
    ["an image the parser could not read", () => mediaMessage("image", { mime_type: "image/jpeg" })],
  ])("does not queue a download for %s", async (_name, make) => {
    await post(make());
    expect(db.state.messages).toHaveLength(1);
    expect(names()).toEqual(["whatsapp/message.received"]);
  });

  it("a replay of the same photo queues the same two ids again (Inngest drops the repeats), and stores one message", async () => {
    const raw = fixture("synthetic-image-message");
    await post(raw);
    await post(raw);
    expect(db.state.messages).toHaveLength(1);
    expect(names()).toEqual(["whatsapp/message.received", "whatsapp/media.received", "whatsapp/message.received", "whatsapp/media.received"]);
    expect(new Set(send.mock.calls.map(([event]) => event.id)).size).toBe(2);
  });

  it("when the download can't be queued the answer is 500 (the message stays stored, the reply was already queued) and Meta's retry queues it", async () => {
    send.mockResolvedValueOnce({ ids: ["x"] }).mockRejectedValueOnce(new Error("inngest unreachable for 910000000101"));
    const raw = fixture("synthetic-image-message");
    expect((await post(raw)).status).toBe(500);
    expect(db.state.messages).toHaveLength(1);
    expect(names()).toEqual(["whatsapp/message.received", "whatsapp/media.received"]);
    expect(allLogs()).not.toContain("910000000101");
    expect((await post(raw)).status).toBe(200);
    expect(names()).toEqual(["whatsapp/message.received", "whatsapp/media.received", "whatsapp/message.received", "whatsapp/media.received"]);
  });

  it("the business in the event is the one of the number's connection, never anything in the payload", async () => {
    await post(forTenantB(fixture("synthetic-image-message")));
    expect(db.state.messages[0].tenantId).toBe(TENANT_B);
    expect(send.mock.calls.map(([event]) => event.data.tenantId)).toEqual([TENANT_B, TENANT_B]);
  });

  it("stores the media as before (id and type) and the lines it logs hold no media id", async () => {
    await post(fixture("synthetic-image-message"));
    expect(db.state.messages[0].media).toEqual({ id: "synthetic-media-0001", mime: "image/jpeg" });
    expect(allLogs()).not.toContain("synthetic-media-0001");
  });
});
