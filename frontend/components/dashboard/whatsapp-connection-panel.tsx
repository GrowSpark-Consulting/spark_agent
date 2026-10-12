import { getWhatsAppConnections, type ConnectionsResult } from "@pakka/backend/channels/whatsapp/connections";
import type { Role, WhatsAppConnectionPublic } from "@pakka/types";
import { unstable_rethrow } from "next/navigation";
import { WhatsAppConnectionActions } from "@/components/dashboard/whatsapp-connection-actions";
import { WhatsAppConnectionChecks } from "@/components/dashboard/whatsapp-connection-checks";
import { WhatsAppTemplateStatus } from "@/components/dashboard/whatsapp-template-status";
import { EmptyState, ErrorState } from "@/components/shared/states";
import { getAuth } from "@/lib/auth/session";
import { formatError } from "@/lib/errors";
import { visibleActions } from "@/lib/whatsapp/connection-actions";
import { parseLastCheck, webhookUnconfirmed } from "@/lib/whatsapp/last-check";
import { fetchTemplates, type TemplateStatusRow } from "@/lib/whatsapp/templates";

const STATUS: Record<WhatsAppConnectionPublic["status"], { label: string; tone: "ok" | "warn" | "off"; detail: string }> = {
  active: { label: "Connected", tone: "ok", detail: "Your assistant replies to customers from this number." },
  pending: {
    label: "Connecting",
    tone: "warn",
    detail: "Setup with Meta isn't finished yet. Messages can't be sent from this number until it is.",
  },
  validating: {
    label: "Checking",
    tone: "warn",
    detail: "We're running the connection checks with Meta. Messages can't be sent until they pass.",
  },
  failed: {
    label: "Needs attention",
    tone: "warn",
    detail: "A connection check failed, so messages aren't being sent. Fix it in Meta, then recheck the connection.",
  },
  disconnected: {
    label: "Disconnected",
    tone: "off",
    detail: "This number no longer sends or receives messages through Spark Agent.",
  },
};

// An active number whose stored checks don't show a webhook from the business's app: it can send, but nothing proves that
// customers' messages reach the assistant, so it is not called plainly "Connected" (lib/whatsapp/last-check.ts).
const UNCONFIRMED: (typeof STATUS)["active"] = {
  label: "Connected, webhook not confirmed",
  tone: "warn",
  detail: "Messages can be sent from this number, but we haven't confirmed that customers' messages reach your assistant yet. See the checks below.",
};

const METHOD: Record<WhatsAppConnectionPublic["method"], string> = {
  embedded_signup: "Connected with Facebook",
  assisted: "Assisted setup",
  manual_byo: "Connected manually",
  platform: "Spark Agent number",
};

const ADDED = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

function addedOn(createdAt: string): string | null {
  const date = new Date(createdAt);
  return Number.isNaN(date.getTime()) ? null : ADDED.format(date);
}

/**
 * The business's WhatsApp numbers. Reads `whatsapp_connections_public` (non-secret columns only) as
 * the signed-in member, so row-level security scopes it to their business. `role` decides which
 * actions are offered; the API checks again. Wrap in <Suspense> with a LoadingState.
 */
export async function WhatsAppConnectionPanel({ tenantId, role, compact }: { tenantId: string; role?: Role; compact?: boolean }) {
  let result: ConnectionsResult;
  try {
    const { supabase } = await getAuth();
    result = await getWhatsAppConnections(supabase, tenantId);
  } catch (err) {
    unstable_rethrow(err);
    const e = formatError(err);
    return <ErrorState compact={compact} title="Couldn't load your WhatsApp connection" description={e.message} retryHref="/dashboard/whatsapp" />;
  }

  if (result.state === "unavailable") {
    return (
      <EmptyState
        compact={compact}
        title="WhatsApp connection details aren't available yet"
        description="Connecting a number isn't switched on for this workspace yet. Once it is, the number, its status and Meta's quality rating appear here."
      />
    );
  }

  if (result.connections.length === 0) {
    return (
      <EmptyState
        compact={compact}
        title="No WhatsApp number connected"
        description="Connect your WhatsApp Business account so your assistant can reply to customers and you can send test messages."
        action={<ConnectPlaceholder />}
      />
    );
  }

  const allDisconnected = result.connections.every((c) => c.status === "disconnected");

  // Template approval is read with the signed-in member's own client (RLS). The full screen only: Home's card doesn't show it. A failed
  // read doesn't take the connection down with it: the numbers still show, and the template block says it couldn't be loaded.
  let templates: TemplateStatusRow[] | null = null;
  if (!compact) {
    try {
      const { supabase } = await getAuth();
      templates = await fetchTemplates(supabase, tenantId);
    } catch (err) {
      unstable_rethrow(err);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <ul className="app-grid" style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label="WhatsApp numbers">
        {result.connections.map((c) => {
          const last = parseLastCheck(c.last_check);
          const s = c.status === "active" && webhookUnconfirmed(last) ? UNCONFIRMED : STATUS[c.status];
          const added = addedOn(c.created_at);
          const actions = role ? visibleActions(c.status, role, c.method) : [];
          return (
            <li key={c.id} className="app-card" style={{ minWidth: 0 }}>
              <span className={`app-status app-status-${s.tone}`}>
                <span className="app-status-dot" aria-hidden="true" />
                {s.label}
              </span>
              <span className="app-card-title">{c.display_phone ?? "Number pending"}</span>
              <span className="app-card-text">
                {c.verified_name ? `Shows as “${c.verified_name}” · ` : ""}
                {METHOD[c.method]}
                {c.coexistence ? " · WhatsApp Business app still works" : ""}
              </span>
              {!compact ? (
                <>
                  <p className="app-card-text">{s.detail}</p>
                  <dl className="app-facts" style={{ marginTop: 8 }}>
                    <div>
                      <dt>Quality rating</dt>
                      <dd>{c.quality_rating ?? "Not reported yet"}</dd>
                    </div>
                    <div>
                      <dt>Messaging limit</dt>
                      <dd>{c.messaging_limit ?? "Not reported yet"}</dd>
                    </div>
                    {added ? (
                      <div>
                        <dt>Added</dt>
                        <dd>{added}</dd>
                      </div>
                    ) : null}
                    <div>
                      <dt>WhatsApp Business Account ID</dt>
                      <dd style={{ fontFamily: "var(--font-mono, monospace)" }}>{c.waba_id}</dd>
                    </div>
                    <div>
                      <dt>Phone number ID</dt>
                      <dd style={{ fontFamily: "var(--font-mono, monospace)" }}>{c.phone_number_id}</dd>
                    </div>
                  </dl>
                  <WhatsAppConnectionChecks lastCheck={last} canRecheck={actions.includes("recheck")} />
                  <WhatsAppTemplateStatus templates={templates && templates.filter((t) => t.connectionId === c.id)} />
                  {role ? <WhatsAppConnectionActions connectionId={c.id} tenantId={tenantId} displayPhone={c.display_phone} actions={actions} /> : null}
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
      {!compact && allDisconnected ? (
        <div className="app-actions">
          <ConnectPlaceholder />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The call to action, switched off until the connect flow exists (Embedded Signup and
 * POST /api/onboarding/whatsapp/embedded-signup, docs/handover.md module 10). It does nothing and
 * says so; it never fakes a connection.
 */
function ConnectPlaceholder() {
  return (
    <>
      <button type="button" className="btn btn-primary" disabled aria-describedby="connect-unavailable">
        Connect WhatsApp
      </button>
      <p id="connect-unavailable" className="app-hint" style={{ margin: 0, alignSelf: "center" }}>
        Connecting from the dashboard isn&apos;t switched on yet.
      </p>
    </>
  );
}
