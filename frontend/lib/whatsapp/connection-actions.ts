import type { ConnectionMethod, ConnectionStatus, Role } from "@pakka/types";
import { sendNoContent } from "@/lib/api/client";

// What a member may do to a WhatsApp connection from the dashboard, and how it is done: POST
// /api/whatsapp/connections/:id/recheck and /disconnect (backend/src/channels/whatsapp/connect/recheck.ts), no body, the
// business in X-Pakka-Tenant. Each answers 200 with the connection; the page re-reads it from whatsapp_connections_public
// afterwards, so the answer isn't kept here. Errors: forbidden (staff, another business's connection, a Spark Agent number),
// not_found, conflict (a check already running, or recheck on a disconnected number), upstream_failed (Meta unreachable;
// the status is what it was before).

export type ConnectionAction = "recheck" | "disconnect";

/** Runs one action against the API. Resolves once the server has done it; throws ApiError if not. */
export type ConnectionService = (args: { connectionId: string; tenantId: string }) => Promise<void>;

const connectionPath = (connectionId: string, action: ConnectionAction) => `/api/whatsapp/connections/${encodeURIComponent(connectionId)}/${action}` as const;

export const CONNECTION_SERVICES: Record<ConnectionAction, ConnectionService> = {
  recheck: ({ connectionId, tenantId }) => sendNoContent(connectionPath(connectionId, "recheck"), "POST", { tenantId }),
  disconnect: ({ connectionId, tenantId }) => sendNoContent(connectionPath(connectionId, "disconnect"), "POST", { tenantId }),
};

// Recheck: owner or admin (handover module 10: "Dashboard, admin"). Disconnect: owner only
// (docs/dashboard-screen-contracts.md, Settings). The API allows owner and admin for both
// (docs/whatsapp-connection-contract.md); the stricter rule for disconnect is this screen's choice until the team
// settles it. The API decides in the end.
const ROLES: Record<ConnectionAction, readonly Role[]> = {
  recheck: ["owner", "admin"],
  disconnect: ["owner"],
};

// A check already running (validating) or a number no longer connected (disconnected) has nothing
// to recheck. A disconnected number has nothing to disconnect.
const STATUSES: Record<ConnectionAction, readonly ConnectionStatus[]> = {
  recheck: ["pending", "active", "failed"],
  disconnect: ["pending", "validating", "active", "failed"],
};

// `platform` is one of Spark Agent's own test or demo numbers (migration 0014), seeded by script and
// never the client's: recheck and disconnect are for the client's own connections, so it has neither
// (docs/whatsapp-connection-contract.md).
const METHODS: Record<ConnectionAction, readonly ConnectionMethod[]> = {
  recheck: ["embedded_signup", "assisted", "manual_byo"],
  disconnect: ["embedded_signup", "assisted", "manual_byo"],
};

/** The actions this member sees for a connection with this method and status, in display order. */
export function visibleActions(status: ConnectionStatus, role: Role, method: ConnectionMethod): ConnectionAction[] {
  return (["recheck", "disconnect"] as const).filter(
    (a) => METHODS[a].includes(method) && ROLES[a].includes(role) && STATUSES[a].includes(status),
  );
}
