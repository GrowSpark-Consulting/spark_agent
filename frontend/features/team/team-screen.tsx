"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/shared/states";
import { ConfirmDialog } from "@/features/knowledge/confirm-dialog";
import { FlashStatus, useFlash } from "@/features/knowledge/flash";
import { describeSetupWriteError } from "@/features/settings/resources-data";
import { sectionHead, sectionTitle } from "@/features/settings/section";
import { formatError, type FormattedError } from "@/lib/errors";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { fetchAlertNumber, saveAlertNumber, validateAlertNumber } from "./alert-number";
import { MembersSection } from "./members-section";
import { TakeoverSection } from "./takeover-section";

// /dashboard/team, first slice (docs/dashboard-screen-inventory.md, Team): the signed-in member's own
// WhatsApp alert number, in the Booking setup screen's layout, and how they take over chats (takeover-section.tsx; the own-number choices
// follow the handoff_own_number feature row). Every role sets their own; nobody sets anyone else's (row-level security). The rest of the
// Team screen (alert choices) waits on its contract and isn't shown as working. Members and invitations are members-section.tsx.

type State = { status: "loading" } | { status: "error"; error: FormattedError } | { status: "ready"; phone: string | null };

export function TeamScreen({ tenantId, userId }: { tenantId: string; userId: string }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [draft, setDraft] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<FormattedError | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [toast, flash] = useFlash();

  const load = useCallback(
    () =>
      fetchAlertNumber(getSupabaseBrowserClient(), tenantId, userId).then(
        (phone) => setState({ status: "ready", phone }),
        (err: unknown) => setState({ status: "error", error: formatError(err) }),
      ),
    [tenantId, userId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const phone = state.status === "ready" ? state.phone : null;

  function startEditing() {
    setDraft(phone ?? "");
    setFieldError(null);
    setSaveError(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (draft === null || saving) return;
    const result = validateAlertNumber(draft);
    if (!result.ok) {
      setFieldError(result.message);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await saveAlertNumber(getSupabaseBrowserClient(), tenantId, userId, result.phone);
      setState({ status: "ready", phone: saved });
      setDraft(null);
      flash("Saved your WhatsApp number");
    } catch (err) {
      setSaveError(describeSetupWriteError(err, "Couldn't save your number"));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    await saveAlertNumber(getSupabaseBrowserClient(), tenantId, userId, null);
    setState({ status: "ready", phone: null });
    setConfirmRemove(false);
    flash("Removed your WhatsApp number");
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "36px", maxWidth: "960px", minWidth: 0, color: "var(--color-text)" }}>
      <div>
        <h1 className="app-h1">Team</h1>
        <p style={{ margin: "4px 0 0", color: "var(--color-neutral-700)" }}>Who is on your team, and how Spark Agent reaches you on WhatsApp.</p>
      </div>

      <MembersSection tenantId={tenantId} />

      <section aria-labelledby="alert-number-heading" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <div style={sectionHead}>
          <h2 id="alert-number-heading" style={sectionTitle}>
            Your WhatsApp alerts
          </h2>
          {state.status === "ready" && draft === null && phone ? (
            <div style={{ display: "flex", gap: "4px" }}>
              <button type="button" className="btn btn-ghost" onClick={startEditing}>
                Edit
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirmRemove(true)}>
                Remove
              </button>
            </div>
          ) : null}
        </div>

        {state.status === "loading" ? <LoadingState compact title="Loading your number" /> : null}
        {state.status === "error" ? (
          <ErrorState
            compact
            title="Couldn't load your number"
            description={state.error.message}
            onRetry={() => {
              setState({ status: "loading" });
              void load();
            }}
          />
        ) : null}

        {state.status === "ready" && draft === null ? (
          <>
            <p className="app-hint" style={{ margin: 0 }}>
              Spark Agent sends staff alerts to this WhatsApp number. Only you can change it.
            </p>
            {phone ? (
              <dl style={{ margin: 0 }}>
                <div style={{ display: "grid", gridTemplateColumns: "minmax(96px,160px) minmax(0,1fr)", gap: "12px", padding: "8px 0", borderBottom: "1px solid var(--color-divider)", fontSize: "14px" }}>
                  <dt style={{ color: "var(--color-neutral-700)" }}>WhatsApp number</dt>
                  <dd style={{ margin: 0, fontWeight: 600, overflowWrap: "anywhere" }}>{phone}</dd>
                </div>
              </dl>
            ) : (
              <EmptyState
                compact
                title="No WhatsApp number yet"
                description="Add the number you use on WhatsApp so alerts can reach you."
                action={
                  <button type="button" className="btn btn-primary" onClick={startEditing}>
                    Add your number
                  </button>
                }
              />
            )}
          </>
        ) : null}

        {draft !== null ? (
          <form className="app-form" onSubmit={submit} noValidate style={{ gap: "12px" }} aria-label="Your WhatsApp number">
            <div className="field">
              <label htmlFor="alert-number">WhatsApp number</label>
              <input
                id="alert-number"
                className="input"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="+919840012345"
                value={draft}
                disabled={saving}
                autoFocus
                aria-invalid={fieldError ? true : undefined}
                aria-describedby={fieldError ? "alert-number-error" : "alert-number-hint"}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setFieldError(null);
                }}
              />
              {fieldError ? (
                <p id="alert-number-error" className="app-field-error">
                  {fieldError}
                </p>
              ) : (
                <p id="alert-number-hint" className="app-hint">
                  With country code, like +919840012345.
                </p>
              )}
            </div>
            {saveError ? <ErrorState compact title={saveError.title} description={saveError.message} /> : null}
            <div className="app-actions">
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? "Saving…" : "Save number"}
              </button>
              <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => setDraft(null)}>
                Cancel
              </button>
            </div>
          </form>
        ) : null}
      </section>

      <TakeoverSection tenantId={tenantId} userId={userId} hasAlertNumber={phone !== null} onSaved={flash} />

      <p className="app-hint" style={{ margin: 0 }}>
        Which alerts each person gets will be added here later.
      </p>

      {confirmRemove ? (
        <ConfirmDialog
          title="Remove your WhatsApp number?"
          text="Staff alerts can’t reach you until you add a number again."
          confirmLabel="Remove number"
          busyLabel="Removing…"
          keepLabel="Keep it"
          onConfirm={remove}
          describeError={(err) => describeSetupWriteError(err, "Couldn't remove your number")}
          onClose={() => setConfirmRemove(false)}
        />
      ) : null}
      <FlashStatus toast={toast} />
    </div>
  );
}
