"use client";

import { useCallback, useEffect, useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/shared/states";
import { isRouteMissing } from "@/lib/api/route-missing";
import { formatError, type FormattedError } from "@/lib/errors";
import { changeNote, homeService as defaultService, leadsLeft, meterShare, type BalanceAnswer, type HomeService, type SummaryAnswer } from "./home-api";

// Home v1: the credit meter in leads, this month's summary, and the after-hours enquiries handled. Each card loads on its own from
// Dev 2's proposed routes (home-api.ts) and has its own loading, "not available yet", error-with-retry and ready state, so one missing
// route never blanks the other. Nothing is invented: a card whose route answers 404 says so, and shows no figure.

type Card<T> = { status: "loading" } | { status: "missing" } | { status: "error"; error: FormattedError } | { status: "ready"; data: T };

function useCard<T>(load: () => Promise<T>): [Card<T>, () => void] {
  const [card, setCard] = useState<Card<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    load().then(
      (data) => live && setCard({ status: "ready", data }),
      (err: unknown) => live && setCard(isRouteMissing(err) ? { status: "missing" } : { status: "error", error: formatError(err) }),
    );
    return () => {
      live = false;
    };
  }, [load, attempt]);
  const retry = useCallback(() => {
    setCard({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  return [card, retry];
}

const number = new Intl.NumberFormat("en-IN");

export function HomeOverview({ tenantId, service = defaultService }: { tenantId: string; service?: HomeService }) {
  const loadSummary = useCallback(() => service.summary(tenantId), [service, tenantId]);
  const loadBalance = useCallback(() => service.balance(tenantId), [service, tenantId]);
  const [summary, retrySummary] = useCard(loadSummary);
  const [balance, retryBalance] = useCard(loadBalance);
  const enquiries = summary.status === "ready" ? summary.data.stats.enquiries : null;

  return (
    <>
      <section aria-labelledby="credits-heading" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <h2 id="credits-heading" className="app-section-title">Credits</h2>
        <CardBody card={balance} loading="Loading your credits" missing="Your credit balance isn't available yet" onRetry={retryBalance} errorTitle="Couldn't load your credits">
          {(b) => <CreditMeter balance={b} enquiries={enquiries} />}
        </CardBody>
      </section>

      <section aria-labelledby="month-heading" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <h2 id="month-heading" className="app-section-title">This month</h2>
        <CardBody card={summary} loading="Loading this month's numbers" missing="This month's summary isn't available yet" onRetry={retrySummary} errorTitle="Couldn't load this month's summary">
          {(s) => <MonthSummary summary={s} />}
        </CardBody>
      </section>
    </>
  );
}

function CardBody<T>({
  card,
  loading,
  missing,
  errorTitle,
  onRetry,
  children,
}: {
  card: Card<T>;
  loading: string;
  missing: string;
  errorTitle: string;
  onRetry: () => void;
  children: (data: T) => React.ReactNode;
}) {
  if (card.status === "loading") return <LoadingState compact title={loading} />;
  if (card.status === "missing") return <EmptyState compact title={missing} description="The server doesn't provide this yet. Nothing is wrong with your account." />;
  if (card.status === "error") return <ErrorState compact title={errorTitle} description={card.error.message} onRetry={onRetry} />;
  return <>{children(card.data)}</>;
}

function CreditMeter({ balance, enquiries }: { balance: BalanceAnswer; enquiries: number | null }) {
  const left = leadsLeft(balance, enquiries);
  const share = meterShare(balance);
  const paused = balance.aiPaused === true || balance.credits.total <= 0;
  return (
    <div className="app-card" data-testid="credit-meter" data-paused={paused}>
      {paused ? <span className="app-status app-status-warn">Assistant paused: out of credits</span> : balance.lowCredits ? <span className="app-status app-status-warn">Running low</span> : null}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: "clamp(32px, 6vw, 48px)", fontWeight: 800, lineHeight: 1 }} data-testid="credit-leads">
          {left.kind === "estimate" ? `About ${number.format(left.leads)}` : number.format(balance.credits.total)}
        </span>
        <span style={{ fontSize: 16, color: "var(--color-neutral-700)" }}>{left.kind === "estimate" ? "more leads" : "credits left"}</span>
      </div>
      {share !== null ? (
        <div role="img" aria-label={`${share}% of this cycle's credits left`} style={{ height: 6, background: "var(--color-neutral-300)" }}>
          <div style={{ height: 6, width: `${share}%`, background: paused || balance.lowCredits ? "var(--color-accent-700)" : "var(--color-accent)" }} />
        </div>
      ) : null}
      <p className="app-card-text">
        {number.format(balance.credits.total)} {balance.credits.total === 1 ? "credit" : "credits"} left
        {balance.creditsGranted ? ` of ${number.format(balance.creditsGranted)} this cycle` : ""}.{" "}
        {left.kind === "estimate"
          ? `At about ${left.creditsPerLead.toFixed(1)} credits a lead so far this month.`
          : "We'll show how many leads that is once there's a month of activity to go on."}
      </p>
      {paused ? <p className="app-card-text">New chats go to your inbox until you top up.</p> : null}
    </div>
  );
}

function MonthSummary({ summary }: { summary: SummaryAnswer }) {
  const { stats } = summary;
  const change = changeNote(stats.enquiriesChangePct);
  const cells: [string, number, string | null][] = [
    ["Enquiries", stats.enquiries, change],
    ["Qualified", stats.qualified, null],
    ["Booked", stats.booked, null],
    ["After-hours enquiries handled", stats.afterHours, stats.afterHours > 0 && summary.overnightHandled ? `${number.format(summary.overnightHandled)} chats overnight` : null],
  ];
  return (
    <div className="app-grid" data-testid="month-summary" data-month={summary.month}>
      {cells.map(([label, value, note]) => (
        <div key={label} className="app-card" data-stat={label}>
          <span style={{ fontSize: 12, color: "var(--color-neutral-700)" }}>{label}</span>
          <span style={{ fontSize: "clamp(28px, 5vw, 40px)", fontWeight: 800, lineHeight: 1 }}>{number.format(value)}</span>
          {note ? <span className="app-card-text">{note}</span> : null}
        </div>
      ))}
    </div>
  );
}
