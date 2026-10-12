"use client";

import { useRef, useState, type FormEvent } from "react";
import { WhatsAppConnectionChecks } from "@/components/dashboard/whatsapp-connection-checks";
import {
  EMPTY_ADMIN_FORM,
  fieldErrorsFrom,
  submitAdminConnect,
  validateAdminForm,
  type AdminConnectForm,
  type AdminConnectResult,
  type AdminFieldErrors,
} from "@/lib/whatsapp/admin-connect";
import { overallSummary, parseLastCheck, webhookUnconfirmed } from "@/lib/whatsapp/last-check";

// /dashboard/admin/whatsapp: the Spark Agent team connects a client's number by hand (POST /api/admin/whatsapp/manual). The token and
// the app secret live only in these two inputs: they are sent once, and cleared from the form the moment the request has been sent,
// whatever the answer, so neither is kept in state, storage or the page after that. What the page says about the number is what the
// server answered: "Connected" only when it returns status active (and says so with the checks beside it), and the reason when not.

type Outcome = Extract<AdminConnectResult, { state: "done" }> | Extract<AdminConnectResult, { state: "rejected" }>;

export function AdminManualConnectForm() {
  const [form, setForm] = useState<AdminConnectForm>(EMPTY_ADMIN_FORM);
  const [errors, setErrors] = useState<AdminFieldErrors>({});
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const sendingRef = useRef(false);

  const set = (key: keyof AdminConnectForm) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (sendingRef.current) return;
    const problems = validateAdminForm(form);
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    sendingRef.current = true;
    setSending(true);
    setOutcome(null);
    const sent = form;
    // The secrets leave the form as the request goes out; the rest stays so a wrong ID can be fixed and sent again.
    setForm({ ...sent, token: "", appSecret: "" });
    try {
      const result = await submitAdminConnect(sent);
      setOutcome(result);
      if (result.state === "rejected") setErrors(fieldErrorsFrom(result.fields));
      else setForm(EMPTY_ADMIN_FORM);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 640 }}>
      <form className="app-form" onSubmit={submit} noValidate aria-label="Connect a WhatsApp number" autoComplete="off">
        <Field id="tenantId" label="Business ID" error={errors.tenantId} hint="The business's ID from the database (tenants.id).">
          <input id="tenantId" className="input" value={form.tenantId} onChange={(e) => set("tenantId")(e.target.value)} aria-invalid={!!errors.tenantId} disabled={sending} spellCheck={false} />
        </Field>
        <Field id="wabaId" label="WhatsApp Business Account ID" error={errors.wabaId}>
          <input id="wabaId" className="input" inputMode="numeric" value={form.wabaId} onChange={(e) => set("wabaId")(e.target.value)} aria-invalid={!!errors.wabaId} disabled={sending} spellCheck={false} />
        </Field>
        <Field id="phoneNumberId" label="Phone number ID" error={errors.phoneNumberId}>
          <input id="phoneNumberId" className="input" inputMode="numeric" value={form.phoneNumberId} onChange={(e) => set("phoneNumberId")(e.target.value)} aria-invalid={!!errors.phoneNumberId} disabled={sending} spellCheck={false} />
        </Field>
        <Field id="tokenType" label="Token type" error={errors.tokenType}>
          <select id="tokenType" className="input" value={form.tokenType} onChange={(e) => set("tokenType")(e.target.value)} disabled={sending}>
            <option value="system_user">System user (recommended)</option>
            <option value="business">Business token</option>
          </select>
        </Field>
        <Field id="token" label="System-user access token" error={errors.token} hint="Sent once and never shown again.">
          <input id="token" className="input" type="password" autoComplete="off" value={form.token} onChange={(e) => set("token")(e.target.value)} aria-invalid={!!errors.token} disabled={sending} spellCheck={false} />
        </Field>
        <Field id="appSecret" label="App secret" error={errors.appSecret} hint="Sent once and never shown again.">
          <input id="appSecret" className="input" type="password" autoComplete="off" value={form.appSecret} onChange={(e) => set("appSecret")(e.target.value)} aria-invalid={!!errors.appSecret} disabled={sending} spellCheck={false} />
        </Field>
        <Field id="displayPhone" label="Display phone (optional)" error={errors.displayPhone}>
          <input id="displayPhone" className="input" value={form.displayPhone} onChange={(e) => set("displayPhone")(e.target.value)} disabled={sending} />
        </Field>
        <Field id="clientBusinessId" label="Client's Meta business ID (optional)" error={errors.clientBusinessId}>
          <input id="clientBusinessId" className="input" value={form.clientBusinessId} onChange={(e) => set("clientBusinessId")(e.target.value)} disabled={sending} spellCheck={false} />
        </Field>
        <div className="app-actions">
          <button type="submit" className="btn btn-primary" disabled={sending}>
            {sending ? "Connecting and checking…" : "Connect number"}
          </button>
          {sending ? <span className="app-hint" style={{ margin: 0 }} role="status">Running the six connection checks with Meta. This can take a few seconds.</span> : null}
        </div>
      </form>

      {outcome ? <Result outcome={outcome} /> : null}
    </div>
  );
}

function Field({ id, label, error, hint, children }: { id: string; label: string; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && !error ? <p className="app-hint">{hint}</p> : null}
      {error ? <p className="app-field-error" role="alert">{error}</p> : null}
    </div>
  );
}

function Result({ outcome }: { outcome: Outcome }) {
  if (outcome.state === "rejected") {
    return (
      <div className="app-notice" role="alert" data-testid="admin-connect-rejected">
        <strong>Nothing was connected.</strong> {outcome.message}
      </div>
    );
  }
  const c = outcome.connection;
  const last = parseLastCheck(c.last_check);
  const active = c.status === "active";
  const headline = active
    ? webhookUnconfirmed(last)
      ? "Connected. The webhook isn't confirmed yet."
      : "Connected."
    : c.status === "failed"
      ? "The number was saved but a check failed, so it is not active."
      : `The number was saved. Its status is “${c.status}”.`;
  return (
    <section aria-label="Result" data-testid="admin-connect-result" data-status={c.status} className={active ? "app-success" : "app-notice"}>
      <div style={{ fontWeight: 800 }}>{headline}</div>
      <div className="app-hint">
        {c.display_phone ?? "Number pending"} · Phone number ID {c.phone_number_id}
      </div>
      {last.state === "checked" ? <div className="app-hint">{overallSummary(last.overall, last.checks.length)}</div> : null}
      <WhatsAppConnectionChecks lastCheck={last} canRecheck={false} />
    </section>
  );
}
