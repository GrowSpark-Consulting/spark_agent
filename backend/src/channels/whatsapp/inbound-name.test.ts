import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The customer's WhatsApp profile name is a stranger's words, and it is stored ONCE (store_inbound_message keeps the first name it sees) and then read by everything: the staff alerts,
// the dashboard, the inbox, the lead card, the greeting staff send from their own number. So it is cleaned at the door (Day 7, staff-text cleaning): a name with a link, an "@" or a phone
// number is not stored at all (the screens then show the masked number, as for a contact with no name); a clean name, an emoji name included, is stored as it came, cut to 60 characters.

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

const TENANT = "a0000000-0000-4000-8000-00000000000a";
const PNID = "200000000000001";
const sign = (raw: string) => `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;
const fixtureJson = () => JSON.parse(readFileSync(new URL("./__fixtures__/synthetic-text-message.json", import.meta.url), "utf8")) as Record<string, unknown>;

function bodyWithName(name: string | null): string {
  const json = fixtureJson() as { entry: { changes: { value: { contacts: { profile?: { name?: string } }[] } }[] }[] };
  const contact = json.entry[0].changes[0].value.contacts[0];
  if (name === null) delete contact.profile;
  else contact.profile = { name };
  return JSON.stringify(json);
}

function fakes() {
  const stored: { contactName?: string }[] = [];
  const deps = {
    findConnections: vi.fn(async () => [{ id: "c0000000-0000-4000-8000-0000000000a1", tenantId: TENANT, channelId: "ch1", phoneNumberId: PNID, wabaId: "100000000000001", method: "platform", status: "active" }]),
    findConnectionsByWaba: vi.fn(async () => []),
    storeInboundMessage: vi.fn(async (args: { contactName?: string }) => (stored.push(args), { conversationId: "cv", messageId: "m1", inserted: true })),
    applyMessageStatus: vi.fn(async () => true),
    templateBelongsToTenant: vi.fn(async () => true),
    setTemplateStatus: vi.fn(async () => true),
    updateConnectionHealth: vi.fn(async () => undefined),
    sendEvent: vi.fn(async () => undefined),
  };
  return { deps: deps as unknown as Deps, stored };
}

async function nameStoredFor(name: string | null): Promise<string | undefined> {
  const f = fakes();
  const raw = bodyWithName(name);
  const res = await handleWhatsAppWebhook(new Request("http://localhost:4000/api/webhooks/whatsapp", { method: "POST", body: raw, headers: { "content-type": "application/json", "x-hub-signature-256": sign(raw) } }), f.deps);
  expect(res.status).toBe(200);
  expect(f.stored).toHaveLength(1);
  return f.stored[0].contactName;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("the profile name that is stored", () => {
  it.each(["Priya", "Priya Kumar", "Priya 💖", "Raj_K ✨", "வேளச்சேரி குமார்", "O'Brien & Sons"])("a clean name is stored as it came: %j", async (name) => {
    expect(await nameStoredFor(name)).toBe(name);
  });

  it.each(["Priya 9876543210", "Priya https://evil.example", "evil.com", "priya@evil.example", "@priya_offers", "+91 98765 43210", "98765​43210", "98765,43210"])(
    "a name with a link, an @ or a phone number is not stored: %j",
    async (name) => {
      expect(await nameStoredFor(name)).toBeUndefined();
    },
  );

  it("a name with control characters has them removed, and a blank one is not stored", async () => {
    expect(await nameStoredFor("Priya\u0000\u0007 Kumar")).toBe("Priya Kumar");
    expect(await nameStoredFor("   ")).toBeUndefined();
  });

  it("a very long name is cut to 60 characters", async () => {
    const stored = await nameStoredFor("N".repeat(300));
    expect([...(stored ?? "")]).toHaveLength(60);
  });

  it("no name at all is no name", async () => {
    expect(await nameStoredFor(null)).toBeUndefined();
  });
});
