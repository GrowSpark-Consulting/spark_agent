import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, type FakeResponse } from "../test-support/fake-supabase";

type RpcResult = { data: unknown; error: { code?: string; message: string } | null };
const rpcHandlers: Record<string, (args: Record<string, unknown>) => RpcResult> = {};
const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => rpcHandlers[fn](args));
const isEnabled = vi.fn(async () => true);
// Tables read directly (the idempotency check reads messages); filled per test.
const tables: Record<string, FakeResponse> = {};
const db = fakeSupabase(tables);
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: () => ({ rpc, from: (table: string) => db.client.from(table) }) }));
vi.mock("../features/is-enabled", () => ({ isEnabled }));

const { keyedMessageId, send, templateVariableCount, TEST_MESSAGES_PER_HOUR } = await import("./send");
const { OutsideWindowError, registerSender, SendError } = await import("./sender");

const TENANT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const CONVERSATION = "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f601";
const STAFF = "16fd2706-8baf-433b-82eb-8c7fada847da";
const target = (over: Record<string, unknown> = {}) => ({
  connection_id: "1b4e28ba-2fa1-41d2-883f-0016d3cca427",
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

const sender = { sendText: vi.fn(), sendTemplate: vi.fn(), sendInteractive: vi.fn() };

beforeEach(() => {
  rpc.mockClear();
  isEnabled.mockReset().mockResolvedValue(true);
  sender.sendText.mockReset().mockResolvedValue({ providerMsgId: "wamid.text" });
  sender.sendTemplate.mockReset().mockResolvedValue({ providerMsgId: "wamid.tpl" });
  sender.sendInteractive.mockReset().mockResolvedValue({ providerMsgId: "wamid.buttons" });
  registerSender(async () => sender);
  rpcHandlers.notify_target = () => ok([target()]);
  rpcHandlers.notify_staff_target = () => ok([target({ to_phone: "+919800011111" })]);
  rpcHandlers.notify_template = () => ok([{ name: "reminder_24h_v2", language: "en", category: "utility" }]);
  rpcHandlers.notify_record = () => ok(null);
  rpcHandlers.spend_credits = () => ok(true);
  rpcHandlers.refund_credits = () => ok(1);
  tables.messages = { data: [], error: null };
  db.calls.length = 0;
});

describe("a template chosen by staff (staff_reply)", () => {
  const chosen = { name: "reminder_24h_v2", language: "en", params: ["Asha", "5 pm"] };
  const approved = () => ({
    data: [{ name: "reminder_24h_v2", language: "en", category: "utility", components: { body: "Hi {{1}}, see you at {{2}}.", examples: ["Asha", "5 pm"] } }],
    error: null,
  });

  it("sends an approved template of this number whatever the window, free, recorded with its name", async () => {
    rpcHandlers.notify_target = () => ok([target({ last_customer_msg_at: null })]);
    tables.whatsapp_templates = approved();
    const outcome = await send(TENANT, "staff_reply", { conversationId: CONVERSATION, template: chosen, actorId: STAFF });
    expect(outcome).toMatchObject({ status: "sent", usedTemplate: true, creditsCharged: 0 });
    expect(sender.sendTemplate).toHaveBeenCalledWith("+919840012345", "reminder_24h_v2", "en", ["Asha", "5 pm"]);
    expect(calls("notify_template")).toHaveLength(0);
    expect(calls("spend_credits")).toHaveLength(0);
    expect(calls("notify_record")[0]).toMatchObject({ p_template_name: "reminder_24h_v2", p_sender: "staff", p_actor: STAFF, p_kind: "staff_reply" });
    for (const [column, value] of [["tenant_id", TENANT], ["connection_id", target().connection_id], ["name", "reminder_24h_v2"], ["language", "en"], ["status", "approved"]]) {
      expect(db.calls).toContainEqual({ table: "whatsapp_templates", method: "eq", args: [column, value] });
    }
  });

  it("refuses a template that isn't approved for this number, or the wrong number of values", async () => {
    tables.whatsapp_templates = { data: [], error: null };
    await expect(send(TENANT, "staff_reply", { conversationId: CONVERSATION, template: chosen })).resolves.toMatchObject({
      status: "failed",
      error: { code: "not_found", message: "That template isn't approved for this WhatsApp number." },
    });
    tables.whatsapp_templates = approved();
    await expect(send(TENANT, "staff_reply", { conversationId: CONVERSATION, template: { ...chosen, params: ["Asha"] } })).resolves.toMatchObject({
      status: "failed",
      error: { code: "validation_failed", message: "This template needs 2 values." },
    });
    expect(sender.sendTemplate).not.toHaveBeenCalled();
  });

  it("is only for staff replies, and checks the shape before reading anything", async () => {
    await expect(send(TENANT, "ai_reply", { conversationId: CONVERSATION, template: chosen })).rejects.toThrow("only a staff reply");
    await expect(send(TENANT, "staff_reply", { conversationId: CONVERSATION, template: { ...chosen, name: "Reminder 24h" } })).resolves.toMatchObject({
      status: "failed",
      error: { code: "validation_failed" },
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("counts a body's variables as submitted or as Meta lists them", () => {
    expect(templateVariableCount({ body: "Hi {{1}}, see you at {{2}}. {{1}} again." })).toBe(2);
    expect(templateVariableCount([{ type: "HEADER", text: "{{1}}" }, { type: "BODY", text: "Thanks {{1}}" }])).toBe(1);
    expect(templateVariableCount({ body: "No variables here." })).toBe(0);
    expect(templateVariableCount(null)).toBeNull();
    expect(templateVariableCount({})).toBeNull();
  });
});

describe("idempotencyKey", () => {
  const KEY = "reminder_24h:9b2f0a4e-1c3d-4e5f-8a6b-7c8d9e0f1a2b:2026-10-10T11:30:00.000Z";
  const reminder = { conversationId: CONVERSATION, text: "Reminder: your visit is on Sat 10 Oct, 5:00 pm.", idempotencyKey: KEY };

  it("derives one stable message id per business, kind and key", () => {
    const id = keyedMessageId(TENANT, "reminder_24h", KEY);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(keyedMessageId(TENANT, "reminder_24h", KEY)).toBe(id);
    expect(keyedMessageId(TENANT, "reminder_2h", KEY)).not.toBe(id);
    expect(keyedMessageId(CONVERSATION, "reminder_24h", KEY)).not.toBe(id);
  });

  it("sends under the keyed id the first time", async () => {
    const outcome = await send(TENANT, "reminder_24h", reminder);
    expect(outcome).toMatchObject({ status: "sent", messageId: keyedMessageId(TENANT, "reminder_24h", KEY) });
    expect(calls("spend_credits")[0]).toMatchObject({ p_ref_id: keyedMessageId(TENANT, "reminder_24h", KEY) });
    expect(calls("notify_record")[0]).toMatchObject({ p_message_id: keyedMessageId(TENANT, "reminder_24h", KEY) });
    // It looked for an earlier send under both ids (the free-form one and the template fallback's), for this business.
    expect(db.calls).toContainEqual({ table: "messages", method: "eq", args: ["tenant_id", TENANT] });
    expect(db.calls).toContainEqual({
      table: "messages",
      method: "in",
      args: ["id", [keyedMessageId(TENANT, "reminder_24h", KEY), keyedMessageId(TENANT, "reminder_24h", `${KEY}#template`)]],
    });
  });

  it("returns the first send for a repeat, without sending, charging or checking toggles again", async () => {
    const id = keyedMessageId(TENANT, "reminder_24h", KEY);
    tables.messages = { data: [{ id, provider_msg_id: "wamid.first", credits_charged: 1, template_name: null }], error: null };
    isEnabled.mockResolvedValue(false);
    await expect(send(TENANT, "reminder_24h", reminder)).resolves.toEqual({
      status: "sent",
      messageId: id,
      providerMsgId: "wamid.first",
      creditsCharged: 1,
      usedTemplate: false,
    });
    expect(sender.sendText).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("gives the template fallback its own id, which a repeat also finds", async () => {
    sender.sendText.mockRejectedValueOnce(new OutsideWindowError());
    await expect(send(TENANT, "reminder_24h", { ...reminder, templateParams: ["visit", "Skyline Homes", "Sat 10 Oct, 5:00 pm"] })).resolves.toMatchObject({
      status: "sent",
      usedTemplate: true,
      messageId: keyedMessageId(TENANT, "reminder_24h", `${KEY}#template`),
    });
    expect(calls("refund_credits")[0]).toMatchObject({ p_ref_id: keyedMessageId(TENANT, "reminder_24h", KEY) });
  });

  it("refuses a key that is empty or too long, before anything is read", async () => {
    await expect(send(TENANT, "reminder_24h", { ...reminder, idempotencyKey: "" })).rejects.toThrow("idempotencyKey");
    await expect(send(TENANT, "reminder_24h", { ...reminder, idempotencyKey: "k".repeat(201) })).rejects.toThrow("idempotencyKey");
    expect(db.calls).toHaveLength(0);
  });
});

describe("staff_alert", () => {
  const OWNER = "2c4d6e8f-1a3b-4c5d-8e7f-9a0b1c2d3e4f";
  const alert = { staffUserId: OWNER, text: "Asha is waiting for a person.\nhttps://app.test/dashboard/inbox", templateParams: ["Asha is waiting for a person.", "https://app.test/dashboard/inbox"] };

  it("goes to the member's alert number, free, as free text inside their window", async () => {
    const outcome = await send(TENANT, "staff_alert", alert);
    expect(outcome).toMatchObject({ status: "sent", creditsCharged: 0, usedTemplate: false });
    expect(calls("notify_staff_target")[0]).toEqual({ p_tenant_id: TENANT, p_user_id: OWNER });
    expect(calls("notify_target")).toHaveLength(0);
    expect(sender.sendText).toHaveBeenCalledWith("+919800011111", alert.text);
    expect(isEnabled).toHaveBeenCalledWith(TENANT, "staff_alerts");
    expect(calls("spend_credits")).toHaveLength(0);
    expect(calls("notify_record")[0]).toMatchObject({ p_sender: "system", p_kind: "staff_alert", p_credits: 0 });
  });

  it("uses the approved staff_alert template outside their window, still free", async () => {
    rpcHandlers.notify_staff_target = () => ok([target({ to_phone: "+919800011111", last_customer_msg_at: null })]);
    rpcHandlers.notify_template = () => ok([{ name: "staff_alert_v1", language: "en", category: "utility" }]);
    const outcome = await send(TENANT, "staff_alert", alert);
    expect(outcome).toMatchObject({ status: "sent", usedTemplate: true, creditsCharged: 0 });
    expect(calls("notify_template")[0]).toMatchObject({ p_base_name: "staff_alert" });
    expect(sender.sendTemplate).toHaveBeenCalledWith("+919800011111", "staff_alert_v1", "en", alert.templateParams);
    expect(calls("spend_credits")).toHaveLength(0);
  });

  it("is off with the staff_alerts toggle, needs a member, and says when they have no alert number", async () => {
    isEnabled.mockResolvedValue(false);
    await expect(send(TENANT, "staff_alert", alert)).resolves.toEqual({ status: "skipped", reason: "feature_off" });
    isEnabled.mockResolvedValue(true);
    await expect(send(TENANT, "staff_alert", { text: "x" })).rejects.toThrow("staffUserId required");
    rpcHandlers.notify_staff_target = () => ({ data: null, error: { code: "PA404", message: "no WhatsApp number for alerts" } });
    await expect(send(TENANT, "staff_alert", alert)).resolves.toMatchObject({
      status: "failed",
      error: { code: "not_found", message: "That person has no WhatsApp number for alerts." },
    });
  });
});

describe("reply buttons and lists", () => {
  const buttons = {
    type: "buttons" as const,
    body: "Your visit is tomorrow at 5 pm.",
    buttons: [
      { id: "booking:b1:confirm", title: "Confirm" },
      { id: "booking:b1:cancel", title: "Cancel" },
    ],
  };
  const reminder = { conversationId: CONVERSATION, interactive: buttons, templateParams: ["5 pm"] };

  it("go out inside the window instead of text, cost what free text costs, and the inbox sees the choices", async () => {
    const outcome = await send(TENANT, "reminder_24h", { ...reminder, text: "not sent: the buttons replace it" });
    expect(outcome).toMatchObject({ status: "sent", providerMsgId: "wamid.buttons", creditsCharged: 1, usedTemplate: false });
    expect(sender.sendInteractive).toHaveBeenCalledWith("+919840012345", buttons);
    expect(sender.sendText).not.toHaveBeenCalled();
    expect(calls("spend_credits")[0]).toMatchObject({ p_amount: 1, p_reason: "template_utility" });
    expect(calls("notify_record")[0]).toMatchObject({ p_body: "Your visit is tomorrow at 5 pm.\n\n[Confirm] [Cancel]", p_template_name: null });
  });

  it("give way to the approved template outside the window", async () => {
    rpcHandlers.notify_target = () => ok([target({ last_customer_msg_at: null })]);
    await expect(send(TENANT, "reminder_24h", reminder)).resolves.toMatchObject({ status: "sent", usedTemplate: true });
    expect(sender.sendInteractive).not.toHaveBeenCalled();
    expect(sender.sendTemplate).toHaveBeenCalledWith("+919840012345", "reminder_24h_v2", "en", ["5 pm"]);
  });

  it("fall back to the template, refunding first, when WhatsApp says the window has closed", async () => {
    sender.sendInteractive.mockRejectedValueOnce(new OutsideWindowError());
    await expect(send(TENANT, "reminder_24h", reminder)).resolves.toMatchObject({ status: "sent", usedTemplate: true });
    expect(calls("refund_credits")).toHaveLength(1);
    expect(sender.sendInteractive).toHaveBeenCalledTimes(1);
    expect(sender.sendTemplate).toHaveBeenCalledTimes(1);
  });

  it("are refused over WhatsApp's limits before anything is read or spent", async () => {
    const fourButtons = { ...buttons, buttons: [1, 2, 3, 4].map((i) => ({ id: `b${i}`, title: `B${i}` })) };
    await expect(send(TENANT, "ai_reply", { conversationId: CONVERSATION, interactive: fourButtons })).resolves.toMatchObject({
      status: "failed",
      error: { code: "validation_failed" },
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(sender.sendInteractive).not.toHaveBeenCalled();
  });

  it("carry the AI's slot list, recorded with every row", async () => {
    const list = { type: "list" as const, body: "Which time suits you?", button: "See times", sections: [{ rows: [{ id: "slot:1", title: "Fri 9 Oct, 5:00 pm" }] }] };
    await expect(send(TENANT, "ai_reply", { conversationId: CONVERSATION, interactive: list })).resolves.toMatchObject({ status: "sent", creditsCharged: 1 });
    expect(sender.sendInteractive).toHaveBeenCalledWith("+919840012345", list);
    expect(calls("notify_record")[0]).toMatchObject({ p_sender: "ai", p_body: "Which time suits you?\n\n• Fri 9 Oct, 5:00 pm" });
  });
});

describe("test_message", () => {
  const payload = { to: "+919840012345", text: "Hello from Spark Agent", actorId: STAFF };

  it("sends free text inside the window for 0 credits and records it in messages and audit_logs", async () => {
    const outcome = await send(TENANT, "test_message", payload);
    expect(outcome).toMatchObject({ status: "sent", providerMsgId: "wamid.text", creditsCharged: 0, usedTemplate: false });
    expect(sender.sendText).toHaveBeenCalledWith("+919840012345", "Hello from Spark Agent");
    expect(calls("spend_credits")).toHaveLength(0);
    expect(calls("notify_record")[0]).toMatchObject({ p_sender: "staff", p_actor: STAFF, p_kind: "test_message", p_credits: 0 });
  });

  it("refuses outside the 24-hour window instead of sending", async () => {
    rpcHandlers.notify_target = () => ok([target({ last_customer_msg_at: null })]);
    await expect(send(TENANT, "test_message", payload)).resolves.toEqual({ status: "skipped", reason: "outside_window" });
    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it(`allows ${TEST_MESSAGES_PER_HOUR} an hour per business`, async () => {
    rpcHandlers.notify_target = () => ok([target({ recent_test_messages: TEST_MESSAGES_PER_HOUR })]);
    await expect(send(TENANT, "test_message", payload)).resolves.toMatchObject({
      status: "failed",
      error: { code: "rate_limited", retryable: true, outcomeUnknown: false },
    });
    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it("reports a business with no connected number", async () => {
    rpcHandlers.notify_target = () => ({ data: null, error: { code: "PA409", message: "no active WhatsApp connection" } });
    await expect(send(TENANT, "test_message", payload)).resolves.toMatchObject({
      status: "failed",
      error: { code: "whatsapp_not_connected" },
    });
  });
});

describe("customer messages", () => {
  it("skips a kind whose feature is off without looking anything up", async () => {
    isEnabled.mockResolvedValue(false);
    await expect(send(TENANT, "ai_reply", { conversationId: CONVERSATION, text: "Hi" })).resolves.toEqual({
      status: "skipped",
      reason: "feature_off",
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("never messages a contact who opted out", async () => {
    rpcHandlers.notify_target = () => ok([target({ opted_out: true })]);
    await expect(send(TENANT, "ai_reply", { conversationId: CONVERSATION, text: "Hi" })).resolves.toEqual({
      status: "skipped",
      reason: "opted_out",
    });
    for (const kind of ["staff_reply", "booking_confirmation", "reminder_24h"] as const) {
      await expect(send(TENANT, kind, { conversationId: CONVERSATION, text: "Hi", templateParams: [] })).resolves.toMatchObject({
        reason: "opted_out",
      });
    }
  });

  it("sends a system notice even after STOP, free and without a toggle", async () => {
    rpcHandlers.notify_target = () => ok([target({ opted_out: true })]);
    const outcome = await send(TENANT, "system_notice", { conversationId: CONVERSATION, text: "You won't get more messages from us." });
    expect(outcome).toMatchObject({ status: "sent", creditsCharged: 0, usedTemplate: false });
    expect(isEnabled).not.toHaveBeenCalled();
    expect(calls("spend_credits")).toHaveLength(0);
    expect(calls("notify_record")[0]).toMatchObject({ p_sender: "system", p_actor: "system", p_kind: "system_notice", p_credits: 0 });
  });

  it("sends the holding message when the business is out of credits (it costs nothing)", async () => {
    rpcHandlers.spend_credits = () => ok(false);
    const outcome = await send(TENANT, "system_notice", { conversationId: CONVERSATION, text: "We'll get back to you shortly." });
    expect(outcome).toMatchObject({ status: "sent", creditsCharged: 0 });
    expect(calls("spend_credits")).toHaveLength(0);
  });

  it("skips a system notice outside the 24-hour window (it has no template)", async () => {
    rpcHandlers.notify_target = () => ok([target({ last_customer_msg_at: null })]);
    await expect(send(TENANT, "system_notice", { conversationId: CONVERSATION, text: "Hi" })).resolves.toEqual({
      status: "skipped",
      reason: "outside_window",
    });
    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it("charges an AI reply 1 credit, with the message id as ref_id", async () => {
    const outcome = await send(TENANT, "ai_reply", { conversationId: CONVERSATION, text: "Aster 3BHKs start at ₹88 L." });
    expect(outcome).toMatchObject({ status: "sent", creditsCharged: 1, usedTemplate: false });
    if (outcome.status !== "sent") throw new Error("not sent");
    expect(calls("spend_credits")[0]).toMatchObject({ p_amount: 1, p_reason: "ai_reply", p_ref_id: outcome.messageId });
    expect(calls("notify_record")[0]).toMatchObject({ p_message_id: outcome.messageId, p_sender: "ai", p_actor: "ai", p_credits: 1 });
  });

  it("does not send when the business is out of credits", async () => {
    rpcHandlers.spend_credits = () => ok(false);
    await expect(send(TENANT, "ai_reply", { conversationId: CONVERSATION, text: "Hi" })).resolves.toEqual({
      status: "skipped",
      reason: "insufficient_credits",
    });
    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it("refunds the credits when WhatsApp rejects the message, keeping the sender's code", async () => {
    sender.sendText.mockRejectedValue(new SendError("validation_failed", "The number or the text is not valid."));
    const outcome = await send(TENANT, "ai_reply", { conversationId: CONVERSATION, text: "Hi" });
    expect(outcome).toEqual({
      status: "failed",
      error: { code: "validation_failed", message: "The number or the text is not valid.", retryable: false, outcomeUnknown: false },
    });
    const spent = calls("spend_credits")[0];
    expect(calls("refund_credits")[0]).toMatchObject({ p_tenant_id: TENANT, p_ref_id: spent.p_ref_id });
    expect(calls("notify_record")).toHaveLength(0);
  });

  it("passes a rate limit through as retryable", async () => {
    sender.sendText.mockRejectedValue(new SendError("rate_limited", "WhatsApp is limiting messages right now.", { retryable: true }));
    await expect(send(TENANT, "ai_reply", { conversationId: CONVERSATION, text: "Hi" })).resolves.toMatchObject({
      status: "failed",
      error: { code: "rate_limited", retryable: true, outcomeUnknown: false },
    });
    expect(calls("refund_credits")).toHaveLength(1);
  });

  // Decision 16 in docs/contracts.md: holding the credit instead of refunding waits for Raja.
  it("refunds an unknown outcome for now, says so, and does not send again", async () => {
    sender.sendText.mockRejectedValue(
      new SendError("upstream_failed", "WhatsApp did not answer in time.", { retryable: true, outcomeUnknown: true }),
    );
    await expect(send(TENANT, "ai_reply", { conversationId: CONVERSATION, text: "Hi" })).resolves.toMatchObject({
      status: "failed",
      error: { code: "upstream_failed", retryable: true, outcomeUnknown: true },
    });
    expect(sender.sendText).toHaveBeenCalledTimes(1);
    expect(sender.sendTemplate).not.toHaveBeenCalled();
    expect(calls("refund_credits")).toHaveLength(1);
    expect(calls("notify_record")).toHaveLength(0);
  });

  it("answers upstream_failed for an unexpected sender error and logs it without credentials", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    sender.sendText.mockRejectedValue(new Error("socket hang up, Authorization: Bearer EAAGsyntheticTokenValue123456"));
    await expect(send(TENANT, "ai_reply", { conversationId: CONVERSATION, text: "Hi" })).resolves.toMatchObject({
      status: "failed",
      error: { code: "upstream_failed", message: "WhatsApp did not accept the message, so it was not sent.", retryable: false },
    });
    expect(calls("refund_credits")).toHaveLength(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain("[notify] unexpected sender error");
    expect(String(log.mock.calls[0][0])).not.toContain("EAAGsyntheticTokenValue123456");
    log.mockRestore();
  });

  it("stops before spending when the connection can't be used", async () => {
    registerSender(async () => {
      throw new SendError("whatsapp_not_connected", "This business has no connected WhatsApp number, so the message was not sent.");
    });
    await expect(send(TENANT, "ai_reply", { conversationId: CONVERSATION, text: "Hi" })).resolves.toMatchObject({
      status: "failed",
      error: { code: "whatsapp_not_connected", retryable: false },
    });
    expect(calls("spend_credits")).toHaveLength(0);
  });

  it("skips and refunds an AI reply when WhatsApp says the window has closed", async () => {
    sender.sendText.mockRejectedValue(new OutsideWindowError());
    await expect(send(TENANT, "ai_reply", { conversationId: CONVERSATION, text: "Hi" })).resolves.toEqual({
      status: "skipped",
      reason: "outside_window",
    });
    expect(calls("refund_credits")).toHaveLength(1);
    expect(calls("notify_record")).toHaveLength(0);
  });

  it("sends the template instead when the window closes during a free-text send", async () => {
    sender.sendText.mockRejectedValue(new OutsideWindowError());
    rpcHandlers.notify_template = () => ok([{ name: "booking_confirmed_v1", language: "en", category: "utility" }]);
    const outcome = await send(TENANT, "booking_confirmation", {
      conversationId: CONVERSATION,
      text: "See you at 4 pm.",
      templateParams: ["4 pm"],
    });
    expect(outcome).toMatchObject({ status: "sent", usedTemplate: true, creditsCharged: 1 });
    expect(sender.sendTemplate).toHaveBeenCalledWith("+919840012345", "booking_confirmed_v1", "en", ["4 pm"]);
    const [first, second] = calls("spend_credits");
    expect(calls("refund_credits")).toEqual([expect.objectContaining({ p_ref_id: first.p_ref_id })]);
    expect(calls("notify_record")).toEqual([
      expect.objectContaining({ p_message_id: second.p_ref_id, p_template_name: "booking_confirmed_v1", p_body: null }),
    ]);
  });

  it("does not retry when a template send is refused", async () => {
    sender.sendTemplate.mockRejectedValue(new OutsideWindowError());
    const outcome = await send(TENANT, "reminder_24h", { conversationId: CONVERSATION, templateParams: ["4 pm"] });
    expect(outcome).toMatchObject({ status: "failed", error: { code: "outside_window", retryable: false } });
    expect(sender.sendTemplate).toHaveBeenCalledTimes(1);
    expect(calls("refund_credits")).toHaveLength(1);
  });

  it("sends the approved template outside the window and charges by its category", async () => {
    rpcHandlers.notify_target = () => ok([target({ last_customer_msg_at: null, language: "ta" })]);
    rpcHandlers.notify_template = () => ok([{ name: "nudge_v1", language: "en", category: "marketing" }]);
    const outcome = await send(TENANT, "followup_nudge", { conversationId: CONVERSATION, templateParams: ["Priya"] });
    expect(outcome).toMatchObject({ status: "sent", usedTemplate: true, creditsCharged: 1 });
    expect(calls("notify_template")[0]).toMatchObject({ p_base_name: "nudge", p_language: "ta" });
    expect(sender.sendTemplate).toHaveBeenCalledWith("+919840012345", "nudge_v1", "en", ["Priya"]);
    expect(calls("spend_credits")[0]).toMatchObject({ p_reason: "template_marketing" });
  });

  it("charges a nudge 1 credit inside the window too (Raja, 9 Oct: every automated message is 1)", async () => {
    const outcome = await send(TENANT, "followup_nudge", { conversationId: CONVERSATION, text: "Still interested?" });
    expect(outcome).toMatchObject({ status: "sent", usedTemplate: false, creditsCharged: 1 });
    expect(calls("spend_credits")[0]).toMatchObject({ p_amount: 1, p_reason: "template_marketing" });
  });

  it("uses a template even inside the window when the job gives no free text", async () => {
    const outcome = await send(TENANT, "reminder_24h", { conversationId: CONVERSATION, templateParams: ["4 pm"] });
    expect(outcome).toMatchObject({ status: "sent", usedTemplate: true });
    expect(calls("spend_credits")[0]).toMatchObject({ p_reason: "template_utility" });
  });

  it("skips outside the window when no approved template exists", async () => {
    rpcHandlers.notify_target = () => ok([target({ last_customer_msg_at: null })]);
    rpcHandlers.notify_template = () => ok([]);
    await expect(send(TENANT, "reminder_24h", { conversationId: CONVERSATION, templateParams: [] })).resolves.toEqual({
      status: "skipped",
      reason: "outside_window",
    });
    expect(calls("spend_credits")).toHaveLength(0);
  });

  it("keeps staff replies free and records the staff member", async () => {
    await expect(send(TENANT, "staff_reply", { conversationId: CONVERSATION, text: "Hi", actorId: STAFF })).resolves.toMatchObject({
      status: "sent",
      creditsCharged: 0,
    });
    expect(calls("spend_credits")).toHaveLength(0);
    expect(calls("notify_record")[0]).toMatchObject({ p_sender: "staff", p_actor: STAFF });
  });
});

describe("before the adapter exists", () => {
  it("answers not_available before spending anything", async () => {
    registerSender(undefined);
    await expect(send(TENANT, "ai_reply", { conversationId: CONVERSATION, text: "Hi" })).resolves.toMatchObject({
      status: "failed",
      error: { code: "not_available", retryable: false, outcomeUnknown: false },
    });
    expect(calls("spend_credits")).toHaveLength(0);
  });
});
