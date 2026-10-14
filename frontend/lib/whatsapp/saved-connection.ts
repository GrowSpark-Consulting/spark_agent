import { getWhatsAppConnections } from "@pakka/backend/channels/whatsapp/connections";
import type { WhatsAppConnectionPublic } from "@pakka/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";
import { formatError } from "@/lib/errors";
import { parseLastCheck, webhookUnconfirmed } from "./last-check";
import { resolveBrowserTenant, type BrowserTenant } from "@/lib/api/tenant";
import { resolveWhatsAppTenant } from "./manual-connect";

// What the onboarding wizard knows about the business's WhatsApp number when the WhatsApp step opens, read from the database as the signed-in
// member (`whatsapp_connections_public`, row-level security), never from React memory: a refresh, a Back and Next, or a return to the wizard
// on another day all find the same answer. "Connected" is only an `active` connection the database returns; a number that is saved but
// pending, being checked or failed is `inactive` and is never called connected; a read that failed is `error`, which is not "nothing saved".

/** The part of a saved connection the wizard shows. `messagesReach` is false when the webhook check does not prove that customers' messages arrive. */
export interface SavedNumber {
  status: WhatsAppConnectionPublic["status"];
  displayPhone: string | null;
  messagesReach: boolean;
}

export type SavedConnection =
  | { state: "active"; number: SavedNumber }
  /** Saved, but pending, validating or failed: not connected. */
  | { state: "inactive"; number: SavedNumber }
  /** Nothing saved (or only a disconnected number), or no business yet. */
  | { state: "none" }
  /** The connections view doesn't exist on this database yet. */
  | { state: "unavailable" }
  | { state: "error"; message: string; retryable: boolean };

const numberOf = (c: WhatsAppConnectionPublic): SavedNumber => ({
  status: c.status,
  displayPhone: c.display_phone,
  messagesReach: !webhookUnconfirmed(parseLastCheck(c.last_check)),
});

/** The most useful saved connection: an active one first, then the newest that isn't disconnected. */
export function pickSaved(connections: WhatsAppConnectionPublic[]): SavedConnection {
  const active = connections.find((c) => c.status === "active");
  if (active) return { state: "active", number: numberOf(active) };
  const live = connections.filter((c) => c.status !== "disconnected");
  const newest = live[live.length - 1];
  return newest ? { state: "inactive", number: numberOf(newest) } : { state: "none" };
}

/** Reads the saved connection for the signed-in member's business. */
export async function loadSavedConnection(
  client: SupabaseClient = getSupabaseBrowserClient(),
  resolve: () => Promise<BrowserTenant> = resolveBrowserTenant,
): Promise<SavedConnection> {
  const found = await resolve();
  // A person who has not made their business yet has nothing saved; any other reason is a failure to look, not an empty answer.
  if (found.status === "no_business") return { state: "none" };
  const tenant = await resolveWhatsAppTenant(() => Promise.resolve(found));
  if (tenant.state !== "ready") return { state: "error", message: tenant.message, retryable: tenant.retryable };
  try {
    const result = await getWhatsAppConnections(client, tenant.tenantId);
    return result.state === "unavailable" ? { state: "unavailable" } : pickSaved(result.connections);
  } catch (err) {
    const shown = formatError(err);
    return { state: "error", message: shown.message, retryable: true };
  }
}
