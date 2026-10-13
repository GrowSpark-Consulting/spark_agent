"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { languageName } from "@/lib/whatsapp/templates";
import { replyFailure, sendStaffTemplate, type ReplyFailure } from "./staff-reply";
import { fetchConversationTemplates, paramProblem, renderPreview, type SendableTemplate } from "./template-reply";

// The closed-window reply (chat-view.tsx shows it under the closed-window strip). Staff pick one of the business's approved templates, fill
// its values and send; the route is POST /api/conversations/:id/messages with `{ template }` (staff-reply.ts). Nothing is shown as sent
// until the API says so, the message then reaches the chat through realtime, and the choice and values are kept on any failure.
// Mounted with key={conversation.id}, so a choice never moves to another chat. The list is GET /api/conversations/:id/templates: the server
// picks the chat's WhatsApp number and returns only what that number can send, so nothing is filtered by connection here.

type Load = { state: "loading" } | { state: "error" } | { state: "ready"; connectionId: string | null; templates: SendableTemplate[] };

export function TemplateReplyPanel({ tenantId, conversationId, firstName }: { tenantId: string; conversationId: string; firstName: string }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [choice, setChoice] = useState("");
  const [values, setValues] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<ReplyFailure | null>(null);
  const [sent, setSent] = useState(false);
  // A ref, not state: two quick presses must not both pass a check before a re-render.
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const selectId = useId();
  const errorId = useId();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchConversationTemplates(tenantId, conversationId, controller.signal).then(
      (list) => !controller.signal.aborted && setLoad({ state: "ready", connectionId: list.connectionId, templates: list.templates }),
      () => !controller.signal.aborted && setLoad({ state: "error" }),
    );
    return () => controller.abort();
  }, [tenantId, conversationId, attempt]);

  function retryLoad() {
    setLoad({ state: "loading" });
    setAttempt((n) => n + 1);
  }

  const templates = load.state === "ready" ? load.templates : [];
  const chosen = templates.find((t) => t.id === choice) ?? null;
  const needed = chosen?.variables.length ?? 0;
  const filled = Array.from({ length: needed }, (_, i) => values[i] ?? "");
  const problem = chosen ? paramProblem(filled) : null;

  function pick(id: string) {
    const next = templates.find((t) => t.id === id) ?? null;
    setChoice(id);
    setValues(next ? next.variables.map(() => "") : []);
    setTouched(false);
    setFailure(null);
    setSent(false);
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (inFlight.current || !chosen || chosen.body === null) return;
    setTouched(true);
    if (problem) return;
    inFlight.current = true;
    setSending(true);
    setFailure(null);
    setSent(false);
    try {
      await sendStaffTemplate(tenantId, conversationId, { name: chosen.name, language: chosen.language, params: filled });
      if (!mounted.current) return;
      setSent(true);
      setChoice("");
      setValues([]);
      setTouched(false);
    } catch (err) {
      if (mounted.current) setFailure(replyFailure(err));
    } finally {
      inFlight.current = false;
      if (mounted.current) setSending(false);
    }
  }

  if (load.state === "loading") {
    return (
      <p role="status" className="app-hint" style={{ margin: 0 }}>
        Loading approved templates…
      </p>
    );
  }
  if (load.state === "error") {
    return (
      <div role="alert" className="app-hint" style={{ margin: 0, display: "flex", flexDirection: "column", gap: "8px", alignItems: "flex-start" }}>
        <span>Couldn’t load your message templates, so nothing can be sent to {firstName} yet.</span>
        <button type="button" className="btn btn-secondary" onClick={retryLoad} style={{ minHeight: "44px" }}>
          Try again
        </button>
      </div>
    );
  }
  if (load.connectionId === null) {
    return (
      <p role="status" className="app-hint" data-testid="number-not-connected" style={{ margin: 0 }}>
        The WhatsApp number this chat is on isn’t connected, so no template can be sent to {firstName}. Reconnect it under WhatsApp, then come back.
      </p>
    );
  }
  const usable = templates.filter((t) => t.body !== null);
  if (usable.length === 0) {
    return (
      <p role="status" className="app-hint" data-testid="no-approved-templates" style={{ margin: 0 }}>
        You have no approved templates yet, so nothing can be sent until {firstName} writes first. Submit one under Templates; Meta must approve it.
      </p>
    );
  }

  return (
    <form onSubmit={submit} aria-label="Send a template" data-testid="template-reply" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <label htmlFor={selectId} style={{ fontSize: "13px", fontWeight: 700 }}>
        Send an approved template
      </label>
      <select id={selectId} className="input" value={choice} onChange={(e) => pick(e.target.value)} disabled={sending} style={{ minHeight: "44px", fontSize: "15px" }}>
        <option value="">Choose a template</option>
        {usable.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name} · {languageName(t.language)}
          </option>
        ))}
      </select>
      {chosen ? (
        <>
          {chosen.variables.map((n, i) => (
            <label key={n} style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
              Value for {`{{${n}}}`}
              <input
                className="input"
                value={values[i] ?? ""}
                readOnly={sending}
                aria-invalid={touched && (values[i] ?? "").trim() === "" ? true : undefined}
                aria-describedby={touched && problem ? errorId : undefined}
                onChange={(e) => setValues((all) => filled.map((v, at) => (at === i ? e.target.value : (all[at] ?? v))))}
                style={{ minHeight: "44px", fontSize: "15px" }}
              />
            </label>
          ))}
          <div data-testid="template-meta" className="app-hint" style={{ margin: 0 }}>
            {chosen.category.toLowerCase()} · {languageName(chosen.language)}
          </div>
          <div data-testid="template-preview" style={{ fontSize: "14px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", padding: "10px", background: "var(--color-surface)" }}>
            {renderPreview(chosen, values)}
          </div>
          {touched && problem ? (
            <div id={errorId} role="status" style={{ fontSize: "13px", fontWeight: 700 }}>
              {problem}
            </div>
          ) : null}
          <div>
            <button type="submit" className="btn btn-secondary" disabled={sending} aria-busy={sending || undefined} style={{ minHeight: "44px", cursor: sending ? "progress" : undefined }}>
              {sending ? "Sending…" : "Send template"}
            </button>
          </div>
        </>
      ) : null}
      {sent ? (
        <div role="status" style={{ fontSize: "13px" }}>
          WhatsApp accepted the template. It appears in the chat in a moment.
        </div>
      ) : null}
      {failure ? (
        <div role="alert" style={{ fontSize: "13px", padding: "8px 10px", background: "var(--color-surface)" }}>
          <strong>{failure.maybeSent ? "Couldn’t confirm it was sent." : "Not sent."}</strong> {failure.message}
          {failure.maybeSent ? " Check the chat before sending it again." : " Your choice and values are still here."}
        </div>
      ) : null}
    </form>
  );
}
