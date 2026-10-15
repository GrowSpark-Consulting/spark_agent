import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/errors";

const getJson = vi.fn();
const postJson = vi.fn();
vi.mock("@/lib/api/client", () => ({
  getJson: (...args: unknown[]) => getJson(...args),
  postJson: (...args: unknown[]) => postJson(...args),
}));

const { acceptInvitation, acceptProblem, fetchInvite, InviteDataError, invitePath, isInviteToken, previewProblem, signInHref, signUpHref } = await import("./invite-api");

const TOKEN = "B".repeat(43);
const refusal = (status: number, code: string, message = "x") => new ApiError(status, { error: { code, message } } as never);

beforeEach(() => {
  getJson.mockReset();
  postJson.mockReset();
});

describe("isInviteToken", () => {
  it("accepts only 43 base64url characters", () => {
    expect(isInviteToken(TOKEN)).toBe(true);
    for (const bad of ["", "short", "B".repeat(42), "B".repeat(44), `${"B".repeat(42)}=`, `${"B".repeat(42)}/`, "../../etc/passwd".padEnd(43, "a")]) {
      expect(isInviteToken(bad), bad).toBe(false);
    }
  });
});

describe("fetchInvite", () => {
  it("reads the public route anonymously, so a signed-in visitor's token does not ride along", async () => {
    getJson.mockResolvedValueOnce({ status: "valid", businessName: "Salon One", role: "staff", expiresAt: "2026-10-22T10:00:00.000Z", email: "leak@example.com" });
    const preview = await fetchInvite(TOKEN);
    expect(getJson).toHaveBeenCalledWith(`/api/team/invites/${TOKEN}`, { signal: undefined, anonymous: true });
    expect(preview).toEqual({ status: "valid", businessName: "Salon One", role: "staff", expiresAt: "2026-10-22T10:00:00.000Z" });
  });

  it.each(["valid", "expired", "used", "revoked"])("understands the %s state", async (status) => {
    getJson.mockResolvedValueOnce({ status, businessName: "Salon One", role: "admin", expiresAt: "2026-10-22T10:00:00.000Z" });
    expect((await fetchInvite(TOKEN)).status).toBe(status);
  });

  it("refuses an answer of the wrong shape", async () => {
    for (const bad of [{}, null, { status: "weird", businessName: "X", role: "staff", expiresAt: "e" }, { status: "valid", businessName: "X", role: "owner", expiresAt: "e" }]) {
      getJson.mockResolvedValueOnce(bad);
      await expect(fetchInvite(TOKEN)).rejects.toBeInstanceOf(InviteDataError);
    }
  });
});

describe("acceptInvitation", () => {
  it("posts with no body and trusts only an answer naming the business", async () => {
    postJson.mockResolvedValueOnce({ tenantId: "t1", businessName: "Salon One", role: "staff", alreadyMember: false });
    await expect(acceptInvitation(TOKEN)).resolves.toEqual({ tenantId: "t1", businessName: "Salon One", role: "staff", alreadyMember: false });
    expect(postJson).toHaveBeenCalledWith(`/api/team/invites/${TOKEN}/accept`, undefined);
  });

  it("does not count anything else as joined", async () => {
    for (const bad of [{}, null, { tenantId: "t1" }, { ok: true }]) {
      postJson.mockResolvedValueOnce(bad);
      await expect(acceptInvitation(TOKEN)).rejects.toBeInstanceOf(InviteDataError);
    }
  });

  it("lets the server's refusal through unchanged", async () => {
    postJson.mockRejectedValueOnce(refusal(403, "forbidden"));
    await expect(acceptInvitation(TOKEN)).rejects.toBeInstanceOf(ApiError);
  });
});

describe("previewProblem", () => {
  it("maps the refusals the page words differently", () => {
    expect(previewProblem(refusal(404, "not_found"))).toBe("invalid");
    expect(previewProblem(refusal(429, "rate_limited"))).toBe("rate_limited");
    expect(previewProblem(refusal(500, "internal"))).toBe("failed");
    expect(previewProblem(new TypeError("fetch failed"))).toBe("failed");
  });
});

describe("acceptProblem", () => {
  it.each([
    [refusal(404, "not_found"), "invalid"],
    [refusal(403, "forbidden", "This invitation was sent to a different email address. Sign in with the address it was sent to."), "wrong_email"],
    [refusal(403, "forbidden", "Confirm your email address first, then open the invitation again."), "unconfirmed"],
    [refusal(409, "seat_limit"), "seat_limit"],
    [refusal(429, "rate_limited"), "rate_limited"],
    [refusal(401, "unauthenticated"), "signed_out"],
    [refusal(502, "upstream_failed"), "failed"],
    [new Error("boom"), "failed"],
  ])("%#", (err, expected) => {
    expect(acceptProblem(err)).toBe(expected);
  });
});

describe("sign-in links", () => {
  it("send the person back to the invitation, encoded", () => {
    expect(invitePath(TOKEN)).toBe(`/invite/${TOKEN}`);
    expect(signInHref(TOKEN)).toBe(`/login?next=${encodeURIComponent(`/invite/${TOKEN}`)}`);
    expect(signUpHref(TOKEN)).toBe(`/signup?next=${encodeURIComponent(`/invite/${TOKEN}`)}`);
  });
});
