import { z } from "zod";
import { ROLES, type Role } from "./tenancy";

const MemberRole = z.enum(ROLES);

// Team invitations (migration 0052, backend/src/team). An owner or admin invites a person by email; the link is shared by hand
// for now (no email is sent). The link is shown ONCE, in the answer that creates or resends the invitation; it is not stored
// anywhere readable (the database keeps only a SHA-256 of its token) and no later read returns it.
//   GET  /api/team                          → TeamOverview. Any member; invitations and emails only for an owner or admin.
//   POST /api/team/invite                   InviteTeamMember → 201 InviteCreated. Owner: admin or staff. Admin: staff only. Staff: 403.
//                                           seat_limit (409) when members + pending invitations fill the plan; conflict (409) for an
//                                           address already on the team or already invited (fields.email).
//   POST /api/team/invites/:id/resend       no body → InviteResent. The old link stops working; the expiry restarts (7 days); no extra seat;
//                                           rate_limited (429) after 5 resends in a day.
//   POST /api/team/invites/:id/cancel       no body → 204. The link stops working at once.
//   GET  /api/team/invites/:token           public → InvitePreview. An unknown or malformed token is not_found.
//   POST /api/team/invites/:token/accept    signed in, no body → InviteAccepted. The signed-in email must be the invited one (forbidden
//                                           otherwise); an invitation that cannot be used is not_found; seat_limit (409) if the plan
//                                           was lowered since.

/** The roles an invitation can carry. Nobody is invited as owner. */
export const INVITE_ROLES = ["admin", "staff"] as const;
export const InviteRole = z.enum(INVITE_ROLES);
export type InviteRole = z.infer<typeof InviteRole>;

/** The roles a member may invite: an owner invites admins and staff, an admin invites staff, staff invite no one. */
export function invitableRoles(role: Role): InviteRole[] {
  return role === "owner" ? ["admin", "staff"] : role === "admin" ? ["staff"] : [];
}

export const INVITE_VALID_DAYS = 7;
export const INVITE_RESENDS_PER_DAY = 5;

export const InviteTeamMember = z.object({
  name: z.string({ error: "Enter their name." }).trim().min(1, "Enter their name.").max(80, "Keep the name under 80 characters."),
  email: z
    .string({ error: "Enter their email address." })
    .trim()
    .toLowerCase()
    .min(1, "Enter their email address.")
    .max(254, "That email address is too long.")
    .pipe(z.email("Enter a valid email address.")),
  role: InviteRole,
});
export type InviteTeamMember = z.infer<typeof InviteTeamMember>;

export const TeamInvite = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: InviteRole,
  createdAt: z.string(),
  expiresAt: z.string(),
  /** The seven days are over. An expired invitation holds no seat; resending it brings it back if a seat is free. */
  expired: z.boolean(),
});
export type TeamInvite = z.infer<typeof TeamInvite>;

/** The link to pass on, and the invitation it opens. The only answers that carry the link. */
export const InviteCreated = z.object({ invite: TeamInvite, url: z.string() });
export type InviteCreated = z.infer<typeof InviteCreated>;

export const InviteResent = z.object({ invite: TeamInvite, url: z.string(), resendsLeft: z.number().int().min(0) });
export type InviteResent = z.infer<typeof InviteResent>;

export const TeamMemberRow = z.object({
  userId: z.string(),
  role: MemberRole,
  /** The name from the invitation they accepted; null for a member who has none (an owner who signed up). */
  name: z.string().nullable(),
  /** Only an owner or admin sees teammates' email addresses. */
  email: z.string().nullable(),
  you: z.boolean(),
});
export type TeamMemberRow = z.infer<typeof TeamMemberRow>;

export const TeamSeats = z.object({
  /** Members plus pending (unexpired) invitations: what the plan's seats are counted against. */
  used: z.number().int().min(0),
  members: z.number().int().min(0),
  pending: z.number().int().min(0),
  limit: z.union([z.number().int(), z.literal("unlimited")]),
  planName: z.string(),
});
export type TeamSeats = z.infer<typeof TeamSeats>;

export const TeamOverview = z.object({
  viewerRole: MemberRole,
  /** What the server will let this member invite. Empty for staff. The server checks again on every request. */
  inviteRoles: z.array(InviteRole),
  seats: TeamSeats,
  members: z.array(TeamMemberRow),
  /** Empty for staff. */
  invites: z.array(TeamInvite),
});
export type TeamOverview = z.infer<typeof TeamOverview>;

/** What the public invitation page may say. Never the invited address. */
export const InvitePreview = z.object({
  status: z.enum(["valid", "expired", "used", "revoked"]),
  businessName: z.string(),
  role: InviteRole,
  expiresAt: z.string(),
});
export type InvitePreview = z.infer<typeof InvitePreview>;

export const InviteAccepted = z.object({
  tenantId: z.string(),
  businessName: z.string(),
  role: MemberRole,
  /** They were already on the team: their role is unchanged. */
  alreadyMember: z.boolean(),
});
export type InviteAccepted = z.infer<typeof InviteAccepted>;
