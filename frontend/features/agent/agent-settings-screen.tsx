"use client";

import type { AgentSettings, Role } from "@pakka/types";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ErrorState, LoadingState } from "@/components/shared/states";
import { Switch } from "@/components/ui/switch";
import { FlashStatus, useFlash } from "@/features/knowledge/flash";
import { sectionHead, sectionTitle } from "@/features/settings/section";
import { formatError, type FormattedError } from "@/lib/errors";
import {
  agentSettingsService as defaultService,
  AGENT_PERSONA_MAX_LENGTH,
  canEditAgentSettings,
  canSave,
  changedFields,
  draftFrom,
  saveFailure,
  type AgentSettingsDraft,
  type AgentSettingsService,
  type SaveFailure,
} from "./agent-settings";

// /dashboard/agent: the assistant's name, tone, privacy notice and which situations hand a chat to a person. Read from GET /api/agent/settings and saved
// with PATCH /api/agent/settings, sending only what changed; nothing is written to the database from the browser. The page says "Saved" only after the
// server's answer, and shows the settings as that answer has them. A refusal leaves the draft as it was. Staff see the settings and cannot change them
// (the server refuses their save as well). Languages, scoring and business hours are not edited here: each is explained and, where it has an editor, linked.

type State = { status: "loading" } | { status: "error"; error: FormattedError } | { status: "ready"; settings: AgentSettings };

const label = { fontWeight: 700, fontSize: "14px" } as const;
const hint = { fontSize: "13px", color: "var(--color-neutral-700)", margin: 0 } as const;

export function AgentSettingsScreen({ tenantId, role, service = defaultService }: { tenantId: string; role: Role; service?: AgentSettingsService }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [draft, setDraft] = useState<AgentSettingsDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const [toast, flash] = useFlash();
  const [attempt, setAttempt] = useState(0);
  const inFlight = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    service.load(tenantId, controller.signal).then(
      (settings) => {
        if (controller.signal.aborted) return;
        setState({ status: "ready", settings });
        setDraft(draftFrom(settings));
        setFailure(null);
      },
      (err) => {
        if (!controller.signal.aborted) setState({ status: "error", error: formatError(err) });
      },
    );
    return () => controller.abort();
  }, [service, tenantId, attempt]);

  /** Retry, or load the current settings after a conflict: back to loading, so no old draft is left on screen. */
  const reload = () => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  };

  if (state.status === "loading") return <LoadingState title="Loading your assistant's settings" />;
  if (state.status === "error") return <ErrorState title="Couldn't load your assistant's settings" description={state.error.message} onRetry={reload} />;
  if (!draft) return null;

  const original = state.settings;
  const editable = canEditAgentSettings(role);
  const changes = changedFields(original, draft);
  const fieldErrors: Record<string, string> = { ...(failure?.fields ?? {}), ...changes.errors };
  const ready = canSave(role, changes, saving);

  async function save() {
    // The button is also disabled, but a second click or Enter in the box must not send a second request, and staff never send one.
    if (inFlight.current || !editable) return;
    const current = changedFields(original, draft as AgentSettingsDraft);
    if (!canSave(role, current, false)) return;
    inFlight.current = true;
    setSaving(true);
    setFailure(null);
    try {
      const saved = await service.update(tenantId, current.patch);
      setState({ status: "ready", settings: saved });
      setDraft(draftFrom(saved));
      flash("Saved. Your assistant uses this from the next message.");
    } catch (err) {
      setFailure(saveFailure(err));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  const set = (change: Partial<AgentSettingsDraft>) => {
    setDraft({ ...draft, ...change });
    setFailure(null);
  };
  const locked = !editable || saving;
  const personaError = fieldErrors.persona;
  const name = original.persona ?? "Your assistant";

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      style={{ display: "flex", flexDirection: "column", gap: "32px", maxWidth: "760px", minWidth: 0 }}
    >
      {!editable ? (
        <p className="app-notice" style={{ margin: 0 }} data-testid="agent-readonly">
          You can see these settings. Only an owner or admin can change them.
        </p>
      ) : null}

      <section aria-labelledby="agent-persona-h" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <div style={sectionHead}>
          <h2 id="agent-persona-h" style={sectionTitle}>
            Name and tone
          </h2>
        </div>
        <div className="field">
          <label htmlFor="agent-persona" style={label}>
            Assistant&apos;s name
          </label>
          <input
            id="agent-persona"
            className="input"
            value={draft.persona}
            disabled={locked}
            onChange={(e) => set({ persona: e.target.value })}
            aria-invalid={personaError ? true : undefined}
            aria-describedby="agent-persona-hint"
            placeholder="Leave empty to use the default name"
            autoComplete="off"
          />
          <p id="agent-persona-hint" style={hint}>
            A name, up to {AGENT_PERSONA_MAX_LENGTH} characters. Customers are always told it is an assistant.
          </p>
          {personaError ? (
            <p className="app-field-error" role="alert" data-testid="agent-persona-error" style={{ margin: 0 }}>
              {personaError}
            </p>
          ) : null}
        </div>
        <div role="group" aria-labelledby="agent-tone-h" style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <span id="agent-tone-h" style={label}>
            Tone
          </span>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            {(["friendly", "formal"] as const).map((tone) => (
              <button
                key={tone}
                type="button"
                className={draft.tone === tone ? "btn btn-primary" : "btn btn-secondary"}
                aria-pressed={draft.tone === tone}
                disabled={locked}
                onClick={() => set({ tone })}
              >
                {tone === "friendly" ? "Friendly" : "Formal"}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section aria-labelledby="agent-privacy-h" style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <div style={sectionHead}>
          <h2 id="agent-privacy-h" style={sectionTitle}>
            Privacy notice
          </h2>
        </div>
        <div style={{ display: "flex", gap: "16px", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 280px", minWidth: 0 }}>
            <div style={label} id="agent-privacy-label">
              Add a privacy notice to the first reply
            </div>
            <p id="agent-privacy-desc" style={hint}>
              The first reply to a new contact says it is an AI assistant, how to stop (reply STOP) and where to read your privacy policy. Off unless you turn it on.
            </p>
          </div>
          <Switch checked={draft.privacyNotice} disabled={locked} onCheckedChange={(on) => set({ privacyNotice: on })} aria-labelledby="agent-privacy-label" aria-describedby="agent-privacy-desc" />
        </div>
      </section>

      <section aria-labelledby="agent-handoff-h" style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <div style={sectionHead}>
          <h2 id="agent-handoff-h" style={sectionTitle}>
            Hand over to your team when
          </h2>
        </div>
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {original.handoffTriggers.map((t) => (
            <li
              key={t.key}
              data-testid="agent-trigger"
              data-trigger={t.key}
              style={{ display: "flex", gap: "16px", alignItems: "center", justifyContent: "space-between", padding: "12px 0", borderBottom: "1px solid var(--color-divider)", flexWrap: "wrap" }}
            >
              <div style={{ flex: "1 1 280px", minWidth: 0 }}>
                <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                  <span id={`trigger-${t.key}`} style={{ fontWeight: 600, fontSize: "15px", overflowWrap: "anywhere" }}>
                    {t.label}
                  </span>
                  {t.highPriority ? (
                    <span style={{ fontSize: "10px", fontWeight: 800, letterSpacing: ".06em", textTransform: "uppercase", padding: "2px 6px", border: "1px solid var(--color-accent)", color: "var(--color-accent-700)" }}>
                      High priority
                    </span>
                  ) : null}
                </div>
                <div id={`trigger-${t.key}-example`} style={hint}>
                  {t.example}
                </div>
              </div>
              <Switch
                checked={draft.triggers[t.key] ?? t.enabled}
                disabled={locked}
                onCheckedChange={(on) => set({ triggers: { ...draft.triggers, [t.key]: on } })}
                aria-labelledby={`trigger-${t.key}`}
                aria-describedby={`trigger-${t.key}-example`}
              />
            </li>
          ))}
        </ul>
        <p data-testid="agent-always-on" style={{ ...hint, paddingTop: "8px" }}>
          Some handovers always happen and can&apos;t be switched off: when {name} is stuck, when credits run out, and when a customer opts out.
        </p>
      </section>

      <section aria-labelledby="agent-more-h" style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <div style={sectionHead}>
          <h2 id="agent-more-h" style={sectionTitle}>
            Set elsewhere
          </h2>
        </div>
        <p style={{ margin: 0, fontSize: "14px" }} data-testid="agent-languages">
          <strong>Languages.</strong> {name} follows the language each customer writes in. There is nothing to switch on or off.
        </p>
        <p style={{ margin: 0, fontSize: "14px" }} data-testid="agent-scoring">
          <strong>Lead scoring.</strong> Hot and warm leads are scored by your industry pack. It can&apos;t be changed from this screen.
        </p>
        <p style={{ margin: 0, fontSize: "14px" }}>
          <strong>Business hours and the service it books.</strong> Both are set in Booking setup.{" "}
          <Link href="/dashboard/settings/booking" data-testid="agent-hours-link" style={{ fontWeight: 600 }}>
            Open Booking setup
          </Link>
        </p>
      </section>

      {editable ? (
        <div style={{ position: "sticky", bottom: 0, display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap", padding: "14px 0", background: "var(--color-bg)", borderTop: "2px solid var(--color-text)" }}>
          <button type="submit" className="btn btn-primary" disabled={!ready} data-testid="agent-save">
            {saving ? "Saving…" : "Save changes"}
          </button>
          {failure ? (
            <span role="alert" data-testid="agent-save-error" style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-accent-700)", flex: "1 1 240px" }}>
              {failure.message}{" "}
              {failure.stale ? (
                <button type="button" className="btn btn-secondary" onClick={reload} data-testid="agent-reload">
                  Load the current settings
                </button>
              ) : null}
            </span>
          ) : (
            <span style={hint}>{Object.keys(changes.patch).length > 0 ? "You have unsaved changes." : "No changes."}</span>
          )}
        </div>
      ) : null}
      <FlashStatus toast={toast} />
    </form>
  );
}
