import type { CSSProperties } from "react";
import { EmptyState, ErrorState, LoadingState } from "@/components/shared/states";
import type { FormattedError } from "@/lib/errors";
import {
  CONVERSATION_LIMIT,
  conversationTag,
  formatListTime,
  matchesFilter,
  type ConversationSummary,
  type InboxFilter,
  type InboxTag,
} from "./data";
import type { RealtimeState } from "./use-inbox-realtime";

// The chat list column, ported from the /dashboard/preview Inbox (components/dashboard/pakka-app.tsx):
// search, filter chips, rows with initials, name, preview, time and the AI / Needs human tag.
// Left out on purpose: the lead score chip (no conversation → lead link) and unread counts (not tracked).

const FILTERS: { key: InboxFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "ai", label: "AI handling" },
  { key: "needs_human", label: "Needs human" },
];

/** Tag colours from the prototype: Needs human = accent, a person replying = ink, AI = neutral. */
export const TAG: Record<InboxTag, { label: string; bg: string; fg: string }> = {
  needs_human: { label: "Needs human", bg: "var(--color-accent)", fg: "#fff" },
  human: { label: "Human", bg: "var(--color-text)", fg: "var(--color-bg)" },
  external: { label: "Own number", bg: "var(--color-text)", fg: "var(--color-bg)" },
  ai: { label: "AI", bg: "var(--color-neutral-200)", fg: "var(--color-neutral-800)" },
};

const chip = (active: boolean): CSSProperties => ({
  flex: "none",
  border: `1px solid ${active ? "var(--color-text)" : "var(--color-divider)"}`,
  background: active ? "var(--color-text)" : "transparent",
  color: active ? "var(--color-bg)" : "var(--color-text)",
  font: "inherit",
  fontSize: "13px",
  fontWeight: "600",
  padding: "5px 10px",
  cursor: "pointer",
  whiteSpace: "nowrap",
});

export type ListState =
  | { status: "loading" }
  | { status: "error"; error: FormattedError }
  /** `truncated`: the newest page was full, so older chats exist that this list doesn't hold. */
  | { status: "ready"; items: ConversationSummary[]; truncated?: boolean };

export function ConversationList({
  list,
  visible,
  filter,
  onFilter,
  query,
  onQuery,
  selectedId,
  onOpen,
  onRetry,
  realtime,
  now,
  timeZone,
}: {
  list: ListState;
  visible: ConversationSummary[];
  filter: InboxFilter;
  onFilter: (f: InboxFilter) => void;
  query: string;
  onQuery: (q: string) => void;
  selectedId: string | null;
  onOpen: (id: string) => void;
  onRetry: () => void;
  realtime: RealtimeState;
  now: Date;
  timeZone: string;
}) {
  const all = list.status === "ready" ? list.items : [];

  return (
    <div className="app-inbox-list" style={{ borderRight: "2px solid var(--color-divider)" }}>
      <div style={{ padding: "14px 16px 10px", display: "flex", flexDirection: "column", gap: "10px", borderBottom: "1px solid var(--color-divider)" }}>
        <input
          className="input"
          type="search"
          aria-label="Search name or number"
          placeholder="Search name or number"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          style={{ minHeight: "40px" }}
        />
        <div role="group" aria-label="Show" style={{ display: "flex", gap: "6px", overflowX: "auto" }}>
          {FILTERS.map((f) => (
            <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => onFilter(f.key)} style={chip(filter === f.key)}>
              {f.label} {list.status === "ready" ? all.filter((c) => matchesFilter(c, f.key)).length : ""}
            </button>
          ))}
          <button
            type="button"
            disabled
            title="Unread chats aren't tracked yet"
            aria-describedby="inbox-unread-note"
            style={{ ...chip(false), cursor: "not-allowed", opacity: 0.45 }}
          >
            Unread
          </button>
          <span id="inbox-unread-note" hidden>
            Unread chats aren&apos;t tracked yet.
          </span>
        </div>
      </div>

      {realtime === "unavailable" && list.status === "ready" ? (
        <div role="status" style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap", padding: "8px 16px", fontSize: "13px", color: "var(--color-neutral-700)", borderBottom: "1px solid var(--color-divider)", flex: "none" }}>
          <span style={{ flex: "1", minWidth: "160px" }}>Live updates aren&apos;t connected. New messages show when you refresh.</span>
          <button type="button" className="btn btn-ghost" onClick={onRetry} style={{ padding: "4px 8px" }}>
            Refresh
          </button>
        </div>
      ) : null}

      {list.status === "ready" && list.truncated ? (
        <p role="status" data-testid="inbox-list-truncated" className="app-hint" style={{ margin: 0, padding: "8px 16px", borderBottom: "1px solid var(--color-divider)", flex: "none" }}>
          Showing your newest {CONVERSATION_LIMIT} chats. Older chats aren&apos;t listed here.
        </p>
      ) : null}

      <div style={{ flex: "1", minHeight: "0", overflow: "auto" }}>
        {list.status === "loading" ? (
          <div style={{ padding: "16px" }}>
            <LoadingState compact title="Loading chats" />
          </div>
        ) : null}

        {list.status === "error" ? (
          <div style={{ padding: "16px" }}>
            <ErrorState compact title="Couldn't load your chats" description={list.error.message} onRetry={onRetry} />
          </div>
        ) : null}

        {list.status === "ready" && all.length === 0 ? (
          <div style={{ padding: "16px" }}>
            <EmptyState
              compact
              title="No conversations yet"
              description="When customers message your business on WhatsApp, every chat lands here."
            />
          </div>
        ) : null}

        {list.status === "ready" && all.length > 0 && visible.length === 0 ? (
          <p style={{ padding: "20px 16px", margin: "0", color: "var(--color-neutral-700)", fontSize: "14px" }}>No chats here right now.</p>
        ) : null}

        {visible.map((c) => {
          const tag = TAG[conversationTag(c)];
          const time = c.lastMessage?.at ?? c.createdAt;
          return (
            <button
              key={c.id}
              type="button"
              className="app-inbox-row"
              aria-current={c.id === selectedId ? "true" : undefined}
              onClick={() => onOpen(c.id)}
              style={{ width: "100%", display: "grid", gridTemplateColumns: "40px minmax(0,1fr) auto", gap: "12px", padding: "12px 16px", border: "0", borderBottom: "1px solid var(--color-divider)", color: "var(--color-text)", font: "inherit", textAlign: "left", cursor: "pointer" }}
            >
              <span aria-hidden="true" style={{ width: "40px", height: "40px", background: "var(--color-neutral-300)", display: "grid", placeItems: "center", fontWeight: "800", fontSize: "13px" }}>
                {c.initials}
              </span>
              <span style={{ minWidth: "0", display: "flex", flexDirection: "column", gap: "3px" }}>
                <span style={{ display: "flex", gap: "6px", alignItems: "center", minWidth: "0" }}>
                  <span style={{ fontWeight: "600", fontSize: "15px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</span>
                </span>
                <span style={{ fontSize: "13px", color: "var(--color-neutral-700)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {c.lastMessage?.preview ?? "No messages yet"}
                </span>
              </span>
              <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "5px" }}>
                <time dateTime={time} style={{ fontSize: "11px", color: "var(--color-neutral-700)" }}>
                  {formatListTime(time, now, timeZone)}
                </time>
                <span style={{ fontSize: "10px", fontWeight: "800", letterSpacing: ".04em", textTransform: "uppercase", padding: "2px 5px", background: tag.bg, color: tag.fg, whiteSpace: "nowrap" }}>
                  {tag.label}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
