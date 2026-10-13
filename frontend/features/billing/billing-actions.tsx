"use client";

import type { BILLING_CYCLES, CheckoutInput } from "@pakka/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatError, type FormattedError } from "@/lib/errors";
import { BillingDataError, changePlan, startCheckout, startSetupFee, startTopup } from "./billing-data";
import { PayuFormError, submitPayuForm } from "./payu-form";

// The owner's payment actions on the Billing screen (docs/contracts.md, "PayU billing"). Each one asks the API to start a payment and,
// when the answer is PayU's checkout details, posts them to PayU in a real form (payu-form.ts); the browser then leaves for PayU and
// comes back to /dashboard/billing?payment=<id>, where payment-return.tsx finds out what happened. Nothing here says a payment worked.
//   checkout     the first plan (a business with no live plan)         → PayU
//   change_plan  a business on a paid plan: upgrade → PayU; downgrade → scheduled; same plan → kept or unchanged (no PayU)
//   topup, setup_fee                                                   → PayU
// One request at a time: a second click while one is running does nothing (a ref, because state updates after the click).

export type PlanKey = CheckoutInput["planKey"];
export type BillingCycle = (typeof BILLING_CYCLES)[number];

export type BillingAction =
  | { kind: "checkout"; planKey: PlanKey; cycle: BillingCycle }
  | { kind: "change_plan"; planKey: PlanKey }
  | { kind: "topup" }
  | { kind: "setup_fee" };

/** Which button a running action belongs to, so only that one says it is working. */
export const sameAction = (a: BillingAction | null, b: BillingAction): boolean =>
  a !== null && a.kind === b.kind && ("planKey" in a ? "planKey" in b && a.planKey === b.planKey : true);

const titleCase = (key: string) => key.charAt(0).toUpperCase() + key.slice(1);
const date = (iso: string, timeZone: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone }).format(new Date(iso));

/** Words for a failure; the API's own refusals (not the owner, already on a plan, not switched on) keep their message. */
function actionError(err: unknown): FormattedError {
  if (err instanceof PayuFormError) {
    return { code: "internal", title: "Couldn't open PayU", message: "We couldn't open PayU's payment page, so nothing was charged. Try again in a moment.", retryable: true };
  }
  if (err instanceof BillingDataError) {
    return { code: "internal", title: "Something went wrong", message: "Spark Agent answered something we didn't expect, so nothing was sent to PayU and nothing was charged. Try again in a moment.", retryable: true };
  }
  return formatError(err);
}

export interface BillingActions {
  /** The action in progress, if any. */
  busy: BillingAction | null;
  /** The action PayU is waiting on a phone number for, with the API's (or the form's) reason. */
  needPhone: { action: BillingAction; message: string } | null;
  error: FormattedError | null;
  /** A plan change that finished without PayU (scheduled, kept, unchanged). */
  done: string | null;
  run: (action: BillingAction, phone?: string) => Promise<void>;
  cancelPhone: () => void;
}

export function useBillingActions(tenantId: string, timeZone: string): BillingActions {
  const lock = useRef(false);
  const [busy, setBusy] = useState<BillingAction | null>(null);
  const [needPhone, setNeedPhone] = useState<BillingActions["needPhone"]>(null);
  const [error, setError] = useState<FormattedError | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Back from PayU with the browser's back button can restore this page as it was when it left: working, buttons off. Start over.
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      lock.current = false;
      setBusy(null);
    };
    window.addEventListener("pageshow", restored);
    return () => window.removeEventListener("pageshow", restored);
  }, []);

  const run = useCallback(
    async (action: BillingAction, phone?: string) => {
      if (lock.current) return;
      lock.current = true;
      setBusy(action);
      setError(null);
      setDone(null);
      setNeedPhone(null);
      let leaving = false;
      try {
        const withPhone = phone ? { phone } : {};
        if (action.kind === "change_plan") {
          const result = await changePlan(tenantId, { planKey: action.planKey, ...withPhone });
          if (result.action === "upgrade") {
            leaving = true;
            submitPayuForm(result.payu);
          } else if (result.action === "scheduled") {
            setDone(`Your plan changes to ${titleCase(result.planKey)} on ${date(result.effectiveAt, timeZone)}. Until then you keep your current plan and credits.`);
          } else if (result.action === "kept") {
            setDone("Done. The plan change that was scheduled is cancelled, and you stay on your current plan.");
          } else {
            setDone("You're already on that plan. Nothing was changed.");
          }
        } else {
          const checkout =
            action.kind === "checkout"
              ? await startCheckout(tenantId, { planKey: action.planKey, cycle: action.cycle, ...withPhone })
              : action.kind === "topup"
                ? await startTopup(tenantId, withPhone)
                : await startSetupFee(tenantId, withPhone);
          leaving = true;
          submitPayuForm(checkout.payu);
        }
      } catch (err) {
        leaving = false;
        const shown = actionError(err);
        // PayU needs a phone: the API asks for one when the owner has none saved (fields.phone); a mistyped one fails the same way.
        if (shown.code === "validation_failed" && shown.fields?.phone) setNeedPhone({ action, message: shown.fields.phone });
        else setError(shown);
      } finally {
        // Leaving for PayU keeps the buttons off until the page is gone.
        if (!leaving) {
          lock.current = false;
          setBusy(null);
        }
      }
    },
    [tenantId, timeZone],
  );

  const cancelPhone = useCallback(() => setNeedPhone(null), []);
  return { busy, needPhone, error, done, run, cancelPhone };
}

/** The phone PayU asks for. Asked only when the API says it has none for the owner. */
export function PhonePrompt({ actions }: { actions: BillingActions }) {
  const { needPhone, busy, run, cancelPhone } = actions;
  const [phone, setPhone] = useState("");
  if (!needPhone) return null;
  const working = busy !== null;
  return (
    <form
      className="app-form"
      aria-label="Phone number for the payment"
      noValidate
      data-testid="phone-prompt"
      style={{ gap: 12 }}
      onSubmit={(e) => {
        e.preventDefault();
        void run(needPhone.action, phone.trim());
      }}
    >
      <div className="field">
        <label htmlFor="payment-phone">Phone number for the payment</label>
        <input
          id="payment-phone"
          className="input"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="+919840012345"
          value={phone}
          disabled={working}
          autoFocus
          aria-invalid
          aria-describedby="payment-phone-error"
          onChange={(e) => setPhone(e.target.value)}
        />
        <p id="payment-phone-error" className="app-field-error">
          {needPhone.message}
        </p>
        <p className="app-hint">PayU needs a phone number to take the payment. It is not saved to your profile.</p>
      </div>
      <div className="app-actions">
        <button type="submit" className="btn btn-primary" disabled={working}>
          {working ? "Opening PayU…" : "Continue to PayU"}
        </button>
        <button type="button" className="btn btn-secondary" disabled={working} onClick={cancelPhone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** What the last action said: a plan change that needed no payment, or why it did not start. */
export function ActionFeedback({ actions }: { actions: BillingActions }) {
  const { done, error } = actions;
  return (
    <>
      {done ? (
        <p className="app-notice" role="status" data-testid="billing-action-done" style={{ margin: 0 }}>
          {done}
        </p>
      ) : null}
      {error ? (
        <p className="app-notice" role="alert" data-testid="billing-action-error" data-code={error.code} style={{ margin: 0 }}>
          <strong>{error.title}.</strong> {error.message}
        </p>
      ) : null}
    </>
  );
}
