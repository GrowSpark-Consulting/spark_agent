"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/shared/states";
import { isRouteMissing } from "@/lib/api/route-missing";
import { formatError, type FormattedError } from "@/lib/errors";
import {
  changeNote,
  daysLeft,
  homeService as defaultService,
  leadsLeft,
  meterShare,
  pausedNotice,
  type BalanceAnswer,
  type HomeService,
  type SummaryAnswer,
} from "./home-api";

// Home v1: why the assistant is (not) replying, the credit meter in leads, this month's summary, the hot leads waiting and today's
// bookings. Each card loads on its own from Dev 2's routes (home-api.ts) and has its own loading, "not available yet", error-with-retry and
// ready state, so one failing route never blanks the other. Nothing is invented: a card whose route answers 404 says so, and shows no figure.

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

export function HomeOverview({ tenantId, timeZone = "Asia/Kolkata", service = defaultService }: { tenantId: string; timeZone?: string; service?: HomeService }) {
  const loadSummary = useCallback(() => service.summary(tenantId), [service, tenantId]);
  const loadBalance = useCallback(() => service.balance(tenantId), [service, tenantId]);
  const [summary, retrySummary] = useCard(loadSummary);
  const [balance, retryBalance] = useCard(loadBalance);
  const enquiries = summary.status === "ready" ? summary.data.stats.enquiries : null;

  return (
    <>
      {balance.status === "ready" ? <AssistantStatus balance={balance.data} /> : null}

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

      {summary.status === "ready" ? <WaitingAndToday summary={summary.data} timeZone={timeZone} /> : null}
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

/**
 * Why the assistant isn't replying, worded per reason the server gives (aiPausedReason), or the trial countdown while a trial is running.
 * Renders nothing when the assistant is on and there is no trial to count down.
 */
function AssistantStatus({ balance }: { balance: BalanceAnswer }) {
  const notice = pausedNotice(balance.aiPausedReason);
  const trialDays = balance.status === "trial" && !balance.aiPaused ? daysLeft(balance.trialEndsAt, new Date()) : null;
  if (!notice && trialDays === null) return null;
  return (
    <section
      aria-label="Assistant status"
      data-testid="assistant-status"
      data-reason={notice?.reason ?? "trial"}
      className="app-card"
      role={notice ? "alert" : "status"}
    >
      {notice ? (
        <>
          <span className="app-status app-status-warn">{notice.title}</span>
          <p className="app-card-text">{notice.detail}</p>
          {notice.action ? (
            <Link className="btn btn-secondary" href={notice.action.href} style={{ minHeight: 44, alignSelf: "flex-start" }}>
              {notice.action.label}
            </Link>
          ) : null}
        </>
      ) : (
        <>
          <span className="app-status">Free trial</span>
          <p className="app-card-text">{trialDays === 0 ? "Your trial ends today." : `${trialDays} ${trialDays === 1 ? "day" : "days"} left in your free trial.`}</p>
          <Link className="btn btn-secondary" href="/dashboard/billing" style={{ minHeight: 44, alignSelf: "flex-start" }}>
            Choose a plan
          </Link>
        </>
      )}
    </section>
  );
}

function CreditMeter({ balance, enquiries }: { balance: BalanceAnswer; enquiries: number | null }) {
  const left = leadsLeft(balance, enquiries);
  const share = meterShare(balance);
  const paused = balance.aiPaused;
  return (
    <div className="app-card" data-testid="credit-meter" data-paused={paused}>
      {paused ? <span className="app-status app-status-warn">Assistant paused</span> : balance.lowCredits ? <span className="app-status app-status-warn">Running low</span> : null}
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
      {balance.renewsAt ? (
        <p className="app-card-text" data-testid="renews-at">
          Renews {new Date(balance.renewsAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}.
        </p>
      ) : null}
    </div>
  );
}

const clock = (iso: string, timeZone: string) => new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone }).format(new Date(iso));

/** Hot leads and today's bookings, as the summary lists them (staff get their own: the server filters, nothing is filtered here). */
function WaitingAndToday({ summary, timeZone }: { summary: SummaryAnswer; timeZone: string }) {
  return (
    <>
      <section aria-labelledby="hot-heading" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <h2 id="hot-heading" className="app-section-title">Hot leads waiting</h2>
        {summary.hotLeads.length === 0 ? (
          <EmptyState compact title="No hot leads waiting" description="Leads that need someone will show here." />
        ) : (
          <ul className="app-grid" data-testid="hot-leads" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {summary.hotLeads.map((lead) => (
              <li key={lead.leadId}>
                <Link
                  className="app-card"
                  href={lead.conversationId ? `/dashboard/inbox?chat=${encodeURIComponent(lead.conversationId)}` : `/dashboard/leads/${encodeURIComponent(lead.leadId)}`}
                >
                  <span className="app-card-title">{lead.name}</span>
                  <span className="app-card-text">{lead.need}</span>
                  <span className="app-card-text">
                    {lead.reason}
                    {lead.waitingSince ? ` · waiting since ${clock(lead.waitingSince, timeZone)}` : ""}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="today-heading" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <h2 id="today-heading" className="app-section-title">Today&apos;s bookings</h2>
        {summary.todayBookings.length === 0 ? (
          <EmptyState compact title="No bookings today" description="Held and confirmed bookings for today will show here." />
        ) : (
          <ul className="app-grid" data-testid="today-bookings" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {summary.todayBookings.map((b) => (
              <li key={b.bookingId} className="app-card">
                <span className="app-card-title">
                  {clock(b.startAt, timeZone)} · {b.name}
                </span>
                <span className="app-card-text">{[b.place, b.staff].filter(Boolean).join(" · ")}</span>
                <span className="app-card-text">{b.status === "held" ? "Held" : "Confirmed"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
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
