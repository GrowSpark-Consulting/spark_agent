import { describe, expect, it } from "vitest";
import { INVITE_RESENDS_PER_DAY, INVITE_VALID_DAYS, InviteAccepted, InvitePreview, InviteTeamMember, invitableRoles, TeamOverview } from "./team";

describe("invitableRoles", () => {
  it("lets an owner invite admins and staff, an admin staff only, and staff no one", () => {
    expect(invitableRoles("owner")).toEqual(["admin", "staff"]);
    expect(invitableRoles("admin")).toEqual(["staff"]);
    expect(invitableRoles("staff")).toEqual([]);
  });

  it("never offers owner", () => {
    for (const role of ["owner", "admin", "staff"] as const) expect(invitableRoles(role)).not.toContain("owner");
  });
});

describe("InviteTeamMember", () => {
  it("trims the name and trims and lower-cases the email", () => {
    expect(InviteTeamMember.parse({ name: "  Asha ", email: "  Asha@Example.COM ", role: "staff" })).toEqual({ name: "Asha", email: "asha@example.com", role: "staff" });
  });

  it.each([
    [{ name: "", email: "a@example.com", role: "staff" }, "name"],
    [{ name: "x".repeat(81), email: "a@example.com", role: "staff" }, "name"],
    [{ name: "A", email: "", role: "staff" }, "email"],
    [{ name: "A", email: "no-at-sign", role: "staff" }, "email"],
    [{ name: "A", email: "a@b", role: "staff" }, "email"],
    [{ name: "A", email: `${"a".repeat(250)}@example.com`, role: "staff" }, "email"],
    [{ name: "A", email: "a@example.com", role: "owner" }, "role"],
    [{ name: "A", email: "a@example.com" }, "role"],
  ])("refuses %j on %s", (input, field) => {
    const result = InviteTeamMember.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((i) => i.path[0])).toContain(field);
  });
});

describe("answers", () => {
  it("the public preview carries no email", () => {
    const parsed = InvitePreview.parse({ status: "valid", businessName: "Salon", role: "staff", expiresAt: "e", email: "leak@example.com" });
    expect(parsed).not.toHaveProperty("email");
  });

  it("the team overview has no link or token field", () => {
    const parsed = TeamOverview.parse({
      viewerRole: "owner", inviteRoles: ["staff"], seats: { used: 1, members: 1, pending: 0, limit: "unlimited", planName: "Pro" },
      members: [], invites: [{ id: "i", email: "a@b.co", name: "A", role: "staff", createdAt: "c", expiresAt: "e", expired: false, url: "https://x/invite/t", token: "t" }],
    });
    expect(parsed.invites[0]).not.toHaveProperty("url");
    expect(parsed.invites[0]).not.toHaveProperty("token");
  });

  it("accepting names the business and the role", () => {
    expect(InviteAccepted.parse({ tenantId: "t", businessName: "Salon", role: "staff", alreadyMember: false }).role).toBe("staff");
    expect(InviteAccepted.safeParse({ tenantId: "t" }).success).toBe(false);
  });

  it("states the approved limits", () => {
    expect(INVITE_VALID_DAYS).toBe(7);
    expect(INVITE_RESENDS_PER_DAY).toBe(5);
  });
});
