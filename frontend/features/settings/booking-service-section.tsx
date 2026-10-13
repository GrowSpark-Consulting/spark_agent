"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ErrorState, LoadingState } from "@/components/shared/states";
import { formatDuration, listServices, type Service } from "@/features/knowledge/data";
import { formatError, type FormattedError } from "@/lib/errors";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { describeBookingService, isSelectableChoice, readBookingService, saveBookingService } from "./booking-service";
import { describeSetupWriteError } from "./resources-data";
import { sectionHead, sectionTitle } from "./section";

// Which service the assistant books (tenants.agent_settings.bookingServiceId, booking-service.ts). One active service is booked on
// its own; with several, the assistant books the one chosen here, and with no choice it hands booking chats to your team. Shown
// below the services table so it can name them; owners and admins choose, staff read it.

type State = { status: "loading" } | { status: "error"; error: FormattedError } | { status: "ready"; services: Service[]; chosen: string | null };

const NO_CHOICE = "";

export function BookingServiceSection({ tenantId, canWrite, onSaved }: { tenantId: string; canWrite: boolean; onSaved: (message: string) => void }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [draft, setDraft] = useState<string>(NO_CHOICE);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<FormattedError | null>(null);

  const load = useCallback(() => {
    const client = getSupabaseBrowserClient();
    return Promise.all([listServices(client, tenantId), readBookingService(client, tenantId)]).then(
      ([services, chosen]) => {
        setState({ status: "ready", services, chosen });
        setDraft(chosen ?? NO_CHOICE);
      },
      (err: unknown) => setState({ status: "error", error: formatError(err) }),
    );
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  // A service added or switched off in the table above isn't known here until read again, so the list is read again when the
  // choice is opened. Best effort: if it fails, the list already on screen stays.
  const refreshServices = useCallback(async () => {
    try {
      const services = await listServices(getSupabaseBrowserClient(), tenantId);
      setState((prev) => (prev.status === "ready" ? { ...prev, services } : prev));
    } catch {
      // keep the list that is shown
    }
  }, [tenantId]);

  const view = state.status === "ready" ? describeBookingService(state.services, state.chosen) : null;
  const dirty = state.status === "ready" && draft !== (state.chosen ?? NO_CHOICE);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (state.status !== "ready" || saving || !dirty) return;
    const choice = draft === NO_CHOICE ? null : draft;
    if (!isSelectableChoice(state.services, choice)) {
      setSaveError({ code: "validation_failed", title: "Couldn't save the choice", message: "That service isn't active any more. Pick one from the list.", retryable: false });
      void refreshServices();
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await saveBookingService(getSupabaseBrowserClient(), tenantId, choice);
      setState({ ...state, chosen: saved });
      setDraft(saved ?? NO_CHOICE);
      onSaved("Saved the service the assistant books");
    } catch (err) {
      setSaveError(describeSetupWriteError(err, "Couldn't save the choice"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="booking-service-heading" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <div style={sectionHead}>
        <h2 id="booking-service-heading" style={sectionTitle}>
          Service the assistant books
        </h2>
      </div>

      {state.status === "loading" ? <LoadingState compact title="Loading your choice" /> : null}
      {state.status === "error" ? (
        <ErrorState
          compact
          title="Couldn't load your choice"
          description={state.error.message}
          onRetry={() => {
            setState({ status: "loading" });
            void load();
          }}
        />
      ) : null}

      {view?.kind === "none" ? (
        <p className="app-hint" style={{ margin: 0 }}>
          There’s no active service yet. Add one above so the assistant can book it.
        </p>
      ) : null}

      {view?.kind === "only" ? (
        <p className="app-hint" style={{ margin: 0 }}>
          The assistant books <strong>{view.service.name}</strong>, your only active service. If you add another, choose here which one it books.
        </p>
      ) : null}

      {view?.kind === "several" ? (
        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "8px", maxWidth: "480px" }}>
          <p id="booking-service-hint" className="app-hint" style={{ margin: 0 }}>
            With more than one active service, the assistant books the one you choose. With no choice it passes booking chats to your team instead of guessing.
          </p>
          {view.stale ? (
            <p role="status" className="app-notice" style={{ margin: 0 }}>
              The service you chose is no longer active, so the assistant is booking as if you hadn’t chosen one.
            </p>
          ) : null}
          {canWrite ? (
            <>
              <label htmlFor="booking-service">Service to book</label>
              <select
                id="booking-service"
                className="input"
                value={draft}
                disabled={saving}
                aria-describedby="booking-service-hint"
                onFocus={() => void refreshServices()}
                onChange={(e) => setDraft(e.target.value)}
              >
                <option value={NO_CHOICE}>No choice: a person takes booking chats</option>
                {view.services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {formatDuration(s.durationMin)}
                  </option>
                ))}
              </select>
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
            </>
          ) : (
            <p style={{ margin: 0 }}>{view.chosen ? <strong>{view.chosen.name}</strong> : "No choice: a person takes booking chats."}</p>
          )}
        </form>
      ) : null}
    </section>
  );
}
