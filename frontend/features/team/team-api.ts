import { InviteCreated, InviteResent, InviteTeamMember, TeamOverview } from "@pakka/types";
import { getJson, postJson, sendNoContent } from "@/lib/api/client";
import { ApiError, formatError } from "@/lib/errors";

// The Team screen's members and invitations (backend/src/team, migration 0052). Every call goes through the authenticated API client; the
// server decides who may do what (owner: admin or staff, admin: staff only, staff: nothing) and the screen only hides what the server
// would refuse. The invitation link comes back ONCE, in the answer that creates or resends an invitation; nothing here stores it.

export class TeamDataError extends Error {
  constructor(what: string) {
    super(`The ${what} answer had an unexpected shape.`);
    this.name = "TeamDataError";
  }
}

export async function fetchTeam(tenantId: string, signal?: AbortSignal): Promise<TeamOverview> {
  const parsed = TeamOverview.safeParse(await getJson<unknown>("/api/team", { tenantId, signal }));
  if (!parsed.success) throw new TeamDataError("team");
  return parsed.data;
}

export async function sendInvite(tenantId: string, input: InviteTeamMember): Promise<InviteCreated> {
  const parsed = InviteCreated.safeParse(await postJson<unknown>("/api/team/invite", input, { tenantId }));
  if (!parsed.success) throw new TeamDataError("invitation");
  return parsed.data;
}

export async function resendInvite(tenantId: string, inviteId: string): Promise<InviteResent> {
  const parsed = InviteResent.safeParse(await postJson<unknown>(`/api/team/invites/${encodeURIComponent(inviteId)}/resend`, undefined, { tenantId }));
  if (!parsed.success) throw new TeamDataError("invitation");
  return parsed.data;
}

export async function cancelInvite(tenantId: string, inviteId: string): Promise<void> {
  await sendNoContent(`/api/team/invites/${encodeURIComponent(inviteId)}/cancel`, "POST", { tenantId });
}

export type InviteFormInput = { name: string; email: string; role: string };

/** The same checks the server makes, for a quicker answer. The server stays the authority: its refusals are shown too. */
export function validateInvite(input: InviteFormInput): { ok: true; value: InviteTeamMember } | { ok: false; fields: Record<string, string> } {
  const parsed = InviteTeamMember.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  const fields: Record<string, string> = {};
  for (const issue of parsed.error.issues) fields[String(issue.path[0] ?? "form")] ??= issue.message;
  if (fields.role) fields.role = "Choose a role.";
  return { ok: false, fields };
}

export type InviteProblem = {
  kind: "seat_limit" | "forbidden" | "duplicate" | "validation" | "rate_limited" | "gone" | "other";
  title: string;
  message: string;
  fields: Record<string, string>;
};

/** What the person is told when an invitation action is refused. The API writes its messages for people; the screen adds what to do next. */
export function describeInviteError(err: unknown, action: "invite" | "resend" | "cancel"): InviteProblem {
  const formatted = formatError(err);
  const fields = formatted.fields ?? {};
  const code = err instanceof ApiError ? err.body.error.code : formatted.code;
  switch (code) {
    case "seat_limit":
      return { kind: "seat_limit", title: "No team seats left", message: `${formatted.message} Invitations that have not been used yet count as seats; cancel one, or upgrade your plan.`, fields };
    case "forbidden":
      return { kind: "forbidden", title: "You can't do that", message: formatted.message, fields };
    case "conflict":
      return { kind: "duplicate", title: "Already invited", message: formatted.message, fields };
    case "validation_failed":
      return { kind: "validation", title: "Check the highlighted fields", message: formatted.message, fields };
    case "rate_limited":
      return { kind: "rate_limited", title: action === "resend" ? "Sent again too many times" : "Too many requests", message: formatted.message, fields };
    case "not_found":
      return { kind: "gone", title: "That invitation is gone", message: "It was already used, cancelled or replaced. The list has been refreshed.", fields };
    default:
      return { kind: "other", title: formatted.title, message: formatted.message, fields };
  }
}

/** Copies text to the clipboard; false if the browser refuses (the screen then asks the person to select and copy by hand). */
export async function copyText(text: string, clipboard: Pick<Clipboard, "writeText"> | undefined = typeof navigator === "undefined" ? undefined : navigator.clipboard): Promise<boolean> {
  if (!clipboard) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** When an invitation ends, for the list: "Expires 22 Oct" or "Expired 14 Oct". */
export function expiryLabel(invite: { expiresAt: string; expired: boolean }): string {
  const day = new Date(invite.expiresAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  return invite.expired ? `Expired ${day}` : `Expires ${day}`;
}

/** "3 of 5 seats used (2 members, 1 invited)". */
export function seatSummary(seats: TeamOverview["seats"]): string {
  const limit = seats.limit === "unlimited" ? "unlimited seats" : `${seats.limit} seats`;
  const invited = seats.pending > 0 ? `, ${seats.pending} invited` : "";
  return `${seats.used} of ${limit} used (${seats.members} ${seats.members === 1 ? "member" : "members"}${invited})`;
}
