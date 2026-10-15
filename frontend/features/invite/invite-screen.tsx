"use client";

import type { InviteAccepted, InvitePreview } from "@pakka/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { chooseTenant } from "@/lib/auth/actions";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { acceptInvitation, acceptProblem, fetchInvite, isInviteToken, previewProblem, signInHref, signUpHref, type AcceptProblem, type PreviewProblem } from "./invite-api";

// /invite/:token: a person opens the link an owner or admin shared with them. Public to read (who invited them, as which role); joining needs
// a signed-in account whose email is the one invited, which the server checks. "Joined" is shown only after the server answers the accept
// call with a business; every refusal leaves the page honest about what happened and, where it makes sense, lets them try again.
// The token is read from the address and sent only to the invitation routes (invite-api.ts).

type Preview =
  | { status: "loading" }
  | { status: "invalid" }
  | { status: "problem"; problem: Exclude<PreviewProblem, "invalid"> }
  | { status: "ready"; invite: InvitePreview };

type Session = { status: "checking" } | { status: "signed_out" } | { status: "signed_in"; email: string | null };

type Attempt = { status: "idle" } | { status: "working" } | { status: "failed"; problem: AcceptProblem } | { status: "joined"; joined: InviteAccepted };

const ROLE_WORDS = { admin: "an admin", staff: "a staff member" } as const;

const PREVIEW_COPY: Record<Exclude<PreviewProblem, "invalid">, { title: string; body: string }> = {
  rate_limited: { title: "Too many tries", body: "Wait a minute, then try again." },
  failed: { title: "We couldn't check this invitation", body: "Check your connection and try again." },
};

const END_COPY = {
  expired: { title: "This invitation has expired", body: "Invitations last seven days. Ask whoever invited you to send you a new link." },
  used: { title: "This invitation was already used", body: "If that was you, sign in to open the business. Otherwise ask for a new invitation." },
  revoked: { title: "This invitation was cancelled", body: "Ask whoever invited you to send you a new link." },
} as const;

const ATTEMPT_COPY: Record<AcceptProblem, { title: string; body: string }> = {
  invalid: { title: "This invitation isn't valid anymore", body: "It may have expired, been used, cancelled or replaced by a newer link. Ask for a new one." },
  wrong_email: { title: "This invitation was sent to a different email address", body: "You're signed in with another account. Sign in with the address it was sent to, or ask for a new invitation to this one." },
  unconfirmed: { title: "Confirm your email address first", body: "Open the confirmation email we sent you, then come back to this page." },
  seat_limit: { title: "This business has no free team seat", body: "You haven't joined. Ask the owner to free a seat or upgrade their plan, then open this link again." },
  rate_limited: { title: "Too many tries", body: "Wait a minute, then try again." },
  signed_out: { title: "You're signed out", body: "Sign in again to join." },
  failed: { title: "We couldn't add you", body: "You haven't joined. Try again in a moment." },
};

export function InviteScreen({ token }: { token: string }) {
  const [preview, setPreview] = useState<Preview>(isInviteToken(token) ? { status: "loading" } : { status: "invalid" });
  const [session, setSession] = useState<Session>({ status: "checking" });
  const [attempt, setAttempt] = useState<Attempt>({ status: "idle" });
  const [reload, setReload] = useState(0);
  // A ref, not state: two quick presses must not send the request twice before a re-render.
  const running = useRef(false);

  useEffect(() => {
    if (!isInviteToken(token)) return;
    const controller = new AbortController();
    fetchInvite(token, controller.signal).then(
      (invite) => setPreview({ status: "ready", invite }),
      (err: unknown) => {
        if (controller.signal.aborted) return;
        const problem = previewProblem(err);
        setPreview(problem === "invalid" ? { status: "invalid" } : { status: "problem", problem });
      },
    );
    return () => controller.abort();
  }, [token, reload]);

  useEffect(() => {
    let live = true;
    getSupabaseBrowserClient()
      .auth.getSession()
      .then(
        ({ data }) => live && setSession(data.session ? { status: "signed_in", email: data.session.user.email ?? null } : { status: "signed_out" }),
        () => live && setSession({ status: "signed_out" }),
      );
    return () => {
      live = false;
    };
  }, []);

  const join = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setAttempt({ status: "working" });
    try {
      setAttempt({ status: "joined", joined: await acceptInvitation(token) });
    } catch (err) {
      const problem = acceptProblem(err);
      if (problem === "signed_out") setSession({ status: "signed_out" });
      setAttempt({ status: "failed", problem });
    } finally {
      running.current = false;
    }
  }, [token]);

  async function switchAccount() {
    await getSupabaseBrowserClient().auth.signOut();
    setSession({ status: "signed_out" });
    setAttempt({ status: "idle" });
  }

  const working = attempt.status === "working";
  const invite = preview.status === "ready" ? preview.invite : null;

  return (
    <main aria-labelledby="invite-heading" className="mx-auto flex min-h-screen max-w-[560px] flex-col gap-6 px-4 py-10 sm:px-6 sm:py-16">
      <p className="m-0 text-[13px] font-extrabold uppercase tracking-[.08em]">Spark Agent</p>

      {preview.status === "loading" ? (
        <p role="status" id="invite-heading" className="m-0 text-base text-neutral-700">
          Checking your invitation…
        </p>
      ) : null}

      {preview.status === "invalid" ? (
        <Notice tone="error" id="invite-heading" title="This invitation isn't valid" body="The link may be mistyped, or it was replaced by a newer one. Ask whoever invited you to send it again." testId="invite-invalid" />
      ) : null}

      {preview.status === "problem" ? (
        <>
          <Notice tone="error" id="invite-heading" title={PREVIEW_COPY[preview.problem].title} body={PREVIEW_COPY[preview.problem].body} testId="invite-problem" />
          <Button variant="secondary" className="self-start" onClick={() => { setPreview({ status: "loading" }); setReload((n) => n + 1); }}>
            Try again
          </Button>
        </>
      ) : null}

      {invite && invite.status !== "valid" ? (
        <>
          <Notice tone="error" id="invite-heading" title={END_COPY[invite.status].title} body={END_COPY[invite.status].body} testId={`invite-${invite.status}`} />
          {invite.status === "used" && session.status === "signed_out" ? (
            <Button asChild variant="primary" className="self-start">
              <a href={signInHref(token)}>Sign in</a>
            </Button>
          ) : null}
        </>
      ) : null}

      {invite && invite.status === "valid" ? (
        attempt.status === "joined" ? (
          <>
            <Notice
              tone="ok"
              id="invite-heading"
              title={attempt.joined.alreadyMember ? `You're already on the team at ${attempt.joined.businessName}` : `You've joined ${attempt.joined.businessName}`}
              body={attempt.joined.alreadyMember ? "Your role is unchanged." : `You're on the team as ${attempt.joined.role === "admin" ? ROLE_WORDS.admin : attempt.joined.role === "staff" ? ROLE_WORDS.staff : "the owner"}.`}
              testId="invite-joined"
            />
            <form action={chooseTenant}>
              <input type="hidden" name="tenantId" value={attempt.joined.tenantId} />
              <Button type="submit" variant="primary" className="min-w-[220px] px-[18px] py-3 text-base">
                Open {attempt.joined.businessName}
              </Button>
            </form>
          </>
        ) : (
          <>
            <div>
              <h1 id="invite-heading" className="m-0 mb-2 text-[clamp(28px,5vw,40px)]">
                Join {invite.businessName}
              </h1>
              <p className="m-0 text-base text-neutral-700">
                You&apos;ve been invited to join {invite.businessName} on Spark Agent as {ROLE_WORDS[invite.role]}. This invitation expires{" "}
                {new Date(invite.expiresAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}.
              </p>
            </div>

            {attempt.status === "failed" ? (
              <Notice tone="error" title={ATTEMPT_COPY[attempt.problem].title} body={ATTEMPT_COPY[attempt.problem].body} testId="invite-failed" />
            ) : null}

            {session.status === "checking" ? (
              <p role="status" className="m-0 text-sm text-neutral-700">
                Checking your sign-in…
              </p>
            ) : null}

            {session.status === "signed_out" ? (
              <div className="flex flex-col gap-3">
                <p className="m-0 text-sm text-neutral-700">Sign in with the email address this invitation was sent to. New to Spark Agent? Create an account with that address.</p>
                <div className="flex flex-wrap gap-3">
                  <Button asChild variant="primary">
                    <a href={signInHref(token)}>Sign in to join</a>
                  </Button>
                  <Button asChild variant="secondary">
                    <a href={signUpHref(token)}>Create an account</a>
                  </Button>
                </div>
              </div>
            ) : null}

            {session.status === "signed_in" ? (
              <div className="flex flex-col gap-3">
                <p className="m-0 text-sm text-neutral-700">
                  {session.email ? <>You&apos;re signed in as <strong>{session.email}</strong>. </> : null}
                  You can only join with the email address the invitation was sent to.
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="primary" className="min-w-[200px] px-[18px] py-3 text-base" disabled={working} aria-busy={working || undefined} onClick={() => void join()}>
                    {working ? "Joining…" : `Join ${invite.businessName}`}
                  </Button>
                  <Button variant="secondary" disabled={working} onClick={() => void switchAccount()}>
                    Use a different account
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        )
      ) : null}
    </main>
  );
}

function Notice({ id, tone, title, body, testId }: { id?: string; tone: "ok" | "error"; title: string; body: string; testId: string }) {
  return (
    <div role={tone === "error" ? "alert" : "status"} data-testid={testId} className="border-2 border-foreground px-4 py-3 text-sm">
      <strong id={id} className="block text-base">
        {title}
      </strong>
      <span className="text-neutral-700">{body}</span>
    </div>
  );
}
