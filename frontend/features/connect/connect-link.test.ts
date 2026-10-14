import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/errors";

const getJson = vi.fn();
const postJson = vi.fn();
vi.mock("@/lib/api/client", () => ({
  getJson: (...args: unknown[]) => getJson(...args),
  postJson: (...args: unknown[]) => postJson(...args),
}));

const { ConnectDataError, connectionOutcome, fetchConnectLink, isLinkToken, linkProblem, sendSignup, submitEmbeddedSignup, submitFields, submitProblem } = await import("./connect-link");

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
    expect(submitProblem(refusal(429, "rate_limited"))).toBe("rate_limited");
    expect(submitProblem(refusal(422, "validation_failed"))).toBe("validation");
    expect(submitProblem(refusal(500, "internal"))).toBe("failed");
    expect(submitProblem(new Error("boom"))).toBe("failed");
  });
});

const refusalWith = (status: number, code: string, fields?: Record<string, string>) => new ApiError(status, { error: { code, message: "x", ...(fields && { fields }) } } as never);

describe("submitFields", () => {
  it("returns the per-field messages of a validation_failed answer, for example when Meta returned no number", () => {
    expect(submitFields(refusalWith(422, "validation_failed", { phoneNumberId: "Pick or add a phone number in the Facebook sign-in, then try again." }))).toEqual({
      phoneNumberId: "Pick or add a phone number in the Facebook sign-in, then try again.",
    });
  });
  it("returns nothing for other errors, and drops a field message that looks like a credential", () => {
    expect(submitFields(refusalWith(409, "conflict", { phoneNumberId: "taken" }))).toEqual({});
    expect(submitFields(new Error("boom"))).toEqual({});
    expect(submitFields(refusalWith(422, "validation_failed", { code: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop", wabaId: "Not in this account." }))).toEqual({ wabaId: "Not in this account." });
  });
});

describe("connectionOutcome", () => {
  it("is connected only for an active connection", () => {
    expect(connectionOutcome("active")).toBe("connected");
    expect(connectionOutcome("pending")).toBe("checking");
    expect(connectionOutcome("validating")).toBe("checking");
    expect(connectionOutcome("failed")).toBe("check_failed");
    expect(connectionOutcome("disconnected")).toBe("check_failed");
    expect(connectionOutcome("something-new")).toBe("check_failed");
  });
});

describe("sendSignup", () => {
  const payload = { code: "meta-code", wabaId: "123", phoneNumberId: "456", coexistence: false };

  it("is connected only when the server says the connection is active", async () => {
    postJson.mockResolvedValueOnce({ id: "c1", status: "active" });
    expect(await sendSignup(TOKEN, payload)).toEqual({ kind: "connected" });
  });
  it("does not claim a connection that is still being checked or that failed its checks", async () => {
    postJson.mockResolvedValueOnce({ id: "c1", status: "validating" });
    expect(await sendSignup(TOKEN, payload)).toEqual({ kind: "checking" });
    postJson.mockResolvedValueOnce({ id: "c1", status: "failed" });
    expect(await sendSignup(TOKEN, payload)).toEqual({ kind: "failed", problem: "check_failed", fields: {} });
  });
  it("makes a 404 the end of the link and every other refusal a retry with the same link", async () => {
    postJson.mockRejectedValueOnce(refusalWith(404, "not_found"));
    expect(await sendSignup(TOKEN, payload)).toEqual({ kind: "invalid" });
    postJson.mockRejectedValueOnce(refusalWith(429, "rate_limited"));
    expect(await sendSignup(TOKEN, payload)).toEqual({ kind: "failed", problem: "rate_limited", fields: {} });
    postJson.mockRejectedValueOnce(refusalWith(501, "not_available"));
    expect(await sendSignup(TOKEN, payload)).toMatchObject({ kind: "failed", problem: "not_available" });
    postJson.mockRejectedValueOnce(refusalWith(409, "conflict", { phoneNumberId: "This phone number is already connected." }));
    expect(await sendSignup(TOKEN, payload)).toMatchObject({ kind: "failed", problem: "conflict" });
    postJson.mockRejectedValueOnce(refusalWith(502, "upstream_failed"));
    expect(await sendSignup(TOKEN, payload)).toMatchObject({ kind: "failed", problem: "meta_failed" });
    postJson.mockRejectedValueOnce(refusalWith(422, "validation_failed", { phoneNumberId: "Pick a number." }));
    expect(await sendSignup(TOKEN, payload)).toEqual({ kind: "failed", problem: "validation", fields: { phoneNumberId: "Pick a number." } });
  });
  it("treats an unreadable 2xx answer as a failure, not a connection", async () => {
    postJson.mockResolvedValueOnce({ ok: true });
    expect(await sendSignup(TOKEN, payload)).toMatchObject({ kind: "failed", problem: "failed" });
  });
  it("sends the same link token on every attempt", async () => {
    postJson.mockRejectedValueOnce(refusalWith(502, "upstream_failed")).mockResolvedValueOnce({ id: "c1", status: "active" });
    await sendSignup(TOKEN, payload);
    await sendSignup(TOKEN, payload);
    expect(postJson.mock.calls.map((c) => (c[1] as { connectToken: string }).connectToken)).toEqual([TOKEN, TOKEN]);
  });
});
