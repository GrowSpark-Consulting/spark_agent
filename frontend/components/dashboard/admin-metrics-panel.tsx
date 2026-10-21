"use client";

import { useCallback, useEffect, useState } from "react";
import type { AdminMetrics, AdminMetricsWindow } from "@pakka/types";
import { compareToTarget, fetchAdminMetrics, formatAsOf, formatCount, formatInr, formatInrPerCredit, formatPercent, formatUsd, windowLabel } from "@/lib/admin/metrics";
import { formatError } from "@/lib/errors";

// /dashboard/admin/metrics: cost per credit and trial-to-paid for the Spark Agent team. The server answers `forbidden` to everyone else and this
// screen then says so and shows nothing. Every figure is the server's; the only thing worked out here is cost per credit against the target.

type Load = { state: "loading" } | { state: "ready"; data: AdminMetrics } | { state: "failed"; code: string; title: string; message: string; retryable: boolean };

function useMetrics(): [Load, () => void] {
  const [result, setResult] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetchAdminMetrics(controller.signal).then(
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
  return [result, useCallback(() => { setResult({ state: "loading" }); setAttempt((n) => n + 1); }, [])];
}

export function AdminMetricsPanel() {
  const [metrics, reload] = useMetrics();

  if (metrics.state === "loading") {
    return (
      <p className="app-hint" role="status" data-testid="metrics-loading">
        Loading metrics…
      </p>
    );
  }
  if (metrics.state === "failed") {
    const forbidden = metrics.code === "forbidden";
    return (
      <div className="app-notice" role="alert" data-testid="admin-error" data-code={metrics.code}>
        <strong>{forbidden ? "Only the Spark Agent team can see this." : `${metrics.title}.`}</strong>{" "}
        {forbidden ? "You are not on the platform-admin list. Nothing was loaded." : metrics.message}
        {metrics.retryable && !forbidden ? (
          <div className="app-actions">
            <button type="button" className="btn" onClick={reload}>
              Try again
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  const { data } = metrics;
  if (data.windows.length === 0) {
    return (
      <p className="app-hint" data-testid="metrics-empty">
        No figures yet. The server returned no reporting period.
      </p>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      {data.windows.map((w) => (
        <WindowSection key={w.days} window={w} targetInr={data.targetCostPerCreditInr} />
      ))}
      <section aria-labelledby="metrics-notes-h" data-testid="metrics-notes" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h2 id="metrics-notes-h" className="app-h2">
          How these are worked out
        </h2>
        <ul className="app-hint" style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
          <li>Credits spent: credits taken for replies and templates sent to customers. A refund for a failed send is not taken off.</li>
          <li>AI cost: the models&apos; estimated cost, including calls that spend no credit. Dollars are converted at ₹{formatCount(data.usdInr)} to the dollar, a stated assumption, not a live rate.</li>
          <li>Cost per credit: AI cost in rupees divided by credits spent. The target is ₹{data.targetCostPerCreditInr.toFixed(2)} per credit.</li>
          <li>Trials: businesses created in the period. Paid: how many of them have paid for a plan, as of now. Our own demo and test businesses are left out.</li>
        </ul>
        <p className="app-hint" data-testid="metrics-as-of">
          Calculated {formatAsOf(data.asOf)}.
        </p>
      </section>
    </div>
  );
}

function WindowSection({ window: w, targetInr }: { window: AdminMetricsWindow; targetInr: number }) {
  const id = `metrics-${w.days}-h`;
  const comparison = compareToTarget(w.costPerCreditInr, targetInr);
  return (
    <section aria-labelledby={id} data-testid={`metrics-window-${w.days}`} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h2 id={id} className="app-h2">
        {windowLabel(w.days)}
      </h2>
      <dl className="app-grid" style={{ margin: 0 }}>
        <Stat label="Cost per credit" testId="cost-per-credit">
          {w.costPerCreditInr === null ? (
            <>
              <Value>—</Value>
              <Note>No credits were spent in this period.</Note>
            </>
          ) : (
            <>
              <Value>{formatInrPerCredit(w.costPerCreditInr)}</Value>
              <Note testId="target-comparison">
                {comparison.kind === "within"
                  ? `Within the ${formatInrPerCredit(targetInr)} target (${formatInrPerCredit(comparison.gapInr)} under).`
                  : comparison.kind === "above"
                    ? `Above the ${formatInrPerCredit(targetInr)} target by ${formatInrPerCredit(comparison.gapInr)}.`
                    : null}
              </Note>
            </>
          )}
        </Stat>
        <Stat label="Trial to paid" testId="trial-to-paid">
          {w.trialToPaidPct === null ? (
            <>
              <Value>—</Value>
              <Note>No trials started in this period.</Note>
            </>
          ) : (
            <>
              <Value>{formatPercent(w.trialToPaidPct)}</Value>
              <Note>
                {formatCount(w.trialsPaid)} of {formatCount(w.trialsStarted)} {w.trialsStarted === 1 ? "trial" : "trials"} paid.
              </Note>
            </>
          )}
        </Stat>
        <Stat label="Trials started" testId="trials-started">
          <Value>{formatCount(w.trialsStarted)}</Value>
        </Stat>
        <Stat label="Trials paid" testId="trials-paid">
          <Value>{formatCount(w.trialsPaid)}</Value>
        </Stat>
        <Stat label="Credits spent" testId="credits-spent">
          <Value>{formatCount(w.creditsSpent)}</Value>
        </Stat>
        <Stat label="AI cost" testId="ai-cost">
          <Value>{formatInr(w.aiCostInr)}</Value>
          <Note>
            {formatUsd(w.aiCostUsd)} over {formatCount(w.aiCalls)} {w.aiCalls === 1 ? "call" : "calls"}.
          </Note>
        </Stat>
      </dl>
    </section>
  );
}

function Stat({ label, testId, children }: { label: string; testId: string; children: React.ReactNode }) {
  return (
    <div className="app-card" data-testid={testId}>
      <dt className="app-card-text">{label}</dt>
      {children}
    </div>
  );
}

function Value({ children }: { children: React.ReactNode }) {
  return (
    <dd className="app-card-title" style={{ margin: 0, fontSize: 24 }} data-testid="stat-value">
      {children}
    </dd>
  );
}

function Note({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return children ? (
    <dd className="app-hint" style={{ margin: 0 }} data-testid={testId}>
      {children}
    </dd>
  ) : null;
}
