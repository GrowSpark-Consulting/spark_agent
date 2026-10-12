import type { TenantContext } from "@pakka/types";
import { describe, expect, it } from "vitest";
import { fakeDb, type FakeDbResponse } from "../test-support/fake-db";
import { conversationTemplates, templateBody } from "./templates";

const TENANT = "7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const CHAT = "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f601";
const CHANNEL = "2e3f4a5b-6c7d-4e8f-9a0b-1c2d3e4f5a6b";
const CONNECTION = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";

const context: TenantContext = {
  user: { id: "0f1e2d3c-4b5a-4697-8877-665544332211", email: null },
  role: "staff",
  tenant: { id: TENANT, name: "Skyline Homes", vertical: "real-estate", timezone: "Asia/Kolkata", status: "active", planKey: "growth", trialEndsAt: null },
};

function db(over: { chat?: FakeDbResponse; connection?: FakeDbResponse } = {}) {
  return fakeDb({
    conversations: over.chat ?? { data: { channel_id: CHANNEL }, error: null },
    whatsapp_connections: over.connection ?? { data: [{ id: CONNECTION }], error: null },
    whatsapp_templates: {
      data: [
        { id: "t-1", name: "reminder_24h_v1", language: "en", category: "utility", components: [{ type: "BODY", text: "Reminder: your {{1}} with {{2}} is on {{3}}." }, { type: "BUTTONS", buttons: [] }] },
        { id: "t-2", name: "nudge_v1", language: "ta", category: "marketing", components: { body: "வணக்கம் {{1}}" } },
        { id: "t-3", name: "odd_v1", language: "en", category: "utility", components: null },
      ],
      error: null,
    },
  });
}

describe("GET /api/conversations/:id/templates", () => {
  it("lists the approved templates of the number this chat is on, with how many values each needs", async () => {
    const { client, calls } = db();
    expect(await conversationTemplates(context, CHAT, client)).toEqual({
      connectionId: CONNECTION,
      templates: [
        { id: "t-1", name: "reminder_24h_v1", language: "en", category: "utility", variableCount: 3, body: "Reminder: your {{1}} with {{2}} is on {{3}}." },
        { id: "t-2", name: "nudge_v1", language: "ta", category: "marketing", variableCount: 1, body: "வணக்கம் {{1}}" },
        { id: "t-3", name: "odd_v1", language: "en", category: "utility", variableCount: null, body: null },
      ],
    });
    // The number is found as notify.send finds it: the active connection on the chat's channel, in this business.
    expect(calls.filter((c) => c.table === "whatsapp_connections" && c.method === "eq").map((c) => c.args)).toEqual([
      ["tenant_id", TENANT],
      ["channel_id", CHANNEL],
      ["status", "active"],
    ]);
    expect(calls.filter((c) => c.table === "whatsapp_templates" && c.method === "eq").map((c) => c.args)).toEqual([
      ["tenant_id", TENANT],
      ["connection_id", CONNECTION],
      ["status", "approved"],
    ]);
  });

  it("says no number is connected rather than offering templates nothing can send", async () => {
    const { client, calls } = db({ connection: { data: [], error: null } });
    expect(await conversationTemplates(context, CHAT, client)).toEqual({ connectionId: null, templates: [] });
    expect(calls.some((c) => c.table === "whatsapp_templates")).toBe(false);
  });

  it("does not know a chat of another business, or an id that isn't one", async () => {
    await expect(conversationTemplates(context, CHAT, db({ chat: { data: null, error: null } }).client)).rejects.toMatchObject({ code: "not_found" });
    const { client, calls } = db();
    await expect(conversationTemplates(context, "not-a-uuid", client)).rejects.toMatchObject({ code: "not_found" });
    expect(calls).toHaveLength(0);
  });

  it("reads a body from Meta's components or the submitted ones", () => {
    expect(templateBody([{ type: "HEADER" }, { type: "body", text: "Hi {{1}}" }])).toBe("Hi {{1}}");
    expect(templateBody({ body: "Hi {{1}}", examples: ["Asha"] })).toBe("Hi {{1}}");
    expect(templateBody("nope")).toBeNull();
  });
});
