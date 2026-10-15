"use client";

import { useCallback, useEffect, useState } from "react";
import type { AdminConnection } from "@pakka/types";
import { ADMIN_CONNECTIONS_CAP, businessName, fetchAdminConnections, isPlatformNumber, lastCheckLine, METHOD_LABEL, STATUS_VIEW, whenText } from "@/lib/admin/connections";
import { formatError } from "@/lib/errors";
import { checkStatus, checkTitle } from "@/lib/whatsapp/last-check";

// /dashboard/admin/connections: every business's WhatsApp connections, read only (docs/contracts.md, "Admin panel"). The server answers `forbidden`
// to anyone off the platform-admin list, and this screen then says so instead of showing an empty list. Nothing here changes a connection: no
// recheck, no disconnect. The answer carries no token or secret.

type Load = { state: "loading" } | { state: "ready"; data: AdminConnection[] } | { state: "failed"; code: string; title: string; message: string; retryable: boolean };

const tone = { ok: "var(--color-accent)", warn: "var(--color-text)", off: "var(--color-neutral-700)" } as const;

export function AdminConnectionsPanel() {
  const [result, setResult] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetchAdminConnections(controller.signal).then(
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
  }, [attempt]);
  const reload = useCallback(() => {
    setResult({ state: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  if (result.state === "loading") {
    return (
      <p className="app-hint" role="status">
        Loading connections…
      </p>
    );
  }
  if (result.state === "failed") {
    const forbidden = result.code === "forbidden";
    return (
      <div className="app-notice" role="alert" data-testid="admin-error" data-code={result.code}>
        <strong>{forbidden ? "Only the Spark Agent team can see this." : `${result.title}.`}</strong>{" "}
        {forbidden ? "You are not on the platform-admin list. Nothing was loaded." : result.message}
        {result.retryable && !forbidden ? (
          <div className="app-actions">
            <button type="button" className="btn" onClick={reload}>
              Try again
            </button>
          </div>
        ) : null}
      </div>
    );
  }
  if (result.data.length === 0) {
    return (
      <p className="app-hint" data-testid="no-connections">
        No WhatsApp numbers are connected yet.
      </p>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <p className="app-hint" data-testid="connections-count" style={{ margin: 0 }}>
        {result.data.length} {result.data.length === 1 ? "connection" : "connections"}, newest first.
        {result.data.length >= ADMIN_CONNECTIONS_CAP ? ` Only the newest ${ADMIN_CONNECTIONS_CAP} are listed; older ones are not shown.` : ""}
      </p>
      <ul data-testid="connection-list" style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 16 }}>
        {result.data.map((c) => (
          <ConnectionRow key={c.id} connection={c} />
        ))}
      </ul>
    </div>
  );
}

function ConnectionRow({ connection: c }: { connection: AdminConnection }) {
  const status = STATUS_VIEW[c.status];
  return (
    <li className="app-card" data-testid="connection-row" data-status={c.status} data-method={c.method} style={{ minWidth: 0, overflowWrap: "anywhere" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", alignItems: "baseline", justifyContent: "space-between" }}>
        <strong className="app-card-title" data-testid="connection-business">
          {businessName(c)}
        </strong>
        <span data-testid="connection-status" style={{ fontWeight: 700, color: tone[status.tone] }}>
          {status.label}
        </span>
      </div>
      <p className="app-card-text">{status.detail}</p>
      <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "8px 16px", margin: 0, fontSize: 14 }}>
        <Field label="Method">
          <span data-testid="connection-method">{METHOD_LABEL[c.method]}</span>
          {isPlatformNumber(c) ? <span className="app-hint"> · ours, not the business&apos;s own number</span> : null}
        </Field>
        <Field label="Number">
          <span data-testid="connection-phone">{c.displayPhone ?? "Not read from Meta yet"}</span>
        </Field>
        <Field label="Verified name">{c.verifiedName ?? "—"}</Field>
        <Field label="Quality · limit">
          {c.qualityRating ?? "—"} · {c.messagingLimit ?? "—"}
        </Field>
        {c.coexistence ? <Field label="Coexistence">On</Field> : null}
        {c.tokenExpiresAt ? <Field label="Token runs out">{whenText(c.tokenExpiresAt)}</Field> : null}
        <Field label="Added">{whenText(c.createdAt)}</Field>
      </dl>
      <LastCheck connection={c} />
    </li>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <dt className="app-hint" style={{ margin: 0 }}>
        {label}
      </dt>
      <dd style={{ margin: 0 }}>{children}</dd>
    </div>
  );
}

function LastCheck({ connection: c }: { connection: AdminConnection }) {
  const check = c.lastCheck;
  return (
    <div data-testid="connection-check" data-overall={check?.overall ?? "none"} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <p style={{ margin: 0, fontSize: 14 }}>
        <strong>Last check{check ? ` · ${whenText(check.ranAt)}` : ""}:</strong> {lastCheckLine(c)}
      </p>
      {check && check.checks.length > 0 ? (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
          {check.checks.map((k) => {
            const s = checkStatus(k.status);
            return (
              <li key={k.key} data-testid="check-item" data-key={k.key} data-status={k.status}>
                <strong>{checkTitle(k.key)}</strong> <span style={{ color: tone[s.tone], fontWeight: 700 }}>{s.label}</span>
                {k.message ? <span className="app-hint"> · {k.message}</span> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
