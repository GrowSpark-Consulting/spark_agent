import { checkStatus, checkTitle, overallSummary, type ParsedLastCheck } from "@/lib/whatsapp/last-check";

// The connection checks of one WhatsApp number, from its `last_check` (lib/whatsapp/last-check.ts). Draws only what the
// stored result says: a number that was never checked, or whose result isn't in the contract's shape, says so and claims nothing.
// Each message is written by the API to be shown as it is. Plain divs, not a list: the panel's own list is the list of numbers.

const RAN = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });

function ranOn(ranAt: string): string | null {
  const date = new Date(ranAt);
  return Number.isNaN(date.getTime()) ? null : RAN.format(date);
}

export function WhatsAppConnectionChecks({ lastCheck, canRecheck }: { lastCheck: ParsedLastCheck; canRecheck: boolean }) {
  if (lastCheck.state !== "checked") {
    return (
      <p className="app-hint" data-testid="connection-checks-none" style={{ margin: "8px 0 0" }}>
        {lastCheck.state === "never" ? "No connection checks have run for this number yet." : "The last check result isn’t in a form we can show."}
        {canRecheck ? " Use Recheck connection to run them." : ""}
      </p>
    );
  }
  const ran = ranOn(lastCheck.ranAt);
  return (
    <div role="group" aria-label="Connection checks" data-testid="connection-checks" style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
      <div>
        <div style={{ fontSize: 12, color: "var(--color-neutral-700)" }}>Connection checks{ran ? ` · last run ${ran}` : ""}</div>
        <div style={{ fontWeight: 600 }}>{overallSummary(lastCheck.overall, lastCheck.checks.length)}</div>
      </div>
      {lastCheck.checks.map((check) => {
        const s = checkStatus(check.status);
        return (
          <div key={check.key} data-testid="connection-check" data-check={check.key} data-status={check.status} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontWeight: 600 }}>{checkTitle(check.key)}</span>
              <span className={`app-status app-status-${s.tone}`}>{s.label}</span>
            </div>
            <p className="app-hint" style={{ margin: 0 }}>
              {check.message}
            </p>
          </div>
        );
      })}
    </div>
  );
}
