import { InboundMessage, StatusUpdate } from "@pakka/types";
import { describe, expect, it } from "vitest";
import batch from "./__fixtures__/synthetic-batch-2-messages-1-status.json";
import buttonReply from "./__fixtures__/synthetic-button-reply.json";
import emptyBody from "./__fixtures__/synthetic-empty-body.json";
import imageMessage from "./__fixtures__/synthetic-image-message.json";
import statusDelivered from "./__fixtures__/synthetic-status-delivered.json";
import statusFailed from "./__fixtures__/synthetic-status-failed.json";
import templateApproved from "./__fixtures__/synthetic-template-approved.json";
import templateRejected from "./__fixtures__/synthetic-template-rejected.json";
import textMessage from "./__fixtures__/synthetic-text-message.json";
import unknownField from "./__fixtures__/synthetic-unknown-field.json";
import { parseWebhook } from "./parse";

// The fixtures are SYNTHETIC: hand-written from Meta's webhook reference with obviously fake numbers
// and ids, not captured from Meta. Shapes marked "unconfirmed" below are assumptions.
const WABA = "100000000000001";
const PNID = "200000000000001";
const routing = { phoneNumberId: PNID, wabaId: WABA };

// Builders for inline payloads (the cases that do not need a fixture file).
const metadata = { display_phone_number: "910000000001", phone_number_id: PNID };
const change = (field: string, value: unknown) => ({
  object: "whatsapp_business_account",
  entry: [{ id: WABA, changes: [{ field, value }] }],
});
const withMessages = (messages: unknown[], contacts?: unknown[]) =>
  change("messages", { messaging_product: "whatsapp", metadata, ...(contacts && { contacts }), messages });
const withStatuses = (statuses: unknown[]) =>
  change("messages", { messaging_product: "whatsapp", metadata, statuses });
const msg = (over: Record<string, unknown>) => ({
  from: "910000000101",
  id: "wamid.SYNTHETIC_INLINE_0001",
  timestamp: "1759743000",
  ...over,
});
const only = <T,>(list: T[]): T => {
  expect(list).toHaveLength(1);
  return list[0];
};

describe("fixtures", () => {
  it("parses a text message", () => {
    const result = parseWebhook(textMessage);
    expect(result.statuses).toEqual([]);
    expect(result.templateStatuses).toEqual([]);
    expect(result.ignored).toEqual([]);
    expect(only(result.messages)).toEqual({
      providerMsgId: "wamid.SYNTHETIC_TEXT_0001",
      from: "+910000000101",
      contactName: "Test Customer",
      type: "text",
      text: "வணக்கம், 2BHK price என்ன?",
      timestamp: "2025-10-06T09:30:00.000Z",
      ...routing,
    });
  });

  it("parses a button reply (shape assumed from the docs, unconfirmed)", () => {
    expect(only(parseWebhook(buttonReply).messages)).toMatchObject({
      providerMsgId: "wamid.SYNTHETIC_BUTTON_0001",
      type: "interactive",
      buttonId: "slot_1",
      text: "Tomorrow 5 pm",
      timestamp: "2025-10-06T09:31:00.000Z",
    });
  });

  it("parses an image with its media id, MIME type and caption", () => {
    expect(only(parseWebhook(imageMessage).messages)).toMatchObject({
      type: "image",
      media: { id: "synthetic-media-0001", mime: "image/jpeg" },
      text: "Kitchen photo",
    });
  });

  it("parses a delivered status", () => {
    const result = parseWebhook(statusDelivered);
    expect(result.messages).toEqual([]);
    expect(only(result.statuses)).toEqual({
      providerMsgId: "wamid.SYNTHETIC_OUT_0001",
      status: "delivered",
      timestamp: "2025-10-06T09:33:00.000Z",
      recipient: "+910000000101",
      ...routing,
    });
  });

  it("parses a failed status with the error code, title and message", () => {
    expect(only(parseWebhook(statusFailed).statuses)).toMatchObject({
      status: "failed",
      error: { code: 131047, title: "Synthetic failure title", message: "Synthetic failure message" },
    });
  });

  it("parses an approved template (numeric Meta id becomes text)", () => {
    const result = parseWebhook(templateApproved);
    expect(result.messages).toEqual([]);
    expect(only(result.templateStatuses)).toEqual({
      wabaId: WABA,
      metaTemplateId: "123456789012345",
      name: "reminder_24h_v1",
      event: "APPROVED",
      reason: "NONE",
    });
  });

  it("parses a rejected template with its reason (string Meta id kept)", () => {
    expect(only(parseWebhook(templateRejected).templateStatuses)).toEqual({
      wabaId: WABA,
      metaTemplateId: "123456789012346",
      name: "offer_blast_v1",
      event: "REJECTED",
      reason: "INCORRECT_CATEGORY",
    });
  });

  it("parses a batch of 2 messages and 1 status", () => {
    const result = parseWebhook(batch);
    expect(result.messages.map((m) => m.providerMsgId)).toEqual([
      "wamid.SYNTHETIC_BATCH_0001",
      "wamid.SYNTHETIC_BATCH_0002",
    ]);
    expect(result.messages.map((m) => m.contactName)).toEqual(["Test Customer", "Second Customer"]);
    expect(only(result.statuses)).toMatchObject({ status: "read", timestamp: "2025-10-06T09:32:00.000Z" });
    expect(result.ignored).toEqual([]);
  });

  it("returns an empty result and one ignored item for an empty body", () => {
    expect(parseWebhook(emptyBody)).toEqual({
      messages: [],
      statuses: [],
      templateStatuses: [],
      qualityUpdates: [],
      accountUpdates: [],
      echoes: [],
      ignored: [{ field: "payload", reason: "malformed_payload" }],
    });
  });

  it("ignores an unknown field and unknown keys, and still parses the message beside them", () => {
    const result = parseWebhook(unknownField);
    expect(only(result.messages)).toMatchObject({ providerMsgId: "wamid.SYNTHETIC_UNKNOWN_0001", text: "Still parsed" });
    expect(result.ignored).toEqual([{ field: "future_feature_synthetic", reason: "unsupported_field", wabaId: WABA }]);
  });

  it("gives every item the phone_number_id and WABA id, and matches the shared contract", () => {
    const parsed = [textMessage, buttonReply, imageMessage, batch].flatMap((f) => parseWebhook(f).messages);
    expect(parsed.length).toBeGreaterThan(0);
    for (const m of parsed) {
      expect(m).toMatchObject(routing);
      expect(InboundMessage.omit({ tenantId: true, channelId: true }).safeParse(m).success).toBe(true);
    }
    const statuses = [statusDelivered, statusFailed, batch].flatMap((f) => parseWebhook(f).statuses);
    expect(statuses.length).toBeGreaterThan(0);
    for (const s of statuses) {
      expect(s).toMatchObject(routing);
      expect(StatusUpdate.omit({ error: true }).safeParse(s).success).toBe(true);
    }
  });
});

describe("message types", () => {
  it("maps a list reply (shape assumed from the docs, unconfirmed)", () => {
    const body = withMessages([
      msg({ type: "interactive", interactive: { type: "list_reply", list_reply: { id: "row_3", title: "3BHK", description: "Sea view" } } }),
    ]);
    expect(only(parseWebhook(body).messages)).toMatchObject({ type: "interactive", buttonId: "row_3", text: "3BHK" });
  });

  it("maps audio and a document with its caption", () => {
    const body = withMessages([
      msg({ id: "wamid.A", type: "audio", audio: { id: "m1", mime_type: "audio/ogg; codecs=opus", voice: true } }),
      msg({ id: "wamid.D", type: "document", document: { id: "m2", mime_type: "application/pdf", filename: "plan.pdf", caption: "Floor plan" } }),
    ]);
    const [audio, doc] = parseWebhook(body).messages;
    expect(audio).toMatchObject({ type: "audio", media: { id: "m1", mime: "audio/ogg; codecs=opus" } });
    expect(audio.text).toBeUndefined();
    expect(doc).toMatchObject({ type: "document", media: { id: "m2", mime: "application/pdf" }, text: "Floor plan" });
  });

  it("maps a location to '<lat>,<lng> <name> <address>'", () => {
    const full = msg({ type: "location", location: { latitude: 13.0827, longitude: 80.2707, name: "Site", address: "1 Test Road" } });
    const bare = msg({ id: "wamid.L2", type: "location", location: { latitude: 13.5, longitude: 80 } });
    const [a, b] = parseWebhook(withMessages([full, bare])).messages;
    expect(a).toMatchObject({ type: "location", text: "13.0827,80.2707 Site 1 Test Road" });
    expect(b.text).toBe("13.5,80");
  });

  it.each(["reaction", "sticker", "video", "button", "contacts", "unsupported"])(
    "keeps a %s message as unsupported with its wamid",
    (type) => {
      const body = withMessages([msg({ type, [type]: { anything: true } })]);
      expect(only(parseWebhook(body).messages)).toMatchObject({
        providerMsgId: "wamid.SYNTHETIC_INLINE_0001",
        from: "+910000000101",
        type: "unsupported",
        unsupportedType: type,
        timestamp: "2025-10-06T09:30:00.000Z",
        ...routing,
      });
    },
  );

  it("never drops an image that has no MIME type: it becomes unsupported with the real type word", () => {
    const body = withMessages([msg({ type: "image", image: { id: "m1", caption: "no mime" } })]);
    const result = parseWebhook(body);
    expect(only(result.messages)).toMatchObject({
      providerMsgId: "wamid.SYNTHETIC_INLINE_0001",
      type: "unsupported",
      unsupportedType: "image",
    });
    expect(result.ignored).toEqual([]);
  });

  it("keeps a text or interactive message with a missing body as unsupported", () => {
    const body = withMessages([
      msg({ id: "wamid.T", type: "text" }),
      msg({ id: "wamid.I", type: "interactive", interactive: { type: "nfm_reply" } }),
    ]);
    expect(parseWebhook(body).messages.map((m) => [m.providerMsgId, m.type, m.unsupportedType])).toEqual([
      ["wamid.T", "unsupported", "text"],
      ["wamid.I", "unsupported", "interactive"],
    ]);
  });

  it("replaces an odd type word with 'unknown' so nothing untrusted is passed on", () => {
    const body = withMessages([msg({ type: "Weird Type!<script>" })]);
    expect(only(parseWebhook(body).messages)).toMatchObject({ type: "unsupported", unsupportedType: "unknown" });
  });
});

describe("phone numbers", () => {
  it("normalises bare digits to E.164 with a leading +, and keeps an existing +", () => {
    const body = withMessages([
      msg({ id: "a", type: "text", text: { body: "x" } }),
      msg({ id: "b", from: "+910000000102", type: "text", text: { body: "y" } }),
    ]);
    expect(parseWebhook(body).messages.map((m) => m.from)).toEqual(["+910000000101", "+910000000102"]);
  });

  it("ignores a message from a number that is not E.164, keeps its neighbours, and leaks nothing", () => {
    const body = withMessages([
      msg({ id: "wamid.BAD", from: "120363025246125486@g.us", type: "text", text: { body: "secret text" } }),
      msg({ id: "wamid.GOOD", type: "text", text: { body: "fine" } }),
    ]);
    const result = parseWebhook(body);
    expect(result.messages.map((m) => m.providerMsgId)).toEqual(["wamid.GOOD"]);
    expect(result.ignored).toEqual([{ field: "messages", reason: "invalid_item", wabaId: WABA, ref: "wamid.BAD" }]);
    expect(JSON.stringify(result.ignored)).not.toMatch(/120363|secret text/);
  });

  it("normalises a status recipient and drops one that is not a number", () => {
    const ok = { id: "wamid.S1", status: "sent", timestamp: "1759743000", recipient_id: "910000000101" };
    const group = { id: "wamid.S2", status: "sent", timestamp: "1759743000", recipient_id: "120363025246125486@g.us" };
    const [a, b] = parseWebhook(withStatuses([ok, group])).statuses;
    expect(a.recipient).toBe("+910000000101");
    expect(b.recipient).toBeUndefined();
  });
});

describe("timestamps", () => {
  it.each([
    ["a string of seconds", "1759743000"],
    ["a number of seconds", 1759743000],
  ])("converts %s to an ISO string", (_why, timestamp) => {
    const body = withMessages([msg({ timestamp, type: "text", text: { body: "x" } })]);
    expect(only(parseWebhook(body).messages).timestamp).toBe("2025-10-06T09:30:00.000Z");
  });

  it.each([
    ["letters", "abc"],
    ["empty", ""],
    ["negative", "-5"],
    ["fractional", 1.5],
    ["missing", undefined],
    ["a huge value", "99999999999999999999"],
  ])("ignores an item whose timestamp is %s", (_why, timestamp) => {
    const body = withMessages([msg({ timestamp, type: "text", text: { body: "x" } })]);
    const result = parseWebhook(body);
    expect(result.messages).toEqual([]);
    expect(result.ignored).toMatchObject([{ reason: "invalid_item", ref: "wamid.SYNTHETIC_INLINE_0001" }]);
  });
});

describe("statuses", () => {
  it("accepts sent, delivered, read and failed", () => {
    const statuses = ["sent", "delivered", "read", "failed"].map((status, i) => ({
      id: `wamid.S${i}`,
      status,
      timestamp: "1759743000",
    }));
    expect(parseWebhook(withStatuses(statuses)).statuses.map((s) => s.status)).toEqual([
      "sent",
      "delivered",
      "read",
      "failed",
    ]);
  });

  it("ignores played and unknown statuses", () => {
    const statuses = ["played", "queued"].map((status, i) => ({ id: `wamid.S${i}`, status, timestamp: "1759743000" }));
    const result = parseWebhook(withStatuses(statuses));
    expect(result.statuses).toEqual([]);
    expect(result.ignored.map((i) => i.reason)).toEqual(["unsupported_status", "unsupported_status"]);
  });

  it("falls back to the title when Meta sends no message, and omits an error without an integer code", () => {
    const base = { id: "wamid.S", status: "failed", timestamp: "1759743000" };
    const a = parseWebhook(withStatuses([{ ...base, errors: [{ code: 131026, title: "Only a title" }] }])).statuses[0];
    expect(a.error).toEqual({ code: 131026, title: "Only a title", message: "Only a title" });
    const b = parseWebhook(withStatuses([{ ...base, errors: [{ code: "x", title: "t" }] }])).statuses[0];
    expect(b.error).toBeUndefined();
    expect(parseWebhook(withStatuses([base])).statuses[0].error).toBeUndefined();
  });

  it("keeps the wamid dedupe key in providerMsgId", () => {
    expect(only(parseWebhook(statusFailed).statuses).providerMsgId).toBe("wamid.SYNTHETIC_OUT_0002");
  });
});

describe("template statuses", () => {
  const template = (value: Record<string, unknown>) =>
    change("message_template_status_update", { event: "APPROVED", message_template_name: "t_v1", ...value });

  it("accepts a safe integer id and a string id, and keeps the raw event and reason", () => {
    const a = only(
      parseWebhook(template({ message_template_id: 42, event: "REINSTATED", reason: "NONE" })).templateStatuses,
    );
    expect(a).toEqual({ wabaId: WABA, metaTemplateId: "42", name: "t_v1", event: "REINSTATED", reason: "NONE" });
    expect(only(parseWebhook(template({ message_template_id: "99" })).templateStatuses).metaTemplateId).toBe("99");
  });

  it("ignores an unsafe integer id instead of passing on a rounded one", () => {
    const result = parseWebhook(template({ message_template_id: 2 ** 60 }));
    expect(result.templateStatuses).toEqual([]);
    expect(result.ignored).toEqual([
      { field: "message_template_status_update", reason: "invalid_item", wabaId: WABA },
    ]);
  });

  it.each([
    ["no id", {}],
    ["an empty id", { message_template_id: "" }],
    ["a boolean id", { message_template_id: true }],
    ["no name", { message_template_id: 1, message_template_name: undefined }],
    ["no event", { message_template_id: 1, event: undefined }],
  ])("ignores an update with %s", (_why, value) => {
    const result = parseWebhook(template(value));
    expect(result.templateStatuses).toEqual([]);
    expect(result.ignored).toMatchObject([{ reason: "invalid_item" }]);
  });

  it("does not read a language or timestamp, because Meta's field names for them are unconfirmed", () => {
    const body = template({ message_template_id: 1, message_template_language: "en" });
    const item = only(parseWebhook(body).templateStatuses);
    expect(item.language).toBeUndefined();
    expect(item.timestamp).toBeUndefined();
  });
});

describe("fields that are ignored without guessing their shape", () => {
  it.each([
    "smb_app_state_sync",
    "history",
    "brand_new_field",
  ])("ignores %s as unsupported_field", (field) => {
    const result = parseWebhook(change(field, { event: "X", secret_marker: "SHOULD_NOT_LEAK", from: "910000000101" }));
    expect(result).toEqual({
      messages: [],
      statuses: [],
      templateStatuses: [],
      qualityUpdates: [],
      accountUpdates: [],
      echoes: [],
      ignored: [{ field, reason: "unsupported_field", wabaId: WABA }],
    });
    expect(JSON.stringify(result)).not.toContain("SHOULD_NOT_LEAK");
  });

  it("cleans and shortens the template's reason before it is passed on", () => {
    const result = parseWebhook(change("message_template_status_update", { event: "REJECTED", message_template_id: 7, message_template_name: "t", reason: "Bad\u0000 text\n" + "y".repeat(2000) }));
    const reason = result.templateStatuses[0].reason ?? "";
    expect([...reason].length).toBeLessThanOrEqual(500);
    expect(reason).not.toContain("\u0000");
    expect(reason.startsWith("Bad text")).toBe(true);
  });

  it("reads a quality update's event and limit, and nothing else of it", () => {
    const result = parseWebhook(change("phone_number_quality_update", { display_phone_number: "919840012345", event: "UPGRADE", current_limit: "TIER_10K", secret_marker: "SHOULD_NOT_LEAK" }));
    expect(result.qualityUpdates).toEqual([{ wabaId: WABA, event: "UPGRADE", currentLimit: "TIER_10K" }]);
    expect(result.ignored).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/SHOULD_NOT_LEAK|919840012345/);
  });

  it("keeps a quality rating when there is one, and 'unknown' for an event that is not a plain word", () => {
    expect(parseWebhook(change("phone_number_quality_update", { event: "a b", quality_rating: "GREEN" })).qualityUpdates).toEqual([{ wabaId: WABA, event: "unknown", qualityRating: "GREEN" }]);
  });

  it("reads an account update's event only", () => {
    const result = parseWebhook(change("account_update", { phone_number: "919840012345", event: "ACCOUNT_VIOLATION", secret_marker: "SHOULD_NOT_LEAK" }));
    expect(result.accountUpdates).toEqual([{ wabaId: WABA, event: "ACCOUNT_VIOLATION" }]);
    expect(JSON.stringify(result)).not.toMatch(/SHOULD_NOT_LEAK|919840012345/);
  });

  it.each(["phone_number_quality_update", "account_update"])("ignores %s whose value is not an object", (field) => {
    const result = parseWebhook(change(field, "text"));
    expect(result.ignored).toEqual([{ field, reason: "invalid_item", wabaId: WABA }]);
  });

  it("replaces an odd field name with 'unknown'", () => {
    expect(parseWebhook(change("<b>weird field</b>", {})).ignored).toEqual([
      { field: "unknown", reason: "unsupported_field", wabaId: WABA },
    ]);
  });
});

describe("never throws", () => {
  const throwingGetter = {
    get entry(): never {
      throw new Error("boom");
    },
  };
  const boom = () => {
    throw new Error("boom");
  };
  const throwingProxy = new Proxy({}, { get: boom, has: boom, ownKeys: boom });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["a string", "text"],
    ["an array", []],
    ["an empty object", {}],
    ["entry null", { entry: null }],
    ["entry a string", { entry: "x" }],
    ["entry of junk", { entry: [1, null, "x", []] }],
    ["changes a string", { entry: [{ id: WABA, changes: "x" }] }],
    ["a change without a value", { entry: [{ id: WABA, changes: [{ field: "messages" }] }] }],
    ["messages a string", change("messages", { metadata, messages: "x" })],
    ["messages of junk", change("messages", { metadata, messages: [null, 1, "x", {}] })],
    ["no metadata", change("messages", { messages: [msg({ type: "text", text: { body: "x" } })] })],
    ["a throwing getter", throwingGetter],
    ["a throwing proxy", throwingProxy],
  ])("returns a result for %s", (_why, body) => {
    const run = () => parseWebhook(body);
    expect(run).not.toThrow();
    const result = run();
    expect(result.messages).toEqual([]);
    expect(result.statuses).toEqual([]);
    expect(result.templateStatuses).toEqual([]);
  });

  it("still parses an item beside one that throws when read", () => {
    const bad = {
      get id(): never {
        throw new Error("boom");
      },
      from: "910000000101",
      timestamp: "1759743000",
      type: "text",
    };
    const good = msg({ id: "wamid.GOOD", type: "text", text: { body: "fine" } });
    expect(parseWebhook(withMessages([bad, good])).messages.map((m) => m.providerMsgId)).toEqual(["wamid.GOOD"]);
  });

  it("does not change its input", () => {
    for (const fixture of [textMessage, statusFailed, templateApproved, batch, unknownField]) {
      const before = structuredClone(fixture);
      parseWebhook(fixture);
      expect(fixture).toEqual(before);
    }
  });

  it("does not remove or merge duplicates: the same wamid twice gives two items", () => {
    const m = msg({ type: "text", text: { body: "x" } });
    expect(parseWebhook(withMessages([m, m])).messages).toHaveLength(2);
  });
});
