import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { supabaseAdmin } from "../../../lib/supabase-admin";
import { withWebhookConfirmed, type LastCheck } from "./checks";

// Proof that a manual_byo connection's own Meta app delivers webhooks to us: a request signed with that connection's app secret that named its phone number
// (inbound.ts). It is the "signed test webhook arrived" half of the webhook check (checks.ts). Kept as one audit row per connection
// (`whatsapp_connection.webhook_seen`), written the first time it is seen after the server starts, so a busy number costs two queries once, not one per webhook.
// Best effort: a failure here never touches the webhook's answer.
//
// The same proof clears the connection's own waiting note: the stored `webhook_subscribed` check, left waiting (`not_verified`) when the number was connected, becomes
// a pass and `overall` is worked out again, so the owner does not have to press Recheck. The status is never changed (an active number stays active), only an active
// manual_byo connection of that business is touched, a repeat changes nothing, and a result saved in between (a recheck) is not overwritten. A connection that is
// not ready yet, or a database that failed, is looked at again by a later webhook, at most once a minute.

export const WEBHOOK_SEEN_ACTION = "whatsapp_connection.webhook_seen";

const noted = new Set<string>();
const RETRY_AFTER_MS = 60_000;
const retryAt = new Map<string, number>();
const proofWritten = new Set<string>();

export async function webhookWasSeen(db: SupabaseClient, tenantId: string, connectionId: string): Promise<boolean> {
  const { data, error } = await db.from("audit_logs").select("id").eq("tenant_id", tenantId).eq("action", WEBHOOK_SEEN_ACTION).eq("entity_id", connectionId).limit(1);
  if (error) return false;
  return Array.isArray(data) && data.length > 0;
}

// Only what the update needs is checked, and everything else is passed through untouched: a check this code does not know yet must not stop the clearing.
const StoredCheck = z.object({ key: z.string(), status: z.string(), message: z.string(), checked_at: z.string() }).passthrough();
const StoredLastCheck = z.object({ ran_at: z.string(), overall: z.string(), checks: z.array(StoredCheck) }).passthrough();

/**
 * Turns the stored webhook check of an active manual_byo connection into a pass. "done" when the check is passed now or needs no change; "later" when the
 * connection is not ready (not active, nothing stored yet), the database failed, or a newer result was saved meanwhile: a later webhook looks again.
 */
async function confirmWebhookCheck(db: SupabaseClient, tenantId: string, connectionId: string): Promise<"done" | "later"> {
  const { data, error } = await db
    .from("whatsapp_connections")
    .select("id, last_check, updated_at")
    .eq("tenant_id", tenantId)
    .eq("id", connectionId)
    .eq("method", "manual_byo")
    .eq("status", "active")
    .limit(1);
  if (error) return "later";
  if (!Array.isArray(data) || data.length === 0) return "later"; // not an active manual_byo connection of this business (yet)
  const readAt = data[0]?.updated_at; // as it was when read: the guard below
  const parsed = StoredLastCheck.safeParse(data[0]?.last_check);
  if (!parsed.success) return "later"; // never checked, or not in the shape we wrote
  const last = parsed.data as LastCheck;
  const confirmed = withWebhookConfirmed(last, new Date());
  if (confirmed === last) return "done";

  const result = await db
    .from("whatsapp_connections")
    .update({ last_check: confirmed })
    .eq("tenant_id", tenantId)
    .eq("id", connectionId)
    .eq("method", "manual_byo")
    .eq("status", "active")
    .eq("updated_at", readAt) // not over anything saved since it was read (a recheck, the sixth check of a connect)
    .select("id");
  return !result.error && Array.isArray(result.data) && result.data.length > 0 ? "done" : "later";
}

/** Called for each connection a verified webhook named. Never throws. */
export async function noteWebhookSeen(tenantId: string, connectionId: string, db: SupabaseClient = supabaseAdmin()): Promise<void> {
  if (noted.has(connectionId)) return;
  if ((retryAt.get(connectionId) ?? 0) > Date.now()) return;
  try {
    if (!proofWritten.has(connectionId)) {
      if (!(await webhookWasSeen(db, tenantId, connectionId))) {
        const { error } = await db.from("audit_logs").insert({ tenant_id: tenantId, actor: "system", action: WEBHOOK_SEEN_ACTION, entity: "whatsapp_connection", entity_id: connectionId, diff: {} });
        if (error) return;
      }
      proofWritten.add(connectionId);
    }
    if ((await confirmWebhookCheck(db, tenantId, connectionId)) === "later") {
      retryAt.set(connectionId, Date.now() + RETRY_AFTER_MS);
      return;
    }
    retryAt.delete(connectionId);
    noted.add(connectionId);
  } catch {
    // nothing: the next webhook tries again
  }
}

/** For tests. */
export const forgetNotedWebhooks = () => {
  noted.clear();
  retryAt.clear();
  proofWritten.clear();
};
