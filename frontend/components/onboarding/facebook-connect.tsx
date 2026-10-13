"use client";

import * as React from "react";
import type { WhatsAppConnectionPublic } from "@pakka/types";

import { Button } from "@/components/ui/button";
import { ConnectionResult } from "@/components/onboarding/own-app-connect";
import { metaSignupConfig } from "@/lib/env";
import { resolveWhatsAppTenant, type WhatsAppTenantResult } from "@/lib/whatsapp/manual-connect";
import { createOwnerSignup, type OwnerSignupResult } from "@/lib/whatsapp/owner-embedded-signup";

// The "Connect with Facebook" button of the wizard's WhatsApp step: the real Meta Embedded Signup for the signed-in owner
// (lib/whatsapp/owner-embedded-signup.ts). Facebook's script is loaded only when the button is pressed. The screen says
// "Connected" only when the API answered with an active connection; every other outcome says what happened and that
// nothing is connected.

type Attempt = { state: "idle" } | { state: "working" } | OwnerSignupResult;

const NOT_ACTIVE = {
  title: "The number was saved but isn’t connected yet",
  body: "It didn’t pass the checks below, so the assistant won’t reply from it yet. Fix what they say, then recheck it from your dashboard’s WhatsApp page.",
};

export function FacebookConnect({
  coexistence,
  onConnected,
}: {
  coexistence: boolean;
  onConnected: (connection: WhatsAppConnectionPublic) => void;
}) {
  const configured = metaSignupConfig().status === "ready";
  const [signup] = React.useState(() => createOwnerSignup());
  const [attempt, setAttempt] = React.useState<Attempt>({ state: "idle" });
  // The business the step is for, read when the step opens; worked out again after the popup, before anything is sent.
  const [tenant, setTenant] = React.useState<WhatsAppTenantResult | null>(null);
  const [tenantTry, setTenantTry] = React.useState(0);

  React.useEffect(() => {
    if (!configured) return;
    let live = true;
    resolveWhatsAppTenant().then(
      (found) => live && setTenant(found),
      () => live && setTenant({ state: "error", message: "We couldn’t load your business. Try again in a moment.", retryable: true }),
    );
    return () => {
      live = false;
    };
  }, [configured, tenantTry]);

  const start = () => {
    if (tenant?.state !== "ready") return;
    // No await before start(): the popup must open as part of this click.
    const run = signup.start({ coexistence, tenantId: tenant.tenantId });
    setAttempt({ state: "working" });
    void run.then((result) => {
      if (!result) return; // a second press while one run is open: nothing was started
      setAttempt(result);
      if (result.state === "connected") onConnected(result.connection);
    });
  };

  if (!configured) {
    return (
      <div role="note" data-testid="facebook-not-configured" className="border-2 border-foreground px-4 py-3 text-sm flex flex-col gap-1">
        <strong>Connecting with Facebook isn’t set up on this site yet.</strong>
        <span className="text-neutral-700">
          Nothing is sent to Meta and no number is connected. Choose a manual connection, or skip this step and connect later from your
          dashboard.
        </span>
      </div>
    );
  }

  if (attempt.state === "connected" && attempt.connection.status === "active") {
    return (
      <div data-testid="facebook-result" data-state="connected">
        <ConnectionResult connection={attempt.connection} />
      </div>
    );
  }

  const working = attempt.state === "working";
  const canRetry =
    attempt.state === "idle" ||
    attempt.state === "cancelled" ||
    (attempt.state === "failed" && attempt.retryable) ||
    (attempt.state === "connected" && attempt.connection.status !== "active");

  return (
    <div className="flex flex-col gap-3">
      {tenant === null ? (
        <p role="status" className="m-0 text-sm text-neutral-700">
          Getting your business ready…
        </p>
      ) : null}
      {tenant?.state === "error" ? (
        <div role="alert" data-testid="facebook-business" className="border-2 border-primary bg-brand-100 text-brand-900 px-3.5 py-3 text-sm flex flex-col gap-2">
          <span>{tenant.message}</span>
          {tenant.retryable ? (
            <Button variant="secondary" className="self-start" onClick={() => { setTenant(null); setTenantTry((n) => n + 1); }}>
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}

      <Outcome attempt={attempt} />

      {tenant?.state === "ready" && canRetry ? (
        <Button
          variant="primary"
          onClick={start}
          disabled={working}
          aria-busy={working}
          data-testid="facebook-connect"
          className="self-start text-base px-[18px] py-3 min-w-[260px] justify-start"
        >
          {attempt.state === "idle" ? "Continue with Facebook" : "Try again with Facebook"}
        </Button>
      ) : null}
      {working ? (
        <Button variant="primary" disabled aria-busy data-testid="facebook-working" className="self-start text-base px-[18px] py-3 min-w-[260px] justify-start">
          Waiting for Facebook…
        </Button>
      ) : null}
    </div>
  );
}

function Outcome({ attempt }: { attempt: Attempt }) {
  const box = (testId: string, state: string, title: string, body: string, role: "status" | "alert" = "alert") => (
    <div role={role} data-testid={testId} data-state={state} className="border-2 border-primary bg-brand-100 text-brand-900 px-3.5 py-3 text-sm">
      <strong>{title}</strong> {body}
    </div>
  );
  switch (attempt.state) {
    case "idle":
      return null;
    case "working":
      return (
        <p role="status" aria-live="polite" data-testid="facebook-result" data-state="working" className="m-0 text-sm">
          Finish the steps in Facebook’s window. Keep this page open; we’ll connect your number when it closes.
        </p>
      );
    case "cancelled":
      return box(
        "facebook-result",
        "cancelled",
        attempt.step ? `You closed Facebook’s window at “${attempt.step}”.` : "You closed Facebook’s window.",
        "Nothing was connected. Try again when you’re ready.",
        "status",
      );
    case "not_configured":
      return box("facebook-result", "not_configured", "Connecting with Facebook isn’t set up on this site yet.", "Nothing was connected.");
    case "not_available":
      return box(
        "facebook-result",
        "not_available",
        "Connecting with Facebook isn’t switched on yet.",
        `Nothing was connected. ${attempt.message} You can choose a manual connection, or skip this step and connect later from your dashboard.`,
      );
    case "failed":
      return box("facebook-result", "failed", "Your number wasn’t connected.", attempt.message);
    case "connected":
      // Only a saved number that is not active reaches here (an active one is drawn by FacebookConnect).
      return (
        <div data-testid="facebook-result" data-state="saved_not_active">
          <ConnectionResult connection={attempt.connection} notActive={NOT_ACTIVE} />
        </div>
      );
  }
}
