import { describe, expect, it, vi } from "vitest";
import { fakeTables, type Row } from "../test-support/fake-tables";
import { mediaDb } from "./db";

// The real database side of the media download, on a fake client that records every query: each one must name the business, and the connection lookup
// must read the token column only for the one active connection of this business and channel.

const A = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const B = "7a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8e";
const CONV = "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f601";
const MSG = "8e9f0a1b-2c3d-4e5f-8a7b-9c0d1e2f3a4b";
const CHANNEL = "c1000000-0000-4000-8000-0000000000c1";
const CONN = "d4000000-0000-4000-8000-0000000000a1";

const message = (over: Row = {}): Row => ({ id: MSG, tenant_id: A, conversation_id: CONV, direction: "in", sender: "customer", kind: "image", media: { id: "m1", mime: "image/jpeg" }, ...over });
const conversation = (over: Row = {}): Row => ({ id: CONV, tenant_id: A, channel_id: CHANNEL, ...over });
const connection = (over: Row = {}): Row => ({ id: CONN, tenant_id: A, channel_id: CHANNEL, status: "active", token_enc: "enc", ...over });
const uploader = () => vi.fn(async () => undefined);

describe("loadMessage", () => {
  it("reads the customer's inbound message of this chat and business, and its channel", async () => {
    const { db, calls } = fakeTables({ messages: [message()], conversations: [conversation()] });
    expect(await mediaDb(db, uploader()).loadMessage(A, CONV, MSG)).toEqual({ kind: "image", channelId: CHANNEL, media: { id: "m1", mime: "image/jpeg" } });
    for (const call of calls) expect(call.filters, call.table).toContainEqual({ column: "tenant_id", op: "eq", value: A });
    const messages = calls.find((c) => c.table === "messages");
    expect(messages?.filters).toEqual(expect.arrayContaining([{ column: "id", op: "eq", value: MSG }, { column: "conversation_id", op: "eq", value: CONV }, { column: "direction", op: "eq", value: "in" }, { column: "sender", op: "eq", value: "customer" }]));
  });

  it("finds nothing for another business's message, another chat's, or a message that is ours (outbound)", async () => {
    const tables = { messages: [message(), message({ id: "x", direction: "out", sender: "ai" })], conversations: [conversation()] };
    const { db } = fakeTables(tables);
    const store = mediaDb(db, uploader());
    expect(await store.loadMessage(B, CONV, MSG)).toBeNull();
    expect(await store.loadMessage(A, "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f699", MSG)).toBeNull();
    expect(await store.loadMessage(A, CONV, "x")).toBeNull();
  });

  it("does not read the chat of another business even if the message row said so", async () => {
    const { db } = fakeTables({ messages: [message()], conversations: [conversation({ tenant_id: B })] });
    expect(await mediaDb(db, uploader()).loadMessage(A, CONV, MSG)).toBeNull();
  });

  it("a media value that is not an object reads as none", async () => {
    const { db } = fakeTables({ messages: [message({ media: "oops" })], conversations: [conversation()] });
    expect((await mediaDb(db, uploader()).loadMessage(A, CONV, MSG))?.media).toBeNull();
  });

  it("throws on a database failure (the step is retried), with no database text", async () => {
    const { db } = fakeTables({ messages: { error: { code: "XX000", message: "SYNTHETIC +919812345621 detail" } }, conversations: [] });
    const error = await mediaDb(db, uploader()).loadMessage(A, CONV, MSG).then(() => null, (e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).not.toMatch(/SYNTHETIC|9198/);
  });
});

describe("loadConnection", () => {
  it("reads the active connection of this business and channel, and nothing of another's", async () => {
    const { db, calls } = fakeTables({ whatsapp_connections: [connection(), connection({ id: "other", tenant_id: B, token_enc: "theirs" })] });
    expect(await mediaDb(db, uploader()).loadConnection(A, CHANNEL)).toEqual({ connectionId: CONN, tokenEnc: "enc" });
    expect(calls[0].filters).toEqual(expect.arrayContaining([{ column: "tenant_id", op: "eq", value: A }, { column: "channel_id", op: "eq", value: CHANNEL }, { column: "status", op: "eq", value: "active" }]));
  });

  it("is null for another business's channel, an inactive connection, or none", async () => {
    const { db } = fakeTables({ whatsapp_connections: [connection({ tenant_id: B }), connection({ id: "x", status: "needs_reconnect" })] });
    expect(await mediaDb(db, uploader()).loadConnection(A, CHANNEL)).toBeNull();
  });

  it("is null when the token column is empty or not text", async () => {
    const { db } = fakeTables({ whatsapp_connections: [connection({ token_enc: null })] });
    expect(await mediaDb(db, uploader()).loadConnection(A, CHANNEL)).toBeNull();
  });
});

describe("saveMedia", () => {
  it("updates one message's media, for this business only", async () => {
    const { db, calls, tables } = fakeTables({ messages: [message(), message({ id: "m2", tenant_id: B })] });
    await mediaDb(db, uploader()).saveMedia(A, MSG, { id: "m1", path: "p" });
    expect(tables.messages[0].media).toEqual({ id: "m1", path: "p" });
    expect(tables.messages[1].media).toEqual({ id: "m1", mime: "image/jpeg" });
    expect(calls[0].filters).toEqual(expect.arrayContaining([{ column: "tenant_id", op: "eq", value: A }, { column: "id", op: "eq", value: MSG }]));
  });

  it("throws when no row changed (the message is not this business's), so a record is never silently lost", async () => {
    const { db } = fakeTables({ messages: [message({ tenant_id: B })] });
    await expect(mediaDb(db, uploader()).saveMedia(A, MSG, { id: "m1" })).rejects.toThrow();
  });
});

describe("upload", () => {
  it("is handed to the storage writer as it is", async () => {
    const write = uploader();
    const { db } = fakeTables({});
    const bytes = Uint8Array.from([1]);
    await mediaDb(db, write).upload("a/b/c.jpg", bytes, "image/jpeg");
    expect(write).toHaveBeenCalledWith("a/b/c.jpg", bytes, "image/jpeg");
  });
});
