"use client";

import type { Role, WebhookEndpoint, WebhookEvent, WebhookSettings, WebhookTestResult } from "@pakka/types";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorState, LoadingState } from "@/components/shared/states";
import { DialogFrame } from "@/features/knowledge/dialog-frame";
import { FlashStatus, useFlash } from "@/features/knowledge/flash";
import { sectionHead, sectionTitle } from "@/features/settings/section";
import { isRouteMissing } from "@/lib/api/route-missing";
import { formatError, type FormattedError } from "@/lib/errors";
import { webhookService as defaultService, type WebhookService } from "./webhook-api";
import { ALL_EVENTS, canManageWebhook, EVENT_LABEL, failureText, formProblems, hintText, orderedEvents, sameEvents, testResultText } from "./webhook-view";

// /dashboard/settings/integrations: where a business tells its CRM or sheet about new leads, bookings and handovers (outbound webhooks, Pro).
// Read and written only through the five routes in webhook-api.ts; the screen says "saved" only after the server's answer and shows what that
// answer holds. The signing secret is shown once, straight from the answer that created or rotated it, held in this component's memory and
// nowhere else: not logged, not stored, gone when it is dismissed or the page is left. Owners and admins only; the server checks every call.

type Load = { status: "loading" } | { status: "missing" } | { status: "error"; error: FormattedError } | { status: "ready"; settings: WebhookSettings };
type Busy = "save" | "test" | "rotate" | "delete" | null;
type Confirming = "rotate" | "delete" | null;

const label = { fontWeight: 700, fontSize: "14px" } as const;

export function WebhookScreen({ tenantId, role, service = defaultService }: { tenantId: string; role: Role; service?: WebhookService }) {
  if (!canManageWebhook(role)) {
    return (
      <p className="app-notice" role="status" data-testid="webhook-no-access" style={{ margin: 0 }}>
        Integrations are for owners and admins. Ask an owner or admin if you need to connect your business to another tool.
      </p>
    );
  }
  return <WebhookView tenantId={tenantId} service={service} />;
}

function WebhookView({ tenantId, service }: { tenantId: string; service: WebhookService }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    service.load(tenantId, controller.signal).then(
      (settings) => !controller.signal.aborted && setLoad({ status: "ready", settings }),
      (err: unknown) => {
        if (controller.signal.aborted) return;
        setLoad(isRouteMissing(err) ? { status: "missing" } : { status: "error", error: formatError(err) });
      },
    );
    return () => controller.abort();
  }, [service, tenantId, attempt]);

  const retry = useCallback(() => {
    setLoad({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  if (load.status === "loading") return <LoadingState title="Loading your webhook" />;
  if (load.status === "missing") {
    return <ErrorState title="Integrations aren't available yet" description="The server doesn't provide this yet. Nothing is wrong with your account." onRetry={retry} />;
  }
  if (load.status === "error") return <ErrorState title="Couldn't load your webhook" description={load.error.message} onRetry={retry} />;
  // key: a different business starts from a clean form, with no secret or result left over.
  return <WebhookPanel key={tenantId} tenantId={tenantId} service={service} initial={load.settings} />;
}

function WebhookPanel({ tenantId, service, initial }: { tenantId: string; service: WebhookService; initial: WebhookSettings }) {
  const [settings, setSettings] = useState(initial);
  const { inPlan, endpoint } = settings;
  const [url, setUrl] = useState(endpoint?.url ?? "");
  const [events, setEvents] = useState<WebhookEvent[]>(endpoint?.events ?? []);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<FormattedError | null>(null);
  const [secret, setSecret] = useState<{ value: string; why: "created" | "rotated" } | null>(null);
  const [result, setResult] = useState<WebhookTestResult | null>(null);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [toast, flash] = useFlash();
  // A ref, not state: two quick presses must not both pass the check before a re-render.
  const inFlight = useRef(false);

  const problems = formProblems(url, events);
  const dirty = endpoint === null ? url.trim() !== "" || events.length > 0 : url.trim() !== endpoint.url || !sameEvents(events, endpoint.events);
  const locked = busy !== null;

  async function run<T>(what: Exclude<Busy, null>, action: () => Promise<T>, onDone: (value: T) => void) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(what);
    setError(null);
    try {
      onDone(await action());
    } catch (err) {
      setError(formatError(err));
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  function save() {
    setSubmitted(true);
    if (problems.url || problems.events) return;
    setResult(null);
    void run(
      "save",
      () => service.save(tenantId, { url: url.trim(), events: orderedEvents(events) }),
      (saved) => {
        setSettings((s) => ({ ...s, endpoint: saved.endpoint }));
        setUrl(saved.endpoint.url);
        setEvents(saved.endpoint.events);
        setSubmitted(false);
        // The secret arrives only when the endpoint was created; a change answers null and nothing is shown.
        if (saved.secret) setSecret({ value: saved.secret, why: "created" });
        flash(saved.secret ? "Webhook created." : "Webhook saved.");
      },
    );
  }

  function test() {
    setResult(null);
    void run("test", () => service.test(tenantId), setResult);
  }

  function rotate() {
    void run(
      "rotate",
      () => service.rotate(tenantId),
      (rotated) => {
        setConfirming(null);
        setSettings((s) => (s.endpoint ? { ...s, endpoint: { ...s.endpoint, secretHint: rotated.secretHint } } : s));
        setSecret({ value: rotated.secret, why: "rotated" });
        setResult(null);
      },
    );
  }

  function remove() {
    void run(
      "delete",
      () => service.remove(tenantId),
      () => {
        setConfirming(null);
        setSettings((s) => ({ ...s, endpoint: null }));
        setUrl("");
        setEvents([]);
        setSecret(null);
        setResult(null);
        setSubmitted(false);
        flash("Webhook deleted.");
      },
    );
  }

  const toggle = (event: WebhookEvent) => setEvents((now) => (now.includes(event) ? now.filter((e) => e !== event) : [...now, event]));
  const urlError = (submitted ? problems.url : undefined) ?? error?.fields?.url;
  const eventsError = submitted ? problems.events : undefined;
  // Errors the server gave for a field are shown at the field; the rest go in the alert below the buttons.
  const generalError = error && !(error.code === "validation_failed" && error.fields?.url) ? error : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "28px", maxWidth: "760px", minWidth: 0 }}>
      <FlashStatus toast={toast} />

      {!inPlan ? (
        <p className="app-notice" role="status" data-testid="webhook-plan" style={{ margin: 0 }}>
          Outbound webhooks are part of the Pro plan, so saving and testing are off for your business.{" "}
          <Link href="/dashboard/billing">See plans</Link>
        </p>
      ) : endpoint && !settings.sending ? (
        <p className="app-notice" role="status" data-testid="webhook-not-sending" style={{ margin: 0 }}>
          Events aren&apos;t being sent right now. The Outbound webhooks switch in <Link href="/dashboard/features">Features</Link> may be off, or the endpoint is not active.
        </p>
      ) : null}

      {secret ? <SecretPanel secret={secret.value} why={secret.why} onDismiss={() => setSecret(null)} /> : null}

      <form
        noValidate
        aria-label="Webhook"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        style={{ display: "flex", flexDirection: "column", gap: "18px" }}
      >
        <div style={sectionHead}>
          <h2 style={sectionTitle}>{endpoint ? "Your webhook" : "Add a webhook"}</h2>
        </div>

        <div className="field">
          <label htmlFor="webhook-url" style={label}>
            Address that receives the events
          </label>
          <input
            id="webhook-url"
            className="input"
            type="url"
            inputMode="url"
            value={url}
            disabled={locked || !inPlan}
            onChange={(e) => {
              setUrl(e.target.value);
              setError(null);
            }}
            placeholder="https://example.com/hooks/spark"
            aria-invalid={urlError ? true : undefined}
            aria-describedby={urlError ? "webhook-url-error" : "webhook-url-hint"}
            autoComplete="off"
            spellCheck={false}
          />
          <p id="webhook-url-hint" className="app-hint">
            https only, on port 443 or 8443. An address on a private network is refused.
          </p>
          {urlError ? (
            <p id="webhook-url-error" className="app-field-error" role="alert" data-testid="webhook-url-error" style={{ margin: 0 }}>
              {urlError}
            </p>
          ) : null}
        </div>

        <fieldset style={{ border: 0, margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "8px" }} disabled={locked || !inPlan} aria-describedby={eventsError ? "webhook-events-error" : undefined}>
          <legend style={{ ...label, padding: 0, marginBottom: "6px" }}>Send me an event when</legend>
          {ALL_EVENTS.map((event) => (
            <label key={event} style={{ display: "flex", gap: "10px", alignItems: "flex-start", minHeight: "32px", cursor: "pointer" }}>
              <input type="checkbox" checked={events.includes(event)} onChange={() => toggle(event)} style={{ marginTop: "4px" }} />
              <span style={{ fontSize: "14px" }}>
                <strong>{EVENT_LABEL[event].title}</strong>
                <span style={{ display: "block", fontSize: "13px", color: "var(--color-neutral-700)" }}>{EVENT_LABEL[event].detail}</span>
              </span>
            </label>
          ))}
          {eventsError ? (
            <p id="webhook-events-error" className="app-field-error" role="alert" data-testid="webhook-events-error" style={{ margin: 0 }}>
              {eventsError}
            </p>
          ) : null}
        </fieldset>

        <div className="app-actions">
          <button type="submit" className="btn btn-primary" disabled={locked || !inPlan || (endpoint !== null && !dirty)} aria-busy={busy === "save" || undefined} data-testid="webhook-save">
            {busy === "save" ? "Saving…" : endpoint ? "Save changes" : "Create webhook"}
          </button>
        </div>
      </form>

      {generalError ? (
        <ErrorState compact title={generalError.title} description={generalError.message} action={generalError.code === "plan_required" ? <Link href="/dashboard/billing">See plans</Link> : undefined} />
      ) : null}

      {endpoint ? (
        <EndpointDetails
          endpoint={endpoint}
          busy={busy}
          canSend={inPlan && !dirty}
          dirty={dirty}
          result={result}
          onTest={test}
          onRotate={() => {
            setError(null);
            setConfirming("rotate");
          }}
          onDelete={() => {
            setError(null);
            setConfirming("delete");
          }}
        />
      ) : null}

      {confirming ? (
        <DialogFrame title={confirming === "rotate" ? "Replace the signing secret?" : "Delete this webhook?"} onClose={() => setConfirming(null)} busy={busy !== null}>
          <>
            <div style={{ fontSize: "14px", color: "var(--color-neutral-700)" }}>
              {confirming === "rotate"
                ? "A new secret is made and shown once. The old one stops working at once, so your receiver will reject events until you give it the new one."
                : "Events stop going to this address, and anything still waiting to be sent to it is dropped. You can add a webhook again later."}
            </div>
            {error ? <ErrorState compact title={error.title} description={error.message} /> : null}
            <div className="dialog-actions" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
              <button type="button" className="btn btn-primary" disabled={locked} aria-busy={busy === confirming || undefined} onClick={confirming === "rotate" ? rotate : remove} data-testid="webhook-confirm">
                {confirming === "rotate" ? (busy === "rotate" ? "Replacing…" : "Replace secret") : busy === "delete" ? "Deleting…" : "Delete webhook"}
              </button>
              <button type="button" className="btn btn-secondary" disabled={locked} onClick={() => setConfirming(null)} autoFocus>
                Keep it
              </button>
            </div>
          </>
        </DialogFrame>
      ) : null}
    </div>
  );
}

function EndpointDetails({
  endpoint,
  busy,
  canSend,
  dirty,
  result,
  onTest,
  onRotate,
  onDelete,
}: {
  endpoint: WebhookEndpoint;
  busy: Busy;
  canSend: boolean;
  dirty: boolean;
  result: WebhookTestResult | null;
  onTest: () => void;
  onRotate: () => void;
  onDelete: () => void;
}) {
  const locked = busy !== null;
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : null);
  const failure = failureText(endpoint.lastFailure);
  const outcome = result ? testResultText(result) : null;
  return (
    <section aria-labelledby="webhook-status-h" style={{ display: "flex", flexDirection: "column", gap: "14px" }} data-testid="webhook-details">
      <div style={sectionHead}>
        <h2 id="webhook-status-h" style={sectionTitle}>
          Status
        </h2>
      </div>
      <dl className="app-facts">
        <div>
          <dt>Secret</dt>
          <dd data-testid="webhook-hint">{hintText(endpoint.secretHint)}</dd>
        </div>
        <div>
          <dt>State</dt>
          <dd>{endpoint.active ? "Active" : "Not active"}</dd>
        </div>
        <div>
          <dt>Last delivered</dt>
          <dd>{when(endpoint.lastSuccessAt) ?? "Not yet"}</dd>
        </div>
        <div>
          <dt>Last failed</dt>
          <dd>{when(endpoint.lastFailureAt) ?? "Never"}</dd>
        </div>
      </dl>
      {failure && endpoint.lastFailureAt ? (
        <p className="app-hint" data-testid="webhook-last-failure" style={{ margin: 0 }}>
          {failure}
        </p>
      ) : null}

      <div className="app-actions">
        <button type="button" className="btn btn-secondary" disabled={locked || !canSend} aria-busy={busy === "test" || undefined} onClick={onTest} data-testid="webhook-test">
          {busy === "test" ? "Sending…" : "Send a test event"}
        </button>
        <button type="button" className="btn btn-secondary" disabled={locked} onClick={onRotate} data-testid="webhook-rotate">
          Replace secret
        </button>
        <button type="button" className="btn btn-ghost" disabled={locked} onClick={onDelete} data-testid="webhook-delete">
          Delete webhook
        </button>
      </div>
      {dirty ? (
        <p className="app-hint" style={{ margin: 0 }}>
          Save your changes before sending a test: it goes to the saved address.
        </p>
      ) : null}
      {outcome ? (
        <p role="status" className={outcome.ok ? "app-success" : "app-notice"} data-testid="webhook-test-result" style={{ margin: 0 }}>
          {outcome.text}
        </p>
      ) : null}
    </section>
  );
}

/** The secret, once. Copying is optional; closing it is the only way it goes away, and nothing else holds it. */
function SecretPanel({ secret, why, onDismiss }: { secret: string; why: "created" | "rotated"; onDismiss: () => void }) {
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  }
  return (
    <section aria-label="Signing secret" className="app-success" data-testid="webhook-secret" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <strong>{why === "created" ? "Your signing secret" : "Your new signing secret"}</strong>
      <input readOnly aria-label="Signing secret" className="input" value={secret} onFocus={(e) => e.currentTarget.select()} spellCheck={false} autoComplete="off" data-testid="webhook-secret-value" />
      <p className="app-hint" style={{ margin: 0 }}>
        Copy it now and give it to your receiver, which uses it to check that each request came from us. It can&apos;t be shown again: leaving or refreshing this page loses it.
        {why === "rotated" ? " The old secret no longer works." : ""}
      </p>
      <div className="app-actions">
        <button type="button" className="btn btn-primary" onClick={() => void copy()}>
          Copy secret
        </button>
        <button type="button" className="btn btn-secondary" onClick={onDismiss} data-testid="webhook-secret-done">
          I&apos;ve saved it
        </button>
      </div>
      <p role="status" className="app-hint" style={{ margin: 0 }}>
        {copied === "yes" ? "Copied." : copied === "failed" ? "Couldn't copy automatically. Select the secret and copy it." : ""}
      </p>
    </section>
  );
}
