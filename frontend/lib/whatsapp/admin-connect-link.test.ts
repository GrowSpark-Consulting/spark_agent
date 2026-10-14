import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

const { createConnectLink, expiryLabel, validateLinkTenant } = await import("./admin-connect-link");

const TENANT = "10000000-0000-0000-0000-000000000004";
const TOKEN = "A".repeat(43);
const URL_OK = `https://app.example.com/connect/${TOKEN}`;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => { apiFetch.mockReset(); });

describe("validateLinkTenant", () => {
  it("accepts a uuid, with spaces around it", () => expect(validateLinkTenant(` ${TENANT} `)).toBeNull());
  it("asks for an id, and refuses one that is not a uuid", () => {
    expect(validateLinkTenant("  ")).toMatch(/Enter/);
    expect(validateLinkTenant("acme")).toMatch(/isn't a business ID/);
  });
});

describe("createConnectLink", () => {
  it("posts { tenantId } once, with no business header, and returns the link", async () => {
    apiFetch.mockResolvedValue(json(201, { url: URL_OK, expiresAt: "2026-10-15T10:00:00.000Z" }));
    const r = await createConnectLink(` ${TENANT} `);
    expect(r).toEqual({ state: "done", url: URL_OK, expiresAt: "2026-10-15T10:00:00.000Z" });
    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [path, init] = apiFetch.mock.calls[0];
    expect(path).toBe("/api/admin/whatsapp/connect-link");
    expect(init.method).toBe("POST");
    expect(init.tenantId).toBeUndefined();
    expect(init.body).toEqual({ tenantId: TENANT });
  });

  it("sends nothing for an invalid business id", async () => {
    const r = await createConnectLink("nope");
    expect(r).toMatchObject({ state: "rejected", code: "validation_failed", fields: { tenantId: expect.any(String) } });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it.each([
    [501, "not_available", /switched on yet/],
    [404, "not_found", /couldn't find that business/],
    [403, "forbidden", /Only the Spark Agent team/],
  ])("%i %s gets a truthful refusal and no link", async (status, code, message) => {
    apiFetch.mockResolvedValue(json(status, { error: { code, message: "server words" } }));
    const r = await createConnectLink(TENANT);
    expect(r).toMatchObject({ state: "rejected", code });
    expect(r.state === "rejected" && r.message).toMatch(message);
  });

  it("passes the server's field messages through for validation_failed", async () => {
    apiFetch.mockResolvedValue(json(422, { error: { code: "validation_failed", message: "Some details need fixing.", fields: { tenantId: "Name the business." } } }));
    expect(await createConnectLink(TENANT)).toMatchObject({ state: "rejected", fields: { tenantId: "Name the business." } });
  });

  it("refuses an answer that is not a connect link, and says a link may exist", async () => {
    for (const body of [{}, { url: "https://x.example.com/other", expiresAt: "2026-10-15T10:00:00.000Z" }, { url: URL_OK, expiresAt: "soon" }, { url: "javascript:alert(1)", expiresAt: "2026-10-15T10:00:00.000Z" }]) {
      apiFetch.mockResolvedValueOnce(json(201, body));
      const r = await createConnectLink(TENANT);
      expect(r).toMatchObject({ state: "rejected", retryable: false });
      expect(r.state === "rejected" && r.message).toMatch(/may have been made/);
    }
  });

  it("reports a network failure as retryable and never retries by itself", async () => {
    let calls = 0;
    apiFetch.mockImplementation(async () => {
      calls += 1;
      throw new TypeError("Failed to fetch");
    });
    const r = await createConnectLink(TENANT);
    expect(r.state).toBe("rejected");
    expect(r.state === "rejected" && r.code).toBe("network");
    expect(r.state === "rejected" && r.retryable).toBe(true);
    expect(calls).toBe(1);
  });
});

describe("expiryLabel", () => {
  it("says a past link has expired", () => expect(expiryLabel("2026-10-14T10:00:00.000Z", new Date("2026-10-15T00:00:00Z"))).toMatch(/expired/));
  it("says when a live one ends and that it works once", () => expect(expiryLabel("2026-10-15T10:00:00.000Z", new Date("2026-10-14T00:00:00Z"))).toMatch(/^Valid until .* It works once\.$/));
});
