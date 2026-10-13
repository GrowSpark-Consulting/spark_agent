import { beforeEach, describe, expect, it, vi } from "vitest";
import { bodyVariables, fetchConversationTemplates, paramProblem, renderPreview } from "./template-reply";

const getJsonMock = vi.fn();
vi.mock("@/lib/api/client", () => ({ getJson: (...args: unknown[]) => getJsonMock(...args) }));

const TENANT = "10000000-0000-0000-0000-000000000004";
const CHAT = "40000000-0000-0000-0000-000000000003";
const row = (over: Record<string, unknown> = {}) => ({
  id: "70000000-0000-0000-0000-000000000001",
  name: "reminder_24h_v1",
  language: "en",
  category: "utility",
  variableCount: 2,
  body: "Hi {{1}}, see you at {{2}}.",
  ...over,
});

beforeEach(() => {
  getJsonMock.mockReset();
});

describe("bodyVariables", () => {
  it("lists each distinct number once, in order, tolerating spaces", () => {
    expect(bodyVariables("{{2}} then {{ 1 }} then {{2}} again")).toEqual([1, 2]);
    expect(bodyVariables("No values")).toEqual([]);
  });
});

describe("fetchConversationTemplates", () => {
  it("asks the server for this chat's templates as this business, and keeps its order and connection", async () => {
    getJsonMock.mockResolvedValue({ connectionId: "c1", templates: [row(), row({ id: "t2", name: "thanks_v1", variableCount: 0, body: "Thanks!" })] });
    const list = await fetchConversationTemplates(TENANT, CHAT);
    expect(getJsonMock).toHaveBeenCalledWith(`/api/conversations/${CHAT}/templates`, { tenantId: TENANT, signal: undefined });
    expect(list.connectionId).toBe("c1");
    expect(list.templates.map((t) => [t.name, t.category, t.variables])).toEqual([["reminder_24h_v1", "utility", [1, 2]], ["thanks_v1", "utility", []]]);
  });

  it("passes a disconnected number through as connectionId null with nothing to send", async () => {
    getJsonMock.mockResolvedValue({ connectionId: null, templates: [] });
    expect(await fetchConversationTemplates(TENANT, CHAT)).toEqual({ connectionId: null, templates: [] });
  });

  it("never offers a template whose body is unreadable or whose value count disagrees with its body", async () => {
    getJsonMock.mockResolvedValue({ connectionId: "c1", templates: [row({ body: null, variableCount: null }), row({ id: "t3", variableCount: 1 })] });
    const list = await fetchConversationTemplates(TENANT, CHAT);
    expect(list.templates.map((t) => t.body)).toEqual([null, null]);
  });

  it("fails on an answer that is not in the contract's shape", async () => {
    getJsonMock.mockResolvedValue({ templates: [] });
    await expect(fetchConversationTemplates(TENANT, CHAT)).rejects.toThrow(/unexpected shape/);
    getJsonMock.mockResolvedValue({ connectionId: "c1", templates: [{ name: "x" }] });
    await expect(fetchConversationTemplates(TENANT, CHAT)).rejects.toThrow(/unexpected shape/);
  });

  it("passes a refused read on, so the screen can show it", async () => {
    const refused = new Error("boom");
    getJsonMock.mockRejectedValue(refused);
    await expect(fetchConversationTemplates(TENANT, CHAT)).rejects.toBe(refused);
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
