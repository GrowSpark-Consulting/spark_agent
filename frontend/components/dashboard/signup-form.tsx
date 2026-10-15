"use client";

import Link from "next/link";
import { useActionState } from "react";
import { EmptyState, ErrorState } from "@/components/shared/states";
import { signup, type SignupState } from "@/lib/auth/actions";

export function SignupForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState<SignupState, FormData>(signup, {});

  // The same message whether or not the address already has an account.
  if (state.sent) {
    return (
      <EmptyState
        title="Check your email"
        description="If this address can be used for a new account, we've sent a link to finish signing up. Open it on this device to continue."
        action={
          <Link className="btn btn-secondary" href="/login">
            Back to sign in
          </Link>
        }
      />
    );
  }

  return (
    <form action={action} className="app-form" noValidate>
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <div className="field">
        <label htmlFor="email">Email</label>
        <input
          id="email"
          name="email"
          type="email"
          className="input"
          autoComplete="email"
          defaultValue={state.email}
          aria-invalid={state.fields?.email ? true : undefined}
          aria-describedby={state.fields?.email ? "email-error" : undefined}
        />
        {state.fields?.email ? <p id="email-error" className="app-field-error">{state.fields.email}</p> : null}
      </div>
      <div className="field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          className="input"
          autoComplete="new-password"
          aria-invalid={state.fields?.password ? true : undefined}
          aria-describedby={state.fields?.password ? "password-error" : "password-hint"}
        />
        {state.fields?.password ? (
          <p id="password-error" className="app-field-error">{state.fields.password}</p>
        ) : (
          <p id="password-hint" className="app-hint">At least 8 characters.</p>
        )}
      </div>
      <div className="field">
        <label htmlFor="confirmPassword">Confirm password</label>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          className="input"
          autoComplete="new-password"
          aria-invalid={state.fields?.confirmPassword ? true : undefined}
          aria-describedby={state.fields?.confirmPassword ? "confirm-error" : undefined}
        />
        {state.fields?.confirmPassword ? <p id="confirm-error" className="app-field-error">{state.fields.confirmPassword}</p> : null}
      </div>
      {state.error ? <ErrorState compact title="Couldn't create your account" description={state.error} /> : null}
      <div className="app-actions">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? "Signing up…" : "Sign up"}
        </button>
      </div>
    </form>
  );
}
