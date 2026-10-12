"use client";

import type { Role } from "@pakka/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/shared/states";
import { Switch } from "@/components/ui/switch";
import { DialogFrame } from "@/features/knowledge/dialog-frame";
import { FlashStatus, useFlash } from "@/features/knowledge/flash";
import { sectionHead, sectionTitle } from "@/features/settings/section";
import { formatError, type FormattedError } from "@/lib/errors";
import {
  canChangeFeatures,
  changeFor,
  featureService as defaultService,
  isFeatureApiMissing,
  isPlanRequired,
  planName,
  rowControl,
  savedOffset,
  TIMING_CHOICES,
  offsetLabel,
  withRow,
  type FeatureList,
  type FeatureRow,
  type FeatureService,
} from "./feature-api";

// /dashboard/features (Day 5, Dev 3): every feature the business can switch, grouped, with what its plan includes and the
// credits it used in the last 30 days. Rendered from GET /api/features; a switch is PATCH /api/features/:key and shows the
// row the server answers with, never the one the person asked for: until the server says so, the switch stays where it
// was and shows "Saving…". Locked rows (the plan does not include them) offer Upgrade and no switch. What a plan includes is
// decided by the server; this file only draws it.

type State =
  | { status: "loading" }
  /** The API answered, but this server has no such route (it is not deployed there yet). Not a fault of the business's. */
  | { status: "missing" }
  | { status: "error"; error: FormattedError }
  | { status: "ready"; list: FeatureList };

const number = new Intl.NumberFormat("en-IN");

export function TogglesScreen({ tenantId, role, service = defaultService }: { tenantId: string; role: Role; service?: FeatureService }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [upgrade, setUpgrade] = useState<FeatureRow | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [toast, flash] = useFlash();
  const latest = useRef(0);
  // useFlash returns a new function on every render; the loader must not depend on it, or every render would read the list again.
  const flashRef = useRef(flash);
  useEffect(() => {
    flashRef.current = flash;
  });

  const load = useCallback(
    async (quiet: boolean) => {
      const request = ++latest.current;
      if (quiet) setRefreshing(true);
      try {
        const list = await service.load(tenantId);
        if (request === latest.current) setState({ status: "ready", list });
      } catch (err) {
        if (request !== latest.current) return;
        // A refresh that fails leaves what is on screen and says so; a first load that fails has nothing to show.
        if (quiet) flashRef.current("Couldn't refresh. Showing what was loaded before.");
        else setState(isFeatureApiMissing(err) ? { status: "missing" } : { status: "error", error: formatError(err) });
      } finally {
        if (request === latest.current) setRefreshing(false);
      }
    },
    [service, tenantId],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const list = state.status === "ready" ? state.list : null;

  async function apply(row: FeatureRow, change: NonNullable<ReturnType<typeof changeFor>>, done: string) {
    if (pending.has(row.key)) return;
    setPending((p) => new Set(p).add(row.key));
    setRowErrors((e) => Object.fromEntries(Object.entries(e).filter(([key]) => key !== row.key)));
    try {
      const saved = await service.update(tenantId, row.key, change);
      setState((s) => (s.status === "ready" ? { status: "ready", list: withRow(s.list, saved) } : s));
      flash(done);
    } catch (err) {
      if (isPlanRequired(err)) setUpgrade(row);
      else setRowErrors((e) => ({ ...e, [row.key]: formatError(err).message }));
    } finally {
      setPending((p) => {
        const next = new Set(p);
        next.delete(row.key);
        return next;
      });
    }
  }

  function toggle(row: FeatureRow, wantOn: boolean) {
    const change = changeFor(row, role, wantOn);
    if (change) void apply(row, change, `${row.name} is ${wantOn ? "on" : "off"}`);
  }

  function setTiming(row: FeatureRow, minutes: number) {
    if (!canChangeFeatures(role) || row.state === "locked") return;
    void apply(row, { settings: { offset_minutes: minutes } }, `${row.name}: ${offsetLabel(minutes).toLowerCase()}`);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "32px", maxWidth: "960px", minWidth: 0, color: "var(--color-text)" }}>
      {state.status === "loading" ? <LoadingState title="Loading your features" /> : null}
      {state.status === "missing" ? (
        <EmptyState
          title="Feature settings aren't available yet"
          description="This server doesn't have the feature settings yet, so nothing can be shown or changed here. Your features keep working as they are."
        />
      ) : null}
      {state.status === "error" ? <ErrorState title="Couldn't load your features" description={state.error.message} onRetry={() => void load(false)} /> : null}

      {list ? (
        <>
          <PlanSummary list={list} refreshing={refreshing} onRefresh={() => void load(true)} />
          {!canChangeFeatures(role) ? <p className="app-notice" style={{ margin: 0 }}>You can see these settings. Only an owner or admin can change them.</p> : null}
          {list.groups.length === 0 ? <EmptyState compact title="No features to show" description="There's nothing to switch on this plan yet." /> : null}
          {list.groups.map((group) => (
            <section key={group.name} aria-labelledby={`group-${slug(group.name)}`} style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              <div style={sectionHead}>
                <h2 id={`group-${slug(group.name)}`} style={sectionTitle}>
                  {group.name}
                </h2>
              </div>
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {group.features.map((row) => (
                  <FeatureRowView
                    key={row.key}
                    row={row}
                    role={role}
                    busy={pending.has(row.key)}
                    error={rowErrors[row.key] ?? null}
                    onToggle={(on) => toggle(row, on)}
                    onTiming={(minutes) => setTiming(row, minutes)}
                    onUpgrade={() => setUpgrade(row)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </>
      ) : null}

      {upgrade ? <UpgradeDialog row={upgrade} currentPlan={list?.plan.name ?? null} onClose={() => setUpgrade(null)} /> : null}
      <FlashStatus toast={toast} />
    </div>
  );
}

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function PlanSummary({ list, refreshing, onRefresh }: { list: FeatureList; refreshing: boolean; onRefresh: () => void }) {
  const { plan, estimatedCreditsPerMonth: used } = list;
  const share = plan.monthlyCredits > 0 ? Math.min(100, Math.round((used / plan.monthlyCredits) * 100)) : 0;
  return (
    <section aria-label="Your plan" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: "16px", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: "12px", color: "var(--color-neutral-700)" }}>Your plan</div>
          <div style={{ fontWeight: 800, fontSize: "24px" }}>
            {plan.name} <span style={{ fontWeight: 600, fontSize: "14px", color: "var(--color-neutral-700)" }}>· {number.format(plan.monthlyCredits)} credits a month</span>
          </div>
        </div>
        <button type="button" className="btn btn-secondary" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <div>
        <div style={{ fontWeight: 600 }} data-testid="credits-estimate">
          About {number.format(used)} of {number.format(plan.monthlyCredits)} credits a month with what&apos;s on
        </div>
        <div role="img" aria-label={`${share}% of the plan's monthly credits`} style={{ height: "6px", background: "var(--color-neutral-300)", marginTop: "6px" }}>
          <div style={{ height: "6px", width: `${share}%`, background: "var(--color-accent)" }} />
        </div>
        <p className="app-hint">Counted from the messages each feature sent in the last 30 days. It changes as you switch things on or off.</p>
      </div>
    </section>
  );
}

function creditText(row: FeatureRow): string {
  if (row.creditsPerMonth !== null) return `${number.format(row.creditsPerMonth)} ${row.creditsPerMonth === 1 ? "credit" : "credits"} in the last 30 days`;
  return row.creditNote ?? "No extra credits";
}

function FeatureRowView({
  row,
  role,
  busy,
  error,
  onToggle,
  onTiming,
  onUpgrade,
}: {
  row: FeatureRow;
  role: Role;
  busy: boolean;
  error: string | null;
  onToggle: (on: boolean) => void;
  onTiming: (minutes: number) => void;
  onUpgrade: () => void;
}) {
  const control = rowControl(row, role);
  const locked = row.state === "locked";
  const note = locked && control.kind === "fixed" ? control.why : row.state === "disabled" ? row.disabledReason : null;
  const showTiming = row.control === "timing" && !locked && row.state !== "disabled";
  const timingDisabled = busy || control.kind === "fixed";
  const offset = savedOffset(row);
  return (
    <li
      data-testid="feature-row"
      data-feature={row.key}
      data-state={row.state}
      style={{ display: "flex", gap: "16px", alignItems: "flex-start", justifyContent: "space-between", padding: "14px 0", borderBottom: "1px solid var(--color-divider)", flexWrap: "wrap" }}
    >
      <div style={{ flex: "1 1 280px", minWidth: 0, display: "flex", flexDirection: "column", gap: "3px" }}>
        <div style={{ fontWeight: 800, fontSize: "16px", overflowWrap: "anywhere" }}>{row.name}</div>
        <div id={`desc-${row.key}`} style={{ fontSize: "14px", color: "var(--color-neutral-700)", overflowWrap: "anywhere" }}>
          {row.description}
        </div>
        <div style={{ fontSize: "12px", color: "var(--color-neutral-700)" }}>{creditText(row)}</div>
        {note ? (
          <div data-testid="feature-note" style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-accent-700)" }}>
            {note}
          </div>
        ) : null}
        {showTiming ? (
          <label style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "13px", marginTop: "6px", flexWrap: "wrap" }}>
            <span>Send</span>
            <select
              className="input"
              value={offset}
              disabled={timingDisabled}
              onChange={(e) => onTiming(Number(e.target.value))}
              style={{ width: "auto", minHeight: "36px" }}
              aria-label={`When to send: ${row.name}`}
            >
              {TIMING_CHOICES.some((c) => c.minutes === offset) ? null : <option value={offset}>{offsetLabel(offset)}</option>}
              {TIMING_CHOICES.map((c) => (
                <option key={c.minutes} value={c.minutes}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {error ? (
          <div role="alert" style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-accent-700)" }}>
            {error}
          </div>
        ) : null}
      </div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "6px", flex: "none" }}>
        {locked ? (
          <button type="button" className="btn btn-secondary" onClick={onUpgrade}>
            {row.requiredPlan ? `Upgrade to ${planName(row.requiredPlan)}` : "Upgrade"}
          </button>
        ) : (
          <>
            <Switch
              checked={control.checked}
              disabled={busy || control.kind === "fixed"}
              onCheckedChange={onToggle}
              aria-label={row.name}
              aria-describedby={`desc-${row.key}`}
            />
            {busy ? (
              <span style={{ fontSize: "12px", color: "var(--color-neutral-700)" }} aria-live="polite">
                Saving…
              </span>
            ) : null}
          </>
        )}
      </div>
    </li>
  );
}

function UpgradeDialog({ row, currentPlan, onClose }: { row: FeatureRow; currentPlan: string | null; onClose: () => void }) {
  const target = row.requiredPlan ? planName(row.requiredPlan) : null;
  return (
    <DialogFrame title={target ? `${row.name} is on the ${target} plan` : `${row.name} isn't in your plan`} onClose={onClose} busy={false}>
      <>
        <div style={{ fontSize: "14px", color: "var(--color-neutral-700)" }}>
          {currentPlan ? `You're on ${currentPlan}. ` : ""}
          {target ? `Switching ${row.name} on needs ${target} or higher. ` : ""}
          Changing plans from the dashboard isn&apos;t switched on yet, so it stays off for now.
        </div>
        <div className="dialog-actions" style={{ justifyContent: "flex-start" }}>
          <button type="button" className="btn btn-secondary" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
      </>
    </DialogFrame>
  );
}
