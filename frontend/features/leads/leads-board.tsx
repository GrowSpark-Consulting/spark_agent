"use client";

import Link from "next/link";
import { useCallback, useEffect, useReducer, useRef, useState, type CSSProperties } from "react";
import { RefreshControl } from "@/components/shared/refresh-control";
import { EmptyState, ErrorState, LoadingState } from "@/components/shared/states";
import { formatError } from "@/lib/errors";
import { useTableRefresh } from "@/lib/realtime/use-table-refresh";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import {
  fetchLeadsPage,
  fetchPackFields,
  formatAgo,
  groupByStage,
  matchesFilters,
  parseMinScore,
  qualificationSummary,
  TEMPERATURE_LABEL,
  temperatureCounts,
  type LeadCursor,
  type PackFieldInfo,
  type TemperatureFilter,
} from "./data";
import { initialLeadsPaging, leadsPagingReducer, refreshLeavesGap } from "./paging";
import { ScoreBadge } from "./score-badge";

// The real Leads board (Day 3): the /dashboard/preview Leads layout (features/leads/pakka-leads.tsx:
// title and counts, score chips, a column per stage scrolling sideways, cards with name, badge and the
// customer's answers) on leads read under RLS. Read-only: stages move as the AI and bookings move them;
// dragging cards isn't part of Day 3. Score and temperature are shown as Dev 1's engine stored them.

// Leads are read a page at a time (data.ts, fetchLeadsPage; the state machine is paging.ts): the board never assumes
// every lead came in one answer. Filters and the counts on them are worked out over the leads loaded so far, the same
// way for every page; while older leads remain, the screen says so and "Load more leads" reads the next page.

const FILTERS: TemperatureFilter[] = ["all", "hot", "warm", "cold", "disqualified", "unscored"];

const chip = (on: boolean): CSSProperties => ({
  border: `1px solid ${on ? "var(--color-text)" : "var(--color-divider)"}`,
  background: on ? "var(--color-text)" : "transparent",
  color: on ? "var(--color-bg)" : "var(--color-text)",
  font: "inherit",
  fontSize: "13px",
  fontWeight: 600,
  padding: "6px 12px",
  cursor: "pointer",
});

export function LeadsBoard({ tenantId, timeZone }: { tenantId: string; timeZone: string }) {
  const [state, dispatch] = useReducer(leadsPagingReducer, undefined, () => initialLeadsPaging());
  const [temperature, setTemperature] = useState<TemperatureFilter>("all");
  const [minScoreText, setMinScoreText] = useState("");
  const [now] = useState(() => new Date());
  // Every start of the first page gets a new number; an answer carrying an older one (another business, an earlier try)
  // is dropped by the reducer.
  const generation = useRef(0);

  const load = useCallback(() => {
    const g = ++generation.current;
    dispatch({ type: "reset", generation: g });
    const client = getSupabaseBrowserClient();
    // Labels are a nicety: without the pack, answers show with their keys.
    const packFields = fetchPackFields(client, tenantId).catch((): PackFieldInfo[] => []);
    return Promise.all([fetchLeadsPage(client, tenantId), packFields]).then(
      ([page, fields]) => dispatch({ type: "first_loaded", generation: g, page, packFields: fields }),
      (err: unknown) => dispatch({ type: "first_failed", generation: g, error: formatError(err) }),
    );
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = (from: LeadCursor) => {
    // One page at a time: the reducer ignores a second request while one is running.
    const g = generation.current;
    dispatch({ type: "more_started", generation: g });
    return fetchLeadsPage(getSupabaseBrowserClient(), tenantId, from).then(
      (page) => dispatch({ type: "more_loaded", generation: g, from, page }),
      (err: unknown) => dispatch({ type: "more_failed", generation: g, from, error: formatError(err) }),
    );
  };

  // Read again without clearing the screen: the newest page is merged into what is held (leads already read stay), and
  // if a burst may have left a gap the list starts over from the first page instead. Used by the Refresh button and,
  // when the database sends changes, by Realtime (below). A failed read leaves the list as it was and says so.
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  });
  const refresh = useCallback(async () => {
    const g = generation.current;
    if (latest.current.phase !== "ready" || latest.current.refresh === "loading") return;
    dispatch({ type: "refresh_started", generation: g });
    try {
      const page = await fetchLeadsPage(getSupabaseBrowserClient(), tenantId);
      if (refreshLeavesGap(latest.current.leads, page)) {
        await load();
        return;
      }
      dispatch({ type: "refreshed", generation: g, page });
    } catch (err) {
      dispatch({ type: "refresh_failed", generation: g, error: formatError(err) });
    }
  }, [tenantId, load]);
  // Only tables the database publishes are listened to; `leads` is not one yet, so this reports "not live" and the
  // Refresh button is the way to update (lib/realtime/published-tables.ts says why and what changes that).
  const live = useTableRefresh(tenantId, ["leads"], refresh);

  const ready = state.phase === "ready";
  // "123+" while older leads are still unread: a count over what is loaded is a minimum, and says so.
  const plus = state.next !== null ? "+" : "";

  const minScore = parseMinScore(minScoreText);
  const minScoreInvalid = minScore === undefined;
  const leads = ready ? state.leads : [];
  const filtered = leads.filter((l) => matchesFilters(l, { temperature, minScore: minScore ?? null }));
  const counts = temperatureCounts(leads);
  const filtering = temperature !== "all" || (minScore !== null && minScore !== undefined);
  const open = leads.filter((l) => l.stage !== "won" && l.stage !== "lost").length;

  const clear = () => {
    setTemperature("all");
    setMinScoreText("");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px", minWidth: 0, color: "var(--color-text)" }}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: "16px", flexWrap: "wrap" }}>
        <div>
          <h1 className="app-h1">Leads</h1>
          <p style={{ margin: "4px 0 0", color: "var(--color-neutral-700)" }}>
            {ready ? `${open}${plus} open · ${counts.hot}${plus} hot` : "Every WhatsApp enquiry, by stage."}
          </p>
        </div>
        {ready ? <RefreshControl live={live} refreshing={state.refresh === "loading"} failed={state.refresh === "error"} onRefresh={() => void refresh()} /> : null}
      </div>

      {ready && leads.length > 0 ? (
        <div style={{ display: "flex", gap: "12px 16px", flexWrap: "wrap", alignItems: "flex-end" }}>
          <div role="group" aria-label="Temperature" style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            {FILTERS.filter((f) => f === "all" || f === "hot" || f === "warm" || f === "cold" || counts[f] > 0).map((f) => (
              <button key={f} type="button" aria-pressed={temperature === f} style={chip(temperature === f)} onClick={() => setTemperature(f)}>
                {f === "all" ? "All" : TEMPERATURE_LABEL[f]} · {counts[f]}{plus}
              </button>
            ))}
          </div>
          <div className="field" style={{ gap: "4px" }}>
            <label htmlFor="leads-min-score" style={{ fontSize: "13px", fontWeight: 600 }}>
              Score at least
            </label>
            <input
              id="leads-min-score"
              className="input"
              inputMode="numeric"
              placeholder="Any"
              value={minScoreText}
              aria-invalid={minScoreInvalid ? true : undefined}
              aria-describedby={minScoreInvalid ? "leads-min-score-error" : undefined}
              onChange={(e) => setMinScoreText(e.target.value)}
              style={{ width: "96px", minHeight: "34px", padding: "4px 8px" }}
            />
          </div>
          {filtering || minScoreText ? (
            <button type="button" className="btn btn-ghost" onClick={clear}>
              Clear filters
            </button>
          ) : null}
          {minScoreInvalid ? (
            <p id="leads-min-score-error" className="app-field-error" style={{ flexBasis: "100%", margin: 0 }}>
              Enter a whole number, like 70
            </p>
          ) : null}
        </div>
      ) : null}

      {state.phase === "loading" ? <LoadingState compact title="Loading your leads" /> : null}
      {state.phase === "error" && state.error ? (
        <ErrorState
          compact
          title="Couldn't load your leads"
          description={state.error.message}
          onRetry={() => {
            void load();
          }}
        />
      ) : null}

      {ready && leads.length === 0 ? (
        <EmptyState compact title="No leads yet" description="Every new WhatsApp enquiry becomes a lead here. The AI fills in their answers and moves them along as they reply." />
      ) : null}

      {ready && state.next !== null ? (
        <p className="app-notice" style={{ margin: 0 }}>
          Showing the {leads.length} most recently updated leads. Filters and counts cover these; load more to include older ones.
        </p>
      ) : null}

      {ready && leads.length > 0 && filtered.length === 0 && !minScoreInvalid ? (
        <EmptyState
          compact
          title="No leads match these filters"
          description={state.next !== null ? "None of the leads loaded so far match. Load more to look through older ones." : undefined}
          action={
            <button type="button" className="btn btn-secondary" onClick={clear}>
              Clear filters
            </button>
          }
        />
      ) : null}

      {ready && filtered.length > 0 ? (
        <div className="app-leads-board" data-testid="leads-board">
          <div style={{ display: "grid", gridAutoFlow: "column", gridAutoColumns: "minmax(232px, 232px)", gap: "2px", background: "var(--color-divider)", borderTop: "2px solid var(--color-text)", width: "max-content", minHeight: "320px" }}>
            {groupByStage(filtered).map((col) => (
              <section key={col.stage} aria-label={`${col.label} · ${col.leads.length}`} data-stage={col.stage} style={{ background: "var(--color-bg)", display: "flex", flexDirection: "column", gap: "8px", padding: "12px 10px 16px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "0 2px 6px" }}>
                  <h2 style={{ margin: 0, fontSize: "12px", fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase" }}>{col.label}</h2>
                  <span style={{ fontSize: "13px", color: "var(--color-neutral-700)", fontWeight: 600 }}>{col.leads.length}</span>
                </div>
                {col.leads.map((l) => {
                  const summary = qualificationSummary(l.answers, state.packFields);
                  return (
                    <Link
                      key={l.id}
                      href={`/dashboard/leads/${l.id}`}
                      className="app-lead-card"
                      style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "12px", background: "var(--color-surface)", color: "var(--color-text)", textDecoration: "none" }}
                    >
                      <span style={{ display: "flex", justifyContent: "space-between", gap: "8px", alignItems: "center" }}>
                        <span style={{ fontWeight: 800, fontSize: "15px", overflowWrap: "anywhere" }}>{l.name}</span>
                        <ScoreBadge temperature={l.temperature} score={l.score} />
                      </span>
                      <span style={{ fontSize: "13px", lineHeight: 1.35, color: summary ? "var(--color-neutral-800)" : "var(--color-neutral-700)", overflowWrap: "anywhere" }}>
                        {summary ?? "No answers yet"}
                      </span>
                      <span style={{ display: "flex", justifyContent: "space-between", gap: "8px", fontSize: "11px", color: "var(--color-neutral-700)", borderTop: "1px solid var(--color-divider)", paddingTop: "6px", marginTop: "2px" }}>
                        <span>{l.hasName ? l.phoneMasked : ""}</span>
                        <span style={{ fontWeight: 600, whiteSpace: "nowrap" }}>Updated {formatAgo(l.updatedAt, now, timeZone)}</span>
                      </span>
                    </Link>
                  );
                })}
                {col.leads.length === 0 ? <div style={{ fontSize: "12px", color: "var(--color-neutral-700)", padding: "8px 2px" }}>Nothing here</div> : null}
              </section>
            ))}
          </div>
        </div>
      ) : null}

      {ready && state.next !== null ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "8px" }}>
          {state.more === "error" && state.moreError ? (
            <p role="alert" className="app-field-error" style={{ margin: 0 }}>
              Couldn’t load more leads. {state.moreError.message}
            </p>
          ) : null}
          <button
            type="button"
            className="btn btn-secondary"
            disabled={state.more === "loading"}
            aria-busy={state.more === "loading" ? true : undefined}
            onClick={() => void loadMore(state.next as LeadCursor)}
          >
            {state.more === "loading" ? "Loading more leads…" : state.more === "error" ? "Try again" : "Load more leads"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
