"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ErrorState, LoadingState } from "@/components/shared/states";
import { planName, featureService as defaultFeatureService, type FeatureService } from "@/features/toggles/feature-api";
import { describeSetupWriteError } from "@/features/settings/resources-data";
import { sectionHead, sectionTitle } from "@/features/settings/section";
import { formatError, type FormattedError } from "@/lib/errors";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { fetchTakeoverPref, ownNumberAccess, saveTakeoverPref, takeoverOptions, type OwnNumberAccess, type TakeoverPref } from "./takeover-pref";

// "How you take over chats" on the Team screen: memberships.takeover_pref, with the own-number choices shown as the `handoff_own_number`
// feature row of GET /api/features says (takeover-pref.ts). A locked feature is shown as unavailable with the plan that includes it; nothing
// here decides what a plan has. Each member sets their own; the server checks the entitlement again when an alert button is tapped.

type PrefState = { status: "loading" } | { status: "error"; error: FormattedError } | { status: "ready"; saved: TakeoverPref | null };
type AccessState = { status: "loading" } | { status: "error"; error: FormattedError } | { status: "ready"; access: OwnNumberAccess };

export function TakeoverSection({
  tenantId,
  userId,
  hasAlertNumber,
  onSaved,
  features = defaultFeatureService,
}: {
  tenantId: string;
  userId: string;
  hasAlertNumber: boolean;
  onSaved: (message: string) => void;
  features?: FeatureService;
}) {
  const [pref, setPref] = useState<PrefState>({ status: "loading" });
  const [access, setAccess] = useState<AccessState>({ status: "loading" });
  const [draft, setDraft] = useState<TakeoverPref | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<FormattedError | null>(null);

  const loadPref = useCallback(
    () =>
      fetchTakeoverPref(getSupabaseBrowserClient(), tenantId, userId).then(
        (saved) => {
          setPref({ status: "ready", saved });
          setDraft(saved);
        },
        (err: unknown) => setPref({ status: "error", error: formatError(err) }),
      ),
    [tenantId, userId],
  );
  const loadAccess = useCallback(
    () =>
      features.load(tenantId).then(
        (list) => setAccess({ status: "ready", access: ownNumberAccess(list) }),
        (err: unknown) => setAccess({ status: "error", error: formatError(err) }),
      ),
    [features, tenantId],
  );

  useEffect(() => {
    void loadPref();
    void loadAccess();
  }, [loadPref, loadAccess]);

  const resolved: OwnNumberAccess = access.status === "ready" ? access.access : { kind: "unknown" };
  const options = takeoverOptions(resolved, hasAlertNumber);
  const saved = pref.status === "ready" ? pref.saved : null;
  const dirty = pref.status === "ready" && draft !== null && draft !== saved;
  // A saved own-number choice the plan no longer allows is shown, not hidden: the alert link falls back to the inbox on its own.
  const savedBlocked = saved !== null ? (options.find((o) => o.value === saved)?.unavailable ?? null) : null;
  const upgradePlan = resolved.kind === "locked" ? resolved.requiredPlan : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!dirty || draft === null || saving) return;
    if (options.find((o) => o.value === draft)?.unavailable) return;
    setSaving(true);
    setSaveError(null);
    try {
      const stored = await saveTakeoverPref(getSupabaseBrowserClient(), tenantId, userId, draft);
      setPref({ status: "ready", saved: stored });
      setDraft(stored);
      onSaved("Saved how you take over chats");
    } catch (err) {
      setSaveError(describeSetupWriteError(err, "Couldn't save your choice"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="takeover-heading" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <div style={sectionHead}>
        <h2 id="takeover-heading" style={sectionTitle}>
          How you take over chats
        </h2>
      </div>

      {pref.status === "loading" ? <LoadingState compact title="Loading your choice" /> : null}
      {pref.status === "error" ? (
        <ErrorState
          compact
          title="Couldn't load your choice"
          description={pref.error.message}
          onRetry={() => {
            setPref({ status: "loading" });
            void loadPref();
          }}
        />
      ) : null}
      {access.status === "error" ? (
        <ErrorState
          compact
          title="Couldn't check your plan"
          description={access.error.message}
          onRetry={() => {
            setAccess({ status: "loading" });
            void loadAccess();
          }}
        />
      ) : null}

      {pref.status === "ready" ? (
        <form onSubmit={submit} aria-label="How you take over chats" style={{ display: "flex", flexDirection: "column", gap: "10px", maxWidth: "560px" }}>
          <p className="app-hint" style={{ margin: 0 }}>
            When an alert tells you a customer needs a person, this is what its button does. Only you can change it.
          </p>
          {resolved.kind === "locked" ? (
            <p role="status" data-testid="own-number-locked" className="app-notice" style={{ margin: 0 }}>
              Taking over from your own number {upgradePlan ? <>needs the {planName(upgradePlan)} plan. </> : "isn’t included in your plan. "}
              {upgradePlan ? (
                <Link href="/dashboard/billing" data-testid="own-number-upgrade">
                  See plans
                </Link>
              ) : null}
            </p>
          ) : null}
          {savedBlocked && saved !== "inbox" ? (
            <p role="status" data-testid="saved-choice-blocked" className="app-notice" style={{ margin: 0 }}>
              You chose “{options.find((o) => o.value === saved)?.label}”, but it can’t be used right now: {savedBlocked} Alerts open the chat in the inbox instead.
            </p>
          ) : null}
          <fieldset disabled={saving} style={{ border: 0, margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "8px", minWidth: 0 }}>
            <legend className="app-hint" style={{ padding: 0 }}>
              Take over a chat
            </legend>
            {options.map((o) => {
              const id = `takeover-${o.value}`;
              const blocked = o.unavailable !== null;
              return (
                <div key={o.value} style={{ display: "flex", gap: "10px", alignItems: "flex-start", opacity: blocked ? 0.7 : 1 }}>
                  <input
                    id={id}
                    type="radio"
                    name="takeover"
                    value={o.value}
                    checked={draft === o.value}
                    disabled={blocked}
                    aria-describedby={`${id}-note`}
                    onChange={() => setDraft(o.value)}
                    style={{ marginTop: "4px", minWidth: "18px", minHeight: "18px" }}
                  />
                  <label htmlFor={id} style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
                    <span style={{ fontWeight: 600 }}>{o.label}</span>
                    <span id={`${id}-note`} className="app-hint" style={{ margin: 0 }}>
                      {o.description}
                      {o.unavailable ? ` ${o.unavailable}` : ""}
                    </span>
                  </label>
                </div>
              );
            })}
          </fieldset>
          {saveError ? (
            <p className="app-field-error" role="alert" style={{ margin: 0 }}>
              <strong>{saveError.title}.</strong> {saveError.message}
            </p>
          ) : null}
          <div>
            <button type="submit" className="btn btn-primary" disabled={saving || !dirty}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
