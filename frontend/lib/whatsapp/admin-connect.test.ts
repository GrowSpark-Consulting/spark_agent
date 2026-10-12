import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

const { buildAdminBody, EMPTY_ADMIN_FORM, fieldErrorsFrom, submitAdminConnect, validateAdminForm } = await import("./admin-connect");

const TENANT = "10000000-0000-0000-0000-000000000004";
const good = { ...EMPTY_ADMIN_FORM, tenantId: TENANT, wabaId: "102938475610", phoneNumberId: "109876543210987", token: "SECRET-TOKEN-VALUE", appSecret: "SECRET-APP-VALUE" };
const connection = (over: Record<string, unknown> = {}) => ({
  id: "30000000-0000-0000-0000-000000000001",
  tenant_id: TENANT,
  method: "manual_byo",
  waba_id: "102938475610",
  phone_number_id: "109876543210987",
  display_phone: "+91 98400 12345",
  verified_name: "Bright",
  coexistence: false,
  status: "active",
  last_check: {},
  quality_rating: null,
  messaging_limit: null,
  created_at: "2026-10-12T00:00:00Z",
  ...over,
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => apiFetch.mockReset());

describe("validateAdminForm", () => {
  it("accepts a complete form", () => expect(validateAdminForm(good)).toEqual({}));
  it("names every missing required field", () => {
    expect(Object.keys(validateAdminForm(EMPTY_ADMIN_FORM)).sort()).toEqual(["appSecret", "phoneNumberId", "tenantId", "token", "wabaId"]);
  });
  it("refuses a business id that is not a uuid and ids that are not digits", () => {
    const e = validateAdminForm({ ...good, tenantId: "acme", wabaId: "abc", phoneNumberId: "12 3" });
    expect(Object.keys(e).sort()).toEqual(["phoneNumberId", "tenantId", "wabaId"]);
  });
});

describe("buildAdminBody", () => {
  it("trims, and leaves out empty optional fields", () => {
    expect(buildAdminBody({ ...good, wabaId: " 102938475610 " })).toEqual({
      tenantId: TENANT, wabaId: "102938475610", phoneNumberId: "109876543210987", token: "SECRET-TOKEN-VALUE", tokenType: "system_user", appSecret: "SECRET-APP-VALUE",
    });
  });
  it("includes the optional fields when given", () => {
    expect(buildAdminBody({ ...good, displayPhone: "+91 98400 12345", clientBusinessId: "555" })).toMatchObject({ displayPhone: "+91 98400 12345", clientBusinessId: "555" });
  });
});

describe("submitAdminConnect", () => {
  it("posts once to the admin route with no business header", async () => {
    apiFetch.mockResolvedValue(json(201, connection()));
    await submitAdminConnect(good);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [path, init] = apiFetch.mock.calls[0];
    expect(path).toBe("/api/admin/whatsapp/manual");
    expect(init.method).toBe("POST");
    expect(init.tenantId).toBeUndefined();
    expect(init.body.tenantId).toBe(TENANT);
  });

  it("returns the connection as the server saved it, status and checks included", async () => {
    apiFetch.mockResolvedValue(json(201, connection({ status: "failed" })));
    const r = await submitAdminConnect(good);
    expect(r.state).toBe("done");
    if (r.state === "done") expect(r.connection.status).toBe("failed");
  });

  it("never carries the token or the secret into its result", async () => {
    apiFetch.mockResolvedValue(json(422, { error: { code: "validation_failed", message: "Check the fields.", fields: { wabaId: "Not found." } } }));
    const r = await submitAdminConnect(good);
    expect(JSON.stringify(r)).not.toMatch(/SECRET-/);
    expect(r).toMatchObject({ state: "rejected", fields: { wabaId: "Not found." } });
  });

  it("reports forbidden for a non-admin, and connected-nothing", async () => {
    apiFetch.mockResolvedValue(json(403, { error: { code: "forbidden", message: "Only the Spark Agent team can do this." } }));
    expect(await submitAdminConnect(good)).toMatchObject({ state: "rejected", code: "forbidden", message: "Only the Spark Agent team can do this." });
  });

  it("claims nothing when the answer is not a connection", async () => {
    apiFetch.mockResolvedValue(json(201, { ok: true }));
    expect(await submitAdminConnect(good)).toMatchObject({ state: "rejected" });
  });

  it("says Meta could not be reached, and that trying again can help", async () => {
    apiFetch.mockResolvedValue(json(502, { error: { code: "upstream_failed", message: "We couldn't reach Meta. Try again in a moment." } }));
    expect(await submitAdminConnect(good)).toMatchObject({ state: "rejected", code: "upstream_failed", retryable: true });
  });

  it("does not send an invalid form", async () => {
    expect(await submitAdminConnect({ ...good, tenantId: "x" })).toMatchObject({ state: "rejected" });
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe("fieldErrorsFrom", () => {
  it("keeps only this form's fields", () => expect(fieldErrorsFrom({ token: "bad", other: "x" })).toEqual({ token: "bad" }));
});
