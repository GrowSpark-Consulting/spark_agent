import { describe, expect, it } from "vitest";
import { fakeTables, type Row } from "../../test-support/fake-tables";
import { ECHO_NOTE, storeEchoedMessage, type EchoArgs } from "./echo";
import { WebhookDbError } from "./inbound-db";

// Storing the owner's reply from the phone app (Day 4, Raja 11 Oct): it becomes a staff message in the chat, and the chat goes to a person at
// once so the assistant does not answer on top of the owner. Only when the AI had the chat: a chat staff already have is left as it is.

const A = "e0000000-0000-0000-0000-00000000000a";
const B = "e0000000-0000-0000-0000-00000000000b";
const CHANNEL = "d1000000-0000-0000-0000-000000000001";
const CONTACT = "b0000000-0000-0000-0000-0000000000b1";
const CONV = "c0000000-0000-0000-0000-00000000000c";

const args = (over: Partial<EchoArgs> = {}): EchoArgs => ({
  tenantId: A,
  channelId: CHANNEL,
  customerPhone: "+919812345621",
  providerMsgId: "wamid.ECHO1",
  kind: "text",
  body: "Sure, I will call you this evening.",
  sentAt: "2026-10-11T12:00:00.000Z",
  ...over,
});

function world(over: { mode?: string; conversations?: Row[]; contacts?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    contacts: over.contacts ?? [{ id: CONTACT, tenant_id: A, phone: "+919812345621" }],
    conversations: over.conversations ?? [{ id: CONV, tenant_id: A, contact_id: CONTACT, channel_id: CHANNEL, mode: over.mode ?? "ai", assigned_user_id: null, status: "open", created_at: "2026-10-01T00:00:00.000Z" }],
    messages: [],
    audit_logs: [],
  };
  return fakeTables(tables, { unique: { messages: "provider_msg_id" } });
}

describe("an echo while the AI has the chat", () => {
  it("is stored as a staff message of the chat, with the time the owner sent it, free of any credit", async () => {
    const w = world();
    const out = await storeEchoedMessage(w.db, args());
    expect(out).toMatchObject({ status: "stored", conversationId: CONV, switched: true });
    const [message] = w.tables.messages;
    expect(message).toMatchObject({
      tenant_id: A,
      conversation_id: CONV,
      direction: "out",
      sender: "staff",
      kind: "text",
      body: "Sure, I will call you this evening.",
      provider_msg_id: "wamid.ECHO1",
      credits_charged: 0,
      created_at: "2026-10-11T12:00:00.000Z",
    });
    expect(message.meta).toMatchObject({ source: "phone_app" });
  });

  it("switches the chat to a person (with no one assigned), and leaves a note in the chat", async () => {
    const w = world();
    await storeEchoedMessage(w.db, args());
    expect(w.tables.conversations[0]).toMatchObject({ mode: "human", assigned_user_id: null });
    const note = w.tables.messages.find((m) => m.sender === "system");
    expect(note).toMatchObject({ tenant_id: A, conversation_id: CONV, direction: "out", body: ECHO_NOTE, meta: { event: "phone_reply" } });
    expect(note?.provider_msg_id).toBeUndefined();
  });

  it("writes an audit row for the switch", async () => {
    const w = world();
    await storeEchoedMessage(w.db, args());
    expect(w.tables.audit_logs).toEqual([expect.objectContaining({ tenant_id: A, actor: "system", action: "conversation.mode_changed", entity: "conversation", entity_id: CONV, diff: { from: "ai", to: "human", reason: "phone_reply" } })]);
  });

  it("an echo that is not text is stored with no words, and still switches the chat", async () => {
    const w = world();
    const out = await storeEchoedMessage(w.db, args({ kind: "unsupported", body: null, unsupportedType: "image" }));
    expect(out).toMatchObject({ status: "stored", switched: true });
    expect(w.tables.messages[0]).toMatchObject({ kind: "unsupported", body: null, meta: { source: "phone_app", unsupportedType: "image" } });
  });
});

describe("an echo while a person already has the chat", () => {
  it.each(["human", "external"])("%s: the message is stored, and nothing about the mode is touched", async (mode) => {
    const w = world({ mode });
    const out = await storeEchoedMessage(w.db, args());
    expect(out).toMatchObject({ status: "stored", switched: false });
    expect(w.tables.conversations[0].mode).toBe(mode);
    expect(w.tables.messages.filter((m) => m.sender === "system")).toEqual([]);
    expect(w.tables.audit_logs).toEqual([]);
  });
});

describe("an echo that was already stored (Meta repeats webhooks)", () => {
  it("is a duplicate: nothing changes, and the chat is not switched or noted twice", async () => {
    const w = world();
    await storeEchoedMessage(w.db, args());
    const again = await storeEchoedMessage(w.db, args());
    expect(again).toEqual({ status: "duplicate" });
    expect(w.tables.messages.filter((m) => m.sender === "staff")).toHaveLength(1);
    expect(w.tables.messages.filter((m) => m.sender === "system")).toHaveLength(1);
  });
});

describe("an echo to someone the business has never talked to here", () => {
  it("is ignored when there is no such customer, or no open chat with them", async () => {
    expect(await storeEchoedMessage(world({ contacts: [] }).db, args())).toEqual({ status: "no_contact" });
    expect(await storeEchoedMessage(world({ conversations: [] }).db, args())).toEqual({ status: "no_conversation" });
  });

  it("does not make a customer or a chat of its own: the owner may be writing to anyone", async () => {
    const w = world({ contacts: [], conversations: [] });
    await storeEchoedMessage(w.db, args());
    expect(w.tables.contacts).toEqual([]);
    expect(w.tables.conversations).toEqual([]);
    expect(w.tables.messages).toEqual([]);
  });

  it("a closed chat is not the chat: only the open one counts", async () => {
    const closed = { id: CONV, tenant_id: A, contact_id: CONTACT, channel_id: CHANNEL, mode: "ai", assigned_user_id: null, status: "closed", created_at: "2026-10-01T00:00:00.000Z" };
    expect(await storeEchoedMessage(world({ conversations: [closed] }).db, args())).toEqual({ status: "no_conversation" });
  });
});

describe("every query names the business", () => {
  it("and another business's customer or chat is never touched, even with the same phone number", async () => {
    const w = world({
      contacts: [{ id: "b0000000-0000-0000-0000-0000000000b9", tenant_id: B, phone: "+919812345621" }],
      conversations: [{ id: "c0000000-0000-0000-0000-0000000000c9", tenant_id: B, contact_id: "b0000000-0000-0000-0000-0000000000b9", channel_id: CHANNEL, mode: "ai", assigned_user_id: null, status: "open", created_at: "2026-10-01T00:00:00.000Z" }],
    });
    expect(await storeEchoedMessage(w.db, args())).toEqual({ status: "no_contact" });
    expect(w.tables.conversations[0].mode).toBe("ai");
    for (const call of w.calls) expect(call.filters.some((f) => f.column === "tenant_id" && f.op === "eq" && f.value === A), `${call.table} ${call.op} is not scoped to the business`).toBe(true);
  });
});

describe("failures", () => {
  it("a database error is thrown with its code only, so Meta's retry can try again", async () => {
    const db = fakeTables({ contacts: { error: { code: "57P01", message: "contains +919812345621" } } }).db;
    const error = await storeEchoedMessage(db, args()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WebhookDbError);
    expect((error as WebhookDbError).code).toBe("57P01");
    expect(String(error)).not.toContain("9812345621");
  });

  it("failing to write the note or the audit row does not undo the switch", async () => {
    const w = world();
    const original = w.tables.audit_logs;
    w.tables.audit_logs = { error: { code: "42501" } } as unknown as Row[];
    const out = await storeEchoedMessage(w.db, args());
    expect(out).toMatchObject({ status: "stored", switched: true });
    expect(w.tables.conversations[0].mode).toBe("human");
    expect(original).toEqual([]);
  });
});
