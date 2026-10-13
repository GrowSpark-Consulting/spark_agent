"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { metaSignupConfig, setupCallUrl } from "@/lib/env";
import { runEmbeddedSignup } from "@/lib/whatsapp/facebook-sdk";
import { fetchConnectLink, isLinkToken, linkProblem, submitEmbeddedSignup, submitProblem, type ConnectLink, type LinkProblem, type SubmitProblem } from "./connect-link";

// /connect/:token: the assisted connection page. Public: the link is the only credential. It reads who the link is for, then runs Meta's
// Embedded Signup and sends the result to the API. "Connected" is shown only when the API answers 201; a closed window, a Meta error, an
// expired or used link and a switched-off flow each get their own plain words, and the page never says a number is connected on its own.
// connect-link.ts has the contract; the token and Meta's code are never logged, stored or put in the address bar.

type Link =
  | { status: "loading" }
  | { status: "invalid" }
  | { status: "problem"; problem: Exclude<LinkProblem, "invalid"> }
  | { status: "ready"; link: ConnectLink };

type Attempt =
  | { status: "idle" }
  | { status: "working"; step: "meta" | "saving" }
  | { status: "cancelled" }
  | { status: "failed"; problem: SubmitProblem | "meta_error" | "incomplete" | "script" }
  | { status: "connected"; connectionStatus: string };

const PROBLEM_COPY: Record<Exclude<LinkProblem, "invalid">, { title: string; body: string }> = {
  not_available: { title: "Connecting through Facebook isn’t switched on yet", body: "Nothing was changed. Use the setup call below, and we’ll connect your number with you." },
  rate_limited: { title: "Too many tries", body: "Wait a minute, then try again." },
  failed: { title: "We couldn’t check this link", body: "Check your connection and try again." },
};

const ATTEMPT_COPY: Record<Extract<Attempt, { status: "failed" }>["problem"], { title: string; body: string }> = {
  invalid: { title: "This link can’t be used any more", body: "It has expired or was already used. Ask for a new one." },
  conflict: { title: "That number is already connected", body: "If you didn’t expect this, ask us to check it with you." },
  not_available: { title: "Connecting through Facebook isn’t switched on yet", body: "Nothing was changed. Use the setup call below." },
  meta_failed: { title: "Meta didn’t accept the connection", body: "Nothing was changed. Try again, or use the setup call below." },
  failed: { title: "We couldn’t finish connecting", body: "Nothing was changed. Try again, or use the setup call below." },
  meta_error: { title: "Meta reported a problem", body: "Nothing was changed. Try again, or use the setup call below." },
  incomplete: { title: "The Meta window didn’t finish", body: "Nothing was changed. Try again." },
  script: { title: "Facebook’s sign-in couldn’t start", body: "Check your connection and try again." },
};

export function ConnectScreen({ token }: { token: string }) {
  const [link, setLink] = useState<Link>(isLinkToken(token) ? { status: "loading" } : { status: "invalid" });
  const [attempt, setAttempt] = useState<Attempt>({ status: "idle" });
  const [coexistence, setCoexistence] = useState<boolean | null>(null);
  const [tries, setTries] = useState(0);
  // A ref, not state: two quick presses must not both start the popup before a re-render.
  const running = useRef(false);

  useEffect(() => {
    if (!isLinkToken(token)) return;
    const controller = new AbortController();
    fetchConnectLink(token, controller.signal).then(
      (found) => !controller.signal.aborted && setLink({ status: "ready", link: found }),
      (err: unknown) => {
        if (controller.signal.aborted) return;
        const problem = linkProblem(err);
        setLink(problem === "invalid" ? { status: "invalid" } : { status: "problem", problem });
      },
    );
    return () => controller.abort();
  }, [token, tries]);

  const start = useCallback(async () => {
    if (running.current || coexistence === null) return;
    running.current = true;
    setAttempt({ status: "working", step: "meta" });
    try {
      const outcome = await runEmbeddedSignup(metaSignupConfig(), { coexistence });
      if (outcome.status === "unavailable") return setAttempt({ status: "failed", problem: "not_available" });
      if (outcome.status === "cancelled") return setAttempt({ status: "cancelled" });
      if (outcome.status === "failed") return setAttempt({ status: "failed", problem: outcome.reason === "error" ? "meta_error" : "incomplete" });
      setAttempt({ status: "working", step: "saving" });
      try {
        const connected = await submitEmbeddedSignup(token, outcome.payload);
        setAttempt({ status: "connected", connectionStatus: connected.status });
      } catch (err) {
        setAttempt({ status: "failed", problem: submitProblem(err) });
      }
    } catch {
      setAttempt({ status: "failed", problem: "script" });
    } finally {
      running.current = false;
    }
  }, [coexistence, token]);

  const setupCall = setupCallUrl();
  const working = attempt.status === "working";

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[640px] flex-col gap-6 px-4 py-10" aria-labelledby="connect-heading">
      <p className="m-0 text-[13px] font-extrabold uppercase tracking-[.08em]">Spark Agent</p>

      {link.status === "loading" ? (
        <p role="status" className="m-0 text-base text-neutral-700">
          Checking your link…
        </p>
      ) : null}

      {link.status === "invalid" ? (
        <Notice id="connect-heading" tone="error" title="This link isn’t valid" body="It may have expired, been used already, or be mistyped. Ask for a new link." testId="connect-invalid" />
      ) : null}

      {link.status === "problem" ? (
        <>
          <Notice id="connect-heading" tone="error" title={PROBLEM_COPY[link.problem].title} body={PROBLEM_COPY[link.problem].body} testId="connect-problem" />
          {link.problem !== "not_available" ? (
            <Button variant="secondary" className="self-start" onClick={() => { setLink({ status: "loading" }); setTries((n) => n + 1); }}>
              Try again
            </Button>
          ) : null}
          {link.problem === "not_available" ? <SetupCall url={setupCall} /> : null}
        </>
      ) : null}

      {link.status === "ready" ? (
        <>
          <div>
            <h1 id="connect-heading" className="m-0 mb-2 text-[clamp(28px,5vw,40px)]">
              Connect {link.link.tenantName} to WhatsApp
            </h1>
            <p className="m-0 text-base text-neutral-700">
              You’ll log in with Facebook in a pop-up and confirm the number. About 3 minutes. This link works once and expires {new Date(link.link.expiresAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}.
            </p>
          </div>

          {attempt.status === "connected" ? (
            <Notice tone="ok" title="Your number was sent to Spark Agent" body={`Spark Agent confirmed it (status: ${attempt.connectionStatus}). You can close this page; we’ll be in touch if anything else is needed.`} testId="connect-done" />
          ) : (
            <>
              <fieldset className="m-0 flex flex-col gap-2 border-0 p-0" disabled={working}>
                <legend className="mb-1 text-[13px] font-extrabold uppercase tracking-[.08em]">Is this number on the WhatsApp Business app today?</legend>
                {[
                  { value: true, name: "Yes, keep the app working", body: "Your chats and contacts stay on your phone." },
                  { value: false, name: "No, it’s a new number or not on the app", body: "We’ll register it fresh. It can’t be used in the WhatsApp app afterwards." },
                ].map((o) => (
                  <label key={String(o.value)} className="flex cursor-pointer items-start gap-2.5 border-b border-divider py-3">
                    <input type="radio" name="coexistence" className="mt-1" checked={coexistence === o.value} onChange={() => setCoexistence(o.value)} />
                    <span>
                      <strong className="block text-[15px]">{o.name}</strong>
                      <span className="text-[13px] text-neutral-700">{o.body}</span>
                    </span>
                  </label>
                ))}
              </fieldset>

              {attempt.status === "cancelled" ? <Notice tone="info" title="You closed the Meta window" body="Nothing was changed. Try again when you’re ready." testId="connect-cancelled" /> : null}
              {attempt.status === "failed" ? <Notice tone="error" title={ATTEMPT_COPY[attempt.problem].title} body={ATTEMPT_COPY[attempt.problem].body} testId="connect-failed" /> : null}
              {working ? (
                <p role="status" className="m-0 text-sm text-neutral-700">
                  {attempt.step === "meta" ? "Waiting for the Meta window…" : "Sending your number to Spark Agent…"}
                </p>
              ) : null}

              <Button variant="primary" className="min-w-[260px] self-start px-[18px] py-3 text-base" disabled={working || coexistence === null} aria-busy={working || undefined} onClick={() => void start()}>
                Continue with Facebook
              </Button>
              {coexistence === null ? <p className="m-0 text-[13px] text-neutral-700">Choose one above to continue.</p> : null}
              <SetupCall url={setupCall} />
            </>
          )}
        </>
      ) : null}
    </main>
  );
}

function Notice({ id, tone, title, body, testId }: { id?: string; tone: "ok" | "error" | "info"; title: string; body: string; testId: string }) {
  return (
    <div role={tone === "error" ? "alert" : "status"} data-testid={testId} className="border-2 border-foreground px-4 py-3 text-sm">
      <strong id={id} className="block text-base">
        {title}
      </strong>
      <span className="text-neutral-700">{body}</span>
    </div>
  );
}

function SetupCall({ url }: { url: string | null }) {
  return (
    <div className="flex flex-col gap-1 text-sm" data-testid="setup-call">
      <strong>Prefer to do it with us?</strong>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" className="font-bold underline">
          Book a setup call
        </a>
      ) : (
        <span className="text-neutral-700">Reply to the person who sent you this link and we’ll set it up with you on a call.</span>
      )}
    </div>
  );
}
