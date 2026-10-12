import type { TenantContext } from "@pakka/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeConversationsDb } from "../test-support/fake-conversations-db";
import { sendStaffReply } from "./staff-reply";

// notify.send's own behaviour (window, opt-out, tenant scoping, recording) is covered in notify/send.test.ts;
// here only what this service does with it, and the one-responder rule (no staff reply while the AI has the chat).
const send = vi.hoisted(() => vi.fn());
vi.mock("../notify/send", () => ({ send }));

const ctx = (role: TenantContext["role"] = "staff", tenantId = "t1"): TenantContext => ({
  user: { id: "u1", email: "staff@test.local" },
  role,
  tenant: { id: tenantId, name: "Skyline Homes", vertical: "real-estate", timezone: "Asia/Kolkata", status: "trial", planKey: "trial", trialEndsAt: null },
});
const CONVERSATION = "40000000-0000-4000-8000-000000000001";
const db = (mode: "ai" | "human" | "external" = "human") => fakeConversationsDb({ conversations: [{ id: CONVERSATION, tenant_id: "t1", mode }] }).db;
const reply = (context: TenantContext, id: string, input: unknown, mode: "ai" | "human" | "external" = "human") => sendStaffReply(context, id, input, db(mode));

describe("sendStaffReply", () => {
  beforeEach(() => {
    send.mockReset().mockResolvedValue({ status: "sent", messageId: "m1", providerMsgId: "wamid.OUT", creditsCharged: 0, usedTemplate: false });
  });

  it("sends the trimmed text through notify.send as staff_reply, for the member's own business, and returns Meta's id", async () => {
    await expect(reply(ctx(), CONVERSATION, { body: "  Hello, Karthik  " })).resolves.toEqual({
      messageId: "m1",
      providerMsgId: "wamid.OUT",
      status: "accepted",
    });
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("t1", "staff_reply", { conversationId: CONVERSATION, text: "Hello, Karthik", actorId: "u1" });
  });

  it("is open to owner, admin and staff", async () => {
    for (const role of ["owner", "admin", "staff"] as const) await expect(reply(ctx(role), CONVERSATION, { body: "Hi" })).resolves.toMatchObject({ status: "accepted" });
  });

  describe("one responder per chat", () => {
    it("refuses a reply while the AI has the chat, with a typed 409 conflict, and sends nothing", async () => {
      await expect(reply(ctx(), CONVERSATION, { body: "Hi" }, "ai")).rejects.toMatchObject({
        code: "conflict",
        status: 409,
        message: expect.stringContaining("Switch to Human"),
      });
      expect(send).not.toHaveBeenCalled();
    });

    it("allows a reply once a person has the chat, whether in the inbox (human) or on their own number (external)", async () => {
      for (const mode of ["human", "external"] as const) await expect(reply(ctx(), CONVERSATION, { body: "Hi" }, mode)).resolves.toMatchObject({ status: "accepted" });
    });

    it("answers a conversation of another business as not found, without sending", async () => {
      await expect(reply(ctx("staff", "t2"), CONVERSATION, { body: "Hi" })).rejects.toMatchObject({ code: "not_found", status: 404 });
      expect(send).not.toHaveBeenCalled();
    });

    it("answers a conversation that doesn't exist as not found", async () => {
      await expect(reply(ctx(), "40000000-0000-4000-8000-0000000000ff", { body: "Hi" })).rejects.toMatchObject({ code: "not_found" });
      expect(send).not.toHaveBeenCalled();
    });

    it("does not send when the mode can't be read", async () => {
      const fake = fakeConversationsDb({ conversations: [{ id: CONVERSATION, tenant_id: "t1", mode: "human" }] });
      fake.fail("conversations");
      await expect(sendStaffReply(ctx(), CONVERSATION, { body: "Hi" }, fake.db)).rejects.toThrow(/read conversation mode failed/);
      expect(send).not.toHaveBeenCalled();
    });
  });

  it("rejects an empty, too long or unexpected body before sending", async () => {
    for (const body of [{ body: "   " }, { body: "x".repeat(4097) }, {}, { body: 5 }, null]) {
      await expect(reply(ctx(), CONVERSATION, body)).rejects.toMatchObject({ name: "ZodError" });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("sends an approved template staff chose, as the staff member, whatever the window", async () => {
    const template = { name: "reminder_24h_v1", language: "en", params: ["site visit", "Skyline Homes", "Sat 10 Oct, 5:00 pm"] };
    await expect(reply(ctx(), CONVERSATION, { template })).resolves.toMatchObject({ status: "accepted" });
    expect(send).toHaveBeenCalledWith("t1", "staff_reply", expect.objectContaining({ conversationId: CONVERSATION, template }));
    expect(send.mock.calls[0][2]).not.toHaveProperty("text");
  });

  it("refuses a template body that is incomplete or also has text, without sending anything", async () => {
    for (const input of [
      { body: "Hi", template: { name: "nudge_v1", language: "en", params: [] } },
      { template: { name: "nudge_v1" } },
      { template: { name: "Nudge V1", language: "en", params: [] } },
      { template: { name: "nudge_v1", language: "en", params: [""] } },
    ]) {
      await expect(reply(ctx(), CONVERSATION, input)).rejects.toMatchObject({ name: "ZodError" });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("says plainly when the template isn't approved for this number, or needs other values", async () => {
    send.mockResolvedValue({ status: "failed", error: { code: "not_found", message: "That template isn't approved for this WhatsApp number.", retryable: false, outcomeUnknown: false } });
    await expect(reply(ctx(), CONVERSATION, { template: { name: "nudge_v9", language: "en", params: [] } })).rejects.toMatchObject({ code: "not_found", status: 404 });
    send.mockResolvedValue({ status: "failed", error: { code: "validation_failed", message: "This template needs 2 values.", retryable: false, outcomeUnknown: false } });
    await expect(reply(ctx(), CONVERSATION, { template: { name: "nudge_v1", language: "en", params: ["Asha"] } })).rejects.toMatchObject({
      code: "validation_failed",
      message: "This template needs 2 values.",
    });
  });

  it("treats an id that isn't a UUID as a missing conversation, without touching notify", async () => {
    await expect(reply(ctx(), "not-a-uuid", { body: "Hi" })).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(send).not.toHaveBeenCalled();
  });

  it("answers a failed lookup in notify.send as not found", async () => {
    send.mockResolvedValue({ status: "failed", error: { code: "not_found", message: "That conversation was not found.", retryable: false, outcomeUnknown: false } });
    await expect(reply(ctx(), CONVERSATION, { body: "Hi" })).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(send).toHaveBeenCalledWith("t1", "staff_reply", expect.objectContaining({ conversationId: CONVERSATION }));
  });

  it("refuses free text outside the 24-hour window and does not fall back to a template", async () => {
    send.mockResolvedValue({ status: "skipped", reason: "outside_window" });
    await expect(reply(ctx(), CONVERSATION, { body: "Hi" })).rejects.toMatchObject({ code: "outside_window", status: 409 });
  });

  it("explains a customer who opted out", async () => {
    send.mockResolvedValue({ status: "skipped", reason: "opted_out" });
    await expect(reply(ctx(), CONVERSATION, { body: "Hi" })).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("opted out") });
  });

  it("does not fake a send while WhatsApp sending is not switched on", async () => {
    send.mockResolvedValue({ status: "failed", error: { code: "not_available", message: "Sending isn't switched on yet.", retryable: false, outcomeUnknown: false } });
    await expect(reply(ctx(), CONVERSATION, { body: "Hi" })).rejects.toMatchObject({ code: "not_available", status: 501 });
  });

  it("passes notify.send's failures through with their codes, and maps an unknown code to upstream_failed", async () => {
    send.mockResolvedValue({ status: "failed", error: { code: "whatsapp_not_connected", message: "No number.", retryable: false, outcomeUnknown: false } });
    await expect(reply(ctx(), CONVERSATION, { body: "Hi" })).rejects.toMatchObject({ code: "whatsapp_not_connected" });
    send.mockResolvedValue({ status: "failed", error: { code: "something_new", message: "Meta said no.", retryable: false, outcomeUnknown: false } });
    await expect(reply(ctx(), CONVERSATION, { body: "Hi" })).rejects.toMatchObject({ code: "upstream_failed" });
  });
});
