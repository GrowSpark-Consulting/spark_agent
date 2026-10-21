import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/errors";

const getJson = vi.fn();
const postJson = vi.fn();
const sendNoContent = vi.fn();
vi.mock("@/lib/api/client", () => ({
  getJson: (...args: unknown[]) => getJson(...args),
  postJson: (...args: unknown[]) => postJson(...args),
  sendNoContent: (...args: unknown[]) => sendNoContent(...args),
}));

const { cancelInvite, copyText, describeInviteError, expiryLabel, fetchTeam, resendInvite, seatSummary, sendInvite, TeamDataError, validateInvite } = await import("./team-api");

const T = "11111111-1111-4111-8111-111111111111";
const INVITE = { id: "i1", email: "asha@example.com", name: "Asha", role: "staff", createdAt: "2026-10-15T10:00:00.000Z", expiresAt: "2026-10-22T10:00:00.000Z", expired: false };
const refusal = (status: number, code: string, message = "Server words.", fields?: Record<string, string>) =>
  new ApiError(status, { error: { code, message, ...(fields && { fields }) } } as never);

beforeEach(() => {
  getJson.mockReset();
  postJson.mockReset();
  sendNoContent.mockReset();
});

describe("calls", () => {
  it("reads the team for the business, with the business header", async () => {
    getJson.mockResolvedValueOnce({
      viewerRole: "owner", inviteRoles: ["admin", "staff"], seats: { used: 2, members: 1, pending: 1, limit: 5, planName: "Growth" },
      members: [{ userId: "u1", role: "owner", name: null, email: "o@example.com", you: true }], invites: [INVITE],
    });
    expect((await fetchTeam(T)).invites).toHaveLength(1);
    expect(getJson).toHaveBeenCalledWith("/api/team", { tenantId: T, signal: undefined });
  });

  it("refuses a team answer of the wrong shape", async () => {
    getJson.mockResolvedValueOnce({ members: "none" });
    await expect(fetchTeam(T)).rejects.toBeInstanceOf(TeamDataError);
  });

  it("sends the invitation and returns the link from that answer", async () => {
    postJson.mockResolvedValueOnce({ invite: INVITE, url: "https://app.example.com/invite/abc" });
    const created = await sendInvite(T, { name: "Asha", email: "asha@example.com", role: "staff" });
    expect(created.url).toBe("https://app.example.com/invite/abc");
    expect(postJson).toHaveBeenCalledWith("/api/team/invite", { name: "Asha", email: "asha@example.com", role: "staff" }, { tenantId: T });
  });

  it("does not take an invitation answer without a link", async () => {
    postJson.mockResolvedValueOnce({ invite: INVITE });
    await expect(sendInvite(T, { name: "Asha", email: "asha@example.com", role: "staff" })).rejects.toBeInstanceOf(TeamDataError);
  });

  it("resends with no body and returns the new link and what is left", async () => {
    postJson.mockResolvedValueOnce({ invite: INVITE, url: "https://app.example.com/invite/new", resendsLeft: 3 });
    await expect(resendInvite(T, "i1")).resolves.toMatchObject({ resendsLeft: 3 });
    expect(postJson).toHaveBeenCalledWith("/api/team/invites/i1/resend", undefined, { tenantId: T });
  });

  it("cancels with a POST that answers no content", async () => {
    sendNoContent.mockResolvedValueOnce(undefined);
    await cancelInvite(T, "i1");
    expect(sendNoContent).toHaveBeenCalledWith("/api/team/invites/i1/cancel", "POST", { tenantId: T });
  });
});

describe("validateInvite", () => {
  it("trims and lower-cases like the server", () => {
    expect(validateInvite({ name: "  Asha ", email: " Asha@Example.COM ", role: "staff" })).toEqual({ ok: true, value: { name: "Asha", email: "asha@example.com", role: "staff" } });
  });

  it("names each field that is wrong", () => {
    const result = validateInvite({ name: " ", email: "nope", role: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.fields).sort()).toEqual(["email", "name", "role"]);
  });

  it("never accepts owner", () => {
    expect(validateInvite({ name: "A", email: "a@example.com", role: "owner" }).ok).toBe(false);
  });
});

describe("describeInviteError", () => {
  it("tells a full team to cancel an invitation or upgrade", () => {
    const p = describeInviteError(refusal(409, "seat_limit", "Every team seat on your plan is taken."), "invite");
    expect(p.kind).toBe("seat_limit");
    expect(p.message).toMatch(/cancel one, or upgrade/);
  });

  it("keeps the server's field on a duplicate", () => {
    const p = describeInviteError(refusal(409, "conflict", "That person is already on your team.", { email: "That person is already on your team." }), "invite");
    expect(p).toMatchObject({ kind: "duplicate", fields: { email: "That person is already on your team." } });
  });

  it("maps permission, validation, the resend limit and a vanished invitation", () => {
    expect(describeInviteError(refusal(403, "forbidden"), "invite").kind).toBe("forbidden");
    expect(describeInviteError(refusal(422, "validation_failed", "Check.", { name: "Enter their name." }), "invite")).toMatchObject({ kind: "validation", fields: { name: "Enter their name." } });
    expect(describeInviteError(refusal(429, "rate_limited"), "resend")).toMatchObject({ kind: "rate_limited", title: "Sent again too many times" });
    expect(describeInviteError(refusal(404, "not_found"), "cancel").kind).toBe("gone");
  });

  it("does not show a raw error", () => {
    const p = describeInviteError(new Error("relation team_invites does not exist"), "invite");
    expect(p.kind).toBe("other");
    expect(p.message).not.toContain("team_invites");
  });
});

describe("copyText", () => {
  it("copies and says so", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    expect(await copyText("https://x", { writeText })).toBe(true);
    expect(writeText).toHaveBeenCalledWith("https://x");
  });

  it("says false when the browser refuses or there is no clipboard", async () => {
    expect(await copyText("x", { writeText: vi.fn().mockRejectedValue(new Error("denied")) })).toBe(false);
    expect(await copyText("x", undefined)).toBe(false);
  });
});

describe("labels", () => {
  it("says when an invitation ends", () => {
    expect(expiryLabel({ expiresAt: "2026-10-22T10:00:00.000Z", expired: false })).toMatch(/^Expires 22 Oct/);
    expect(expiryLabel({ expiresAt: "2026-10-14T10:00:00.000Z", expired: true })).toMatch(/^Expired 14 Oct/);
  });

  it("counts invited people in the seats", () => {
    expect(seatSummary({ used: 3, members: 2, pending: 1, limit: 5, planName: "Growth" })).toBe("3 of 5 seats used (2 members, 1 invited)");
    expect(seatSummary({ used: 1, members: 1, pending: 0, limit: "unlimited", planName: "Pro" })).toBe("1 of unlimited seats used (1 member)");
  });
});
