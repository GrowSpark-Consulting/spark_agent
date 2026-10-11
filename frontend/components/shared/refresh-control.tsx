import type { TableChangeState } from "@/lib/realtime/table-changes";

// A Refresh button and one line saying how this screen is being kept up to date. The button always works: it reads
// the data again without clearing the screen. The line says "live" only when the database is really sending changes for
// this screen's tables (lib/realtime); otherwise it says plainly that nothing updates by itself.

export function RefreshControl({
  live,
  refreshing,
  failed,
  onRefresh,
}: {
  live: TableChangeState;
  refreshing: boolean;
  /** The last refresh failed: what is shown is from the read before it. */
  failed: boolean;
  onRefresh: () => void;
}) {
  const note = failed
    ? "Couldn’t refresh. You’re seeing the last read."
    : live === "live"
      ? "Updating live."
      : live === "unavailable"
        ? "Not updating live. Use Refresh."
        : "";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
      <button type="button" className="btn btn-secondary" disabled={refreshing} aria-busy={refreshing ? true : undefined} onClick={onRefresh}>
        {refreshing ? "Refreshing…" : "Refresh"}
      </button>
      <span role="status" aria-live="polite" className="app-hint" style={{ margin: 0 }}>
        {note}
      </span>
    </div>
  );
}
