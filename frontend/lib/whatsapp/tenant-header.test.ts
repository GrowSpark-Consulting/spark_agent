import { beforeEach, describe, expect, it, vi } from "vitest";

// The two WhatsApp calls through the REAL API client (lib/api/client.ts): only fetch and the session are
// replaced. Shows what actually leaves the browser. It does not show that the API accepts it: that is the
// API's own membership check, which only a running API and database can prove.

const getSession = vi.fn();
vi.mock("@/lib/supabase/browser", () => ({ getSupabaseBrowserClient: () => ({ auth: { getSession } }) }));
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

const { loadWebhookConfig, submitManualConnect } = await import("./manual-connect");

const TENANT_A = "a0000000-0000-4000-8000-00000000000a";
const TENANT_B = "b0000000-0000-4000-8000-00000000000b";
const FORM = { wabaId: "100000000000001", phoneNumberId: "200000000000001", tokenType: "system_user" as const, token: "EAAB-token", appSecret: "app-secret" };
const CONFIG = { webhookUrl: "https://api.example.test/api/webhooks/whatsapp", verifyToken: "tenant-token", partnerBusinessId: null };
const sent = (n = 0) => {
  const [url, init] = fetchMock.mock.calls[n];
  return { url: String(url), init: init!, headers: new Headers(init!.headers) };
};

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.pakkaagent.in");
  getSession.mockReset().mockResolvedValue({ data: { session: { access_token: "header.payload.sig" } } });
  fetchMock.mockReset().mockResolvedValue(Response.json(CONFIG));
});

describe("what the WhatsApp calls send", () => {
  it("webhook-config: the signed-in user's token and the chosen business, as a GET with no body", async () => {
    await loadWebhookConfig(TENANT_A);
    const { url, init, headers } = sent();
    expect(url).toBe("https://api.pakkaagent.in/api/whatsapp/webhook-config");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(headers.get("authorization")).toBe("Bearer header.payload.sig");
    expect(headers.get("x-pakka-tenant")).toBe(TENANT_A);
  });

  it("manual connect: the same two headers, the unchanged JSON payload, and no business id in the body", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: { code: "validation_failed", message: "Some details need fixing." } }, { status: 422 }));
    await submitManualConnect(FORM, TENANT_A);
    const { url, init, headers } = sent();
    expect(url).toBe("https://api.pakkaagent.in/api/whatsapp/manual");
    expect(init.method).toBe("POST");
    expect(headers.get("authorization")).toBe("Bearer header.payload.sig");
    expect(headers.get("x-pakka-tenant")).toBe(TENANT_A);
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ wabaId: "100000000000001", phoneNumberId: "200000000000001", tokenType: "system_user", token: "EAAB-token", appSecret: "app-secret" });
  });

  it("uses the newly chosen business after a switch", async () => {
    await loadWebhookConfig(TENANT_A);
    await loadWebhookConfig(TENANT_B);
    expect([sent(0), sent(1)].map((r) => r.headers.get("x-pakka-tenant"))).toEqual([TENANT_A, TENANT_B]);
  });

  it("sends nothing when there is no usable business, so no ambiguous request reaches the API", async () => {
    await loadWebhookConfig("");
    await submitManualConnect(FORM, "");
    await loadWebhookConfig(undefined as unknown as string);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends no Authorization header when signed out, so the API answers 401, and still names the business", async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    fetchMock.mockResolvedValue(Response.json({ error: { code: "unauthenticated", message: "Your session has ended. Sign in again." } }, { status: 401 }));
    const result = await loadWebhookConfig(TENANT_A);
    expect(sent().headers.get("authorization")).toBeNull();
    expect(result).toMatchObject({ state: "error", retryable: false, message: "Your session has ended. Sign in again." });
  });

  it("shows a 403 as a refusal and a lost connection as retryable", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: { code: "forbidden", message: "Choose a business first." } }, { status: 403 }));
    expect(await loadWebhookConfig(TENANT_A)).toMatchObject({ state: "error", retryable: false, message: "Choose a business first." });
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await loadWebhookConfig(TENANT_A)).toMatchObject({ state: "error", retryable: true });
  });
});
