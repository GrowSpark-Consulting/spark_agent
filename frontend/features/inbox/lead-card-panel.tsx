"use client";

import Link from "next/link";
import { useEffect, useId, useRef, type CSSProperties } from "react";
import { ErrorState, LoadingState } from "@/components/shared/states";
import { ScoreBadge } from "@/features/leads/score-badge";
import type { FormattedError } from "@/lib/errors";
import { handoffReason, type ConversationSummary } from "./data";
import type { LeadCard } from "./lead-card-data";
import type { LeadCardAi } from "./lead-card-provisional";

// The lead card beside the open chat, laid out as the /dashboard/preview Inbox's "Lead card · pinned"
// (components/dashboard/pakka-app.tsx): score block, name and number, then label-over-value rows on a
// 2px rule. Pinned beside the chat on wide screens; below that, a "Lead" button opens it as a sheet.
// Shows only stored data (lead-card-data.ts); the AI-written summary rows wait for buildLeadCard (Dev 1). `ai` is where
// they will arrive: nothing supplies it in the app today, and when something does (lead-card-provisional.ts, then the
// real contract through an adapter) the rows appear without any change here. They show only beside the conversation they
// were made for, and while the contract is provisional they say they are a sample.

export type LeadCardState =
  | { status: "loading" }
  | { status: "error"; error: FormattedError }
  | { status: "ready"; card: LeadCard | null; ai?: LeadCardAi | null };

const label: CSSProperties = { fontSize: "12px", color: "var(--color-neutral-700)" };
const row: CSSProperties = { padding: "10px 0", borderBottom: "1px solid var(--color-divider)" };
const value: CSSProperties = { fontWeight: 600, fontSize: "14px", overflowWrap: "anywhere" };

function LeadCardBody({ state, conversation, onRetry }: { state: LeadCardState; conversation: ConversationSummary; onRetry: () => void }) {
  if (state.status === "loading") return <LoadingState compact title="Loading the lead" />;
  if (state.status === "error") return <ErrorState compact title="Couldn't load the lead" description={state.error.message} onRetry={onRetry} />;
  const card = state.card;
  if (!card) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        <p style={{ margin: 0, fontWeight: 800, fontSize: "16px" }}>No lead yet</p>
        <p style={{ margin: 0, fontSize: "14px", color: "var(--color-neutral-700)" }}>{conversation.name} isn’t on the Leads board.</p>
      </div>
    );
  }
  const { lead, booking } = card;
  const handoff = conversation.openHandoffs[0];
  // Never another chat's summary: it must have been made for the conversation being shown.
  const ai = state.ai && state.ai.conversationId === conversation.id ? state.ai : null;
  const aiRows: [string, string | null][] = ai
    ? [
        ["Need", ai.need],
        ["Summary", ai.summary],
        ["Suggested next step", ai.nextStep],
        ["Sentiment", ai.sentiment],
        ["Language", ai.languageNote],
        ["Source", ai.source],
        ["Owner", ai.owner],
      ]
    : [];
  return (
    <>
      <div style={{ display: "flex", gap: "14px", alignItems: "center" }}>
        <ScoreBadge temperature={lead.temperature} score={lead.score} large unscoredLabel="Not scored yet" />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 800, fontSize: "20px", lineHeight: 1.15, overflowWrap: "anywhere" }}>{lead.name}</div>
          <div style={{ fontSize: "13px", color: "var(--color-neutral-700)" }}>
            {lead.hasName ? lead.phoneMasked : null}
            {lead.hasName && conversation.language ? " · " : null}
            {conversation.language}
          </div>
        </div>
      </div>

      <dl style={{ margin: 0, borderTop: "2px solid var(--color-text)", display: "flex", flexDirection: "column" }}>
        <div style={row}>
          <dt style={label}>Stage</dt>
          <dd style={{ ...value, margin: 0 }}>{card.stage}</dd>
        </div>
        {handoff ? (
          <div style={row}>
            <dt style={label}>Handed over</dt>
            <dd style={{ ...value, margin: 0, color: "var(--color-accent-700)" }}>{handoffReason(handoff.trigger)}</dd>
          </div>
        ) : null}
        <div style={row}>
          <dt style={{ ...label, marginBottom: "4px" }}>Qualifying answers</dt>
          <dd style={{ margin: 0 }}>
            {card.answers.length === 0 ? (
              <span style={{ fontSize: "14px", color: "var(--color-neutral-700)" }}>No answers collected yet.</span>
            ) : (
              <ul aria-label="Qualifying answers" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "4px" }}>
                {card.answers.map((a) => (
                  <li key={a.key} data-testid="lead-card-answer" style={{ fontSize: "14px", display: "flex", gap: "8px", alignItems: "baseline", flexWrap: "wrap" }}>
                    <span style={{ color: "var(--color-neutral-700)" }}>{a.label}:</span>{" "}
                    <span style={{ fontWeight: a.value === null ? 400 : 600, color: a.value === null ? "var(--color-neutral-700)" : "var(--color-text)", overflowWrap: "anywhere" }}>
                      {a.value ?? "Not answered yet"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
        <div style={row}>
          <dt style={label}>Booking</dt>
          <dd style={{ ...value, margin: 0 }}>
            {booking ? (
              <>
                {booking.title}
                <span style={{ display: "block", fontWeight: 400, color: "var(--color-neutral-700)" }}>
                  {booking.when} · {booking.statusLabel}
                </span>
              </>
            ) : (
              <span style={{ fontWeight: 400, color: "var(--color-neutral-700)" }}>No booking yet</span>
            )}
          </dd>
        </div>
        {aiRows
          .filter(([, text]) => text !== null)
          .map(([name, text]) => (
            <div key={name} style={row} data-testid="lead-card-ai-row">
              <dt style={label}>{name}</dt>
              <dd style={{ ...value, margin: 0, fontWeight: name === "Summary" ? 400 : 600 }}>{text}</dd>
            </div>
          ))}
      </dl>

      <p className="app-hint" style={{ margin: 0 }}>
        {ai
          ? "Sample summary in a provisional format: the lead card isn’t connected to the AI yet. Score and answers are as the AI stored them."
          : "Score and answers as the AI stored them. AI summaries of the chat aren’t available yet."}
      </p>
      <Link className="btn btn-secondary" href={`/dashboard/leads/${lead.id}`} style={{ alignSelf: "flex-start" }}>
        Open lead
      </Link>
    </>
  );
}

const heading: CSSProperties = { margin: 0, fontSize: "11px", letterSpacing: ".1em", textTransform: "uppercase", color: "var(--color-neutral-700)", fontWeight: 600 };

/** The card pinned beside the chat (wide screens; hidden below 1180px by styles/app.css). */
export function LeadCardPanel({ state, conversation, onRetry }: { state: LeadCardState; conversation: ConversationSummary; onRetry: () => void }) {
  const headingId = useId();
  return (
    <aside className="app-inbox-lead" aria-labelledby={headingId}>
      <div style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: "16px" }}>
        <h2 id={headingId} style={heading}>
          Lead card
        </h2>
        <LeadCardBody state={state} conversation={conversation} onRetry={onRetry} />
      </div>
    </aside>
  );
}

/** The same card as a bottom sheet (narrower screens): a modal dialog with Close and Escape; focus goes back to the opener. */
export function LeadCardSheet({ state, conversation, onRetry, onClose }: { state: LeadCardState; conversation: ConversationSummary; onRetry: () => void; onClose: () => void }) {
  const headingId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Once per opening: focus Close, listen for Escape, and give focus back to the opener on the way out.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus();
    };
  }, []);

  return (
    <div className="app-inbox-lead-sheet" onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 50, background: "color-mix(in srgb,var(--color-neutral-900) 50%,transparent)" }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onClick={(e) => e.stopPropagation()}
        style={{ position: "absolute", left: 0, right: 0, bottom: 0, maxHeight: "85vh", overflowY: "auto", background: "var(--color-bg)", borderTop: "2px solid var(--color-text)" }}
      >
        <div style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: "16px", maxWidth: "560px", margin: "0 auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2 id={headingId} style={heading}>
              Lead card
            </h2>
            <button ref={closeRef} type="button" className="btn btn-icon" onClick={onClose} aria-label="Close" style={{ width: "32px", height: "32px" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true" style={{ strokeWidth: "2" }}>
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          <LeadCardBody state={state} conversation={conversation} onRetry={onRetry} />
        </div>
      </div>
    </div>
  );
}
