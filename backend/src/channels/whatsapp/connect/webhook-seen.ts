import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "../../../lib/supabase-admin";

// Proof that a manual_byo connection's own Meta app delivers webhooks to us: a request signed with that connection's app secret that named its phone number
// (inbound.ts). It is the "signed test webhook arrived" half of the webhook check (checks.ts). Kept as one audit row per connection
// (`whatsapp_connection.webhook_seen`), written the first time it is seen after the server starts, so a busy number costs two queries once, not one per webhook.
// Best effort: a failure here never touches the webhook's answer.

export const WEBHOOK_SEEN_ACTION = "whatsapp_connection.webhook_seen";

const noted = new Set<string>();

export async function webhookWasSeen(db: SupabaseClient, tenantId: string, connectionId: string): Promise<boolean> {
  const { data, error } = await db.from("audit_logs").select("id").eq("tenant_id", tenantId).eq("action", WEBHOOK_SEEN_ACTION).eq("entity_id", connectionId).limit(1);
  if (error) return false;
  return Array.isArray(data) && data.length > 0;
}

/** Called for each connection a verified webhook named. Never throws. */
export async function noteWebhookSeen(tenantId: string, connectionId: string, db: SupabaseClient = supabaseAdmin()): Promise<void> {
  if (noted.has(connectionId)) return;
  try {
    if (!(await webhookWasSeen(db, tenantId, connectionId))) {
      const { error } = await db.from("audit_logs").insert({ tenant_id: tenantId, actor: "system", action: WEBHOOK_SEEN_ACTION, entity: "whatsapp_connection", entity_id: connectionId, diff: {} });
      if (error) return;
    }
    noted.add(connectionId);
  } catch {
    // nothing: the next webhook tries again
  }
}

/** For tests. */
export const forgetNotedWebhooks = () => noted.clear();
