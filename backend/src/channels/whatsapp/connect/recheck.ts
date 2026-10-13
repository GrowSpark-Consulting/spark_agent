import { WhatsAppConnectionPublic, type TenantContext } from "@pakka/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { connectionSecretContext, decryptSecret } from "../../../lib/crypto";
import { writeAudit, type AuditEntry } from "../../../lib/audit";
import { AppError } from "../../../lib/errors";
import { supabaseAdmin } from "../../../lib/supabase-admin";
import { requireRole } from "../../../lib/tenant";
import { graph as realGraph, withTestMessage, withWebhookConfirmed, type Check, type Graph } from "./checks";
import { probeMeta, type MetaProbe } from "./manual";
import { runConnectionChecks } from "./run-checks";
import { checkTestMessage } from "./test-message-check";
import { webhookWasSeen } from "./webhook-seen";

// POST /api/whatsapp/connections/:id/recheck and /disconnect (docs/whatsapp-connection-contract.md, "Recheck and disconnect"). Owner or admin of the business
// that owns the connection. Service role: whatsapp_connections is closed to every client, and every query names the business from the caller's own token.
//
// recheck      runs the six checks again. The status goes to `validating` first (a compare-and-set, so two rechecks never run together and the number is not
//              used for sending while it is being looked at), then to `active`, or `failed` if any check fails. If Meta cannot be reached, nothing changes:
//              the old status comes back and the caller is told to try again.
// disconnect   marks the number `disconnected`. Every part of the system that sends or receives for a number reads `status = 'active'` (message-sender.ts,
//              inbound.ts), so from that moment the AI neither hears nor answers on it: that is how it is paused. Then our app is unsubscribed from the
//              account's webhooks, best effort (a revoked token cannot do it, and the disconnect stands anyway). The token stays encrypted in its row.

const COLUMNS = "id, tenant_id, method, waba_id, phone_number_id, display_phone, verified_name, coexistence, status, last_check, quality_rating, messaging_limit, created_at";

const Row = z.object({ id: z.string(), method: z.string(), waba_id: z.string(), phone_number_id: z.string(), status: z.string(), token_enc: z.string(), coexistence: z.boolean().nullish() });

export interface RecheckDeps {
  db: SupabaseClient;
  probe: (args: { wabaId: string; phoneNumberId: string; token: string }) => Promise<MetaProbe>;
  graph: Graph;
  decrypt: typeof decryptSecret;
  webhookSeen: (tenantId: string, connectionId: string) => Promise<boolean>;
  testMessage: (tenantId: string, actor: string) => Promise<Check>;
  audit: (entry: AuditEntry) => Promise<void>;
  now: () => Date;
}

const defaults = (): RecheckDeps => {
  const db = supabaseAdmin();
  return {
    db,
    probe: probeMeta,
    graph: realGraph,
    decrypt: decryptSecret,
    webhookSeen: (tenantId, connectionId) => webhookWasSeen(db, tenantId, connectionId),
    testMessage: (tenantId, actor) => checkTestMessage(tenantId, actor),
    audit: writeAudit,
    now: () => new Date(),
  };
};

const trouble = (what: string) => new AppError("upstream_failed", `We couldn't ${what}. Try again in a moment.`);

async function load(context: TenantContext, connectionId: string, deps: RecheckDeps) {
  const { data, error } = await deps.db
    .from("whatsapp_connections")
    .select("id, method, waba_id, phone_number_id, status, token_enc, coexistence")
    .eq("tenant_id", context.tenant.id)
    .eq("id", connectionId)
    .limit(1);
  if (error) throw trouble("read the connection");
  const [row] = z.array(Row).max(1).parse(data ?? []);
  if (!row) throw new AppError("not_found", "We couldn't find that connection.");
  if (row.method === "platform") throw new AppError("forbidden", "This is a Spark Agent number. It can't be rechecked or disconnected here.");
  return row;
}

async function publicRow(context: TenantContext, connectionId: string, deps: RecheckDeps): Promise<WhatsAppConnectionPublic> {
  const { data, error } = await deps.db.from("whatsapp_connections").select(COLUMNS).eq("tenant_id", context.tenant.id).eq("id", connectionId).limit(1);
  if (error) throw trouble("read the connection");
  const parsed = z.array(WhatsAppConnectionPublic).max(1).safeParse(data ?? []);
  if (!parsed.success || !parsed.data[0]) throw trouble("read the connection");
  return parsed.data[0];
}

async function record(deps: RecheckDeps, entry: AuditEntry): Promise<void> {
  try {
    await deps.audit(entry);
  } catch {
    console.error("[whatsapp-connect] audit write failed");
  }
}

export async function recheckConnection(context: TenantContext, connectionId: string, deps: RecheckDeps = defaults()): Promise<WhatsAppConnectionPublic> {
  requireRole(context, ["owner", "admin"], "recheck a WhatsApp number");
  const tenantId = context.tenant.id;
  const row = await load(context, connectionId, deps);
  if (row.status === "disconnected") throw new AppError("conflict", "This number is disconnected. Connect it again with the connection form.");

  // One check at a time: only the caller who moves it to `validating` goes on.
  const claimed = await deps.db
    .from("whatsapp_connections")
    .update({ status: "validating" })
    .eq("tenant_id", tenantId)
    .eq("id", connectionId)
    .in("status", ["pending", "active", "failed"])
    .select("id");
  if (claimed.error) throw trouble("start the check");
  if (!Array.isArray(claimed.data) || claimed.data.length === 0) throw new AppError("conflict", "A check is already running for this number. Try again in a moment.");

  const restore = async () => {
    await deps.db.from("whatsapp_connections").update({ status: row.status }).eq("tenant_id", tenantId).eq("id", connectionId).eq("status", "validating");
  };


  let finalStatus: "active" | "failed";
  let seenBefore: boolean | undefined; // what the proof read said while the checks ran
  let subscribed: boolean | null = null; // an app is subscribed to the account after the check (null: not asked)
  try {
    let token: string;
    try {
      token = deps.decrypt(row.token_enc, connectionSecretContext({ column: "token_enc", tenantId, connectionId }));
    } catch {
      throw new AppError("upstream_failed", "We couldn't read the saved access token. Connect the number again with the connection form.");
    }

    const run = await runConnectionChecks(
      { tenantId, connectionId, method: row.method, wabaId: row.waba_id, phoneNumberId: row.phone_number_id, token, coexistence: row.coexistence === true },
      { probe: deps.probe, graph: deps.graph, webhookSeen: deps.webhookSeen, now: deps.now },
    );
    if (run.state === "unreachable") throw new AppError("upstream_failed", "We couldn't reach Meta to check this number. Try again in a moment.");
    const { lastCheck, fresh } = run;
    subscribed = run.subscribed;
    seenBefore = run.seenBefore;

    finalStatus = lastCheck.overall === "fail" ? "failed" : "active";

    // What Meta says about the number is refreshed along with the checks; a field Meta did not give is left as it was.
    const saved = await deps.db
      .from("whatsapp_connections")
      .update({ ...fresh, status: finalStatus, last_check: lastCheck })
      .eq("tenant_id", tenantId)
      .eq("id", connectionId)
      .eq("status", "validating")
      .select("id");
    if (saved.error || !Array.isArray(saved.data) || saved.data.length === 0) throw trouble("save the result");

    // The sixth check needs an active number (notify.send refuses any other), so it comes after. It never changes the status.
    if (finalStatus === "active") {
      try {
        const sixth = withTestMessage(lastCheck, await deps.testMessage(tenantId, context.user.id));
        // The test message can bring the first signed webhook of the business's own app; read the proof again so this write does not undo what it cleared.
        const withSixth = seenBefore !== true && (await deps.webhookSeen(tenantId, connectionId)) ? withWebhookConfirmed(sixth, deps.now()) : sixth;
        await deps.db.from("whatsapp_connections").update({ last_check: withSixth }).eq("tenant_id", tenantId).eq("id", connectionId);
      } catch {
        console.error("[whatsapp-connect] the test message check could not be recorded");
      }
    }
  } catch (error) {
    await restore().catch(() => undefined);
    throw error instanceof AppError ? error : trouble("check this number");
  }

  await record(deps, {
    tenantId,
    actor: context.user.id,
    action: "whatsapp_connection.rechecked",
    entity: "whatsapp_connection",
    entityId: connectionId,
    diff: { from: row.status, to: finalStatus, subscribed },
  });
  return publicRow(context, connectionId, deps);
}

export async function disconnectConnection(context: TenantContext, connectionId: string, deps: RecheckDeps = defaults()): Promise<WhatsAppConnectionPublic> {
  requireRole(context, ["owner", "admin"], "disconnect a WhatsApp number");
  const tenantId = context.tenant.id;
  const row = await load(context, connectionId, deps);
  if (row.status === "disconnected") return publicRow(context, connectionId, deps); // already done: the same answer, nothing changes

  const marked = await deps.db
    .from("whatsapp_connections")
    .update({ status: "disconnected" })
    .eq("tenant_id", tenantId)
    .eq("id", connectionId)
    .in("status", ["pending", "validating", "active", "failed"])
    .select("id");
  if (marked.error) throw trouble("disconnect this number");

  // Our app is taken off the account's webhooks. The disconnect stands whether or not this works.
  let unsubscribed = false;
  try {
    const token = deps.decrypt(row.token_enc, connectionSecretContext({ column: "token_enc", tenantId, connectionId }));
    const answer = await deps.graph("DELETE", `${row.waba_id}/subscribed_apps`, token);
    unsubscribed = answer.state === "answered" && answer.ok;
  } catch {
    unsubscribed = false;
  }

  await record(deps, {
    tenantId,
    actor: context.user.id,
    action: "whatsapp_connection.disconnected",
    entity: "whatsapp_connection",
    entityId: connectionId,
    diff: { from: row.status, to: "disconnected", unsubscribed },
  });
  return publicRow(context, connectionId, deps);
}
