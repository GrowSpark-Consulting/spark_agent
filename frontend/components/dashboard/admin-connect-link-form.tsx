"use client";

import { useRef, useState, type FormEvent } from "react";
import { createConnectLink, expiryLabel, validateLinkTenant, type ConnectLinkResult } from "@/lib/whatsapp/admin-connect-link";

// /dashboard/admin/whatsapp, second form: make an assisted connect link for a business (POST /api/admin/whatsapp/connect-link). Nothing is
// requested on load or refresh: a link is made only by pressing the button, once per press. The server keeps only a hash of the token, so the
// link is shown here once, held in memory only (no storage, no URL), and gone when the page is left, refreshed, or "Done" is pressed.

type Outcome = Extract<ConnectLinkResult, { state: "done" }> | Extract<ConnectLinkResult, { state: "rejected" }>;
type Copy = "idle" | "copied" | "failed";

export function AdminConnectLinkForm() {
  const [tenantId, setTenantId] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [copy, setCopy] = useState<Copy>("idle");
  const sendingRef = useRef(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (sendingRef.current) return;
    const problem = validateLinkTenant(tenantId);
    setError(problem ?? undefined);
    if (problem) return;
    sendingRef.current = true;
    setSending(true);
    setOutcome(null);
    setCopy("idle");
    try {
      const result = await createConnectLink(tenantId);
      setOutcome(result);
      if (result.state === "rejected" && result.fields.tenantId) setError(result.fields.tenantId);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  }

  function done() {
    setOutcome(null);
    setCopy("idle");
    setTenantId("");
    setError(undefined);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 640 }}>
      <form className="app-form" onSubmit={submit} noValidate aria-label="Make a connect link" autoComplete="off">
        <div className="field">
          <label htmlFor="linkTenantId">Business ID for the link</label>
          <input
            id="linkTenantId"
            className="input"
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
            aria-invalid={!!error}
            disabled={sending}
            spellCheck={false}
          />
          {error ? <p className="app-field-error" role="alert">{error}</p> : <p className="app-hint">The business&apos;s ID from the database (tenants.id).</p>}
        </div>
        <div className="app-actions">
          <button type="submit" className="btn btn-primary" disabled={sending || outcome?.state === "done"}>
            {sending ? "Making the link…" : "Make connect link"}
          </button>
          {outcome?.state === "done" ? <span className="app-hint" style={{ margin: 0 }}>Press Done before making another.</span> : null}
        </div>
      </form>

      {outcome?.state === "rejected" ? (
        <div className="app-notice" role="alert" data-testid="connect-link-rejected">
          <strong>No link was made.</strong> {outcome.message}
        </div>
      ) : null}

      {outcome?.state === "done" ? (
        <section aria-label="Connect link" data-testid="connect-link-result" className="app-success">
          <div style={{ fontWeight: 800 }}>Link ready. Send it to the business owner.</div>
          <p className="app-hint">We keep no copy of this link. Copy it now: it can&apos;t be shown again, and leaving or refreshing this page loses it.</p>
          <input readOnly aria-label="Connect link" className="input" value={outcome.url} onFocus={(e) => e.currentTarget.select()} spellCheck={false} data-testid="connect-link-url" />
          <p className="app-hint" data-testid="connect-link-expiry">{expiryLabel(outcome.expiresAt)}</p>
          <div className="app-actions">
            <button type="button" className="btn btn-primary" onClick={() => copyLink(outcome.url)}>
              {copy === "copied" ? "Copied" : "Copy link"}
            </button>
            <button type="button" className="btn" onClick={done}>Done</button>
          </div>
          <p className="app-hint" role="status">
            {copy === "copied" ? "Copied to your clipboard." : copy === "failed" ? "Your browser wouldn't copy it. Select the link above and copy it by hand." : ""}
          </p>
        </section>
      ) : null}
    </div>
  );
}
