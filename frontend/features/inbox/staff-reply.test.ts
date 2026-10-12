import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replyFailure, sendStaffReply, sendStaffTemplate, StaffReplyDataError } from "./staff-reply";
import { ApiError } from "@/lib/errors";

const postJson = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/client", () => ({ postJson }));

const TENANT = "10000000-0000-0000-0000-000000000004";
const CHAT = "40000000-0000-0000-0000-000000000001";
const apiError = (status: number, code: string, message = "Words.") => new ApiError(status, { error: { code, message } } as never);

describe("sendStaffReply", () => {
  beforeEach(() => {
    postJson.mockReset(); // not returned: vitest would call a returned function as cleanup
  });
  afterEach(() => vi.restoreAllMocks());

  it("posts only the body, with the business in the tenant header, and parses the answer", async () => {
    postJson.mockResolvedValue({ messageId: "m1", providerMsgId: "wamid.1", status: "accepted" });
    await expect(sendStaffReply(TENANT, CHAT, "Hello")).resolves.toEqual({ messageId: "m1", providerMsgId: "wamid.1", status: "accepted" });
    expect(postJson).toHaveBeenCalledWith(`/api/conversations/${CHAT}/messages`, { body: "Hello" }, { tenantId: TENANT });
  });

  it("rejects an answer of the wrong shape instead of showing it as sent", async () => {
    postJson.mockResolvedValue({ status: "accepted" });
    await expect(sendStaffReply(TENANT, CHAT, "Hello")).rejects.toBeInstanceOf(StaffReplyDataError);
  });

  it("passes the API's errors through", async () => {
    postJson.mockImplementation(() => Promise.reject(apiError(409, "outside_window")));
    let seen: { status: number; code: string } | null = null;
    try {
      await sendStaffReply(TENANT, CHAT, "Hello");
    } catch (err) {
      if (err instanceof ApiError) seen = { status: err.status, code: err.body.error.code };
    }
    expect(seen).toEqual({ status: 409, code: "outside_window" });
  });
});

describe("replyFailure", () => {
  it("is certain nothing was sent for a refusal the API made before sending", () => {
    for (const [status, code] of [[409, "outside_window"], [409, "conflict"], [403, "forbidden"], [404, "not_found"], [422, "validation_failed"], [501, "not_available"]] as const) {
      expect(replyFailure(apiError(status, code)).maybeSent, code).toBe(false);
    }
  });

  it("says the message may have gone out when there was no answer or WhatsApp failed", () => {
    expect(replyFailure(new TypeError("Failed to fetch")).maybeSent).toBe(true);
    expect(replyFailure(apiError(502, "upstream_failed")).maybeSent).toBe(true);
    expect(replyFailure(apiError(500, "internal")).maybeSent).toBe(true);
    expect(replyFailure(new StaffReplyDataError())).toMatchObject({ maybeSent: true, retryable: false });
  });
});

describe("sendStaffTemplate", () => {
  beforeEach(() => {
    postJson.mockReset();
  });

  it("posts only the template (name, language, trimmed values) with the business in the tenant header, and parses the answer", async () => {
    postJson.mockResolvedValue({ messageId: "m1", providerMsgId: "wamid.1", status: "accepted" });
    await expect(sendStaffTemplate(TENANT, CHAT, { name: "reminder_24h_v1", language: "en", params: [" Asha ", "5 pm"] })).resolves.toMatchObject({ status: "accepted" });
    expect(postJson).toHaveBeenCalledWith(
      `/api/conversations/${CHAT}/messages`,
      { template: { name: "reminder_24h_v1", language: "en", params: ["Asha", "5 pm"] } },
      { tenantId: TENANT },
    );
  });

  it("rejects an answer of the wrong shape instead of showing it as sent", async () => {
    postJson.mockResolvedValue({ ok: true });
    await expect(sendStaffTemplate(TENANT, CHAT, { name: "a_v1", language: "en", params: [] })).rejects.toBeInstanceOf(StaffReplyDataError);
  });

  it("passes the API's refusals through (not approved, wrong number of values)", async () => {
    postJson.mockImplementation(() => Promise.reject(apiError(404, "not_found", "That template is not approved for this WhatsApp number.")));
    await expect(sendStaffTemplate(TENANT, CHAT, { name: "a_v1", language: "en", params: [] })).rejects.toMatchObject({ status: 404 });
    postJson.mockImplementation(() => Promise.reject(apiError(422, "validation_failed", "This template needs 2 values.")));
    await expect(sendStaffTemplate(TENANT, CHAT, { name: "a_v1", language: "en", params: ["x"] })).rejects.toMatchObject({ status: 422 });
  });
});
