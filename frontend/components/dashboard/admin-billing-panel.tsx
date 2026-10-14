"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { AdminTenant, RefundCandidate } from "@pakka/types";
import { extendTrial, fetchAdminTenants, fetchRefundCandidates, grantCredits, validateDays, validateGrant } from "@/lib/admin/billing";
import { formatError } from "@/lib/errors";

// /dashboard/admin/billing: the Spark Agent team's billing tools (docs/contracts.md, "Admin panel, billing"). Every call needs a platform admin;
// the server answers `forbidden` to everyone else and this screen then says so instead of showing an empty list. A change is shown only after the
// server confirmed it, and then the list is read again rather than edited here.

type Load<T> = { state: "loading" } | { state: "ready"; data: T } | { state: "failed"; code: string; title: string; message: string; retryable: boolean };

function useLoad<T>(fetcher: (signal: AbortSignal) => Promise<T>): [Load<T>, () => void] {
  const [result, setResult] = useState<Load<T>>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetcher(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setResult({ state: "ready", data });
      },
      (err) => {
        if (controller.signal.aborted) return;
        const shown = formatError(err);
        setResult({ state: "failed", code: shown.code, title: shown.title, message: shown.message, retryable: shown.retryable });
      },
    );
    return () => controller.abort();
  }, [fetcher, attempt]);
  // A re-read keeps showing the list it has until the new one arrives, so a confirmed change does not blank the screen.
  return [result, useCallback(() => setAttempt((n) => n + 1), [])];
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—");

function Failed({ result, onRetry }: { result: Extract<Load<unknown>, { state: "failed" }>; onRetry: () => void }) {
  const forbidden = result.code === "forbidden";
  return (
    <div className="app-notice" role="alert" data-testid="admin-error" data-code={result.code}>
      <strong>{forbidden ? "Only the Spark Agent team can see this." : `${result.title}.`}</strong>{" "}
      {forbidden ? "You are not on the platform-admin list. Nothing was loaded." : result.message}
      {result.retryable && !forbidden ? (
        <div className="app-actions">
          <button type="button" className="btn" onClick={onRetry}>
            Try again
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function AdminBillingPanel() {
  const [tenants, reloadTenants] = useLoad(fetchAdminTenants);
  const [refunds, reloadRefunds] = useLoad(fetchRefundCandidates);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      <section aria-labelledby="tenants-h" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <h2 id="tenants-h" className="app-h2">
          Businesses
        </h2>
        {tenants.state === "loading" ? (
          <p className="app-hint" role="status">
            Loading businesses…
          </p>
        ) : null}
        {tenants.state === "failed" ? <Failed result={tenants} onRetry={reloadTenants} /> : null}
        {tenants.state === "ready" && tenants.data.length === 0 ? <p className="app-hint">No businesses yet.</p> : null}
        {tenants.state === "ready" ? (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 16 }}>
            {tenants.data.map((t) => (
              <TenantRow key={t.id} tenant={t} onChanged={reloadTenants} />
            ))}
          </ul>
        ) : null}
      </section>
      <section aria-labelledby="refunds-h" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <h2 id="refunds-h" className="app-h2">
            Payments to refund
          </h2>
          <p className="app-lede">Paid twice, or for a plan that is no longer the business&apos;s. Refund each in PayU&apos;s dashboard; nothing is refunded from here.</p>
        </div>
        {refunds.state === "loading" ? (
          <p className="app-hint" role="status">
            Loading refunds…
          </p>
        ) : null}
        {refunds.state === "failed" ? <Failed result={refunds} onRetry={reloadRefunds} /> : null}
        {refunds.state === "ready" && refunds.data.length === 0 ? (
          <p className="app-hint" data-testid="no-refunds">
            Nothing to refund.
          </p>
        ) : null}
        {refunds.state === "ready" && refunds.data.length > 0 ? <RefundList items={refunds.data} /> : null}
      </section>
    </div>
  );
}

function RefundList({ items }: { items: RefundCandidate[] }) {
  return (
    <ul data-testid="refund-list" style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 12 }}>
      {items.map((r) => (
        <li key={r.paymentId} className="app-card" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <strong>{r.tenantName}</strong>
          <span>
            ₹{r.amountInr.toLocaleString("en-IN")} · {r.kind}
            {r.method ? ` · ${r.method}` : ""}
          </span>
          <span className="app-hint">
            PayU id {r.providerPaymentId ?? "unknown"} · paid {when(r.paidAt)} · flagged {when(r.flaggedAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function TenantRow({ tenant: t, onChanged }: { tenant: AdminTenant; onChanged: () => void }) {
  // The contract refuses an extension for a business with a plan; offering it only to one without a live subscription avoids a certain `conflict`.
  const canExtend = t.subscription === null && t.status !== "active";
  return (
    <li className="app-card" data-testid="tenant-row" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <strong>{t.name}</strong>{" "}
        <span className="app-hint">
          {t.vertical} · {t.status} · {t.planKey}
        </span>
      </div>
      <dl className="app-facts" style={{ margin: 0 }}>
        <div>
          <dt>Credits</dt>
          <dd data-testid="tenant-credits">{t.credits.toLocaleString("en-IN")}</dd>
        </div>
        <div>
          <dt>Members</dt>
          <dd>{t.members}</dd>
        </div>
        <div>
          <dt>Numbers</dt>
          <dd>{t.activeNumbers}</dd>
        </div>
        {t.trialEndsAt ? (
          <div>
            <dt>Trial ends</dt>
            <dd data-testid="tenant-trial-ends">{when(t.trialEndsAt)}</dd>
          </div>
        ) : null}
        {t.subscription ? (
          <div>
            <dt>Subscription</dt>
            <dd>
              {t.subscription.status}, {t.subscription.cycle}, to {when(t.subscription.periodEnd)}
            </dd>
          </div>
        ) : null}
        {t.setupCallPaidAt ? (
          <div>
            <dt>Setup call</dt>
            <dd>Paid {when(t.setupCallPaidAt)}: owed</dd>
          </div>
        ) : null}
      </dl>
      {canExtend ? <ExtendTrialForm tenant={t} onChanged={onChanged} /> : null}
      <GrantCreditsForm tenant={t} onChanged={onChanged} />
    </li>
  );
}

type Outcome = { kind: "ok" | "error"; text: string } | null;

function ExtendTrialForm({ tenant, onChanged }: { tenant: AdminTenant; onChanged: () => void }) {
  const [days, setDays] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (lock.current) return;
    const checked = validateDays(days);
    setError(checked.error);
    setOutcome(null);
    if (checked.value === undefined) return;
    lock.current = true;
    setBusy(true);
    try {
      const r = await extendTrial(tenant.id, { days: checked.value });
      setOutcome({ kind: "ok", text: `Trial now ends ${when(r.trialEndsAt)}.` });
      setDays("");
      onChanged();
    } catch (err) {
      const shown = formatError(err);
      if (shown.fields?.days) setError(shown.fields.days);
      setOutcome({
        kind: "error",
        text: shown.code === "conflict" ? "This business already has a plan, so its trial can't be extended. Nothing changed." : `${shown.message} Nothing changed that we can confirm.`,
      });
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <form className="app-form" onSubmit={submit} noValidate aria-label={`Extend trial for ${tenant.name}`}>
      <div className="field">
        <label htmlFor={`days-${tenant.id}`}>Extend trial by (days, 1 to 30)</label>
        <input id={`days-${tenant.id}`} className="input" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} disabled={busy} aria-invalid={!!error} />
        {error ? (
          <p className="app-field-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="app-actions">
        <button type="submit" className="btn" disabled={busy}>
          {busy ? "Extending…" : "Extend trial"}
        </button>
      </div>
      {outcome ? (
        <p className="app-hint" role={outcome.kind === "error" ? "alert" : "status"} data-testid="extend-outcome">
          {outcome.text}
        </p>
      ) : null}
    </form>
  );
}

function GrantCreditsForm({ tenant, onChanged }: { tenant: AdminTenant; onChanged: () => void }) {
  const [amount, setAmount] = useState("");
  const [expires, setExpires] = useState("");
  const [note, setNote] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  // One id per intended grant: kept across a failed attempt so a retry after a lost answer cannot grant twice, replaced once the server answered.
  const requestId = useRef<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (lock.current) return;
    const checked = validateGrant(amount, expires, note);
    setFields(checked.fields);
    setOutcome(null);
    if (!checked.value) return;
    lock.current = true;
    setBusy(true);
    requestId.current ??= crypto.randomUUID();
    try {
      const r = await grantCredits(tenant.id, { ...checked.value, requestId: requestId.current });
      requestId.current = null;
      const credits = r.credits.toLocaleString("en-IN");
      setOutcome({
        kind: "ok",
        text: r.granted ? `Granted ${checked.value.amount.toLocaleString("en-IN")} credits. The business now has ${credits}.` : `That grant had already been made, so nothing more was added. The business has ${credits}.`,
      });
      setAmount("");
      setExpires("");
      setNote("");
      onChanged();
    } catch (err) {
      const shown = formatError(err);
      if (shown.fields && Object.keys(shown.fields).length) setFields(shown.fields);
      setOutcome({ kind: "error", text: `${shown.message} If you try again, the same grant is not made twice.` });
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <form className="app-form" onSubmit={submit} noValidate aria-label={`Grant credits to ${tenant.name}`}>
      <div className="field">
        <label htmlFor={`amount-${tenant.id}`}>Credits to grant (1 to 100,000)</label>
        <input id={`amount-${tenant.id}`} className="input" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} aria-invalid={!!fields.amount} />
        {fields.amount ? (
          <p className="app-field-error" role="alert">
            {fields.amount}
          </p>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor={`expires-${tenant.id}`}>Expire after (days, blank for never)</label>
        <input id={`expires-${tenant.id}`} className="input" inputMode="numeric" value={expires} onChange={(e) => setExpires(e.target.value)} disabled={busy} aria-invalid={!!fields.expiresInDays} />
        {fields.expiresInDays ? (
          <p className="app-field-error" role="alert">
            {fields.expiresInDays}
          </p>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor={`note-${tenant.id}`}>Note (optional)</label>
        <input id={`note-${tenant.id}`} className="input" value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} aria-invalid={!!fields.note} />
        {fields.note ? (
          <p className="app-field-error" role="alert">
            {fields.note}
          </p>
        ) : null}
      </div>
      <div className="app-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Granting…" : "Grant credits"}
        </button>
      </div>
      {outcome ? (
        <p className="app-hint" role={outcome.kind === "error" ? "alert" : "status"} data-testid="grant-outcome">
          {outcome.text}
        </p>
      ) : null}
    </form>
  );
}
