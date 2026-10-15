import { beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();
vi.mock("@/lib/supabase/browser", () => ({ getSupabaseBrowserClient: () => ({ auth: { getSession } }) }));
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

const { webhookService, WebhookDataError } = await import("./webhook-api");
const { ApiError } = await import("@/lib/errors");

const TENANT = "10000000-0000-0000-0000-000000000001";
const endpoint = { url: "https://example.com/hook", events: ["lead.created"], secretHint: "a1b2", active: true, createdAt: "2026-10-15T08:00:00Z", lastSuccessAt: null, lastFailureAt: null, lastFailure: null };
const call = (i = 0) => {
  const [url, init] = fetchMock.mock.calls[i];
  return { url: String(url), method: init!.method, body: init!.body, headers: new Headers(init!.headers) };
};
const answer = (body: unknown, status = 200) => fetchMock.mockResolvedValue(status === 204 ? new Response(null, { status }) : Response.json(body, { status }));

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.pakkaagent.in");
  getSession.mockReset().mockResolvedValue({ data: { session: { access_token: "tok.en.sig" } } });
  fetchMock.mockReset();
});

describe("webhookService", () => {
  it("reads the settings with the member's token and the business", async () => {
    answer({ inPlan: true, sending: true, endpoint });
    const settings = await webhookService.load(TENANT);
    expect(settings.endpoint?.secretHint).toBe("a1b2");
    const c = call();
    expect(c.url).toBe("https://api.pakkaagent.in/api/integrations/webhook");
    expect(c.method).toBe("GET");
    expect(c.headers.get("authorization")).toBe("Bearer tok.en.sig");
    expect(c.headers.get("x-pakka-tenant")).toBe(TENANT);
  });

  it("reads a business with no endpoint and one off the plan", async () => {
    answer({ inPlan: false, sending: false, endpoint: null });
    await expect(webhookService.load(TENANT)).resolves.toEqual({ inPlan: false, sending: false, endpoint: null });
  });

  it("refuses an answer of another shape", async () => {
    answer({ inPlan: "yes" });
    await expect(webhookService.load(TENANT)).rejects.toBeInstanceOf(WebhookDataError);
  });

  it("saves with PUT, sending only url and events", async () => {
    answer({ endpoint, secret: "whsec_once" });
    const saved = await webhookService.save(TENANT, { url: "https://example.com/hook", events: ["lead.created"] });
    expect(saved.secret).toBe("whsec_once");
    const c = call();
    expect(c.method).toBe("PUT");
    expect(JSON.parse(String(c.body))).toEqual({ url: "https://example.com/hook", events: ["lead.created"] });
  });

  it("does not send a form with no events", async () => {
    await expect(webhookService.save(TENANT, { url: "https://example.com/hook", events: [] })).rejects.toBeInstanceOf(WebhookDataError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a change answers no secret", async () => {
    answer({ endpoint, secret: null });
    expect((await webhookService.save(TENANT, { url: "https://example.com/hook", events: ["lead.created"] })).secret).toBeNull();
  });

  it("deletes with DELETE and expects 204", async () => {
    answer(null, 204);
    await webhookService.remove(TENANT);
    expect(call().method).toBe("DELETE");
  });

  it("rotates and tests with POST and no body", async () => {
    answer({ secret: "whsec_new", secretHint: "zz99" });
    await expect(webhookService.rotate(TENANT)).resolves.toEqual({ secret: "whsec_new", secretHint: "zz99" });
    expect(call().url).toMatch(/\/api\/integrations\/webhook\/rotate-secret$/);
    expect(call().body).toBeUndefined();
    fetchMock.mockReset();
    answer({ delivered: false, status: 500, error: "http_500" });
    await expect(webhookService.test(TENANT)).resolves.toEqual({ delivered: false, status: 500, error: "http_500" });
    expect(call().url).toMatch(/\/api\/integrations\/webhook\/test$/);
  });

  it("passes the API's refusals through as ApiError", async () => {
    answer({ error: { code: "plan_required", message: "Outbound webhooks are part of the Pro plan." } }, 403);
    await expect(webhookService.test(TENANT)).rejects.toBeInstanceOf(ApiError);
    answer({ error: { code: "forbidden", message: "Only an owner or admin can do that." } }, 403);
    await expect(webhookService.load(TENANT)).rejects.toMatchObject({ status: 403 });
  });
});
