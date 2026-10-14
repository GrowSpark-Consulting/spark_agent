"use client";

import type { AccountStatus } from "@pakka/types";
import { useRef, useState } from "react";
import { ConfirmDialog } from "@/features/knowledge/confirm-dialog";
import { formatError, type FormattedError } from "@/lib/errors";
import { BillingDataError, cancelPlan, resumePlan } from "./billing-data";

// Cancel plan and Keep my plan (docs/contracts.md, "PayU billing": POST /api/billing/cancel and /resume, owner only, no body).
//   cancel  scheduled: the plan stops renewing and ends with the period already paid. ended: a plan whose renewal payment failed ends now and
//           the business is paused. Asking again changes nothing.
//   resume  a cancelled plan renews again while its period lasts.
// Neither moves money, so there is no PayU step. What the screen says afterwards is the API's answer; the plan is re-read from the API
// (`onChanged`) rather than edited here, so the card never shows a state the server did not confirm.

const date = (iso: string, timeZone: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone }).format(new Date(iso));

function describeError(err: unknown): FormattedError {
  if (err instanceof BillingDataError) {
    return { code: "internal", title: "Something went wrong", message: "Spark Agent answered something we didn't expect. Nothing was changed on our side that we can confirm. Reload the page to see your plan.", retryable: true };
  }
  return formatError(err);
}

export function PlanEnding({
  tenantId,
  timeZone,
  status,
  onChanged,
}: {
  tenantId: string;
  timeZone: string;
  /** The plan as the API last said it; null while it is loading or failed to load. The buttons follow it; the messages outlive a re-read. */
  status: AccountStatus | null;
  /** Re-read the plan from the API. */
  onChanged: () => void;
}) {
  // Only a plan in good standing can be cancelled or kept; a trial, a paused or cancelled business has nothing to do here.
  const active = status?.status === "active";
  const renewsAt = active ? status.renewsAt : null;
  const endsAt = active ? (status.endsAt ?? null) : null;
  const [confirming, setConfirming] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<FormattedError | null>(null);
  const lock = useRef(false);

  async function resume() {
    if (lock.current) return;
    lock.current = true;
    setResuming(true);
    setError(null);
    setDone(null);
    try {
      const result = await resumePlan(tenantId);
      setDone(`Done. Your plan will renew on ${date(result.renewsAt, timeZone)}.`);
      onChanged();
    } catch (err) {
      setError(describeError(err));
    } finally {
      lock.current = false;
      setResuming(false);
    }
  }

  async function cancel() {
    const result = await cancelPlan(tenantId);
    setDone(
      result.status === "scheduled"
        ? `Your plan is cancelled. It stays active until ${date(result.endsAt, timeZone)} and won't renew. You can keep it until then.`
        : "Your plan has ended and your assistant is paused. Pick a plan below to start again.",
    );
    setConfirming(false);
    onChanged();
  }

  if (!endsAt && !renewsAt && !done && !error) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }} data-testid="plan-ending">
      {endsAt ? (
        <>
          <p className="app-notice" role="status" data-testid="plan-ends" style={{ margin: 0 }}>
            <strong>Your plan is cancelled.</strong> It stays active until {date(endsAt, timeZone)} and won&apos;t renew.
          </p>
          <div className="app-actions">
            <button type="button" className="btn btn-primary" onClick={() => void resume()} disabled={resuming}>
              {resuming ? "Keeping your plan…" : "Keep my plan"}
            </button>
          </div>
        </>
      ) : renewsAt ? (
        <div className="app-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setConfirming(true)}>
            Cancel plan
          </button>
        </div>
      ) : null}
      {done ? (
        <p className="app-notice" role="status" data-testid="plan-ending-done" style={{ margin: 0 }}>
          {done}
        </p>
      ) : null}
      {error ? (
        <p className="app-notice" role="alert" data-testid="plan-ending-error" data-code={error.code} style={{ margin: 0 }}>
          <strong>{error.title}.</strong> {error.message}
        </p>
      ) : null}
      {confirming && renewsAt ? (
        <ConfirmDialog
          title="Cancel your plan?"
          text={`Your plan stops renewing and ends on ${date(renewsAt, timeZone)}. You keep it, and its credits, until then, and you can change your mind before that day. If your last renewal payment failed, cancelling ends the plan right away and pauses your assistant.`}
          confirmLabel="Cancel plan"
          busyLabel="Cancelling…"
          keepLabel="Keep my plan"
          onConfirm={cancel}
          describeError={describeError}
          onClose={() => setConfirming(false)}
        />
      ) : null}
    </div>
  );
}
