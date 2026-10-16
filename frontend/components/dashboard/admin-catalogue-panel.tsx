"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { AdminFeature, AdminPlan } from "@pakka/types";
import { checkFeature, checkPlan, draftOfFeature, draftOfPlan, fetchFeatureCatalogue, fetchPlanCatalogue, saveFeature, savePlan, type FeatureDraft, type PlanDraft } from "@/lib/admin/catalogue";
import { formatError } from "@/lib/errors";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

// /dashboard/admin/plans: the Spark Agent team edits the plans and the feature catalogue (docs/contracts.md, "Admin panel, billing"). The lists are
// read as the signed-in member (plans and features are catalogues any member reads, 0001). Saving is PATCH /api/admin/plans/:key and
// /api/admin/features/:key, which only a platform admin may call: the browser cannot tell who that is, so anyone can open this page and the server
// refuses everyone else, which the card then says. A card shows a change as saved only after the server answered, and then shows the server's row.

type Load<T> = { state: "loading" } | { state: "ready"; data: T } | { state: "failed"; message: string };

function useCatalogue<T>(read: () => Promise<T>): [Load<T>, (change: (current: T) => T) => void, () => void] {
  const [result, setResult] = useState<Load<T>>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const readRef = useRef(read);
  useEffect(() => {
    readRef.current = read;
  });
  useEffect(() => {
    let live = true;
    readRef.current().then(
      (data) => live && setResult({ state: "ready", data }),
      (err) => live && setResult({ state: "failed", message: formatError(err).message }),
    );
    return () => {
      live = false;
    };
  }, [attempt]);
  const reload = useCallback(() => {
    setResult({ state: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  // A change is applied to the list as it is now, never to the one a card saw when it was pressed: two saves that overlap must not undo each other.
  const replace = useCallback((change: (current: T) => T) => setResult((prev) => (prev.state === "ready" ? { state: "ready", data: change(prev.data) } : prev)), []);
  return [result, replace, reload];
}

type Outcome = { kind: "ok" | "error"; text: string } | null;

/** The words for a refused or failed save: the server's own for a refusal that says why, and an honest "can't confirm" for a lost answer. */
function failureText(err: unknown): { text: string; fields?: Record<string, string> } {
  const shown = formatError(err);
  if (shown.code === "forbidden") return { text: "Only the Spark Agent team can change this. You are not on the platform-admin list. Nothing was changed." };
  if (shown.code === "validation_failed") return { text: `${shown.message} Nothing was changed.`, fields: shown.fields };
  if (shown.code === "conflict") return { text: `${shown.message} Nothing was changed.` };
  if (shown.code === "network" || shown.code === "upstream_failed" || shown.code === "internal") return { text: `${shown.message} We can't confirm whether it was saved: reload to see what is stored.` };
  return { text: `${shown.message} Nothing was changed.` };
}

export function AdminCataloguePanel() {
  const [plans, replacePlans, reloadPlans] = useCatalogue(useCallback(() => fetchPlanCatalogue(getSupabaseBrowserClient()), []));
  const [features, replaceFeatures, reloadFeatures] = useCatalogue(useCallback(() => fetchFeatureCatalogue(getSupabaseBrowserClient()), []));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
      <section aria-labelledby="plans-h" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <h2 id="plans-h" className="app-h2">
          Plans
        </h2>
        {plans.state === "loading" ? (
          <p className="app-hint" role="status" data-testid="plans-loading">
            Loading plans…
          </p>
        ) : null}
        {plans.state === "failed" ? <LoadFailed what="the plans" message={plans.message} onRetry={reloadPlans} testId="plans-error" /> : null}
        {plans.state === "ready" && plans.data.length === 0 ? (
          <p className="app-hint" data-testid="plans-empty">
            No plans are set up yet.
          </p>
        ) : null}
        {plans.state === "ready" ? (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 16 }}>
            {plans.data.map((p) => (
              <PlanEditor key={p.key} plan={p} features={features} onSaved={(saved) => replacePlans((list) => list.map((x) => (x.key === saved.key ? saved : x)))} />
            ))}
          </ul>
        ) : null}
      </section>

      <section aria-labelledby="features-h" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <h2 id="features-h" className="app-h2">
          Features
        </h2>
        {features.state === "loading" ? (
          <p className="app-hint" role="status" data-testid="features-loading">
            Loading features…
          </p>
        ) : null}
        {features.state === "failed" ? <LoadFailed what="the features" message={features.message} onRetry={reloadFeatures} testId="features-error" /> : null}
        {features.state === "ready" && features.data.length === 0 ? (
          <p className="app-hint" data-testid="features-empty">
            No features are set up yet.
          </p>
        ) : null}
        {features.state === "ready" ? (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 16 }}>
            {features.data.map((f) => (
              <FeatureEditor key={f.key} feature={f} onSaved={(saved) => replaceFeatures((list) => list.map((x) => (x.key === saved.key ? saved : x)))} />
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}

function LoadFailed({ what, message, onRetry, testId }: { what: string; message: string; onRetry: () => void; testId: string }) {
  return (
    <div className="app-notice" role="alert" data-testid={testId}>
      <strong>Couldn&apos;t load {what}.</strong> {message}
      <div className="app-actions">
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
      </div>
    </div>
  );
}

function FieldError({ text }: { text?: string }) {
  return text ? (
    <p className="app-field-error" role="alert">
      {text}
    </p>
  ) : null;
}

function PlanEditor({ plan, features, onSaved }: { plan: AdminPlan; features: Load<AdminFeature[]>; onSaved: (plan: AdminPlan) => void }) {
  const [draft, setDraft] = useState<PlanDraft>(() => draftOfPlan(plan));
  const [fields, setFields] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const id = `plan-${plan.key}`;
  const checked = checkPlan(plan, draft);
  const set = (patch: Partial<PlanDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setOutcome(null);
  };
  const featureList = features.state === "ready" ? features.data : null;
  const toggle = (key: string, on: boolean) => set({ featureKeys: on ? [...draft.featureKeys, key] : draft.featureKeys.filter((k) => k !== key) });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (lock.current) return;
    const result = checkPlan(plan, draft);
    setOutcome(null);
    if (result.kind === "invalid") return setFields(result.fields);
    setFields({});
    if (result.kind === "unchanged") return setOutcome({ kind: "ok", text: "Nothing to save: no field was changed." });
    lock.current = true;
    setBusy(true);
    try {
      const saved = await savePlan(plan.key, result.value);
      setDraft(draftOfPlan(saved));
      onSaved(saved);
      setOutcome({ kind: "ok", text: `Saved. ${saved.name} is now ₹${saved.priceInr.toLocaleString("en-IN")} with ${saved.monthlyCredits.toLocaleString("en-IN")} credits a month.` });
    } catch (err) {
      const failed = failureText(err);
      if (failed.fields && Object.keys(failed.fields).length) setFields(failed.fields);
      setOutcome({ kind: "error", text: failed.text });
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  const shownKeys = featureList ? featureList.map((f) => f.key) : [];
  // A feature the plan holds that the catalogue no longer lists is still shown, so a save cannot drop it unseen.
  const unknownKeys = featureList ? draft.featureKeys.filter((k) => !shownKeys.includes(k)) : [];

  return (
    <li className="app-card" data-testid="plan-editor" data-plan={plan.key}>
      <form className="app-form" onSubmit={submit} noValidate aria-label={`Edit the ${plan.name} plan`}>
        <div>
          <strong>{plan.name}</strong> <span className="app-hint">{plan.key}</span>
        </div>
        <div className="field">
          <label htmlFor={`${id}-name`}>Name</label>
          <input id={`${id}-name`} className="input" value={draft.name} onChange={(e) => set({ name: e.target.value })} disabled={busy} aria-invalid={!!fields.name} />
          <FieldError text={fields.name} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-price`}>Price per month (₹, before GST)</label>
          <input id={`${id}-price`} className="input" inputMode="numeric" value={draft.priceInr} onChange={(e) => set({ priceInr: e.target.value })} disabled={busy} aria-invalid={!!fields.priceInr} aria-describedby={`${id}-price-hint`} />
          <p id={`${id}-price-hint`} className="app-hint">
            The server refuses a price change while any business is subscribed at the old price.
          </p>
          <FieldError text={fields.priceInr} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-credits`}>Credits per month</label>
          <input id={`${id}-credits`} className="input" inputMode="numeric" value={draft.monthlyCredits} onChange={(e) => set({ monthlyCredits: e.target.value })} disabled={busy} aria-invalid={!!fields.monthlyCredits} />
          <FieldError text={fields.monthlyCredits} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-seats`}>Team seats</label>
          <input id={`${id}-seats`} className="input" inputMode="numeric" value={draft.seats} onChange={(e) => set({ seats: e.target.value })} disabled={busy} aria-invalid={!!fields.seats} />
          <FieldError text={fields.seats} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-numbers`}>WhatsApp numbers</label>
          <input id={`${id}-numbers`} className="input" inputMode="numeric" value={draft.whatsappNumbers} onChange={(e) => set({ whatsappNumbers: e.target.value })} disabled={busy} aria-invalid={!!fields.whatsappNumbers} />
          <FieldError text={fields.whatsappNumbers} />
        </div>
        <fieldset disabled={busy || !featureList} style={{ margin: 0, padding: 0, border: 0, display: "flex", flexDirection: "column", gap: 6 }} data-testid="plan-features">
          <legend style={{ padding: 0, marginBottom: 6, fontWeight: 600 }}>Features in this plan</legend>
          {features.state === "loading" ? <p className="app-hint">Loading the feature list…</p> : null}
          {features.state === "failed" ? <p className="app-hint">The feature list couldn&apos;t be loaded, so this plan&apos;s features can&apos;t be changed right now.</p> : null}
          {featureList?.map((f) => (
            <label key={f.key} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={draft.featureKeys.includes(f.key)} onChange={(e) => toggle(f.key, e.target.checked)} />
              <span>
                {f.name} <span className="app-hint">{f.key}</span>
              </span>
            </label>
          ))}
          {unknownKeys.map((k) => (
            <label key={k} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked onChange={(e) => toggle(k, e.target.checked)} />
              <span>
                {k} <span className="app-hint">not in the feature list</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="app-actions">
          <button type="submit" className="btn btn-primary" disabled={busy || checked.kind === "unchanged"}>
            {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
        {outcome ? (
          <p className="app-hint" role={outcome.kind === "error" ? "alert" : "status"} data-testid="plan-outcome">
            {outcome.text}
          </p>
        ) : null}
      </form>
    </li>
  );
}

function FeatureEditor({ feature, onSaved }: { feature: AdminFeature; onSaved: (feature: AdminFeature) => void }) {
  const [draft, setDraft] = useState<FeatureDraft>(() => draftOfFeature(feature));
  const [fields, setFields] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const id = `feature-${feature.key}`;
  const checked = checkFeature(feature, draft);
  const set = (patch: Partial<FeatureDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setOutcome(null);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (lock.current) return;
    const result = checkFeature(feature, draft);
    setOutcome(null);
    if (result.kind === "invalid") return setFields(result.fields);
    setFields({});
    if (result.kind === "unchanged") return setOutcome({ kind: "ok", text: "Nothing to save: no field was changed." });
    lock.current = true;
    setBusy(true);
    try {
      const saved = await saveFeature(feature.key, result.value);
      setDraft(draftOfFeature(saved));
      onSaved(saved);
      setOutcome({ kind: "ok", text: `Saved. ${saved.name} is ${saved.defaultOn ? "on" : "off"} by default.` });
    } catch (err) {
      const failed = failureText(err);
      if (failed.fields && Object.keys(failed.fields).length) setFields(failed.fields);
      setOutcome({ kind: "error", text: failed.text });
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <li className="app-card" data-testid="feature-editor" data-feature={feature.key}>
      <form className="app-form" onSubmit={submit} noValidate aria-label={`Edit the ${feature.name} feature`}>
        <div>
          <strong>{feature.name}</strong> <span className="app-hint">{feature.key}</span>
        </div>
        <div className="field">
          <label htmlFor={`${id}-name`}>Name</label>
          <input id={`${id}-name`} className="input" value={draft.name} onChange={(e) => set({ name: e.target.value })} disabled={busy} aria-invalid={!!fields.name} />
          <FieldError text={fields.name} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-description`}>Description</label>
          <textarea id={`${id}-description`} className="input" rows={2} value={draft.description} onChange={(e) => set({ description: e.target.value })} disabled={busy} aria-invalid={!!fields.description} />
          <FieldError text={fields.description} />
        </div>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={draft.defaultOn} onChange={(e) => set({ defaultOn: e.target.checked })} disabled={busy} />
          <span>On by default</span>
        </label>
        <div className="app-actions">
          <button type="submit" className="btn btn-primary" disabled={busy || checked.kind === "unchanged"}>
            {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
        {outcome ? (
          <p className="app-hint" role={outcome.kind === "error" ? "alert" : "status"} data-testid="feature-outcome">
            {outcome.text}
          </p>
        ) : null}
      </form>
    </li>
  );
}
