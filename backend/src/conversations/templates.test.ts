import type { TenantContext } from "@pakka/types";
import { describe, expect, it } from "vitest";
import { fakeDb, type FakeDbResponse } from "../test-support/fake-db";
import { conversationTemplates, templateBody } from "./templates";

const TENANT = "7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f";
const CHAT = "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f601";
const CONNECTION = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";

const context: TenantContext = {
  user: { id: "0f1e2d3c-4b5a-4697-8877-665544332211", email: null },
  role: "staff",
  tenant: { id: TENANT, name: "Skyline Homes", vertical: "real-estate", timezone: "Asia/Kolkata", status: "active", planKey: "growth", trialEndsAt: null },
};

// notify_target's answer for a chat: the number it goes out on (its other columns are not used here).
const target = (connectionId: string): FakeDbResponse => ({ data: [{ connection_id: connectionId, conversation_id: CHAT }], error: null });

function db(over: { target?: FakeDbResponse } = {}) {
  return fakeDb({
    "rpc:notify_target": over.target ?? target(CONNECTION),
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
    // The number is the one notify.send would send through: notify_target, for this business and chat.
    expect(calls.filter((c) => c.method === "rpc").map((c) => [c.table, ...c.args])).toEqual([
      ["rpc:notify_target", { p_tenant_id: TENANT, p_conversation_id: CHAT, p_to: null }],
    ]);
    expect(calls.filter((c) => c.table === "whatsapp_templates" && c.method === "eq").map((c) => c.args)).toEqual([
      ["connection_id", CONNECTION],
      ["status", "approved"],
    ]);
  });

  it("offers a routed trial the templates of the platform number its chat is on", async () => {
    const platform = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
    const { client, calls } = db({ target: target(platform) });
    expect((await conversationTemplates(context, CHAT, client)).connectionId).toBe(platform);
    // Those templates belong to the platform business, so the routed business is not a filter.
    expect(calls).toContainEqual({ table: "whatsapp_templates", method: "eq", args: ["connection_id", platform] });
    expect(calls.some((c) => c.table === "whatsapp_templates" && c.args[0] === "tenant_id")).toBe(false);
  });

  it("says no number is connected rather than offering templates nothing can send", async () => {
    const { client, calls } = db({ target: { data: null, error: { code: "PA409", message: "notify_target: no active WhatsApp connection" } } });
    expect(await conversationTemplates(context, CHAT, client)).toEqual({ connectionId: null, templates: [] });
    expect(calls.some((c) => c.table === "whatsapp_templates")).toBe(false);
  });

  it("does not know a chat of another business, or an id that isn't one", async () => {
    const missing: FakeDbResponse = { data: null, error: { code: "PA404", message: "notify_target: conversation not found" } };
    await expect(conversationTemplates(context, CHAT, db({ target: missing }).client)).rejects.toMatchObject({ code: "not_found" });
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
