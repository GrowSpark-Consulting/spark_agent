import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { bodyVariables, fetchSendableTemplates, paramProblem, renderPreview, templateBody } from "./template-reply";

const TENANT = "10000000-0000-0000-0000-000000000004";
const OTHER = "10000000-0000-0000-0000-000000000009";
const row = (over: Record<string, unknown> = {}) => ({
  id: "70000000-0000-0000-0000-000000000001",
  tenant_id: TENANT,
  name: "reminder_24h_v1",
  language: "en",
  category: "utility",
  components: { body: "Hi {{1}}, see you at {{2}}." },
  ...over,
});

function client(result: { data: unknown; error: unknown }) {
  const order = vi.fn().mockResolvedValue(result);
  const eq2 = vi.fn().mockReturnValue({ order });
  const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
  const select = vi.fn().mockReturnValue({ eq: eq1 });
  const from = vi.fn().mockReturnValue({ select });
  return { client: { from } as unknown as SupabaseClient, from, eq1, eq2 };
}

describe("templateBody", () => {
  it("reads the body as submitted and as Meta lists it, like the server", () => {
    expect(templateBody({ body: "Hello {{1}}" })).toBe("Hello {{1}}");
    expect(templateBody([{ type: "HEADER", text: "x" }, { type: "body", text: "Hello {{1}}" }])).toBe("Hello {{1}}");
  });
  it("is null when there is no body text", () => {
    expect(templateBody(null)).toBeNull();
    expect(templateBody({})).toBeNull();
    expect(templateBody([{ type: "BUTTONS" }])).toBeNull();
    expect(templateBody({ body: 5 })).toBeNull();
  });
});

describe("bodyVariables", () => {
  it("lists each distinct number once, in order, tolerating spaces", () => {
    expect(bodyVariables("{{2}} then {{ 1 }} then {{2}} again")).toEqual([1, 2]);
    expect(bodyVariables("No values")).toEqual([]);
  });
});

describe("fetchSendableTemplates", () => {
  it("reads only this business's approved templates and works out the values each needs", async () => {
    const c = client({ data: [row(), row({ id: "70000000-0000-0000-0000-000000000002", name: "thanks_v1", components: [{ type: "BODY", text: "Thanks!" }] })], error: null });
    const rows = await fetchSendableTemplates(c.client, TENANT);
    expect(c.from).toHaveBeenCalledWith("whatsapp_templates");
    expect(c.eq1).toHaveBeenCalledWith("tenant_id", TENANT);
    expect(c.eq2).toHaveBeenCalledWith("status", "approved");
    expect(rows.map((r) => [r.name, r.variables])).toEqual([["reminder_24h_v1", [1, 2]], ["thanks_v1", []]]);
  });
  it("marks a template with no readable body, so it is never offered", async () => {
    const [t] = await fetchSendableTemplates(client({ data: [row({ components: {} })], error: null }).client, TENANT);
    expect(t.body).toBeNull();
  });
  it("drops another business's row, fails on a bad shape and on a read error", async () => {
    expect(await fetchSendableTemplates(client({ data: [row({ tenant_id: OTHER })], error: null }).client, TENANT)).toEqual([]);
    await expect(fetchSendableTemplates(client({ data: [{ name: "x" }], error: null }).client, TENANT)).rejects.toThrow(/unexpected shape/);
    await expect(fetchSendableTemplates(client({ data: null, error: new Error("boom") }).client, TENANT)).rejects.toThrow("boom");
  });
});

describe("renderPreview", () => {
  const t = { body: "Hi {{1}}, see you at {{2}}.", variables: [1, 2] };
  it("fills what is typed and leaves the rest showing", () => {
    expect(renderPreview(t, ["Asha", ""])).toBe("Hi Asha, see you at {{2}}.");
    expect(renderPreview(t, [" Asha ", "5 pm"])).toBe("Hi Asha, see you at 5 pm.");
  });
});

describe("paramProblem", () => {
  it("needs every value, and none over the text limit", () => {
    expect(paramProblem(["a", " "])).toBe("Fill in every value.");
    expect(paramProblem(["a".repeat(5000)])).toMatch(/under/);
    expect(paramProblem(["a", "b"])).toBeNull();
    expect(paramProblem([])).toBeNull();
  });
});
