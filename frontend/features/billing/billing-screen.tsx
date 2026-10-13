"use client";

import type { AccountStatus, Role } from "@pakka/types";
import { useCallback, useEffect, useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/shared/states";
import { daysLeft, meterShare, pausedNotice } from "@/features/home/home-api";
import { sectionHead, sectionTitle } from "@/features/settings/section";
import { isRouteMissing } from "@/lib/api/route-missing";
import { formatError, type FormattedError } from "@/lib/errors";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import {
  fetchAccountStatus,
  fetchCreditHistory,
  fetchPlans,
  HISTORY_PAGE,
  planRelation,
  type LedgerEntry,
  type PlanOption,
} from "./billing-data";

// /dashboard/billing (Day 6, Dev 3). What can be shown truthfully today: the plan and its status, the credit balance, the credit history
// (credit_ledger under RLS) and the plans on offer (the plans catalogue). What cannot: paying. POST /api/billing/checkout, /topup and
// /change-plan, the Razorpay webhook and invoices are Dev 2's and are not on the API yet, so this screen has no pay, upgrade, downgrade
// or top-up button and no invoice list, and says so. Nothing here claims a payment happened. Owners and admins see it; staff do not
// (docs/dashboard-screen-inventory.md, "Billing & credits": owner, admin view only).

export function canViewBilling(role: Role): boolean {
  return role === "owner" || role === "admin";
}

type Load<T> = { status: "loading" } | { status: "missing" } | { status: "error"; error: FormattedError } | { status: "ready"; data: T };

function useLoad<T>(load: () => Promise<T>): [Load<T>, () => void] {
  const [state, setState] = useState<Load<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    load().then(
      (data) => live && setState({ status: "ready", data }),
      (err: unknown) => live && setState(isRouteMissing(err) ? { status: "missing" } : { status: "error", error: formatError(err) }),
    );
    return () => {
      live = false;
    };
  }, [load, attempt]);
  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  return [state, retry];
}

const number = new Intl.NumberFormat("en-IN");
const rupees = (n: number) => `₹${number.format(n)}`;
const STATUS_LABEL: Record<AccountStatus["status"], string> = { trial: "Free trial", active: "Active", paused: "Paused", cancelled: "Cancelled" };

export function BillingScreen({ tenantId, role, timeZone }: { tenantId: string; role: Role; timeZone: string }) {
  if (!canViewBilling(role)) {
    return (
      <p className="app-notice" role="status" data-testid="billing-no-access" style={{ margin: 0 }}>
        Billing is for owners and admins. Ask an owner if you need to see the plan or the credits.
      </p>
    );
  }
  return <BillingView tenantId={tenantId} timeZone={timeZone} />;
}

function BillingView({ tenantId, timeZone }: { tenantId: string; timeZone: string }) {
  const loadStatus = useCallback((): Promise<AccountStatus> => fetchAccountStatus(tenantId), [tenantId]);
  const loadPlans = useCallback((): Promise<PlanOption[]> => fetchPlans(getSupabaseBrowserClient()), []);
  const loadHistory = useCallback((): Promise<LedgerEntry[]> => fetchCreditHistory(getSupabaseBrowserClient(), tenantId), [tenantId]);
  const [status, retryStatus] = useLoad(loadStatus);
  const [plans, retryPlans] = useLoad(loadPlans);
  const [history, retryHistory] = useLoad(loadHistory);

  return (
    <>
      <Section id="plan" title="Your plan">
        <Body state={status} loading="Loading your plan" missing="Your plan isn't available yet" errorTitle="Couldn't load your plan" onRetry={retryStatus}>
          {(s) => <PlanCard status={s} timeZone={timeZone} />}
        </Body>
      </Section>

      <Section id="credits" title="Credits">
        <Body state={status} loading="Loading your credits" missing="Your credit balance isn't available yet" errorTitle="Couldn't load your credits" onRetry={retryStatus}>
          {(s) => <CreditCard status={s} />}
        </Body>
      </Section>

      <Section id="plans" title="Plans">
        <Body state={plans} loading="Loading plans" missing="Plans aren't available yet" errorTitle="Couldn't load the plans" onRetry={retryPlans}>
          {(list) => <PlanList plans={list} current={status.status === "ready" ? status.data.plan : null} />}
        </Body>
        <p className="app-hint" data-testid="payments-unavailable" style={{ margin: 0 }}>
          Changing your plan and topping up credits from the dashboard isn&apos;t switched on yet, so there is nothing to buy here. Your plan and credits stay as they are.
        </p>
      </Section>

      <Section id="history" title="Credit history">
        <Body state={history} loading="Loading credit history" missing="Credit history isn't available yet" errorTitle="Couldn't load credit history" onRetry={retryHistory}>
          {(entries) => <History entries={entries} timeZone={timeZone} />}
        </Body>
      </Section>

      <Section id="invoices" title="Invoices">
        <EmptyState compact title="Invoices aren't available yet" description="Invoices will be listed here once payments are switched on." />
      </Section>
    </>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`${id}-heading`} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={sectionHead}>
        <h2 id={`${id}-heading`} style={sectionTitle}>
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
}

function Body<T>({
  state,
  loading,
  missing,
  errorTitle,
  onRetry,
  children,
}: {
  state: Load<T>;
  loading: string;
  missing: string;
  errorTitle: string;
  onRetry: () => void;
  children: (data: T) => React.ReactNode;
}) {
  if (state.status === "loading") return <LoadingState compact title={loading} />;
  if (state.status === "missing") return <EmptyState compact title={missing} description="The server doesn't provide this yet. Nothing is wrong with your account." />;
  if (state.status === "error") return <ErrorState compact title={errorTitle} description={state.error.message} onRetry={onRetry} />;
  return <>{children(state.data)}</>;
}

const date = (iso: string, timeZone: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone }).format(new Date(iso));

function PlanCard({ status, timeZone }: { status: AccountStatus; timeZone: string }) {
  const notice = pausedNotice(status.aiPausedReason);
  const trialDays = status.status === "trial" ? daysLeft(status.trialEndsAt, new Date()) : null;
  return (
    <div className="app-card" data-testid="plan-card" data-status={status.status}>
      <span className="app-card-title">{status.plan.name}</span>
      <dl className="app-facts" style={{ margin: 0 }}>
        <div>
          <dt>Status</dt>
          <dd>{STATUS_LABEL[status.status]}</dd>
        </div>
        <div>
          <dt>Credits each month</dt>
          <dd>{number.format(status.plan.monthlyCredits)}</dd>
        </div>
        {status.renewsAt ? (
          <div>
            <dt>Renews</dt>
            <dd data-testid="renews-at">{date(status.renewsAt, timeZone)}</dd>
          </div>
        ) : null}
        {status.status === "trial" && status.trialEndsAt ? (
          <div>
            <dt>Trial ends</dt>
            <dd data-testid="trial-ends">
              {date(status.trialEndsAt, timeZone)}
              {trialDays !== null ? ` · ${trialDays === 0 ? "today" : `${trialDays} ${trialDays === 1 ? "day" : "days"} left`}` : ""}
            </dd>
          </div>
        ) : null}
      </dl>
      {notice ? (
        <p role="alert" data-testid="billing-paused" data-reason={notice.reason} className="app-notice" style={{ margin: 0 }}>
          <strong>{notice.title}.</strong> {notice.detail}
        </p>
      ) : null}
      {status.status === "trial" && !notice ? (
        <p className="app-card-text" data-testid="trial-prompt">
          You&apos;re on the free trial. Pick a plan below before it ends so the assistant keeps replying.
        </p>
      ) : null}
    </div>
  );
}

function CreditCard({ status }: { status: AccountStatus }) {
  const share = meterShare(status);
  return (
    <div className="app-card" data-testid="credit-card" data-low={status.lowCredits}>
      {status.lowCredits ? <span className="app-status app-status-warn">Running low</span> : null}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: "clamp(32px, 6vw, 48px)", fontWeight: 800, lineHeight: 1 }} data-testid="credit-total">
          {number.format(status.credits.total)}
        </span>
        <span style={{ fontSize: 16, color: "var(--color-neutral-700)" }}>credits left</span>
      </div>
      {share !== null ? (
        <div role="img" aria-label={`${share}% of this cycle's credits left`} style={{ height: 6, background: "var(--color-neutral-300)" }}>
          <div style={{ height: 6, width: `${share}%`, background: status.lowCredits || status.aiPaused ? "var(--color-accent-700)" : "var(--color-accent)" }} />
        </div>
      ) : null}
      <p className="app-card-text">
        {number.format(status.credits.plan)} from your plan and {number.format(status.credits.topup)} from top-ups
        {status.creditsGranted ? `, of ${number.format(status.creditsGranted)} granted this cycle` : ""}.
      </p>
    </div>
  );
}

function PlanList({ plans, current }: { plans: PlanOption[]; current: AccountStatus["plan"] | null }) {
  if (plans.length === 0) return <EmptyState compact title="No plans to show" description="The plan list is empty." />;
  const RELATION = { current: "Your plan", upgrade: "Higher plan", downgrade: "Lower plan" } as const;
  return (
    <ul className="app-grid" data-testid="plan-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {plans.map((p) => {
        const relation = planRelation(p, current, plans);
        return (
          <li key={p.key} className="app-card" data-plan={p.key} data-relation={relation}>
            <span className="app-card-title">{p.name}</span>
            <span style={{ fontSize: "clamp(20px, 3vw, 26px)", fontWeight: 800 }}>
              {rupees(p.priceInr)}
              <span style={{ fontSize: 13, fontWeight: 400 }}> / month</span>
            </span>
            <span className="app-card-text">{number.format(p.monthlyCredits)} credits each month</span>
            <span className="app-card-text">
              {p.seats} {p.seats === 1 ? "team seat" : "team seats"} · {p.whatsappNumbers} WhatsApp {p.whatsappNumbers === 1 ? "number" : "numbers"}
            </span>
            <span className="app-status">{RELATION[relation]}</span>
          </li>
        );
      })}
    </ul>
  );
}

function History({ entries, timeZone }: { entries: LedgerEntry[]; timeZone: string }) {
  if (entries.length === 0) return <EmptyState compact title="No credit activity yet" description="Credits added and spent will be listed here." />;
  return (
    <>
      <ul data-testid="credit-history" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column" }}>
        {entries.map((e) => (
          <li
            key={e.id}
            data-reason={e.reason}
            style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--color-divider)", fontSize: 14 }}
          >
            <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
              <strong>{e.label}</strong>
              <span className="app-hint" style={{ display: "block", margin: 0 }}>
                {date(e.at, timeZone)}
                {e.expiresAt ? ` · expires ${date(e.expiresAt, timeZone)}` : ""}
              </span>
            </span>
            <span style={{ fontWeight: 700, whiteSpace: "nowrap" }} data-delta={e.delta}>
              {e.delta > 0 ? "+" : ""}
              {number.format(e.delta)}
            </span>
          </li>
        ))}
      </ul>
      {entries.length >= HISTORY_PAGE ? (
        <p className="app-hint" data-testid="history-truncated" style={{ margin: 0 }}>
          Showing the newest {HISTORY_PAGE} entries. Older ones aren&apos;t listed here.
        </p>
      ) : null}
    </>
  );
}
