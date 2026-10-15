import { beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();
vi.mock("@/lib/supabase/browser", () => ({ getSupabaseBrowserClient: () => ({ auth: { getSession } }) }));
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

const { getJson, patchJson, putJson, postForm, postJson, sendNoContent, TENANT_HEADER } = await import("./client");
const { ApiError } = await import("@/lib/errors");

const TENANT = "10000000-0000-0000-0000-000000000001";
const sentRequest = () => {
  const [url, init] = fetchMock.mock.calls[0];
  return { url: String(url), init: init!, headers: new Headers(init!.headers) };
};

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.pakkaagent.in");
  getSession.mockReset().mockResolvedValue({ data: { session: { access_token: "header.payload.sig" } } });
  fetchMock.mockReset().mockResolvedValue(Response.json({ providerMsgId: "wamid.1", status: "accepted" }));
});

describe("putJson", () => {
  it("PUTs JSON with the user's token and the business", async () => {
    await putJson("/api/integrations/webhook", { url: "https://example.com/hook", events: ["lead.created"] }, { tenantId: TENANT });
    const { url, init, headers } = sentRequest();
    expect(url).toBe("https://api.pakkaagent.in/api/integrations/webhook");
    expect(init.method).toBe("PUT");
    expect(init.body).toBe('{"url":"https://example.com/hook","events":["lead.created"]}');
    expect(headers.get("authorization")).toBe("Bearer header.payload.sig");
    expect(headers.get(TENANT_HEADER)).toBe(TENANT);
  });

  it("throws the API's error", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: { code: "plan_required", message: "Pro only." } }, { status: 403 }));
    await expect(putJson("/api/integrations/webhook", {}, { tenantId: TENANT })).rejects.toMatchObject({ status: 403 });
  });
});

describe("postJson", () => {
  it("POSTs JSON to the API with the user's token and the business", async () => {
    const result = await postJson("/api/messages/test", { to: "+919840012345", body: "hi" }, { tenantId: TENANT });
    expect(result).toEqual({ providerMsgId: "wamid.1", status: "accepted" });
    const { url, init, headers } = sentRequest();
    expect(url).toBe("https://api.pakkaagent.in/api/messages/test");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"to":"+919840012345","body":"hi"}');
    expect(headers.get("authorization")).toBe("Bearer header.payload.sig");
    expect(headers.get(TENANT_HEADER)).toBe(TENANT);
    expect(headers.get("content-type")).toBe("application/json");
    // Bearer token, not cookies: nothing asks the browser to send credentials cross-site.
    expect(init.credentials).toBeUndefined();
  });

  it("sends no Authorization header when signed out, so the API answers 401", async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    await postJson("/api/templates", {});
    expect(sentRequest().headers.has("authorization")).toBe(false);
    expect(sentRequest().headers.has(TENANT_HEADER)).toBe(false);
  });

  it("throws ApiError with the API's envelope on an error response", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: { code: "forbidden", message: "Only an owner or admin can create a template." } }, { status: 403 }));
    const err = await postJson("/api/templates", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
  });

  it("refuses to call anything when NEXT_PUBLIC_API_URL is missing or has a path", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "");
    await expect(postJson("/api/templates", {})).rejects.toThrow(/NEXT_PUBLIC_API_URL/);
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.pakkaagent.in/api");
    await expect(postJson("/api/templates", {})).rejects.toThrow(/NEXT_PUBLIC_API_URL/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getJson", () => {
  it("GETs JSON with the user's token and the business, and no body or content type", async () => {
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    expect(await getJson("/api/conversations/c1/lead-card", { tenantId: TENANT })).toEqual({ ok: true });
    const { url, init, headers } = sentRequest();
    expect(url).toBe("https://api.pakkaagent.in/api/conversations/c1/lead-card");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(headers.get("authorization")).toBe("Bearer header.payload.sig");
    expect(headers.get(TENANT_HEADER)).toBe(TENANT);
    expect(headers.has("content-type")).toBe(false);
  });

  it("throws ApiError with the API's envelope on an error response", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: { code: "not_found", message: "That conversation was not found." } }, { status: 404 }));
    await expect(getJson("/api/conversations/c1/lead-card", { tenantId: TENANT })).rejects.toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
  });
});

describe("patchJson, postForm and sendNoContent", () => {
  it("PATCHes JSON with the same headers as postJson", async () => {
    fetchMock.mockResolvedValue(Response.json({ id: "1" }));
    await patchJson("/api/kb/faqs/1", { a: "Yes" }, { tenantId: TENANT });
    const { init, headers } = sentRequest();
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe('{"a":"Yes"}');
    expect(headers.get("authorization")).toBe("Bearer header.payload.sig");
    expect(headers.get(TENANT_HEADER)).toBe(TENANT);
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("sends FormData as is, without a content type, so the browser adds the multipart boundary", async () => {
    fetchMock.mockResolvedValue(Response.json({ id: "1" }, { status: 202 }));
    const form = new FormData();
    form.append("file", new File(["hi"], "a.txt"));
    await postForm("/api/kb/documents", form, { tenantId: TENANT });
    const { init, headers } = sentRequest();
    expect(init.method).toBe("POST");
    expect(init.body).toBe(form);
    expect(headers.has("content-type")).toBe(false);
    expect(headers.get(TENANT_HEADER)).toBe(TENANT);
  });

  it("accepts 204 with no body for DELETE and POST, with no JSON content type", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(sendNoContent("/api/kb/faqs/1", "DELETE", { tenantId: TENANT })).resolves.toBeUndefined();
    expect(sentRequest().init.method).toBe("DELETE");
    expect(sentRequest().init.body).toBeUndefined();
    expect(sentRequest().headers.has("content-type")).toBe(false);
  });

  it("throws ApiError from each helper on an error response", async () => {
    fetchMock.mockImplementation(async () => Response.json({ error: { code: "conflict", message: "Exists." } }, { status: 409 }));
    for (const call of [
      () => patchJson("/api/kb/faqs/1", {}),
      () => postForm("/api/kb/documents", new FormData()),
      () => sendNoContent("/api/kb/gaps/1/dismiss", "POST"),
    ]) {
      await expect(call()).rejects.toMatchObject({ status: 409, body: { error: { code: "conflict" } } });
    }
  });
});
