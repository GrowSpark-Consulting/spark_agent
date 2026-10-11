"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { RefreshControl } from "@/components/shared/refresh-control";
import { EmptyState, ErrorState, LoadingState } from "@/components/shared/states";
import { formatError, type FormattedError } from "@/lib/errors";
import { useTableRefresh } from "@/lib/realtime/use-table-refresh";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { bookingTitle, kindLabel, STATUS_LABEL, STATUS_STYLE, type Booking } from "./bookings";
import {
  agendaOrder,
  buildColumns,
  fetchBookings,
  fetchResources,
  gridHours,
  NO_RESOURCE,
  placeBookings,
  rangeFor,
  summarize,
  visibleBookings,
  type CalendarResource,
  type CalendarView,
  type ResourceFilter,
  type ShownBooking,
} from "./data";
import { addDays, formatDate, formatSpan, formatTime, formatWhen, isDateString, localParts } from "./time";

// The real Calendar (Day 3, read-only): the /dashboard/preview Calendar's layout (features/calendar/
// pakka-calendar.tsx: Day/Week switch, staff chips, legend, hour grid with booking blocks, a side panel;
// an agenda list on phones) on bookings and resources read under RLS. Times are in the business's time
// zone. Nothing here creates, moves or cancels a booking.

/** `key` names the range the answer is for: an answer for another range shows as loading. */
type Data =
  | { status: "loading" }
  | { status: "error"; key: string; error: FormattedError }
  | { status: "ready"; key: string; resources: CalendarResource[]; bookings: Booking[]; truncated: boolean };

const PXH = 56;
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
const segButton = (on: boolean): CSSProperties => ({
  padding: "6px 14px",
  border: 0,
  background: on ? "var(--color-text)" : "transparent",
  color: on ? "var(--color-bg)" : "var(--color-text)",
  font: "inherit",
  fontSize: "13px",
  fontWeight: 800,
  cursor: "pointer",
});

function hourLabel(hour: number): string {
  const h12 = ((hour + 11) % 12) + 1;
  return `${h12} ${hour % 24 >= 12 ? "pm" : "am"}`;
}

function customerOf(b: Booking): string {
  return b.customerName ?? b.phoneMasked ?? "Customer";
}

function timeRange(b: Booking, timeZone: string): string {
  return `${formatTime(b.start, timeZone)} – ${formatTime(b.end, timeZone)}`;
}

export function CalendarScreen({
  tenantId,
  timeZone,
  initialView,
  initialDate,
  initialResource,
}: {
  tenantId: string;
  timeZone: string;
  initialView: CalendarView;
  /** "YYYY-MM-DD" in the business's zone; null = today there. */
  initialDate: string | null;
  initialResource: ResourceFilter;
}) {
  const [now, setNow] = useState(() => new Date());
  const today = localParts(now, timeZone).date;
  const [view, setView] = useState<CalendarView>(initialView);
  const [date, setDate] = useState(initialDate ?? today);
  const [resource, setResource] = useState<ResourceFilter>(initialResource);
  const [showInactive, setShowInactive] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Data>({ status: "loading" });
  const latest = useRef(0);

  // The "now" line and lapsing holds follow the clock.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const range = useMemo(() => rangeFor(view, date, timeZone), [view, date, timeZone]);
  const rangeKey = `${range.from.toISOString()}/${range.to.toISOString()}`;
  const data: Data = loaded.status !== "loading" && loaded.key !== rangeKey ? { status: "loading" } : loaded;

  const load = useCallback(() => {
    const request = ++latest.current;
    const key = `${range.from.toISOString()}/${range.to.toISOString()}`;
    const client = getSupabaseBrowserClient();
    Promise.all([fetchResources(client, tenantId), fetchBookings(client, tenantId, range)]).then(
      ([resources, { bookings, truncated }]) => {
        if (request === latest.current) setLoaded({ status: "ready", key, resources, bookings, truncated });
      },
      (err: unknown) => {
        if (request === latest.current) setLoaded({ status: "error", key, error: formatError(err) });
      },
    );
  }, [tenantId, range]);

  useEffect(() => {
    load();
  }, [load]);

  // Read the shown range again without clearing the screen: what is held is replaced by what the database says now, so
  // a change that is reported twice cannot show a booking twice. If the person moved to another day or week meanwhile,
  // that read's answer is dropped (the new range has its own read). A failed read leaves the last one on screen and says so.
  // Used by the Refresh button and, once the database sends booking changes, by Realtime (below).
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const refreshRunning = useRef(false);
  const shownData = useRef(data);
  useEffect(() => {
    shownData.current = data;
  });
  const refresh = useCallback(async () => {
    if (shownData.current.status !== "ready" || refreshRunning.current) return;
    refreshRunning.current = true;
    setRefreshing(true);
    setRefreshFailed(false);
    const request = latest.current;
    const key = `${range.from.toISOString()}/${range.to.toISOString()}`;
    try {
      const client = getSupabaseBrowserClient();
      const [resources, { bookings, truncated }] = await Promise.all([fetchResources(client, tenantId), fetchBookings(client, tenantId, range)]);
      if (request === latest.current) setLoaded({ status: "ready", key, resources, bookings, truncated });
    } catch {
      if (request === latest.current) setRefreshFailed(true);
    } finally {
      refreshRunning.current = false;
      setRefreshing(false);
    }
  }, [tenantId, range]);
  // Only tables the database publishes are listened to; `bookings` is not one yet, so this reports "not live" and the
  // Refresh button is the way to update (lib/realtime/published-tables.ts says why and what changes that).
  const live = useTableRefresh(tenantId, ["bookings"], refresh);

  // Keep the address in step so a reload or a shared link opens the same view.
  useEffect(() => {
    const params = new URLSearchParams();
    if (view !== "day") params.set("view", view);
    if (date !== today) params.set("date", date);
    if (resource !== "all") params.set("resource", resource);
    const query = params.toString();
    window.history.replaceState(window.history.state, "", query ? `?${query}` : window.location.pathname);
  }, [view, date, resource, today]);

  const resources = data.status === "ready" ? data.resources : [];
  const allBookings = data.status === "ready" ? data.bookings : [];
  const shown = visibleBookings(allBookings, { now, showInactive, resource });
  const hasUnassigned = visibleBookings(allBookings, { now, showInactive, resource: "all" }).some((b) => b.resourceId === null);
  const columns = buildColumns({ view, range, resources, bookings: shown, resource, timeZone });
  const hours = gridHours(shown, range.days, timeZone);
  const counts = summarize(shown);
  const selected = shown.find((b) => b.id === selectedId) ?? null;

  const step = (n: number) => {
    setDate(addDays(date, view === "day" ? n : 7 * n));
    setSelectedId(null);
  };

  const heading = view === "day" ? formatDate(date, { weekday: "long" }) : `Week of ${formatDate(range.days[0], { weekday: "short" })}`;
  const word = (n: number) => `${n} ${n === 1 ? "booking" : "bookings"}`;
  const subline =
    data.status === "ready"
      ? `${word(counts.total)} ${view === "day" ? (date === today ? "today" : "this day") : "this week"}${counts.held ? ` · ${counts.held} held, waiting for the customer` : ""} · Times in ${timeZone}`
      : `Times in ${timeZone}`;

  return (
    <div data-testid="calendar" style={{ position: "relative", display: "flex", gap: "24px", minWidth: 0, color: "var(--color-text)" }}>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "16px" }}>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: "16px", flexWrap: "wrap" }}>
          <div>
            <h1 className="app-h1">{heading}</h1>
            <p style={{ margin: "4px 0 0", color: "var(--color-neutral-700)" }}>{subline}</p>
          </div>
          <div role="group" aria-label="View" style={{ display: "flex", border: "2px solid var(--color-text)" }}>
            <button type="button" aria-pressed={view === "day"} style={segButton(view === "day")} onClick={() => setView("day")}>
              Day
            </button>
            <button type="button" aria-pressed={view === "week"} style={segButton(view === "week")} onClick={() => setView("week")}>
              Week
            </button>
          </div>
        </div>

        <div className="app-row" style={{ gap: "8px" }}>
          <button type="button" className="btn btn-secondary" aria-label={view === "day" ? "Previous day" : "Previous week"} onClick={() => step(-1)}>
            ←
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setDate(today)} disabled={view === "day" ? date === today : range.days.includes(today)}>
            Today
          </button>
          <button type="button" className="btn btn-secondary" aria-label={view === "day" ? "Next day" : "Next week"} onClick={() => step(1)}>
            →
          </button>
          <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px" }}>
            <span>Go to</span>
            <input
              type="date"
              className="input"
              value={date}
              onChange={(e) => {
                if (isDateString(e.target.value)) setDate(e.target.value);
              }}
              style={{ width: "auto", minHeight: "36px", padding: "4px 8px" }}
            />
          </label>
          {data.status === "ready" ? <RefreshControl live={live} refreshing={refreshing} failed={refreshFailed} onRefresh={() => void refresh()} /> : null}
        </div>

        <div style={{ display: "flex", gap: "16px", alignItems: "center", flexWrap: "wrap", justifyContent: "space-between" }}>
          <div role="group" aria-label="Staff and resources" style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            <button type="button" aria-pressed={resource === "all"} style={chip(resource === "all")} onClick={() => setResource("all")}>
              All staff
            </button>
            {resources
              .filter((r) => r.active || r.id === resource || allBookings.some((b) => b.resourceId === r.id))
              .map((r) => (
                <button key={r.id} type="button" aria-pressed={resource === r.id} style={chip(resource === r.id)} onClick={() => setResource(r.id)}>
                  {r.name}
                </button>
              ))}
            {hasUnassigned || resource === NO_RESOURCE ? (
              <button type="button" aria-pressed={resource === NO_RESOURCE} style={chip(resource === NO_RESOURCE)} onClick={() => setResource(NO_RESOURCE)}>
                No staff assigned
              </button>
            ) : null}
          </div>
          <Legend />
        </div>

        <div className="app-row" style={{ justifyContent: "space-between", gap: "8px" }}>
          <label style={{ display: "flex", gap: "8px", alignItems: "center", fontSize: "13px", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              style={{ width: "16px", height: "16px", accentColor: "var(--color-accent)", margin: 0 }}
            />
            Show cancelled, moved and expired
          </label>
          <span className="app-hint" style={{ margin: 0 }}>
            Read-only: bookings can’t be changed from the dashboard yet.
          </span>
        </div>

        {data.status === "loading" ? <LoadingState compact title="Loading bookings" /> : null}
        {data.status === "error" ? (
          <ErrorState
            compact
            title="Couldn't load the calendar"
            description={data.error.message}
            onRetry={() => {
              setLoaded({ status: "loading" });
              load();
            }}
          />
        ) : null}

        {data.status === "ready" && data.truncated ? (
          <p className="app-notice" style={{ margin: 0 }}>
            Showing the first {allBookings.length} bookings in this range.
          </p>
        ) : null}

        {data.status === "ready" && resources.length === 0 && allBookings.length === 0 ? (
          <EmptyState
            compact
            title="No staff or resources yet"
            description="Bookings are made with a staff member or resource. Add them, with their hours, in Booking setup."
            action={
              <Link className="btn btn-secondary" href="/dashboard/settings/booking">
                Open booking setup
              </Link>
            }
          />
        ) : null}

        {data.status === "ready" && (resources.length > 0 || allBookings.length > 0) ? (
          <>
            {shown.length === 0 ? (
              <p style={{ margin: 0, color: "var(--color-neutral-700)" }} data-testid="calendar-empty">
                {view === "day" ? "No bookings on this day." : "No bookings this week."}
              </p>
            ) : null}

            {/* Tablet and desktop: the hour grid. */}
            <div className="app-cal-grid" style={{ overflowX: "auto", borderTop: "2px solid var(--color-text)" }}>
              <div style={{ display: "grid", gridTemplateColumns: `56px repeat(${Math.max(columns.length, 1)}, minmax(140px, 1fr))`, minWidth: `${56 + Math.max(columns.length, 1) * 140}px` }}>
                <div style={{ borderBottom: "2px solid var(--color-divider)" }} />
                {columns.map((c) => (
                  <div key={c.key} style={{ padding: "10px", borderBottom: "2px solid var(--color-divider)", borderLeft: "1px solid var(--color-divider)", background: view === "week" && c.date === today ? "var(--color-surface)" : "transparent", minWidth: 0 }}>
                    <div style={{ fontWeight: 800, fontSize: "14px", overflowWrap: "anywhere" }}>{view === "week" ? formatDate(c.date) : c.title}</div>
                    <div style={{ fontSize: "12px", color: "var(--color-neutral-700)" }}>{view === "week" ? (c.date === today ? "Today" : "") : c.subtitle}</div>
                  </div>
                ))}
                {columns.length === 0 ? <div style={{ borderBottom: "2px solid var(--color-divider)", borderLeft: "1px solid var(--color-divider)" }} /> : null}
                <div style={{ position: "relative", height: `${(hours.end - hours.start) * PXH}px` }} aria-hidden="true">
                  {Array.from({ length: hours.end - hours.start }, (_, i) => (
                    <div key={i} style={{ position: "absolute", top: `${i * PXH}px`, left: 0, right: "8px", fontSize: "11px", color: "var(--color-neutral-700)", textAlign: "right", transform: i === 0 ? "none" : "translateY(-7px)" }}>
                      {hourLabel(hours.start + i)}
                    </div>
                  ))}
                </div>
                {columns.map((c) => (
                  <div
                    key={c.key}
                    data-testid={`column-${c.key}`}
                    style={{ position: "relative", height: `${(hours.end - hours.start) * PXH}px`, borderLeft: "1px solid var(--color-divider)", background: view === "week" && c.date === today ? "color-mix(in srgb,var(--color-surface) 50%,transparent)" : "transparent" }}
                  >
                    {Array.from({ length: hours.end - hours.start }, (_, i) => (
                      <div key={i} aria-hidden="true" style={{ position: "absolute", top: `${i * PXH}px`, left: 0, right: 0, borderTop: "1px solid var(--color-neutral-300)" }} />
                    ))}
                    {c.date === today ? (
                      <NowLine minutes={localParts(now, timeZone).minutes} startHour={hours.start} endHour={hours.end} />
                    ) : null}
                    {placeBookings(c.bookings, c.date, timeZone).map((p) => {
                      const s = STATUS_STYLE[p.booking.shown];
                      const top = ((p.start - hours.start * 60) / 60) * PXH;
                      const height = Math.max(((p.end - p.start) / 60) * PXH - 4, 24);
                      return (
                        <button
                          key={p.booking.id}
                          type="button"
                          data-testid="booking-block"
                          aria-label={`${customerOf(p.booking)}, ${timeRange(p.booking, timeZone)}, ${STATUS_LABEL[p.booking.shown]}`}
                          aria-pressed={selectedId === p.booking.id}
                          onClick={() => setSelectedId(p.booking.id)}
                          style={{
                            position: "absolute",
                            top: `${top + 2}px`,
                            height: `${height}px`,
                            left: `calc(${(p.lane / p.lanes) * 100}% + 3px)`,
                            width: `calc(${100 / p.lanes}% - 6px)`,
                            zIndex: 3,
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "flex-start",
                            gap: "1px",
                            padding: "4px 6px",
                            background: s.bg,
                            color: s.fg,
                            border: s.border,
                            font: "inherit",
                            textAlign: "left",
                            cursor: "pointer",
                            overflow: "hidden",
                            boxShadow: selectedId === p.booking.id ? "0 0 0 2px var(--color-accent)" : "none",
                          }}
                        >
                          <span style={{ fontWeight: 800, fontSize: "13px", textDecoration: s.strike ? "line-through" : "none", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>
                            {customerOf(p.booking)}
                          </span>
                          <span style={{ fontSize: "11px", opacity: 0.85, whiteSpace: "nowrap" }}>{timeRange(p.booking, timeZone)}</span>
                          <span style={{ fontSize: "11px", opacity: 0.85, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>
                            {view === "week" ? bookingTitle(p.booking) : (p.booking.serviceName ?? kindLabel(p.booking.kind))}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>

            {/* Phones: the agenda list. */}
            <div className="app-cal-agenda" style={{ flexDirection: "column" }}>
              {agendaOrder(shown).map((b, i, list) => {
                const s = STATUS_STYLE[b.shown];
                const day = localParts(new Date(b.start), timeZone).date;
                const showHead = view === "week" && (i === 0 || localParts(new Date(list[i - 1].start), timeZone).date !== day);
                return (
                  <div key={b.id} style={{ display: "flex", flexDirection: "column" }}>
                    {showHead ? (
                      <div style={{ fontSize: "12px", fontWeight: 800, letterSpacing: ".08em", textTransform: "uppercase", padding: "14px 0 6px", borderBottom: "2px solid var(--color-text)" }}>
                        {formatDate(day)}
                        {day === today ? " · Today" : ""}
                      </div>
                    ) : null}
                    <button
                      type="button"
                      data-testid="agenda-item"
                      aria-label={`${customerOf(b)}, ${timeRange(b, timeZone)}, ${STATUS_LABEL[b.shown]}`}
                      onClick={() => setSelectedId(b.id)}
                      style={{ display: "grid", gridTemplateColumns: "72px minmax(0,1fr)", gap: "12px", alignItems: "center", padding: "10px 0", border: 0, borderBottom: "1px solid var(--color-divider)", background: "transparent", color: "var(--color-text)", font: "inherit", textAlign: "left", cursor: "pointer" }}
                    >
                      <span style={{ fontWeight: 800, fontSize: "14px" }}>{formatTime(b.start, timeZone)}</span>
                      <span style={{ padding: "10px 12px", background: s.bg, color: s.fg, border: s.border, minWidth: 0 }}>
                        <span style={{ display: "block", fontWeight: 800, fontSize: "14px", textDecoration: s.strike ? "line-through" : "none", overflowWrap: "anywhere" }}>{customerOf(b)}</span>
                        <span style={{ fontSize: "12px", opacity: 0.85, overflowWrap: "anywhere" }}>
                          {bookingTitle(b)} · {STATUS_LABEL[b.shown]}
                        </span>
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        ) : null}
      </div>

      {selected ? <BookingPanel booking={selected} timeZone={timeZone} onClose={() => setSelectedId(null)} /> : null}
    </div>
  );
}

function NowLine({ minutes, startHour, endHour }: { minutes: number; startHour: number; endHour: number }) {
  if (minutes < startHour * 60 || minutes > endHour * 60) return null;
  return <div aria-hidden="true" style={{ position: "absolute", top: `${((minutes - startHour * 60) / 60) * PXH}px`, left: 0, right: 0, borderTop: "2px solid var(--color-accent)", zIndex: 2 }} />;
}

function Legend() {
  const items = (["confirmed", "held", "completed", "no_show"] as const).map((k) => ({ k, s: STATUS_STYLE[k] }));
  return (
    <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", fontSize: "12px", color: "var(--color-neutral-700)" }}>
      {items.map(({ k, s }) => (
        <span key={k} style={{ display: "flex", gap: "6px", alignItems: "center" }}>
          <span aria-hidden="true" style={{ width: "12px", height: "12px", border: s.border, background: s.bg, boxSizing: "border-box" }} />
          {STATUS_LABEL[k]}
        </span>
      ))}
    </div>
  );
}

function BookingPanel({ booking: b, timeZone, onClose }: { booking: ShownBooking; timeZone: string; onClose: () => void }) {
  const s = STATUS_STYLE[b.shown];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const rows: [string, string][] = [
    ["When", `${formatWhen(b.start, timeZone)} – ${formatTime(b.end, timeZone)}`],
    ["Length", formatSpan(b.start, b.end)],
    ["Service", b.serviceName ?? "—"],
    ["With", b.resourceName ?? "No staff assigned"],
    ["Type", kindLabel(b.kind)],
  ];
  if (b.shown === "held" && b.holdExpiresAt) rows.push(["Held until", formatWhen(b.holdExpiresAt, timeZone)]);
  if (b.cancelReason) rows.push(["Reason", b.cancelReason === "replaced" ? "The customer picked another time" : b.cancelReason]);
  return (
    <>
      <div className="app-cal-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="app-cal-panel" aria-label="Booking details">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: "10px", fontWeight: 800, letterSpacing: ".06em", textTransform: "uppercase", padding: "3px 7px", background: s.bg, color: s.fg, border: s.border }}>{STATUS_LABEL[b.shown]}</span>
          <button type="button" className="btn btn-icon" onClick={onClose} aria-label="Close" style={{ width: "32px", height: "32px" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div>
          <div style={{ fontWeight: 800, fontSize: "24px", lineHeight: 1.15, overflowWrap: "anywhere" }}>{customerOf(b)}</div>
          {b.customerName && b.phoneMasked ? <div style={{ fontSize: "14px", color: "var(--color-neutral-700)" }}>{b.phoneMasked}</div> : null}
        </div>
        <dl style={{ margin: 0, borderTop: "2px solid var(--color-text)" }}>
          {rows.map(([k, v]) => (
            <div key={k} style={{ display: "grid", gridTemplateColumns: "90px minmax(0,1fr)", gap: "10px", padding: "9px 0", borderBottom: "1px solid var(--color-divider)", fontSize: "14px" }}>
              <dt style={{ color: "var(--color-neutral-700)" }}>{k}</dt>
              <dd style={{ margin: 0, fontWeight: 600, overflowWrap: "anywhere" }}>{v}</dd>
            </div>
          ))}
        </dl>
        {b.shown === "held" ? <p style={{ margin: 0, fontSize: "14px", color: "var(--color-neutral-700)" }}>Not confirmed yet: the customer is still choosing. It isn’t an appointment until it’s confirmed.</p> : null}
        <Link className="btn btn-secondary" href={`/dashboard/leads/${b.leadId}`} style={{ alignSelf: "flex-start" }}>
          Open lead
        </Link>
        <p className="app-hint" style={{ margin: 0 }}>
          Rescheduling, cancelling and marking visits aren’t available from the dashboard yet.
        </p>
      </aside>
    </>
  );
}
