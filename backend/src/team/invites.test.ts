import { createHash } from "node:crypto";
import type { InviteRole, Role, TenantContext } from "@pakka/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter } from "../channels/whatsapp/connect/connect-link-rate-limit";
import { hashConnectLinkToken, newConnectLinkToken } from "../lib/connect-link-token";
import { AppError, toErrorResponse } from "../lib/errors";
import { acceptInvite, cancelInvite, inviteDbError, inviteMember, previewInvite, resendInvite, teamDb, teamOverview, type InviteRecord, type InviteRow, type TeamDb, type TeamDeps } from "./invites";

// Everything here runs against a fake TeamDb (the unit tests) or a fake Supabase client (teamDb's mapping of the database's refusals). The
// database's own guarantees (locks, seats, RLS) are proved by supabase/tests/team_invites.test.sql and scripts/db/team-invite-concurrency.sh,
// which need Docker.

const rpc = vi.hoisted(() => vi.fn());
vi.mock("../lib/supabase-admin", () => ({ supabaseAdmin: () => ({ rpc }) }));

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const INVITE_ID = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-10-15T10:00:00.000Z");

const context = (role: Role): TenantContext => ({
  user: { id: USER, email: "me@example.com" },
  role,
  tenant: { id: TENANT, name: "Salon One", vertical: "salon", timezone: "Asia/Kolkata", status: "active", planKey: "growth", trialEndsAt: null },
});

const record = (over: Partial<InviteRecord> = {}): InviteRecord => ({
  id: INVITE_ID, email: "asha@example.com", name: "Asha", role: "staff", createdAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 7 * 86_400_000).toISOString(), ...over,
});

function fakeDb(over: Partial<TeamDb> = {}): TeamDb & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {};
  const track = <A, R>(name: string, fn: (a: A) => Promise<R>) => (a: A) => {
    (calls[name] ??= []).push(a);
    return fn(a);
  };
  const db: TeamDb = {
    createInvite: track("createInvite", async (a: Parameters<TeamDb["createInvite"]>[0]) => record({ email: a.email, name: a.name, role: a.role })),
    resendInvite: track("resendInvite", async () => ({ ...record(), resendsLeft: 4 })),
    cancelInvite: track("cancelInvite", async () => undefined),
    acceptInvite: track("acceptInvite", async () => ({ tenantId: TENANT, role: "staff" as Role, alreadyMember: false })),
    readInvite: track("readInvite", async (): Promise<(InviteRow & { businessName: string }) | null> => null),
    tenantName: track("tenantName", async () => "Salon One"),
    listMembers: track("listMembers", async () => []),
    emailsOf: track("emailsOf", async () => new Map<string, string | null>()),
    listPending: track("listPending", async () => []),
    seats: track("seats", async () => ({ members: 1, limit: 5 as number | "unlimited", planName: "Growth" })),
    livePendingCount: track("livePendingCount", async () => 0),
    ...over,
  };
  return Object.assign(db, { calls });
}

function deps(db: TeamDb, over: Partial<TeamDeps> = {}): TeamDeps {
  return {
    db, now: () => NOW, newToken: newConnectLinkToken, appOrigin: () => "https://app.example.com",
    limit: createRateLimiter({ limit: 30, windowMs: 60_000, now: () => NOW.getTime() }), ...over,
  };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return (e as AppError).code;
  }
  return "no error";
};

const body = { name: "  Asha  ", email: "  Asha@Example.COM ", role: "staff" };

describe("inviteMember: who may invite whom", () => {
  const matrix: [Role, InviteRole, boolean][] = [
    ["owner", "admin", true], ["owner", "staff", true], ["admin", "staff", true],
    ["admin", "admin", false], ["staff", "staff", false], ["staff", "admin", false],
  ];
  it.each(matrix)("%s inviting %s → %s", async (role, invitee, allowed) => {
    const db = fakeDb();
    const result = inviteMember(context(role), { ...body, role: invitee }, deps(db));
    if (allowed) {
      await expect(result).resolves.toMatchObject({ invite: { role: invitee } });
      expect(db.calls.createInvite).toHaveLength(1);
    } else {
      expect(await code(result)).toBe("forbidden");
      expect(db.calls.createInvite).toBeUndefined();
    }
  });

  it("answers staff 403 even when the body is invalid, before looking at it", async () => {
    expect(await code(inviteMember(context("staff"), {}, deps(fakeDb())))).toBe("forbidden");
  });

  it("nobody can invite an owner", async () => {
    for (const role of ["owner", "admin", "staff"] as const) {
      expect(await code(inviteMember(context(role), { ...body, role: "owner" }, deps(fakeDb())))).not.toBe("no error");
    }
    const err = await inviteMember(context("owner"), { ...body, role: "owner" }, deps(fakeDb())).catch((e: unknown) => e);
    expect(toErrorResponse(err).body.error.code).toBe("validation_failed");
  });

  it("uses the caller's business, never one named in the body", async () => {
    const db = fakeDb();
    await inviteMember(context("owner"), { ...body, tenantId: OTHER_TENANT, tenant_id: OTHER_TENANT }, deps(db));
    expect(db.calls.createInvite).toEqual([expect.objectContaining({ tenantId: TENANT, invitedBy: USER })]);
  });
});

describe("inviteMember: input, token and the single reveal", () => {
  it("trims the name and trims and lower-cases the email", async () => {
    const db = fakeDb();
    await inviteMember(context("owner"), body, deps(db));
    expect(db.calls.createInvite).toEqual([expect.objectContaining({ name: "Asha", email: "asha@example.com", role: "staff" })]);
  });

  it.each([
    [{ ...body, email: "not-an-email" }, "email"],
    [{ ...body, email: "" }, "email"],
    [{ ...body, email: `${"a".repeat(250)}@example.com` }, "email"],
    [{ ...body, name: "   " }, "name"],
    [{ ...body, name: "x".repeat(81) }, "name"],
    [{ name: "Asha", email: "a@example.com" }, "role"],
    [{ ...body, role: "superuser" }, "role"],
  ])("refuses %j with a message on %s", async (input, field) => {
    const db = fakeDb();
    const err = await inviteMember(context("owner"), input, deps(db)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    const { status, body: envelope } = toErrorResponse(err);
    expect(status).toBe(422);
    expect(envelope.error.fields).toHaveProperty(field);
    expect(db.calls.createInvite).toBeUndefined();
  });

  it("stores only the SHA-256 of the 43-character token and returns the link once", async () => {
    const db = fakeDb();
    const token = newConnectLinkToken();
    const result = await inviteMember(context("owner"), body, deps(db, { newToken: () => token }));
    expect(token.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const sent = db.calls.createInvite[0] as { tokenHash: string };
    expect(sent.tokenHash).toBe(createHash("sha256").update(token.token, "utf8").digest("hex"));
    expect(JSON.stringify(db.calls)).not.toContain(token.token);
    expect(result.url).toBe(`https://app.example.com/invite/${token.token}`);
    expect(JSON.stringify(result.invite)).not.toContain(token.token);
    expect(result.invite).toMatchObject({ expired: false, expiresAt: record().expiresAt });
  });

  it("makes a different token for every invitation", async () => {
    const urls = new Set<string>();
    for (let i = 0; i < 20; i++) urls.add((await inviteMember(context("owner"), body, deps(fakeDb()))).url);
    expect(urls.size).toBe(20);
  });

  it("passes the database's seat_limit and conflicts through as the API's errors", async () => {
    const seat = fakeDb({ createInvite: async () => { throw inviteDbError({ code: "PA413", message: "seat_limit: the Growth plan includes 5 team members" }); } });
    const refused = await inviteMember(context("owner"), body, deps(seat)).catch((e: unknown) => e);
    expect(toErrorResponse(refused)).toMatchObject({ status: 409, body: { error: { code: "seat_limit" } } });
  });
});

describe("inviteDbError", () => {
  it.each([
    [{ code: "PA413", message: "seat_limit: x" }, "seat_limit", 409],
    [{ code: "PA409", message: "already_member: x" }, "conflict", 409],
    [{ code: "PA409", message: "invite_exists: x" }, "conflict", 409],
    [{ code: "PA404", message: "invite_not_found: x" }, "not_found", 404],
    [{ code: "PA403", message: "forbidden: x" }, "forbidden", 403],
    [{ code: "PA403", message: "email_mismatch: x" }, "forbidden", 403],
    [{ code: "PA429", message: "resend_limit: x" }, "rate_limited", 429],
    [{ code: "23514", message: "violates check constraint" }, "validation_failed", 422],
  ])("%j → %s (%i)", (error, expected, status) => {
    expect(inviteDbError(error)).toMatchObject({ code: expected, status });
  });

  it("puts a duplicate on the email field and never echoes the address", () => {
    expect(inviteDbError({ code: "PA409", message: "invite_exists: a@b.co" })?.fields).toHaveProperty("email");
    expect(inviteDbError({ code: "PA409", message: "already_member: a@b.co" })?.message).not.toContain("a@b.co");
  });

  it("is null for an error that is not one of ours", () => {
    expect(inviteDbError({ code: "XX000", message: "boom" })).toBeNull();
    expect(inviteDbError({ message: "no code" })).toBeNull();
  });
});

describe("resendInvite and cancelInvite", () => {
  it("rotates the token on every resend and returns the new link once, with what is left", async () => {
    const db = fakeDb();
    const first = await resendInvite(context("owner"), INVITE_ID, deps(db));
    const second = await resendInvite(context("owner"), INVITE_ID, deps(db));
    const hashes = (db.calls.resendInvite as { tokenHash: string }[]).map((c) => c.tokenHash);
    expect(new Set(hashes).size).toBe(2);
    expect(first.url).not.toBe(second.url);
    expect(first.resendsLeft).toBe(4);
    for (const [call, result] of [[hashes[0], first], [hashes[1], second]] as const) {
      expect(call).toBe(hashConnectLinkToken(result.url.split("/invite/")[1]));
    }
    expect(db.calls.resendInvite[0]).toMatchObject({ tenantId: TENANT, inviteId: INVITE_ID, actor: USER });
  });

  it("is forbidden for staff and never reaches the database", async () => {
    const db = fakeDb();
    expect(await code(resendInvite(context("staff"), INVITE_ID, deps(db)))).toBe("forbidden");
    expect(await code(cancelInvite(context("staff"), INVITE_ID, deps(db)))).toBe("forbidden");
    expect(db.calls.resendInvite).toBeUndefined();
    expect(db.calls.cancelInvite).toBeUndefined();
  });

  it("answers an id that is not a UUID with not_found, without a query", async () => {
    const db = fakeDb();
    expect(await code(resendInvite(context("owner"), "../../etc", deps(db)))).toBe("not_found");
    expect(await code(cancelInvite(context("owner"), "nope", deps(db)))).toBe("not_found");
    expect(db.calls.resendInvite).toBeUndefined();
  });

  it("passes the database's refusals through: five a day, an admin's reach, a seat for an expired one", async () => {
    for (const [error, expected] of [
      [{ code: "PA429", message: "resend_limit: x" }, "rate_limited"],
      [{ code: "PA403", message: "forbidden: x" }, "forbidden"],
      [{ code: "PA413", message: "seat_limit: x" }, "seat_limit"],
      [{ code: "PA404", message: "invite_not_found: x" }, "not_found"],
    ] as const) {
      const db = fakeDb({ resendInvite: async () => { throw inviteDbError(error); } });
      expect(await code(resendInvite(context("admin"), INVITE_ID, deps(db)))).toBe(expected);
    }
  });

  it("cancels in the caller's business", async () => {
    const db = fakeDb();
    await expect(cancelInvite(context("admin"), INVITE_ID, deps(db))).resolves.toBeUndefined();
    expect(db.calls.cancelInvite).toEqual([{ tenantId: TENANT, inviteId: INVITE_ID, actor: USER }]);
  });
});

describe("previewInvite (public)", () => {
  const token = newConnectLinkToken();
  const row = (over: Partial<InviteRow> = {}): InviteRow & { businessName: string } => ({
    ...record(), acceptedAt: null, cancelledAt: null, businessName: "Salon One", ...over,
  });

  it("looks the invitation up by the hash of the token and says what the page may say", async () => {
    const db = fakeDb({ readInvite: async (hash) => (hash === token.tokenHash ? row() : null) });
    const preview = await previewInvite(token.token, "1.2.3.4", deps(db));
    expect(preview).toEqual({ status: "valid", businessName: "Salon One", role: "staff", expiresAt: record().expiresAt });
    expect(JSON.stringify(preview)).not.toContain("asha");
    expect(JSON.stringify(preview)).not.toContain("example.com");
  });

  it.each([
    [{ acceptedAt: NOW.toISOString() }, "used"],
    [{ cancelledAt: NOW.toISOString() }, "revoked"],
    [{ expiresAt: new Date(NOW.getTime() - 1000).toISOString() }, "expired"],
    [{ expiresAt: NOW.toISOString() }, "expired"],
  ] as const)("%j → %s", async (over, status) => {
    const db = fakeDb({ readInvite: async () => row(over) });
    expect((await previewInvite(token.token, "k", deps(db))).status).toBe(status);
  });

  it("answers an unknown or malformed token with the same not_found, and queries only a well-formed one", async () => {
    const db = fakeDb();
    expect(await code(previewInvite(token.token, "k", deps(db)))).toBe("not_found");
    expect(await code(previewInvite("short", "k", deps(db)))).toBe("not_found");
    expect(await code(previewInvite(`${token.token}x`, "k", deps(db)))).toBe("not_found");
    expect(db.calls.readInvite).toHaveLength(1);
  });

  it("limits a caller to 30 a minute", async () => {
    const d = deps(fakeDb());
    for (let i = 0; i < 30; i++) await previewInvite(token.token, "same", d).catch(() => undefined);
    expect(await code(previewInvite(token.token, "same", d))).toBe("rate_limited");
    expect(await code(previewInvite(token.token, "other", d))).toBe("not_found");
  });
});

describe("acceptInvite", () => {
  const token = newConnectLinkToken();
  const user = { id: USER, email: "asha@example.com", email_confirmed_at: "2026-10-01T00:00:00Z" };

  it("joins the signed-in user: the database gets the token's hash and the verified user, and the answer names the business", async () => {
    const db = fakeDb();
    const result = await acceptInvite(user, token.token, deps(db));
    expect(db.calls.acceptInvite).toEqual([{ tokenHash: token.tokenHash, userId: USER, email: "asha@example.com" }]);
    expect(result).toEqual({ tenantId: TENANT, businessName: "Salon One", role: "staff", alreadyMember: false });
    expect(JSON.stringify(db.calls)).not.toContain(token.token);
  });

  it("refuses an address that is not confirmed, or a user without one, before touching the invitation", async () => {
    const db = fakeDb();
    expect(await code(acceptInvite({ ...user, email_confirmed_at: undefined }, token.token, deps(db)))).toBe("forbidden");
    expect(await code(acceptInvite({ ...user, email: undefined }, token.token, deps(db)))).toBe("forbidden");
    expect(db.calls.acceptInvite).toBeUndefined();
  });

  it("answers a malformed token with not_found and never asks the database", async () => {
    const db = fakeDb();
    expect(await code(acceptInvite(user, "nope", deps(db)))).toBe("not_found");
    expect(db.calls.acceptInvite).toBeUndefined();
  });

  it("gives one not_found for an unknown, expired, used or cancelled invitation", async () => {
    const db = fakeDb({ acceptInvite: async () => { throw new AppError("not_found", "x"); } });
    expect(await code(acceptInvite(user, token.token, deps(db)))).toBe("not_found");
  });

  it("maps a different signed-in email to forbidden and a lowered plan to seat_limit", async () => {
    const mismatch = fakeDb({ acceptInvite: async () => { throw inviteDbError({ code: "PA403", message: "email_mismatch: x" }); } });
    const refused = await acceptInvite(user, token.token, deps(mismatch)).catch((e: unknown) => e);
    expect(toErrorResponse(refused)).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
    expect(toErrorResponse(refused).body.error.message).not.toContain("asha@example.com");
    const full = fakeDb({ acceptInvite: async () => { throw inviteDbError({ code: "PA413", message: "seat_limit: x" }); } });
    expect(await code(acceptInvite(user, token.token, deps(full)))).toBe("seat_limit");
  });

  it("limits a user to 30 tries a minute", async () => {
    const d = deps(fakeDb({ acceptInvite: async () => { throw new AppError("not_found", "x"); } }));
    for (let i = 0; i < 30; i++) await acceptInvite(user, token.token, d).catch(() => undefined);
    expect(await code(acceptInvite(user, token.token, d))).toBe("rate_limited");
  });
});

describe("teamOverview", () => {
  const members = [
    { userId: "u-staff", role: "staff" as Role, name: "Zed" },
    { userId: USER, role: "owner" as Role, name: null },
    { userId: "u-admin", role: "admin" as Role, name: "Meera" },
  ];
  const pending = [record({ id: "p1", expiresAt: new Date(NOW.getTime() + 86_400_000).toISOString() }), record({ id: "p2", expiresAt: new Date(NOW.getTime() - 1000).toISOString() })];
  const db = () =>
    fakeDb({
      listMembers: async () => members,
      emailsOf: async () => new Map([[USER, "me@example.com"], ["u-admin", "meera@example.com"], ["u-staff", "zed@example.com"]]),
      listPending: async () => pending,
      livePendingCount: async () => 1,
      seats: async () => ({ members: 3, limit: 5, planName: "Growth" }),
    });

  it("counts members plus live invitations as the seats in use, and marks the expired one", async () => {
    const overview = await teamOverview(context("owner"), deps(db()));
    expect(overview.seats).toEqual({ used: 4, members: 3, pending: 1, limit: 5, planName: "Growth" });
    expect(overview.invites.map((i) => [i.id, i.expired])).toEqual([["p1", false], ["p2", true]]);
    expect(overview.members.map((m) => m.role)).toEqual(["owner", "admin", "staff"]);
    expect(overview.members.find((m) => m.you)?.userId).toBe(USER);
    expect(overview.inviteRoles).toEqual(["admin", "staff"]);
  });

  it("shows staff the team's names and roles, but no invitations and no email addresses", async () => {
    const d = db();
    const overview = await teamOverview(context("staff"), deps(d));
    expect(overview.invites).toEqual([]);
    expect(overview.members.every((m) => m.email === null)).toBe(true);
    expect(overview.inviteRoles).toEqual([]);
    expect(d.calls.listPending).toBeUndefined();
    expect(d.calls.emailsOf).toBeUndefined();
  });

  it("lets an admin invite staff only", async () => {
    expect((await teamOverview(context("admin"), deps(db()))).inviteRoles).toEqual(["staff"]);
  });

  it("never carries a link or a token", async () => {
    const text = JSON.stringify(await teamOverview(context("owner"), deps(db())));
    expect(text).not.toMatch(/\/invite\//);
    expect(text).not.toMatch(/token/i);
  });
});

describe("teamDb: the database's refusals", () => {
  beforeEach(() => rpc.mockReset());

  it("calls create_team_invite with the hash and maps seat_limit and a conflict", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "PA413", message: "seat_limit: the Growth plan includes 5 team members" } });
    const err = await teamDb().createInvite({ tenantId: TENANT, email: "a@b.co", name: "A", role: "staff", invitedBy: USER, tokenHash: "f".repeat(64) }).catch((e: unknown) => e);
    expect(toErrorResponse(err)).toMatchObject({ status: 409, body: { error: { code: "seat_limit" } } });
    expect(rpc).toHaveBeenCalledWith("create_team_invite", { p_tenant_id: TENANT, p_email: "a@b.co", p_name: "A", p_role: "staff", p_invited_by: USER, p_token_hash: "f".repeat(64) });

    rpc.mockResolvedValueOnce({ data: null, error: { code: "PA409", message: "invite_exists: x" } });
    const dup = await teamDb().createInvite({ tenantId: TENANT, email: "a@b.co", name: "A", role: "staff", invitedBy: USER, tokenHash: "f".repeat(64) }).catch((e: unknown) => e);
    expect(toErrorResponse(dup)).toMatchObject({ status: 409, body: { error: { code: "conflict" } } });
  });

  it("an unexpected database error becomes upstream_failed, not a leak", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "XX000", message: "relation secret_table does not exist" } });
    const err = await teamDb().resendInvite({ tenantId: TENANT, inviteId: INVITE_ID, actor: USER, tokenHash: "e".repeat(64) }).catch((e: unknown) => e);
    expect(toErrorResponse(err).body.error.message).not.toContain("secret_table");
    expect(toErrorResponse(err).body.error.code).toBe("upstream_failed");
  });

  it("reads the rows the functions return", async () => {
    rpc.mockResolvedValueOnce({
      data: [{ invite_id: INVITE_ID, invite_email: "a@b.co", invite_name: "A", invite_role: "staff", invite_created_at: "c", invite_expires_at: "e", resends_left: 3 }],
      error: null,
    });
    await expect(teamDb().resendInvite({ tenantId: TENANT, inviteId: INVITE_ID, actor: USER, tokenHash: "e".repeat(64) })).resolves.toEqual({
      id: INVITE_ID, email: "a@b.co", name: "A", role: "staff", createdAt: "c", expiresAt: "e", resendsLeft: 3,
    });
    rpc.mockResolvedValueOnce({ data: [{ out_tenant_id: TENANT, out_role: "staff", out_already_member: true }], error: null });
    await expect(teamDb().acceptInvite({ tokenHash: "d".repeat(64), userId: USER, email: "a@b.co" })).resolves.toEqual({ tenantId: TENANT, role: "staff", alreadyMember: true });
  });

  it("answers every 'not found' on accept with the one generic wording", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "PA404", message: "invite_not_found: this invitation is not valid" } });
    const err = await teamDb().acceptInvite({ tokenHash: "d".repeat(64), userId: USER, email: "a@b.co" }).catch((e: unknown) => e);
    expect(toErrorResponse(err)).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
  });
});
