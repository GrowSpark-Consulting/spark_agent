import {
  INVITE_RESENDS_PER_DAY,
  InviteTeamMember,
  invitableRoles,
  type InviteAccepted,
  type InviteCreated,
  type InvitePreview,
  type InviteResent,
  type InviteRole,
  type Role,
  type TeamInvite,
  type TeamOverview,
  type TenantContext,
} from "@pakka/types";
import type { User } from "@supabase/supabase-js";
import { z } from "zod";
import { seatUsage } from "../billing/plan-limits";
import { createRateLimiter, type RateLimiter } from "../channels/whatsapp/connect/connect-link-rate-limit";
import { hashConnectLinkToken, isConnectLinkToken, newConnectLinkToken } from "../lib/connect-link-token";
import { serverEnv } from "../lib/env";
import { AppError, zodFieldErrors } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase-admin";

// Team invitations (migration 0052; docs/task-notes/2026-10-14-day6-dev3-team-invite-proposal.md). The routes only call these functions.
//
//   inviteMember     POST /api/team/invite              { name, email, role } → { invite, url }. The link is returned here and nowhere else.
//   resendInvite     POST /api/team/invites/:id/resend  → { invite, url, resendsLeft }. Rotates the token; the old link stops working.
//   cancelInvite     POST /api/team/invites/:id/cancel  → nothing.
//   previewInvite    GET  /api/team/invites/:token      public → what the page may say (never the invited address).
//   acceptInvite     POST /api/team/invites/:token/accept  signed in → the membership.
//   teamOverview     GET  /api/team                     members, pending invitations and seats.
//
// The database functions do the work in one transaction each, with the seat check under the business's row lock and the audit row
// (team_invite.*): this file checks the role first, for a plain answer, and maps what the database refuses. The tenant is always the caller's
// own membership (requireTenant); a tenant id in the body or the path is never used. The token is 32 random bytes (the connect link's
// helper); only its SHA-256 is stored, and the raw token is never logged, audited or kept.

/** The one answer for every invitation that cannot be used by token. Never says which of unknown, used, cancelled or expired. */
const invalidInvite = () => new AppError("not_found", "This invitation isn't valid anymore. Ask for a new one.");
const inviteNotFound = () => new AppError("not_found", "We couldn't find that invitation.");

export interface InviteRecord {
  id: string;
  email: string;
  name: string;
  role: InviteRole;
  createdAt: string;
  expiresAt: string;
}

export interface InviteRow extends InviteRecord {
  acceptedAt: string | null;
  cancelledAt: string | null;
}

export interface TeamDb {
  createInvite(args: { tenantId: string; email: string; name: string; role: InviteRole; invitedBy: string; tokenHash: string }): Promise<InviteRecord>;
  resendInvite(args: { tenantId: string; inviteId: string; actor: string; tokenHash: string }): Promise<InviteRecord & { resendsLeft: number }>;
  cancelInvite(args: { tenantId: string; inviteId: string; actor: string }): Promise<void>;
  acceptInvite(args: { tokenHash: string; userId: string; email: string }): Promise<{ tenantId: string; role: Role; alreadyMember: boolean }>;
  /** The invitation behind a token hash, with its business's name; null if there is none. */
  readInvite(tokenHash: string): Promise<(InviteRow & { businessName: string }) | null>;
  tenantName(tenantId: string): Promise<string>;
  listMembers(tenantId: string): Promise<{ userId: string; role: Role; name: string | null }[]>;
  emailsOf(userIds: string[]): Promise<Map<string, string | null>>;
  /** Pending (not accepted, not cancelled) invitations of the business, newest first, expired ones included. */
  listPending(tenantId: string): Promise<InviteRecord[]>;
  seats(tenantId: string): Promise<{ members: number; limit: number | "unlimited"; planName: string }>;
  /** Pending invitations that have not expired: the seats they reserve. */
  livePendingCount(tenantId: string, now: Date): Promise<number>;
}

export interface TeamDeps {
  db: TeamDb;
  now: () => Date;
  newToken: () => { token: string; tokenHash: string };
  /** The frontend's origin, for the link. */
  appOrigin: () => string;
  /** True when this caller may go on (30 a minute per address, or per user for accept). */
  limit: RateLimiter;
}

export const inviteLimiter = createRateLimiter({ limit: 30, windowMs: 60_000 });

export const teamDefaults = (): TeamDeps => ({
  db: teamDb(),
  now: () => new Date(),
  newToken: newConnectLinkToken,
  appOrigin: () => new URL(serverEnv().NEXT_PUBLIC_APP_URL).origin,
  limit: inviteLimiter,
});

const Guid = z.guid();

/** The database's refusal as the API's error, or null for an error that is not one of ours. SQLSTATEs: see migration 0052. */
export function inviteDbError(error: { code?: string; message: string }): AppError | null {
  if (error.code === "PA413") return new AppError("seat_limit", "Every team seat on your plan is taken, counting people already invited. Upgrade to add more.");
  const message = error.message;
  switch (error.code) {
    case "PA409":
      return message.startsWith("already_member")
        ? new AppError("conflict", "That person is already on your team.", { email: "That person is already on your team." })
        : new AppError("conflict", "That email already has a pending invitation. Send it again from the list.", { email: "That email already has a pending invitation." });
    case "PA404":
      return message.startsWith("invite_not_found") ? inviteNotFound() : new AppError("not_found", "We couldn't find that business.");
    case "PA403":
      return message.startsWith("email_mismatch")
        ? new AppError("forbidden", "This invitation was sent to a different email address. Sign in with the address it was sent to.")
        : new AppError("forbidden", "Your role can't do that.");
    case "PA429":
      return new AppError("rate_limited", `This invitation was already sent ${INVITE_RESENDS_PER_DAY} times in the last day. Try again tomorrow.`);
    case "23514":
      return new AppError("validation_failed", "Check the highlighted fields.");
    default:
      return null;
  }
}

const toRecord = (row: { invite_id: string; invite_email: string; invite_name: string; invite_role: string; invite_created_at: string; invite_expires_at: string }): InviteRecord => ({
  id: row.invite_id,
  email: row.invite_email,
  name: row.invite_name,
  role: row.invite_role as InviteRole,
  createdAt: row.invite_created_at,
  expiresAt: row.invite_expires_at,
});

export function teamDb(): TeamDb {
  const db = () => supabaseAdmin();
  const fail = (what: string) => new AppError("upstream_failed", `We couldn't ${what}. Try again in a moment.`);
  const refuse = (error: { code?: string; message: string }, what: string): never => {
    throw inviteDbError(error) ?? fail(what);
  };
  return {
    async createInvite(a) {
      const { data, error } = await db().rpc("create_team_invite", {
        p_tenant_id: a.tenantId, p_email: a.email, p_name: a.name, p_role: a.role, p_invited_by: a.invitedBy, p_token_hash: a.tokenHash,
      });
      if (error) return refuse(error, "make the invitation");
      const row = (Array.isArray(data) ? data[0] : data) as Parameters<typeof toRecord>[0] | undefined;
      if (!row) throw fail("make the invitation");
      return toRecord(row);
    },
    async resendInvite(a) {
      const { data, error } = await db().rpc("resend_team_invite", { p_tenant_id: a.tenantId, p_invite_id: a.inviteId, p_actor: a.actor, p_token_hash: a.tokenHash });
      if (error) return refuse(error, "send the invitation again");
      const row = (Array.isArray(data) ? data[0] : data) as (Parameters<typeof toRecord>[0] & { resends_left: number }) | undefined;
      if (!row) throw fail("send the invitation again");
      return { ...toRecord(row), resendsLeft: row.resends_left };
    },
    async cancelInvite(a) {
      const { error } = await db().rpc("cancel_team_invite", { p_tenant_id: a.tenantId, p_invite_id: a.inviteId, p_actor: a.actor });
      if (error) refuse(error, "cancel the invitation");
    },
    async acceptInvite(a) {
      const { data, error } = await db().rpc("accept_team_invite", { p_token_hash: a.tokenHash, p_user_id: a.userId, p_email: a.email });
      if (error) {
        // The database says "not found" for every invitation that cannot be used; the person gets the one wording for all of them.
        if (error.code === "PA404") throw invalidInvite();
        return refuse(error, "accept the invitation");
      }
      const row = (Array.isArray(data) ? data[0] : data) as { out_tenant_id: string; out_role: Role; out_already_member: boolean } | undefined;
      if (!row) throw fail("accept the invitation");
      return { tenantId: row.out_tenant_id, role: row.out_role, alreadyMember: row.out_already_member };
    },
    async readInvite(tokenHash) {
      const { data, error } = await db()
        .from("team_invites")
        .select("id, email, name, role, created_at, expires_at, accepted_at, cancelled_at, tenants(name)")
        .eq("token_hash", tokenHash)
        .maybeSingle();
      if (error) throw fail("read the invitation");
      if (data === null) return null;
      const row = data as unknown as {
        id: string; email: string; name: string; role: InviteRole; created_at: string; expires_at: string;
        accepted_at: string | null; cancelled_at: string | null; tenants: { name?: string } | { name?: string }[] | null;
      };
      const tenant = Array.isArray(row.tenants) ? row.tenants[0] : row.tenants;
      if (!tenant?.name) return null;
      return {
        id: row.id, email: row.email, name: row.name, role: row.role, createdAt: row.created_at, expiresAt: row.expires_at,
        acceptedAt: row.accepted_at, cancelledAt: row.cancelled_at, businessName: tenant.name,
      };
    },
    async tenantName(tenantId) {
      const { data, error } = await db().from("tenants").select("name").eq("id", tenantId).maybeSingle();
      if (error || !data) throw fail("read the business");
      return String((data as { name: unknown }).name);
    },
    async listMembers(tenantId) {
      const { data, error } = await db().from("memberships").select("user_id, role, display_name").eq("tenant_id", tenantId);
      if (error) throw fail("load the team");
      return ((data ?? []) as { user_id: string; role: Role; display_name: string | null }[]).map((m) => ({ userId: m.user_id, role: m.role, name: m.display_name }));
    },
    async emailsOf(userIds) {
      const emails = new Map<string, string | null>();
      await Promise.all(
        userIds.map(async (id) => {
          const { data, error } = await db().auth.admin.getUserById(id);
          emails.set(id, error ? null : (data.user?.email ?? null));
        }),
      );
      return emails;
    },
    async listPending(tenantId) {
      const { data, error } = await db()
        .from("team_invites")
        .select("id, email, name, role, created_at, expires_at")
        .eq("tenant_id", tenantId)
        .is("accepted_at", null)
        .is("cancelled_at", null)
        .order("created_at", { ascending: false });
      if (error) throw fail("load the invitations");
      return ((data ?? []) as { id: string; email: string; name: string; role: InviteRole; created_at: string; expires_at: string }[]).map((r) => ({
        id: r.id, email: r.email, name: r.name, role: r.role, createdAt: r.created_at, expiresAt: r.expires_at,
      }));
    },
    async seats(tenantId) {
      const usage = await seatUsage(tenantId, db());
      return { members: usage.used, limit: usage.limit, planName: usage.planName };
    },
    async livePendingCount(tenantId, now) {
      const { count, error } = await db()
        .from("team_invites")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .is("accepted_at", null)
        .is("cancelled_at", null)
        .gt("expires_at", now.toISOString());
      if (error) throw fail("count the invitations");
      return count ?? 0;
    },
  };
}

// Who may do what ---------------------------------------------------------------------------------------------------------------------

/** Staff may not manage invitations at all; an admin only staff invitations; an owner any. */
function requireCanManage(role: Role, inviteRole?: InviteRole): void {
  if (role === "staff") throw new AppError("forbidden", "Only an owner or admin can invite people.");
  if (role === "admin" && inviteRole !== undefined && inviteRole !== "staff") {
    throw new AppError("forbidden", "Admins can invite staff only. Ask an owner to invite an admin.");
  }
}

const toInvite = (r: InviteRecord, now: Date): TeamInvite => ({ ...r, expired: new Date(r.expiresAt).getTime() <= now.getTime() });
const linkFor = (deps: TeamDeps, token: string) => `${deps.appOrigin()}/invite/${token}`;

// Create and resend ------------------------------------------------------------------------------------------------------------------

/** Makes an invitation for the caller's own business. The raw link is in this answer only. */
export async function inviteMember(context: TenantContext, rawBody: unknown, deps: TeamDeps = teamDefaults()): Promise<InviteCreated> {
  requireCanManage(context.role);
  const parsed = InviteTeamMember.safeParse(rawBody);
  if (!parsed.success) throw new AppError("validation_failed", "Check the highlighted fields.", zodFieldErrors(parsed.error));
  requireCanManage(context.role, parsed.data.role);

  const { token, tokenHash } = deps.newToken();
  const record = await deps.db.createInvite({
    tenantId: context.tenant.id, email: parsed.data.email, name: parsed.data.name, role: parsed.data.role, invitedBy: context.user.id, tokenHash,
  });
  return { invite: toInvite(record, deps.now()), url: linkFor(deps, token) };
}

/** A fresh link for a pending invitation of the caller's business; the old link stops working. At most five a day. */
export async function resendInvite(context: TenantContext, inviteId: string, deps: TeamDeps = teamDefaults()): Promise<InviteResent> {
  requireCanManage(context.role);
  if (!Guid.safeParse(inviteId).success) throw inviteNotFound();
  const { token, tokenHash } = deps.newToken();
  const record = await deps.db.resendInvite({ tenantId: context.tenant.id, inviteId, actor: context.user.id, tokenHash });
  return { invite: toInvite(record, deps.now()), url: linkFor(deps, token), resendsLeft: record.resendsLeft };
}

export async function cancelInvite(context: TenantContext, inviteId: string, deps: TeamDeps = teamDefaults()): Promise<undefined> {
  requireCanManage(context.role);
  if (!Guid.safeParse(inviteId).success) throw inviteNotFound();
  await deps.db.cancelInvite({ tenantId: context.tenant.id, inviteId, actor: context.user.id });
  return undefined;
}

// The invitee's side -----------------------------------------------------------------------------------------------------------------

/** What the public page may say about a link. Public: `clientKey` is the caller's address, for the limit. */
export async function previewInvite(token: string, clientKey: string, deps: TeamDeps = teamDefaults()): Promise<InvitePreview> {
  if (!deps.limit(clientKey)) throw new AppError("rate_limited", "Too many tries. Wait a minute and try again.");
  if (!isConnectLinkToken(token)) throw invalidInvite();
  const row = await deps.db.readInvite(hashConnectLinkToken(token));
  if (row === null) throw invalidInvite();
  // A token is 256 random bits, so whoever holds it was given it: telling them why it no longer works leaks nothing and saves a support call.
  const status: InvitePreview["status"] =
    row.acceptedAt !== null ? "used" : row.cancelledAt !== null ? "revoked" : new Date(row.expiresAt).getTime() <= deps.now().getTime() ? "expired" : "valid";
  return { status, businessName: row.businessName, role: row.role, expiresAt: row.expiresAt };
}

/** Joins the signed-in user to the business that invited their (verified) email. The user comes from the verified token, never the body. */
export async function acceptInvite(user: Pick<User, "id" | "email" | "email_confirmed_at">, token: string, deps: TeamDeps = teamDefaults()): Promise<InviteAccepted> {
  if (!deps.limit(`accept:${user.id}`)) throw new AppError("rate_limited", "Too many tries. Wait a minute and try again.");
  if (!isConnectLinkToken(token)) throw invalidInvite();
  if (!user.email) throw new AppError("forbidden", "Sign in with the email address this invitation was sent to.");
  if (!user.email_confirmed_at) throw new AppError("forbidden", "Confirm your email address first, then open the invitation again.");
  const joined = await deps.db.acceptInvite({ tokenHash: hashConnectLinkToken(token), userId: user.id, email: user.email });
  return { tenantId: joined.tenantId, businessName: await deps.db.tenantName(joined.tenantId), role: joined.role, alreadyMember: joined.alreadyMember };
}

// The Team screen ------------------------------------------------------------------------------------------------------------------

/** Members, pending invitations and seat use for the caller's business. Invitations and teammates' emails go to an owner or admin only. */
export async function teamOverview(context: TenantContext, deps: TeamDeps = teamDefaults()): Promise<TeamOverview> {
  const tenantId = context.tenant.id;
  const manages = context.role !== "staff";
  const now = deps.now();
  const [members, seats, livePending, pending] = await Promise.all([
    deps.db.listMembers(tenantId),
    deps.db.seats(tenantId),
    deps.db.livePendingCount(tenantId, now),
    manages ? deps.db.listPending(tenantId) : Promise.resolve([]),
  ]);
  const emails = manages ? await deps.db.emailsOf(members.map((m) => m.userId)) : new Map<string, string | null>();
  const rank = { owner: 0, admin: 1, staff: 2 } as const;
  return {
    viewerRole: context.role,
    inviteRoles: invitableRoles(context.role),
    seats: { used: seats.members + livePending, members: seats.members, pending: livePending, limit: seats.limit, planName: seats.planName },
    members: members
      .map((m) => ({ userId: m.userId, role: m.role, name: m.name, email: emails.get(m.userId) ?? null, you: m.userId === context.user.id }))
      .sort((a, b) => rank[a.role] - rank[b.role] || (a.name ?? a.email ?? "").localeCompare(b.name ?? b.email ?? "")),
    invites: pending.map((r) => toInvite(r, now)),
  };
}
