"use client";

import type { InviteRole, TeamInvite, TeamOverview } from "@pakka/types";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/shared/states";
import { ConfirmDialog } from "@/features/knowledge/confirm-dialog";
import { sectionHead, sectionTitle } from "@/features/settings/section";
import { formatError, type FormattedError } from "@/lib/errors";
import { cancelInvite, copyText, describeInviteError, expiryLabel, fetchTeam, resendInvite, seatSummary, sendInvite, validateInvite, type InviteProblem } from "./team-api";

// The Team screen's members, seats and invitations (migration 0052). The server decides everything: the roles offered in the form are the
// ones it said this member may invite, and a refusal is shown whatever the screen thought. No email is sent: the link is copied and passed on
// by hand, and it is shown once, right after it is made or made again. It lives only in this component's memory.

type State = { status: "loading" } | { status: "error"; error: FormattedError } | { status: "ready"; team: TeamOverview };

/** The link just made, with who it is for. Cleared when dismissed or when another is made. */
type Reveal = { url: string; name: string; email: string; expiresAt: string; resendsLeft?: number };

const ROLE_LABEL = { owner: "Owner", admin: "Admin", staff: "Staff" } as const;
const field = { display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 } as const;
const row = { display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: "12px", alignItems: "center", padding: "10px 0", borderBottom: "1px solid var(--color-divider)", fontSize: "14px" } as const;

export function MembersSection({ tenantId }: { tenantId: string }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [cancelling, setCancelling] = useState<TeamInvite | null>(null);
  const [rowProblem, setRowProblem] = useState<{ id: string; problem: InviteProblem } | null>(null);
  const [resending, setResending] = useState<string | null>(null);
  const resendLock = useRef(false);

  const load = useCallback(
    () =>
      fetchTeam(tenantId).then(
        (team) => setState({ status: "ready", team }),
        (err: unknown) => setState({ status: "error", error: formatError(err) }),
      ),
    [tenantId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function resend(invite: TeamInvite) {
    if (resendLock.current) return;
    resendLock.current = true;
    setResending(invite.id);
    setRowProblem(null);
    try {
      const sent = await resendInvite(tenantId, invite.id);
      setReveal({ url: sent.url, name: sent.invite.name, email: sent.invite.email, expiresAt: sent.invite.expiresAt, resendsLeft: sent.resendsLeft });
      await load();
    } catch (err) {
      const problem = describeInviteError(err, "resend");
      setRowProblem({ id: invite.id, problem });
      if (problem.kind === "gone" || problem.kind === "seat_limit") await load();
    } finally {
      resendLock.current = false;
      setResending(null);
    }
  }

  const team = state.status === "ready" ? state.team : null;
  const canInvite = team !== null && team.inviteRoles.length > 0;

  return (
    <section aria-labelledby="members-heading" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div style={sectionHead}>
        <h2 id="members-heading" style={sectionTitle}>
          Team members
        </h2>
        {team ? (
          <span className="app-hint" data-testid="seat-summary" style={{ margin: 0 }}>
            {seatSummary(team.seats)}
          </span>
        ) : null}
      </div>

      {state.status === "loading" ? <LoadingState compact title="Loading your team" /> : null}
      {state.status === "error" ? (
        <ErrorState
          compact
          title="Couldn't load your team"
          description={state.error.message}
          onRetry={() => {
            setState({ status: "loading" });
            void load();
          }}
        />
      ) : null}

      {team ? (
        <>
          <ul aria-label="Members" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {team.members.map((m) => (
              <li key={m.userId} style={row}>
                <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                  <strong>{m.name ?? m.email ?? "Team member"}</strong>
                  {m.you ? <span className="app-hint"> (you)</span> : null}
                  {m.name && m.email ? <span className="app-hint" style={{ display: "block" }}>{m.email}</span> : null}
                </span>
                <span style={{ fontWeight: 600 }}>{ROLE_LABEL[m.role]}</span>
              </li>
            ))}
          </ul>

          {reveal ? <InviteLinkPanel reveal={reveal} onDismiss={() => setReveal(null)} /> : null}

          {team.invites.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              <h3 style={{ ...sectionTitle, marginTop: "12px" }}>Invited, not joined yet</h3>
              <ul aria-label="Pending invitations" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {team.invites.map((invite) => (
                  <li key={invite.id} style={{ ...row, gridTemplateColumns: "minmax(0,1fr)" }}>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 16px", alignItems: "center", justifyContent: "space-between" }}>
                      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                        <strong>{invite.name}</strong> <span className="app-hint">{invite.email}</span>
                        <span className="app-hint" style={{ display: "block" }}>
                          {ROLE_LABEL[invite.role]} · {expiryLabel(invite)}
                          {invite.expired ? " · no longer holds a seat" : ""}
                        </span>
                      </span>
                      <span style={{ display: "flex", gap: "4px" }}>
                        <button type="button" className="btn btn-ghost" disabled={resending !== null} onClick={() => void resend(invite)}>
                          {resending === invite.id ? "Making a new link…" : "New link"}
                        </button>
                        <button type="button" className="btn btn-ghost" disabled={resending !== null} onClick={() => setCancelling(invite)}>
                          Cancel
                        </button>
                      </span>
                    </div>
                    {rowProblem?.id === invite.id ? <ProblemNote problem={rowProblem.problem} /> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {canInvite ? (
            <InviteForm
              key={team.inviteRoles.join(",")}
              roles={team.inviteRoles}
              seats={team.seats}
              onInvited={async (created) => {
                setReveal({ url: created.url, name: created.invite.name, email: created.invite.email, expiresAt: created.invite.expiresAt });
                await load();
              }}
              onRefresh={load}
              tenantId={tenantId}
            />
          ) : (
            <p className="app-hint" style={{ margin: 0 }}>
              Only an owner or admin can invite people.
            </p>
          )}

          {team.members.length === 1 && team.invites.length === 0 && canInvite ? (
            <EmptyState compact title="You're the only one here" description="Invite a teammate so they can answer chats and see leads." />
          ) : null}
        </>
      ) : null}

      {cancelling ? (
        <ConfirmDialog
          title={`Cancel the invitation for ${cancelling.name}?`}
          text="Their link stops working at once and the seat is free again. You can invite them again later."
          confirmLabel="Cancel invitation"
          busyLabel="Cancelling…"
          keepLabel="Keep it"
          onConfirm={async () => {
            await cancelInvite(tenantId, cancelling.id);
            setReveal((r) => (r && r.email === cancelling.email ? null : r));
            setCancelling(null);
            await load();
          }}
          describeError={(err) => {
            const problem = describeInviteError(err, "cancel");
            return { code: "internal", title: problem.title, message: problem.message, retryable: false };
          }}
          onClose={() => setCancelling(null)}
        />
      ) : null}
    </section>
  );
}

function ProblemNote({ problem }: { problem: InviteProblem }) {
  return (
    <p role="alert" className="app-field-error" style={{ margin: "6px 0 0" }}>
      <strong>{problem.title}.</strong> {problem.message}
      {problem.kind === "seat_limit" ? (
        <>
          {" "}
          <Link href="/dashboard/billing">See plans</Link>
        </>
      ) : null}
    </p>
  );
}

function InviteForm({
  tenantId,
  roles,
  seats,
  onInvited,
  onRefresh,
}: {
  tenantId: string;
  roles: InviteRole[];
  seats: TeamOverview["seats"];
  onInvited: (created: Awaited<ReturnType<typeof sendInvite>>) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>(roles.length === 1 ? roles[0] : "");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<InviteProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);

  const full = seats.limit !== "unlimited" && seats.used >= seats.limit;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (lock.current) return;
    const checked = validateInvite({ name, email, role });
    if (!checked.ok) {
      setFields(checked.fields);
      setProblem(null);
      return;
    }
    lock.current = true;
    setBusy(true);
    setFields({});
    setProblem(null);
    try {
      await onInvited(await sendInvite(tenantId, checked.value));
      setName("");
      setEmail("");
      setRole(roles.length === 1 ? roles[0] : "");
    } catch (err) {
      const failed = describeInviteError(err, "invite");
      setProblem(failed);
      setFields(failed.fields);
      // Someone else may have filled the last seat, or invited this address, a moment ago: show the list as it is now.
      if (failed.kind === "seat_limit" || failed.kind === "duplicate") await onRefresh();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <form className="app-form" onSubmit={submit} noValidate aria-label="Invite a teammate" style={{ gap: "12px", marginTop: "12px" }}>
      <h3 style={sectionTitle}>Invite a teammate</h3>
      <p className="app-hint" style={{ margin: 0 }}>
        We don&apos;t send an email. You&apos;ll get a link to pass on yourself, by WhatsApp or email. It works for seven days, and a pending invitation takes up a seat.
      </p>
      {full ? (
        <p className="app-hint" role="status" style={{ margin: 0 }} data-testid="seats-full">
          Every seat on your {seats.planName} plan is taken. <Link href="/dashboard/billing">See plans</Link>
        </p>
      ) : null}
      <div className="field" style={field}>
        <label htmlFor="invite-name">Name</label>
        <input id="invite-name" className="input" autoComplete="off" value={name} disabled={busy} aria-invalid={fields.name ? true : undefined} aria-describedby={fields.name ? "invite-name-error" : undefined} onChange={(e) => { setName(e.target.value); setFields((f) => ({ ...f, name: "" })); }} />
        {fields.name ? <p id="invite-name-error" className="app-field-error">{fields.name}</p> : null}
      </div>
      <div className="field" style={field}>
        <label htmlFor="invite-email">Email</label>
        <input id="invite-email" className="input" type="email" autoComplete="off" value={email} disabled={busy} aria-invalid={fields.email ? true : undefined} aria-describedby={fields.email ? "invite-email-error" : "invite-email-hint"} onChange={(e) => { setEmail(e.target.value); setFields((f) => ({ ...f, email: "" })); }} />
        {fields.email ? <p id="invite-email-error" className="app-field-error">{fields.email}</p> : <p id="invite-email-hint" className="app-hint">They must sign in with this address to join.</p>}
      </div>
      <div className="field" style={field}>
        <label htmlFor="invite-role">Role</label>
        <select id="invite-role" className="input" value={role} disabled={busy} aria-invalid={fields.role ? true : undefined} onChange={(e) => { setRole(e.target.value); setFields((f) => ({ ...f, role: "" })); }}>
          {roles.length > 1 ? <option value="">Choose a role</option> : null}
          {roles.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        {fields.role ? <p className="app-field-error">{fields.role}</p> : null}
      </div>
      {problem && problem.kind !== "validation" ? <ErrorState compact title={problem.title} description={problem.message} action={problem.kind === "seat_limit" ? <Link className="btn btn-secondary" href="/dashboard/billing">See plans</Link> : undefined} /> : null}
      <div className="app-actions">
        <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy || undefined}>
          {busy ? "Making the link…" : "Make invitation link"}
        </button>
      </div>
    </form>
  );
}

function InviteLinkPanel({ reveal, onDismiss }: { reveal: Reveal; onDismiss: () => void }) {
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function copy() {
    const ok = await copyText(reveal.url);
    if (!ok) input.current?.select();
    setCopied(ok ? "yes" : "no");
  }

  return (
    <div role="region" aria-label="Invitation link" data-testid="invite-link-panel" style={{ border: "2px solid var(--color-text)", padding: "16px", display: "flex", flexDirection: "column", gap: "8px" }}>
      <strong>Invitation link for {reveal.name}</strong>
      <p className="app-hint" style={{ margin: 0 }}>
        Copy it now and send it to {reveal.email} yourself. We haven&apos;t emailed anyone, and for safety this link can&apos;t be shown again: if you lose it, use &ldquo;New link&rdquo;, which stops this one.
        {" "}It works until {new Date(reveal.expiresAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}.
        {reveal.resendsLeft !== undefined ? ` ${reveal.resendsLeft} new ${reveal.resendsLeft === 1 ? "link" : "links"} left today.` : ""}
      </p>
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <input ref={input} className="input" readOnly aria-label="Invitation link" value={reveal.url} onFocus={(e) => e.currentTarget.select()} style={{ flex: "1 1 240px", minWidth: 0 }} />
        <button type="button" className="btn btn-primary" onClick={() => void copy()}>
          Copy link
        </button>
        <button type="button" className="btn btn-secondary" onClick={onDismiss}>
          Done
        </button>
      </div>
      <p role="status" className="app-hint" style={{ margin: 0, minHeight: "1.2em" }}>
        {copied === "yes" ? "Link copied." : copied === "no" ? "Your browser wouldn't copy it. The link is selected: copy it with Ctrl+C or Cmd+C." : ""}
      </p>
    </div>
  );
}
