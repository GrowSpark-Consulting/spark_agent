"use client";

import { PAID_PLAN_KEYS, SETUP_FEE_INR, TOPUP_PACK, type AccountStatus, type Role } from "@pakka/types";
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
import { ActionFeedback, PhonePrompt, sameAction, useBillingActions, type BillingAction, type BillingActions, type BillingCycle } from "./billing-actions";
import { PlanEnding } from "./billing-cancel";
import { PaymentReturn } from "./payment-return";

// /dashboard/billing (Day 6, Dev 3). Shows the plan and its status, the credit balance, the credit history (credit_ledger under RLS) and the
// plans on offer (the plans catalogue). The business owner can also start a payment through PayU (docs/contracts.md, "PayU billing"): choose
// a first plan, change plan, buy a top-up or the setup fee (billing-actions.tsx). Admins see the same screen without those buttons: the API
// refuses anyone but the owner, and the screen says so. Paying happens on PayU's page; when PayU sends the payer back with ?payment=<id>
// the banner (payment-return.tsx) asks the API what happened, and the plan and credits are re-read only once it confirms. Nothing here
// claims a payment from a button click or from the address. Owners and admins see the screen; staff do not
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

export function BillingScreen({ tenantId, role, timeZone, paymentId = null }: { tenantId: string; role: Role; timeZone: string; paymentId?: string | null }) {
  if (!canViewBilling(role)) {
    return (
      <p className="app-notice" role="status" data-testid="billing-no-access" style={{ margin: 0 }}>
        Billing is for owners and admins. Ask an owner if you need to see the plan or the credits.
      </p>
    );
  }
  return <BillingView tenantId={tenantId} timeZone={timeZone} isOwner={role === "owner"} paymentId={paymentId} />;
}

function BillingView({ tenantId, timeZone, isOwner, paymentId }: { tenantId: string; timeZone: string; isOwner: boolean; paymentId: string | null }) {
  const loadStatus = useCallback((): Promise<AccountStatus> => fetchAccountStatus(tenantId), [tenantId]);
  const loadPlans = useCallback((): Promise<PlanOption[]> => fetchPlans(getSupabaseBrowserClient()), []);
  const loadHistory = useCallback((): Promise<LedgerEntry[]> => fetchCreditHistory(getSupabaseBrowserClient(), tenantId), [tenantId]);
  const [status, retryStatus] = useLoad(loadStatus);
  const [plans, retryPlans] = useLoad(loadPlans);
  const [history, retryHistory] = useLoad(loadHistory);
  const actions = useBillingActions(tenantId, timeZone);
  const [cycle, setCycle] = useState<BillingCycle>("monthly");
  // Only a payment the API has confirmed (success or failed) changes what the screen shows: re-read the plan and the credits then.
  const confirmed = useCallback(() => {
    retryStatus();
    retryHistory();
  }, [retryStatus, retryHistory]);

  return (
    <>
      {paymentId ? <PaymentReturn key={paymentId} tenantId={tenantId} paymentId={paymentId} onConfirmed={confirmed} /> : null}

      <Section id="plan" title="Your plan">
        <Body state={status} loading="Loading your plan" missing="Your plan isn't available yet" errorTitle="Couldn't load your plan" onRetry={retryStatus}>
          {(s) => <PlanCard status={s} timeZone={timeZone} tenantId={tenantId} isOwner={isOwner} onChanged={retryStatus} />}
        </Body>
      </Section>

      <Section id="credits" title="Credits">
        <Body state={status} loading="Loading your credits" missing="Your credit balance isn't available yet" errorTitle="Couldn't load your credits" onRetry={retryStatus}>
          {(s) => <CreditCard status={s} />}
        </Body>
      </Section>

      <Section id="plans" title="Plans">
        <ActionFeedback actions={actions} />
        <PhonePrompt actions={actions} />
        {isOwner && status.status === "ready" && status.data.status !== "active" ? <CycleChoice cycle={cycle} onChange={setCycle} disabled={actions.busy !== null} /> : null}
        <Body state={plans} loading="Loading plans" missing="Plans aren't available yet" errorTitle="Couldn't load the plans" onRetry={retryPlans}>
          {(list) => <PlanList plans={list} status={status.status === "ready" ? status.data : null} isOwner={isOwner} cycle={cycle} actions={actions} />}
        </Body>
        {isOwner ? (
          <p className="app-hint" data-testid="payments-note" style={{ margin: 0 }}>
            Prices are before GST; PayU shows the total before you pay. Yearly is ten months&apos; price for twelve. You pay on PayU&apos;s secure page, and your plan and credits only change once PayU confirms the payment.
          </p>
        ) : (
          <p className="app-hint" data-testid="owner-only-note" style={{ margin: 0 }}>
            Only the business owner can pay or change the plan. Ask the owner to do it from this page.
          </p>
        )}
      </Section>

      {isOwner ? (
        <Section id="extras" title="Top up and extras">
          <Extras status={status.status === "ready" ? status.data : null} actions={actions} />
        </Section>
      ) : null}

      <Section id="history" title="Credit history">
        <Body state={history} loading="Loading credit history" missing="Credit history isn't available yet" errorTitle="Couldn't load credit history" onRetry={retryHistory}>
          {(entries) => <History entries={entries} timeZone={timeZone} />}
        </Body>
      </Section>

      <Section id="invoices" title="Invoices">
        <EmptyState compact title="No invoice list yet" description="The dashboard doesn't list invoices. Each payment you make shows up in the credit history once PayU confirms it." />
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

function PlanCard({ status, timeZone, tenantId, isOwner, onChanged }: { status: AccountStatus; timeZone: string; tenantId: string; isOwner: boolean; onChanged: () => void }) {
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
        {status.endsAt ? (
          <div>
            <dt>Ends</dt>
            <dd data-testid="ends-at">{date(status.endsAt, timeZone)}</dd>
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
      {isOwner && status.status === "active" ? (
        <PlanEnding tenantId={tenantId} timeZone={timeZone} renewsAt={status.renewsAt} endsAt={status.endsAt ?? null} onChanged={onChanged} />
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

function CycleChoice({ cycle, onChange, disabled }: { cycle: BillingCycle; onChange: (c: BillingCycle) => void; disabled: boolean }) {
  return (
    <fieldset data-testid="cycle-choice" disabled={disabled} style={{ border: 0, margin: 0, padding: 0, display: "flex", gap: 16, flexWrap: "wrap" }}>
      <legend className="app-card-text" style={{ padding: 0, marginBottom: 6 }}>
        How do you want to pay?
      </legend>
      {(["monthly", "yearly"] as const).map((c) => (
        <label key={c} style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="radio" name="billing-cycle" value={c} checked={cycle === c} onChange={() => onChange(c)} />
          {c === "monthly" ? "Monthly" : "Yearly (10 months for 12)"}
        </label>
      ))}
    </fieldset>
  );
}

function PlanList({ plans, status, isOwner, cycle, actions }: { plans: PlanOption[]; status: AccountStatus | null; isOwner: boolean; cycle: BillingCycle; actions: BillingActions }) {
  if (plans.length === 0) return <EmptyState compact title="No plans to show" description="The plan list is empty." />;
  const current = status?.plan ?? null;
  const RELATION = { current: "Your plan", upgrade: "Higher plan", downgrade: "Lower plan" } as const;
  // A live paid plan is changed (change-plan); with none (the trial, paused, cancelled) the first plan is chosen (checkout).
  const hasPlan = status?.status === "active";
  const yearly = !hasPlan && cycle === "yearly";
  return (
    <ul className="app-grid" data-testid="plan-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {plans.map((p) => {
        const relation = planRelation(p, current, plans);
        const planKey = PAID_PLAN_KEYS.find((k) => k === p.key);
        const action: BillingAction | null = !isOwner || !status || !planKey ? null : hasPlan ? { kind: "change_plan", planKey } : { kind: "checkout", planKey, cycle };
        const working = action !== null && sameAction(actions.busy, action);
        const label = hasPlan
          ? relation === "current"
            ? "Keep this plan"
            : relation === "upgrade"
              ? `Upgrade to ${p.name}`
              : `Switch to ${p.name} at renewal`
          : `Choose ${p.name}`;
        return (
          <li key={p.key} className="app-card" data-plan={p.key} data-relation={relation}>
            <span className="app-card-title">{p.name}</span>
            <span style={{ fontSize: "clamp(20px, 3vw, 26px)", fontWeight: 800 }}>
              {rupees(yearly ? p.priceInr * 10 : p.priceInr)}
              <span style={{ fontSize: 13, fontWeight: 400 }}>{yearly ? " / year" : " / month"}</span>
            </span>
            <span className="app-card-text">{number.format(p.monthlyCredits)} credits each month</span>
            <span className="app-card-text">
              {p.seats} {p.seats === 1 ? "team seat" : "team seats"} · {p.whatsappNumbers} WhatsApp {p.whatsappNumbers === 1 ? "number" : "numbers"}
            </span>
            <span className="app-status">{RELATION[relation]}</span>
            {action ? (
              <>
                <button type="button" className={relation === "current" && hasPlan ? "btn btn-secondary" : "btn btn-primary"} disabled={actions.busy !== null} aria-busy={working} data-testid={`plan-action-${p.key}`} onClick={() => void actions.run(action)}>
                  {working ? (action.kind === "change_plan" && relation !== "upgrade" ? "Saving…" : "Opening PayU…") : label}
                </button>
                {hasPlan && relation === "current" ? <span className="app-hint">Cancels a downgrade you scheduled earlier.</span> : null}
              </>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function Extras({ status, actions }: { status: AccountStatus | null; actions: BillingActions }) {
  const topup: BillingAction = { kind: "topup" };
  const setup: BillingAction = { kind: "setup_fee" };
  const paid = status?.status === "active";
  return (
    <div className="app-grid">
      <div className="app-card" data-testid="topup-card">
        <span className="app-card-title">Credit top-up</span>
        <span style={{ fontSize: "clamp(20px, 3vw, 26px)", fontWeight: 800 }}>{rupees(TOPUP_PACK.priceInr)}</span>
        <span className="app-card-text">{number.format(TOPUP_PACK.credits)} credits, expiring 90 days after purchase. Before GST.</span>
        {status && !paid ? (
          <span className="app-hint">Top-ups are for businesses on a paid plan. Choose a plan first.</span>
        ) : (
          <button type="button" className="btn btn-primary" disabled={!status || actions.busy !== null} data-testid="topup-action" onClick={() => void actions.run(topup)}>
            {sameAction(actions.busy, topup) ? "Opening PayU…" : "Buy credits"}
          </button>
        )}
      </div>
      <div className="app-card" data-testid="setup-fee-card">
        <span className="app-card-title">Assisted setup</span>
        <span style={{ fontSize: "clamp(20px, 3vw, 26px)", fontWeight: 800 }}>{rupees(SETUP_FEE_INR)}</span>
        <span className="app-card-text">One-time fee, before GST. It adds no credits; we call you to help set things up.</span>
        <button type="button" className="btn btn-secondary" disabled={actions.busy !== null} data-testid="setup-fee-action" onClick={() => void actions.run(setup)}>
          {sameAction(actions.busy, setup) ? "Opening PayU…" : "Pay the setup fee"}
        </button>
      </div>
    </div>
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
