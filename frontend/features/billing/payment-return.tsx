"use client";

import type { PaymentView } from "@pakka/types";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { fetchPayment, isPaymentId } from "./billing-data";
import { pollPayment, type PaymentOutcome } from "./payment-poll";

// The banner for /dashboard/billing?payment=<id>, where PayU sends the payer back. The address says only which payment to look at: it is
// never taken as the result. The banner asks GET /api/billing/payments/:id (payment-poll.ts) and shows what the API confirms. Only a
// confirmed success or failure calls `onConfirmed`, which is when the screen re-reads the plan and credits.

type State = { kind: "checking" } | PaymentOutcome;

const number = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });

/** What a confirmed payment bought, in words. */
function achieved(payment: PaymentView): string {
  switch (payment.kind) {
    case "subscribe":
      return "Your plan is active.";
    case "plan_change":
      return "Your plan has been changed.";
    case "renewal":
      return "Your plan renewal is paid.";
    case "topup":
      return "Your top-up credits have been added.";
    case "setup_fee":
      return "We've got your setup fee, and we'll call you to set things up.";
  }
}

export function PaymentReturn({ tenantId, paymentId, onConfirmed }: { tenantId: string; paymentId: string; onConfirmed: (payment: PaymentView) => void }) {
  const router = useRouter();
  const valid = isPaymentId(paymentId);
  const [state, setState] = useState<State>({ kind: "checking" });
  const [attempt, setAttempt] = useState(0);
  const confirmed = useRef(onConfirmed);
  useEffect(() => {
    confirmed.current = onConfirmed;
  }, [onConfirmed]);

  useEffect(() => {
    if (!valid) return;
    const control = new AbortController();
    void pollPayment({ fetchPayment: (signal) => fetchPayment(tenantId, paymentId, signal), signal: control.signal }).then((outcome) => {
      if (!outcome) return;
      setState(outcome);
      if (outcome.kind === "success" || outcome.kind === "failed") confirmed.current(outcome.payment);
    });
    return () => control.abort();
  }, [tenantId, paymentId, valid, attempt]);

  const dismiss = () => router.replace("/dashboard/billing");
  const again = () => {
    setState({ kind: "checking" });
    setAttempt((n) => n + 1);
  };
  const shown: State = valid ? state : { kind: "invalid" };

  let body: React.ReactNode;
  switch (shown.kind) {
    case "checking":
      body = <>Checking your payment with PayU. This can take up to a minute. Please keep this page open.</>;
      break;
    case "success":
      body = (
        <>
          <strong>Payment confirmed.</strong> {achieved(shown.payment)} (₹{number.format(shown.payment.amountInr)} including GST.)
        </>
      );
      break;
    case "failed":
      body = (
        <>
          <strong>The payment didn&apos;t go through.</strong> Your plan and credits weren&apos;t changed.
          {shown.payment.failureReason ? ` PayU said: ${shown.payment.failureReason.slice(0, 200)}` : ""}
        </>
      );
      break;
    case "processing":
      body = (
        <>
          <strong>Still processing.</strong> PayU hasn&apos;t confirmed this payment yet. Your plan and credits update as soon as it does. Check again in a minute.
        </>
      );
      break;
    case "invalid":
      body = (
        <>
          <strong>We couldn&apos;t find that payment.</strong> It isn&apos;t one of your business&apos;s payments, so nothing was changed.
        </>
      );
      break;
    case "error":
      body = (
        <>
          <strong>{shown.error.title}.</strong> {shown.error.message} We couldn&apos;t confirm the payment yet.
        </>
      );
      break;
  }

  const finished = shown.kind !== "checking";
  return (
    <div
      className="app-notice"
      role={shown.kind === "failed" || shown.kind === "error" || shown.kind === "invalid" ? "alert" : "status"}
      aria-busy={!finished}
      data-testid="payment-return"
      data-state={shown.kind}
      style={{ display: "flex", flexDirection: "column", gap: 10 }}
    >
      <p style={{ margin: 0 }}>{body}</p>
      {finished ? (
        <div className="app-actions">
          {shown.kind === "processing" || shown.kind === "error" ? (
            <button type="button" className="btn btn-primary" onClick={again}>
              Check again
            </button>
          ) : null}
          <button type="button" className="btn btn-secondary" onClick={dismiss}>
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}
