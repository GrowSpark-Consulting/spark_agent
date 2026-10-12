"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ErrorState } from "@/components/shared/states";
import { DialogFrame } from "@/features/knowledge/dialog-frame";
import { ApiError, formatError, type FormattedError } from "@/lib/errors";
import { CONNECTION_SERVICES, type ConnectionAction } from "@/lib/whatsapp/connection-actions";

// Recheck and Disconnect for one WhatsApp connection (lib/whatsapp/connection-actions.ts). Disconnect asks first.
// Nothing here changes what the page shows until the server has done it: on success the page is re-read from
// whatsapp_connections_public, and the buttons stay off until that read is back. An answer that says the page was out of
// date (a check already running, the number already disconnected, the connection gone) re-reads it too, so the screen
// catches up with what the server holds.

/** Errors that mean the page is showing an old state, not that the request was wrong. */
const STALE = new Set(["conflict", "not_found", "forbidden"]);

export function WhatsAppConnectionActions({
  connectionId,
  tenantId,
  displayPhone,
  actions,
}: {
  connectionId: string;
  tenantId: string;
  displayPhone: string | null;
  actions: ConnectionAction[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<ConnectionAction | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const [error, setError] = useState<FormattedError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // A ref, not state: two quick clicks must not both pass the check before a re-render.
  const inFlight = useRef(false);

  if (actions.length === 0) return null;
  const locked = busy !== null || refreshing;

  async function run(action: ConnectionAction) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(action);
    setError(null);
    setDone(null);
    try {
      await CONNECTION_SERVICES[action]({ connectionId, tenantId });
      setConfirming(false);
      setDone(action === "recheck" ? "Rechecked. The checks below are up to date." : "Disconnected.");
      startRefresh(() => router.refresh());
    } catch (err) {
      setError(formatError(err));
      if (err instanceof ApiError && STALE.has(err.body.error.code)) startRefresh(() => router.refresh());
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
      <div className="app-actions">
        {actions.includes("recheck") ? (
          <button type="button" className="btn btn-secondary" disabled={locked} aria-busy={busy === "recheck" || undefined} onClick={() => void run("recheck")}>
            {busy === "recheck" ? "Rechecking…" : "Recheck connection"}
          </button>
        ) : null}
        {actions.includes("disconnect") ? (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={locked}
            onClick={() => {
              setError(null);
              setDone(null);
              setConfirming(true);
            }}
          >
            Disconnect
          </button>
        ) : null}
      </div>
      {busy === "recheck" ? (
        <p role="status" className="app-hint" style={{ margin: 0 }}>
          Asking Meta. This can take a few seconds.
        </p>
      ) : null}
      {done && !confirming ? (
        <p role="status" className="app-hint" style={{ margin: 0 }}>
          {done}
        </p>
      ) : null}
      {error && !confirming ? <ErrorState compact title={error.title} description={error.message} /> : null}

      {confirming ? (
        <DialogFrame title="Disconnect this WhatsApp number?" onClose={() => setConfirming(false)} busy={busy === "disconnect"}>
          <>
            <div style={{ fontSize: "14px", color: "var(--color-neutral-700)" }}>
              {displayPhone ?? "This number"} will stop sending and receiving messages through Spark Agent, and your
              assistant will stop replying from it. You can connect it again later.
            </div>
            {error ? <ErrorState compact title={error.title} description={error.message} /> : null}
            <div className="dialog-actions" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
              <button type="button" className="btn btn-primary" disabled={locked} aria-busy={busy === "disconnect" || undefined} onClick={() => void run("disconnect")}>
                {busy === "disconnect" ? "Disconnecting…" : "Disconnect number"}
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setConfirming(false)} disabled={busy === "disconnect"} autoFocus>
                Keep it connected
              </button>
            </div>
          </>
        </DialogFrame>
      ) : null}
    </div>
  );
}
