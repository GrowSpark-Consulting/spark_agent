import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/errors";

const getJson = vi.fn();
const postJson = vi.fn();
vi.mock("@/lib/api/client", () => ({
  getJson: (...args: unknown[]) => getJson(...args),
  postJson: (...args: unknown[]) => postJson(...args),
}));

const { ConnectDataError, fetchConnectLink, isLinkToken, linkProblem, submitEmbeddedSignup, submitProblem } = await import("./connect-link");

const TOKEN = "A".repeat(43);
const refusal = (status: number, code: string) => new ApiError(status, { error: { code, message: "x" } } as never);

beforeEach(() => {
  getJson.mockReset();
  postJson.mockReset();
});

describe("isLinkToken", () => {
  it("accepts only the shape of a link token (43 base64url characters)", () => {
    expect(isLinkToken(TOKEN)).toBe(true);
    expect(isLinkToken("abc_DEF-123".padEnd(43, "x"))).toBe(true);
    for (const bad of ["", "short", "A".repeat(42), "A".repeat(44), `${"A".repeat(42)}=`, `${"A".repeat(42)}/`, "../../etc/passwd".padEnd(43, "a")]) {
      expect(isLinkToken(bad), bad).toBe(false);
    }
  });
});

describe("fetchConnectLink", () => {
  it("reads who the link is for from the public route, without a business header", async () => {
    getJson.mockResolvedValueOnce({ tenantName: "Sunrise Homes", expiresAt: "2026-10-14T10:00:00.000Z" });
    expect(await fetchConnectLink(TOKEN)).toEqual({ tenantName: "Sunrise Homes", expiresAt: "2026-10-14T10:00:00.000Z" });
    expect(getJson).toHaveBeenCalledWith(`/api/connect-links/${TOKEN}`, { signal: undefined, anonymous: true });
  });

  it("refuses an answer that is not { tenantName, expiresAt }", async () => {
    for (const bad of [{}, { tenantName: "", expiresAt: "2026-10-14T10:00:00.000Z" }, { tenantName: "X", expiresAt: "soon" }, null]) {
      getJson.mockResolvedValueOnce(bad);
      await expect(fetchConnectLink(TOKEN)).rejects.toBeInstanceOf(ConnectDataError);
    }
  });
});

describe("submitEmbeddedSignup", () => {
  const payload = { code: "meta-code", wabaId: "123", phoneNumberId: "456", coexistence: false };

  it("sends the exchange body with the link's token and no business header, and trusts only a connection answer", async () => {
    postJson.mockResolvedValueOnce({ id: "c1", status: "active", extra: "ignored" });
    expect(await submitEmbeddedSignup(TOKEN, payload)).toEqual({ id: "c1", status: "active" });
    expect(postJson).toHaveBeenCalledWith("/api/onboarding/whatsapp/embedded-signup", { ...payload, connectToken: TOKEN }, { anonymous: true });
  });

  it("does not treat an empty or odd 2xx answer as a connection", async () => {
    for (const bad of [{}, { ok: true }, null, "created"]) {
      postJson.mockResolvedValueOnce(bad);
      await expect(submitEmbeddedSignup(TOKEN, payload)).rejects.toBeInstanceOf(ConnectDataError);
    }
  });
});

describe("what a refusal means", () => {
  it("link reads: invalid for any 404, switched off for 501, rate limited for 429, otherwise a failure to retry", () => {
    expect(linkProblem(refusal(404, "not_found"))).toBe("invalid");
    expect(linkProblem(refusal(501, "not_available"))).toBe("not_available");
    expect(linkProblem(refusal(429, "rate_limited"))).toBe("rate_limited");
    expect(linkProblem(refusal(500, "internal"))).toBe("failed");
    expect(linkProblem(new TypeError("Failed to fetch"))).toBe("failed");
    expect(linkProblem(new ConnectDataError("connect link"))).toBe("failed");
  });

  it("exchange: each documented error gets its own words", () => {
    expect(submitProblem(refusal(404, "not_found"))).toBe("invalid");
    expect(submitProblem(refusal(409, "conflict"))).toBe("conflict");
    expect(submitProblem(refusal(501, "not_available"))).toBe("not_available");
    expect(submitProblem(refusal(502, "upstream_failed"))).toBe("meta_failed");
    expect(submitProblem(refusal(422, "validation_failed"))).toBe("failed");
    expect(submitProblem(new Error("boom"))).toBe("failed");
  });
});
