import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

const { checkLines, loadWebhookConfig, resolveWhatsAppTenant, submitManualConnect } = await import("./manual-connect");

const TENANT_A = "a0000000-0000-4000-8000-00000000000a";
const TENANT_B = "b0000000-0000-4000-8000-00000000000b";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const apiError = (status: number, code: string, message: string, fields?: Record<string, string>) => json(status, { error: { code, message, ...(fields && { fields }) } });

const CONFIG = { webhookUrl: "https://api.example.test/api/webhooks/whatsapp", verifyToken: "tenant-token", partnerBusinessId: null };
const CONNECTION = {
  id: "c0000000-0000-4000-8000-0000000000c1", tenant_id: "a0000000-0000-4000-8000-00000000000a", method: "manual_byo", waba_id: "100000000000001",
  phone_number_id: "200000000000001", display_phone: "+91 98765 43210", verified_name: null, coexistence: false, status: "active",
  last_check: {}, quality_rating: null, messaging_limit: null, created_at: "2026-10-09T00:00:00Z",
};
const FORM = { wabaId: " 100000000000001 ", phoneNumberId: "200000000000001", tokenType: "system_user" as const, token: " EAAB-token ", appSecret: "secret-value" };

beforeEach(() => {
  apiFetch.mockReset();
});

describe("loadWebhookConfig", () => {
  it("returns the webhook details the API sends", async () => {
    apiFetch.mockResolvedValue(json(200, CONFIG));
    expect(await loadWebhookConfig(TENANT_A)).toEqual({ state: "ready", config: CONFIG });
    expect(apiFetch).toHaveBeenCalledWith("/api/whatsapp/webhook-config", expect.objectContaining({ method: "GET", tenantId: TENANT_A }));
  });

  it("reports missing configuration (not_available) without offering a retry", async () => {
    apiFetch.mockResolvedValue(apiError(501, "not_available", "The webhook address isn't configured yet."));
    expect(await loadWebhookConfig(TENANT_A)).toEqual({ state: "not_available", message: "The webhook address isn't configured yet." });
  });

  it("reports a backend failure as a retryable error", async () => {
    apiFetch.mockResolvedValue(apiError(502, "upstream_failed", "Try again in a moment."));
    expect(await loadWebhookConfig(TENANT_A)).toMatchObject({ state: "error", retryable: true });
  });

  it("reports a refusal (staff) as an error that is not retryable", async () => {
    apiFetch.mockResolvedValue(apiError(403, "forbidden", "Only an owner or admin can see the webhook details."));
    expect(await loadWebhookConfig(TENANT_A)).toMatchObject({ state: "error", retryable: false });
  });

  it("never shows half a value when the answer has the wrong shape", async () => {
    apiFetch.mockResolvedValue(json(200, { webhookUrl: "not a url" }));
    expect(await loadWebhookConfig(TENANT_A)).toMatchObject({ state: "error" });
  });

  it("turns a network failure into an error", async () => {
    apiFetch.mockImplementation(() => {
      throw new TypeError("fetch failed");
    });
    expect(await loadWebhookConfig(TENANT_A)).toMatchObject({ state: "error", retryable: true });
  });
});

describe("submitManualConnect", () => {
  it("posts the trimmed details once, names the business only in the header, and returns the API's connection", async () => {
    apiFetch.mockResolvedValue(json(201, CONNECTION));
    const result = await submitManualConnect(FORM, TENANT_A);
    expect(result).toMatchObject({ state: "done", connection: { status: "active" } });
    const [path, init] = apiFetch.mock.calls[0];
    expect(path).toBe("/api/whatsapp/manual");
    expect(init.tenantId).toBe(TENANT_A);
    expect(init.body).toEqual({ wabaId: "100000000000001", phoneNumberId: "200000000000001", tokenType: "system_user", token: "EAAB-token", appSecret: "secret-value" });
  });

  it("returns the field messages from a validation error", async () => {
    apiFetch.mockResolvedValue(apiError(422, "validation_failed", "Some details need fixing.", { wabaId: "Digits only." }));
    expect(await submitManualConnect(FORM, TENANT_A)).toEqual({ state: "rejected", message: "Some details need fixing.", fields: { wabaId: "Digits only." } });
  });

  it.each([
    [409, "conflict", "This phone number is already connected."],
    [502, "upstream_failed", "We couldn't reach Meta to check these details. Try again in a moment."],
    [403, "forbidden", "Only an owner or admin can connect WhatsApp."],
  ])("shows a %s %s answer as a rejection", async (status, code, message) => {
    apiFetch.mockResolvedValue(apiError(status, code, message));
    expect(await submitManualConnect(FORM, TENANT_A)).toMatchObject({ state: "rejected", message });
  });

  it("does not claim a connection when the 2xx answer isn't a valid connection", async () => {
    apiFetch.mockResolvedValue(json(201, { ok: true }));
    expect(await submitManualConnect(FORM, TENANT_A)).toMatchObject({ state: "rejected" });
  });

  it("returns a failed connection as done, so the screen shows the API's failed state and checks", async () => {
    apiFetch.mockResolvedValue(json(201, { ...CONNECTION, status: "failed" }));
    expect(await submitManualConnect(FORM, TENANT_A)).toMatchObject({ state: "done", connection: { status: "failed" } });
  });

  it("never puts the secrets into an error message", async () => {
    apiFetch.mockImplementation(() => {
      throw new TypeError("fetch failed: EAAB-token secret-value");
    });
    const result = await submitManualConnect(FORM, TENANT_A);
    expect(JSON.stringify(result)).not.toContain("EAAB-token");
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });
});

describe("the business every WhatsApp call names (X-Pakka-Tenant)", () => {
  it("sends the business it was given on both calls, and never puts it in the body", async () => {
    apiFetch.mockResolvedValueOnce(json(200, CONFIG)).mockResolvedValueOnce(json(201, CONNECTION));
    await loadWebhookConfig(TENANT_B);
    await submitManualConnect(FORM, TENANT_B);
    expect(apiFetch.mock.calls.map(([, init]) => init.tenantId)).toEqual([TENANT_B, TENANT_B]);
    expect(JSON.stringify(apiFetch.mock.calls[1][1].body)).not.toContain(TENANT_B);
  });

  it("follows a change of business: the next call names the new one, not the last", async () => {
    apiFetch.mockResolvedValue(json(200, CONFIG));
    await loadWebhookConfig(TENANT_A);
    await loadWebhookConfig(TENANT_B);
    expect(apiFetch.mock.calls.map(([, init]) => init.tenantId)).toEqual([TENANT_A, TENANT_B]);
  });

  it.each([["an empty id", ""], ["undefined", undefined], ["null", null], ["a word", "undefined"], ["an id with a path", "../../x"]])(
    "sends no request at all for %s",
    async (_name, bad) => {
      const config = await loadWebhookConfig(bad as unknown as string);
      const connect = await submitManualConnect(FORM, bad as unknown as string);
      expect(config).toMatchObject({ state: "error", retryable: false });
      expect(connect).toMatchObject({ state: "rejected", fields: {} });
      expect(apiFetch).not.toHaveBeenCalled();
    },
  );

  it("keeps the signed-out and refused answers the API gives, without retrying them", async () => {
    apiFetch.mockImplementation(async () => apiError(401, "unauthenticated", "Your session has ended. Sign in again."));
    expect(await loadWebhookConfig(TENANT_A)).toEqual({ state: "error", message: "Your session has ended. Sign in again.", retryable: false });
    expect(await submitManualConnect(FORM, TENANT_A)).toMatchObject({ state: "rejected", message: "Your session has ended. Sign in again." });
    apiFetch.mockImplementation(async () => apiError(403, "forbidden", "Choose a business first."));
    expect(await loadWebhookConfig(TENANT_A)).toEqual({ state: "error", message: "Choose a business first.", retryable: false });
    expect(await submitManualConnect(FORM, TENANT_A)).toMatchObject({ state: "rejected", message: "Choose a business first." });
  });
});

describe("resolveWhatsAppTenant", () => {
  const ok = { status: "ok" as const, tenantId: TENANT_A, role: "owner" as const };

  it("returns the business the shared resolver found", async () => {
    expect(await resolveWhatsAppTenant(async () => ok)).toEqual({ state: "ready", tenantId: TENANT_A });
  });

  it("asks again every time instead of remembering the last answer", async () => {
    const resolve = vi.fn().mockResolvedValueOnce(ok).mockResolvedValueOnce({ ...ok, tenantId: TENANT_B });
    expect(await resolveWhatsAppTenant(resolve)).toEqual({ state: "ready", tenantId: TENANT_A });
    expect(await resolveWhatsAppTenant(resolve)).toEqual({ state: "ready", tenantId: TENANT_B });
  });

  it.each([
    ["signed_out", /session has ended/i, false],
    ["no_business", /business details first/i, false],
    ["error", /couldn't load your business/i, true],
  ] as const)("says why there is no business when the account is %s, and sends nothing", async (status, message, retryable) => {
    const result = await resolveWhatsAppTenant(async () => ({ status }));
    expect(result).toMatchObject({ state: "error", retryable });
    expect(result).toMatchObject({ message: expect.stringMatching(message) });
  });

  it("will not guess between several businesses, and points to the dashboard's own chooser", async () => {
    const result = await resolveWhatsAppTenant(async () => ({ status: "choose", businesses: [{ tenantId: TENANT_A, name: "A" }, { tenantId: TENANT_B, name: "B" }] }));
    expect(result).toMatchObject({ state: "error", retryable: false, message: expect.stringMatching(/more than one business.*dashboard/i) });
    expect(JSON.stringify(result)).not.toContain(TENANT_A);
  });

  it("refuses a business id that is not an id", async () => {
    expect(await resolveWhatsAppTenant(async () => ({ ...ok, tenantId: "" }))).toMatchObject({ state: "error", retryable: false });
  });
});

describe("checkLines", () => {
  it("reads the structured checks, and shows none for an unchecked connection", () => {
    expect(checkLines({})).toEqual([]);
    expect(checkLines({ checks: [{ key: "token_permissions", status: "pass", message: "ok", checked_at: "x" }] })).toEqual([{ key: "token_permissions", status: "pass", message: "ok" }]);
  });
});
