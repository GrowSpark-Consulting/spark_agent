"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshControl } from "@/components/shared/refresh-control";
import { EmptyState, ErrorState, LoadingState } from "@/components/shared/states";
import { bookingTitle, effectiveStatus, isActive, STATUS_LABEL, STATUS_STYLE } from "@/features/calendar/bookings";
import { formatDate, formatTime, formatWhen, localParts } from "@/features/calendar/time";
import { formatError, type FormattedError } from "@/lib/errors";
import { useTableRefresh } from "@/lib/realtime/use-table-refresh";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import {
  answerRows,
  fetchLead,
  fetchLeadActivity,
  fetchPackFields,
  humanize,
  STAGES,
  stageLabel,
  TIMELINE_MESSAGE_LIMIT,
  type Lead,
  type LeadActivity,
  type PackFieldInfo,
  type TimelineKind,
} from "./data";
import { ScoreBadge } from "./score-badge";

// The real lead detail (Day 3): the /dashboard/preview lead view (features/leads/pakka-leads.tsx: score
// block, name, stage strip, details and timeline columns) on data read under RLS. The answers are the
// ones Dev 1's engine collected (leads.fields), labelled by the business's pack; the timeline is built
// from the chat, handovers and bookings already stored. Read-only: stage and owner changes need the
// proposed PATCH /api/leads/:id.

type LeadState = { status: "loading" } | { status: "error"; error: FormattedError } | { status: "missing" } | { status: "ready"; lead: Lead };
type ActivityState = { status: "loading" } | { status: "error"; error: FormattedError } | { status: "ready"; activity: LeadActivity };

const sectionTitle = { margin: "0 0 4px", fontSize: "13px", letterSpacing: ".08em", textTransform: "uppercase", borderBottom: "2px solid var(--color-text)", paddingBottom: "8px" } as const;

const DOT: Record<TimelineKind, { bg: string; border: string; color: string }> = {
  lead: { bg: "var(--color-bg)", border: "var(--color-text)", color: "var(--color-neutral-700)" },
  customer: { bg: "var(--color-bg)", border: "var(--color-text)", color: "var(--color-neutral-700)" },
  ai: { bg: "var(--color-bg)", border: "var(--color-text)", color: "var(--color-neutral-700)" },
  staff: { bg: "var(--color-text)", border: "var(--color-text)", color: "var(--color-neutral-700)" },
  system: { bg: "var(--color-bg)", border: "var(--color-neutral-400)", color: "var(--color-neutral-700)" },
  handoff: { bg: "var(--color-accent)", border: "var(--color-accent)", color: "var(--color-accent-700)" },
  booking: { bg: "var(--color-text)", border: "var(--color-text)", color: "var(--color-accent-700)" },
};

export function LeadDetail({ tenantId, timeZone, leadId, userId }: { tenantId: string; timeZone: string; leadId: string; userId: string }) {
  const [leadState, setLeadState] = useState<LeadState>({ status: "loading" });
  const [packFields, setPackFields] = useState<PackFieldInfo[]>([]);
  const [activity, setActivity] = useState<ActivityState>({ status: "loading" });
  /** When the activity on screen was read: held bookings are judged against it (a hold that lapsed is not an appointment). */
  const [now, setNow] = useState(() => new Date());
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const refreshInFlight = useRef(false);

  const loadActivity = useCallback(
    (lead: Lead) => {
      const at = new Date();
      return fetchLeadActivity(getSupabaseBrowserClient(), tenantId, lead, at, timeZone).then(
        (a) => {
          setNow(at);
          setActivity({ status: "ready", activity: a });
        },
        (err: unknown) => setActivity({ status: "error", error: formatError(err) }),
      );
    },
    [tenantId, timeZone],
  );

  // Reads the lead and its activity again without clearing the screen. Both are read before anything is replaced, so a
  // failure on either leaves what is shown exactly as it was and only says so (RefreshControl); one refresh runs at a time.
  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    try {
      const client = getSupabaseBrowserClient();
      const at = new Date();
      const lead = await fetchLead(client, tenantId, leadId);
      if (!lead) {
        setLeadState({ status: "missing" }); // removed since it was opened
        return;
      }
      const fresh = await fetchLeadActivity(client, tenantId, lead, at, timeZone);
      setLeadState({ status: "ready", lead });
      setActivity({ status: "ready", activity: fresh });
      setNow(at);
      setRefreshFailed(false);
    } catch {
      setRefreshFailed(true);
    } finally {
      refreshInFlight.current = false;
      setRefreshing(false);
    }
  }, [tenantId, leadId, timeZone]);

  // `leads` and `bookings` aren't in the supabase_realtime publication yet, so this reports "not live" until they are.
  const live = useTableRefresh(tenantId, ["leads", "bookings"], refresh);

  const load = useCallback(() => {
    const client = getSupabaseBrowserClient();
    void fetchPackFields(client, tenantId).then(setPackFields, () => setPackFields([]));
    return fetchLead(client, tenantId, leadId).then(
      (lead) => {
        if (!lead) return setLeadState({ status: "missing" });
        setLeadState({ status: "ready", lead });
        void loadActivity(lead);
      },
      (err: unknown) => setLeadState({ status: "error", error: formatError(err) }),
    );
  }, [tenantId, leadId, loadActivity]);

  useEffect(() => {
    void load();
  }, [load]);

  const back = (
    <Link className="btn btn-ghost" href="/dashboard/leads" style={{ alignSelf: "flex-start", paddingLeft: 0 }}>
      ← All leads
    </Link>
  );

  if (leadState.status !== "ready") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "16px", maxWidth: "1100px" }}>
        {back}
        {leadState.status === "loading" ? <LoadingState compact title="Loading this lead" /> : null}
        {leadState.status === "missing" ? <EmptyState compact title="This lead isn't available" description="It may have been removed, or it belongs to another business." /> : null}
        {leadState.status === "error" ? (
          <ErrorState
            compact
            title="Couldn't load this lead"
            description={leadState.error.message}
            onRetry={() => {
              setLeadState({ status: "loading" });
              void load();
            }}
          />
        ) : null}
      </div>
    );
  }

  const lead = leadState.lead;
  const rows = answerRows(lead.answers, packFields);
  const a = activity.status === "ready" ? activity.activity : null;
  const upcoming = (a?.bookings ?? []).filter((b) => isActive(effectiveStatus(b, now)));
  const owner = lead.ownerUserId === null ? "Not assigned" : lead.ownerUserId === userId ? "Assigned to you" : "Assigned to a teammate";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px", maxWidth: "1100px", minWidth: 0, color: "var(--color-text)" }}>
      {back}
      <div style={{ display: "flex", gap: "16px", alignItems: "center", flexWrap: "wrap" }}>
        <ScoreBadge temperature={lead.temperature} score={lead.score} large />
        <div style={{ flex: 1, minWidth: "200px" }}>
          <h1 className="app-h1" style={{ overflowWrap: "anywhere" }}>
            {lead.name}
          </h1>
          <div style={{ fontSize: "14px", color: "var(--color-neutral-700)" }}>
            {lead.hasName ? `${lead.phoneMasked} · ` : ""}
            {stageLabel(lead.stage)} · {owner}
          </div>
        </div>
        {a?.latestConversationId ? (
          <Link className="btn btn-primary" href={`/dashboard/inbox?chat=${a.latestConversationId}`}>
            Open chat
          </Link>
        ) : null}
      </div>

      <RefreshControl live={live} refreshing={refreshing} failed={refreshFailed} onRefresh={() => void refresh()} />

      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <div style={{ fontSize: "11px", letterSpacing: ".1em", textTransform: "uppercase", fontWeight: 600, color: "var(--color-neutral-700)" }}>Stage</div>
        <div style={{ overflowX: "auto" }}>
          <ol aria-label="Stage" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: `repeat(${STAGES.length}, minmax(84px, 1fr))`, border: "2px solid var(--color-text)", minWidth: `${STAGES.length * 84}px` }}>
            {STAGES.map((st) => {
              const on = st === lead.stage;
              return (
                <li
                  key={st}
                  aria-current={on ? "step" : undefined}
                  style={{ padding: "9px 4px", borderRight: "1px solid var(--color-divider)", background: on ? (st === "lost" ? "var(--color-neutral-700)" : "var(--color-accent)") : "transparent", color: on ? "#fff" : "var(--color-text)", fontSize: "12px", fontWeight: 800, textAlign: "center", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                >
                  {stageLabel(st)}
                </li>
              );
            })}
          </ol>
        </div>
      </div>

      {a && a.openHandoffs.length > 0 ? (
        <p className="app-notice" style={{ margin: 0 }}>
          Waiting for a person: {a.openHandoffs.map((h) => humanize(h.trigger).toLowerCase()).join(", ")}.
        </p>
      ) : null}

      <div className="app-lead-columns" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))", gap: "32px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "24px", minWidth: 0 }}>
          <section aria-labelledby="lead-answers-heading">
            <h2 id="lead-answers-heading" style={sectionTitle}>
              Answers
            </h2>
            {rows.length === 0 ? (
              <p style={{ margin: "10px 0 0", color: "var(--color-neutral-700)", fontSize: "14px" }}>No answers collected yet.</p>
            ) : (
              <dl style={{ margin: 0 }}>
                {rows.map((r) => (
                  <div key={r.key} data-testid="answer-row" style={{ display: "grid", gridTemplateColumns: "minmax(110px, 40%) minmax(0,1fr)", gap: "12px", padding: "10px 0", borderBottom: "1px solid var(--color-divider)", fontSize: "14px" }}>
                    <dt style={{ color: "var(--color-neutral-700)", overflowWrap: "anywhere" }}>
                      {r.label}
                      {r.required && r.value === null ? <span style={{ display: "block", fontSize: "11px", color: "var(--color-accent-700)", fontWeight: 600 }}>Needed to qualify</span> : null}
                    </dt>
                    <dd style={{ margin: 0, fontWeight: r.value === null ? 400 : 600, color: r.value === null ? "var(--color-neutral-700)" : "var(--color-text)", overflowWrap: "anywhere" }}>
                      {r.value ?? "Not answered yet"}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            <p className="app-hint">
              Collected by the AI during the chat. Score and answers as of {formatWhen(lead.updatedAt, timeZone)}.
            </p>
          </section>

          <section aria-labelledby="lead-bookings-heading" style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <h2 id="lead-bookings-heading" style={sectionTitle}>
              Bookings
            </h2>
            {activity.status === "loading" ? <LoadingState compact title="Loading bookings" /> : null}
            {activity.status === "ready" && upcoming.length === 0 ? <p style={{ margin: "6px 0 0", color: "var(--color-neutral-700)", fontSize: "14px" }}>No current bookings.</p> : null}
            {upcoming.map((b) => {
              const status = effectiveStatus(b, now);
              const s = STATUS_STYLE[status];
              return (
                <div key={b.id} style={{ display: "flex", justifyContent: "space-between", gap: "12px", padding: "10px 0", borderBottom: "1px solid var(--color-divider)", fontSize: "14px", flexWrap: "wrap" }}>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", fontWeight: 600, overflowWrap: "anywhere" }}>{bookingTitle(b)}</span>
                    <span style={{ color: "var(--color-neutral-700)" }}>
                      {formatWhen(b.start, timeZone)} – {formatTime(b.end, timeZone)}
                    </span>
                  </span>
                  <span style={{ alignSelf: "flex-start", fontSize: "10px", fontWeight: 800, letterSpacing: ".06em", textTransform: "uppercase", padding: "3px 7px", background: s.bg, color: s.fg, border: s.border }}>{STATUS_LABEL[status]}</span>
                </div>
              );
            })}
          </section>
        </div>

        <section aria-labelledby="lead-timeline-heading" style={{ minWidth: 0 }}>
          <h2 id="lead-timeline-heading" style={sectionTitle}>
            Timeline
          </h2>
          {activity.status === "loading" ? <LoadingState compact title="Loading the timeline" /> : null}
          {activity.status === "error" ? (
            <ErrorState
              compact
              title="Couldn't load the timeline"
              description={activity.error.message}
              onRetry={() => {
                setActivity({ status: "loading" });
                void loadActivity(lead);
              }}
            />
          ) : null}
          {a?.messagesTruncated ? (
            <p className="app-hint">Showing the latest {TIMELINE_MESSAGE_LIMIT} messages; the chat has the rest.</p>
          ) : null}
          {a ? (
            <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column" }} aria-label="Timeline">
              {a.timeline.map((t) => {
                const dot = DOT[t.kind];
                return (
                  <li key={t.id} data-kind={t.kind} style={{ display: "grid", gridTemplateColumns: "84px 14px minmax(0,1fr)", gap: "10px", padding: "12px 0", borderBottom: "1px solid var(--color-divider)" }}>
                    <time dateTime={t.at} style={{ fontSize: "12px", color: "var(--color-neutral-700)", lineHeight: 1.3 }}>
                      <span style={{ display: "block" }}>{formatDate(localParts(new Date(t.at), timeZone).date)}</span>
                      <span style={{ display: "block" }}>{formatTime(t.at, timeZone)}</span>
                    </time>
                    <span aria-hidden="true" style={{ width: "10px", height: "10px", marginTop: "4px", background: dot.bg, border: `2px solid ${dot.border}`, display: "block" }} />
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: "block", fontSize: "12px", fontWeight: 800, letterSpacing: ".04em", textTransform: "uppercase", color: dot.color }}>{t.label}</span>
                      <span style={{ fontSize: "14px", lineHeight: 1.45, overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>{t.text}</span>
                    </span>
                  </li>
                );
              })}
            </ol>
          ) : null}
        </section>
      </div>
    </div>
  );
}
