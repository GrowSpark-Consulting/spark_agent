import { describe, expect, it } from "vitest";
import echoText from "./__fixtures__/synthetic-echo-text.json";
import { parseWebhook } from "./parse";

// Coexistence echoes (Day 4): the business owner replies to a customer from the WhatsApp Business APP on their phone, and Meta sends us a copy
// (`smb_message_echoes`). Code and fixtures only: it goes live after Embedded Signup is approved. The shape follows Meta's coexistence
// documentation as known today and is UNCONFIRMED: the fixture is synthetic, not captured from Meta. Nothing here is guessed beyond a text body.

const WABA = "100000000000001";
const PNID = "200000000000001";
const metadata = { display_phone_number: "910000000001", phone_number_id: PNID };
const echoesBody = (echoes: unknown[], meta: unknown = metadata) => ({
  object: "whatsapp_business_account",
  entry: [{ id: WABA, changes: [{ field: "smb_message_echoes", value: { messaging_product: "whatsapp", metadata: meta, message_echoes: echoes } }] }],
});
const echo = (over: Record<string, unknown> = {}) => ({ from: "910000000001", to: "910000000101", id: "wamid.SYNTHETIC_ECHO_INLINE", timestamp: "1759743600", type: "text", text: { body: "On my way" }, ...over });

describe("an echo of the owner's reply from the phone app", () => {
  it("is read from the fixture: which customer it was to, which message, when, and what it said", () => {
    const result = parseWebhook(echoText);
    expect(result.echoes).toEqual([
      {
        providerMsgId: "wamid.SYNTHETIC_ECHO_0001",
        customerPhone: "+910000000101",
        sentAt: new Date(1759743600 * 1000).toISOString(),
        kind: "text",
        text: "Sure, I will call you this evening.",
        phoneNumberId: PNID,
        wabaId: WABA,
      },
    ]);
    expect(result.ignored).toEqual([]);
  });

  it("is not a customer's message: it is never read as one, and nothing is queued for the AI", () => {
    const result = parseWebhook(echoText);
    expect(result.messages).toEqual([]);
    expect(result.statuses).toEqual([]);
  });

  it("every echo of a batch is kept, in the order Meta sent them", () => {
    const result = parseWebhook(echoesBody([echo({ id: "wamid.A" }), echo({ id: "wamid.B", to: "910000000102" })]));
    expect(result.echoes.map((e) => [e.providerMsgId, e.customerPhone])).toEqual([["wamid.A", "+910000000101"], ["wamid.B", "+910000000102"]]);
  });

  it("a reply that is not text (a photo, a voice note) is still an echo: staff answered, so the AI must step back, but its words are not kept", () => {
    const [item] = parseWebhook(echoesBody([echo({ type: "image", text: undefined, image: { id: "x", mime_type: "image/jpeg" } })])).echoes;
    expect(item).toMatchObject({ kind: "unsupported", unsupportedType: "image" });
    expect(item.text).toBeUndefined();
  });

  it("a text echo with no body is kept as an echo with no words", () => {
    const [item] = parseWebhook(echoesBody([echo({ text: undefined })])).echoes;
    expect(item).toMatchObject({ kind: "unsupported", unsupportedType: "text" });
  });

  it.each([
    ["a customer number that is not a number", { to: "not-a-number" }],
    ["no message id", { id: "" }],
    ["a time that is not a time", { timestamp: "yesterday" }],
    ["no customer", { to: undefined }],
  ])("%s is ignored as an invalid item, without keeping anything from it", (_why, over) => {
    const result = parseWebhook(echoesBody([echo(over)]));
    expect(result.echoes).toEqual([]);
    expect(result.ignored).toEqual([expect.objectContaining({ field: "smb_message_echoes", reason: "invalid_item", wabaId: WABA })]);
    expect(JSON.stringify(result)).not.toContain("On my way");
  });

  it("one bad echo does not stop the good one next to it", () => {
    const result = parseWebhook(echoesBody([echo({ to: "bad" }), echo({ id: "wamid.GOOD" })]));
    expect(result.echoes.map((e) => e.providerMsgId)).toEqual(["wamid.GOOD"]);
    expect(result.ignored).toHaveLength(1);
  });

  it("a payload that does not name the business's number is malformed, and nothing is stored", () => {
    const result = parseWebhook(echoesBody([echo()], {}));
    expect(result.echoes).toEqual([]);
    expect(result.ignored).toEqual([{ field: "smb_message_echoes", reason: "malformed_payload", wabaId: WABA }]);
  });

  it("a payload with no echoes at all is nothing, not an error", () => {
    const result = parseWebhook({ object: "whatsapp_business_account", entry: [{ id: WABA, changes: [{ field: "smb_message_echoes", value: { metadata } }] }] });
    expect(result.echoes).toEqual([]);
    expect(result.ignored).toEqual([]);
  });

  it("never throws on odd shapes", () => {
    for (const echoes of [null, "x", 5, [null], [[]], [{}], [{ id: 5, to: 6 }]]) expect(() => parseWebhook(echoesBody(echoes as unknown[]))).not.toThrow();
  });

  it("other fields of the same body are still read: the echo does not hide a customer's message", () => {
    const body = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: WABA,
          changes: [
            { field: "smb_message_echoes", value: { metadata, message_echoes: [echo()] } },
            { field: "messages", value: { metadata, messages: [{ from: "910000000101", id: "wamid.IN", timestamp: "1759743700", type: "text", text: { body: "ok" } }] } },
          ],
        },
      ],
    };
    const result = parseWebhook(body);
    expect(result.echoes).toHaveLength(1);
    expect(result.messages).toHaveLength(1);
  });
});

describe("the other fields of coexistence are still ignored without guessing their shape", () => {
  it.each(["smb_app_state_sync", "history"])("%s", (field) => {
    const result = parseWebhook({ object: "whatsapp_business_account", entry: [{ id: WABA, changes: [{ field, value: { secret_marker: "SHOULD_NOT_LEAK" } }] }] });
    expect(result.echoes).toEqual([]);
    expect(result.ignored).toEqual([{ field, reason: "unsupported_field", wabaId: WABA }]);
    expect(JSON.stringify(result)).not.toContain("SHOULD_NOT_LEAK");
  });
});
