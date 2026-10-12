import { z } from "zod";
import { connectionSecretContext, decryptSecret } from "../../lib/crypto";
import { supabaseAdmin } from "../../lib/supabase-admin";

// The webhook route's database access: one lookup and two functions from migration 0013. Service role,
// server only. The lookup by phone number id is the one query that cannot filter by tenant_id (it is how
// the tenant is found); every later call is given the tenant from that verified connection row.

/** A database failure. Carries the Postgres error code only: its message can hold phone numbers or text. */
export class WebhookDbError extends Error {
  constructor(operation: string, readonly code: string) {
    super(`${operation} failed`);
    this.name = "WebhookDbError";
  }
}

export type ConnectionRow = {
  id: string;
  tenantId: string;
  channelId: string;
  phoneNumberId: string;
  wabaId: string;
  method: string;
  status: string;
};

const ConnectionRows = z.array(
  z.object({
    id: z.string(),
    tenant_id: z.string(),
    channel_id: z.string(),
    phone_number_id: z.string(),
    waba_id: z.string(),
    method: z.string(),
    status: z.string(),
  }),
);

/** The connections for these phone number ids. Reads no secret columns. */
export async function findConnections(phoneNumberIds: string[]): Promise<ConnectionRow[]> {
  if (phoneNumberIds.length === 0) return [];
  const { data, error } = await supabaseAdmin()
    .from("whatsapp_connections")
    .select("id, tenant_id, channel_id, phone_number_id, waba_id, method, status")
    .in("phone_number_id", phoneNumberIds);
  if (error) throw new WebhookDbError("connection lookup", error.code);
  return ConnectionRows.parse(data).map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    channelId: r.channel_id,
    phoneNumberId: r.phone_number_id,
    wabaId: r.waba_id,
    method: r.method,
    status: r.status,
  }));
}

export type StoreInboundArgs = {
  tenantId: string;
  channelId: string;
  phone: string;
  contactName?: string;
  providerMsgId: string;
  kind: "text" | "interactive" | "image" | "audio" | "location" | "document" | "unsupported";
  body: string | null;
  media?: { id: string; mime: string };
  meta: Record<string, unknown>;
  sentAt: string;
};

const StoreResult = z.array(z.object({ conversation_id: z.string(), message_id: z.string(), inserted: z.boolean() })).min(1);

/** Contact, open conversation and message in one transaction. `inserted` is false for a replay. */
export async function storeInboundMessage(args: StoreInboundArgs): Promise<{ conversationId: string; messageId: string; inserted: boolean }> {
  const { data, error } = await supabaseAdmin().rpc("store_inbound_message", {
    p_tenant_id: args.tenantId,
    p_channel_id: args.channelId,
    p_phone: args.phone,
    p_name: args.contactName ?? null,
    p_provider_msg_id: args.providerMsgId,
    p_kind: args.kind,
    p_body: args.body,
    p_media: args.media ?? null,
    p_meta: args.meta,
    p_sent_at: args.sentAt,
  });
  if (error) throw new WebhookDbError("store_inbound_message", error.code);
  const row = StoreResult.parse(data)[0];
  return { conversationId: row.conversation_id, messageId: row.message_id, inserted: row.inserted };
}

/** A delivery status for one business's outbound message. True when a row changed. */
export async function applyMessageStatus(args: { tenantId: string; providerMsgId: string; status: string }): Promise<boolean> {
  const { data, error } = await supabaseAdmin().rpc("apply_message_status", {
    p_tenant_id: args.tenantId,
    p_provider_msg_id: args.providerMsgId,
    p_status: args.status,
  });
  if (error) throw new WebhookDbError("apply_message_status", error.code);
  return z.boolean().parse(data);
}

/** The connections of these WhatsApp business accounts (template and quality events name only the account). Reads no secret columns. */
export async function findConnectionsByWaba(wabaIds: string[]): Promise<ConnectionRow[]> {
  if (wabaIds.length === 0) return [];
  const { data, error } = await supabaseAdmin()
    .from("whatsapp_connections")
    .select("id, tenant_id, channel_id, phone_number_id, waba_id, method, status")
    .in("waba_id", wabaIds);
  if (error) throw new WebhookDbError("connection lookup by account", error.code);
  return ConnectionRows.parse(data).map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    channelId: r.channel_id,
    phoneNumberId: r.phone_number_id,
    wabaId: r.waba_id,
    method: r.method,
    status: r.status,
  }));
}

/** Whether this business has a template with Meta's id. set_template_status is not tenant-scoped, so this is asked first. */
export async function templateBelongsToTenant(tenantId: string, metaTemplateId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin().from("whatsapp_templates").select("id").eq("tenant_id", tenantId).eq("meta_template_id", metaTemplateId).limit(1);
  if (error) throw new WebhookDbError("template lookup", error.code);
  return Array.isArray(data) && data.length > 0;
}

/** Dev 2's set_template_status (0007): the webhook never writes the table itself. False: a status it does not know, or no such template. */
export async function setTemplateStatus(args: { metaTemplateId: string; event: string; reason?: string }): Promise<boolean> {
  const { data, error } = await supabaseAdmin().rpc("set_template_status", { p_meta_template_id: args.metaTemplateId, p_status: args.event, p_reason: args.reason ?? null });
  if (error) throw new WebhookDbError("set_template_status", error.code);
  return z.boolean().parse(data);
}

/** The number's messaging limit and quality rating as Meta last reported them, for this business's connection only. */
export async function updateConnectionHealth(args: { tenantId: string; connectionId: string; messagingLimit?: string; qualityRating?: string }): Promise<void> {
  const patch: Record<string, string> = {};
  if (args.messagingLimit !== undefined) patch.messaging_limit = args.messagingLimit;
  if (args.qualityRating !== undefined) patch.quality_rating = args.qualityRating;
  if (Object.keys(patch).length === 0) return;
  const { error } = await supabaseAdmin().from("whatsapp_connections").update(patch).eq("id", args.connectionId).eq("tenant_id", args.tenantId);
  if (error) throw new WebhookDbError("connection health update", error.code);
}

/**
 * App secrets of the manual_byo connections for these phone number ids, decrypted, to check a webhook signature
 * made with a client's own Meta app. A row that cannot be decrypted is skipped (it can never verify). The ids come
 * from a body that is not verified yet, so they only choose which secrets to try; nothing else is read from it.
 */
/** The decrypted app secrets of the manual_byo connections for these numbers; `skipped` counts rows whose saved secret could not be read (only counted, for the refusal log). */
export type ByoSecrets = { connectionId: string; secret: string }[] & { skipped?: number };

export async function findByoSecrets(phoneNumberIds: string[]): Promise<ByoSecrets> {
  const ids = phoneNumberIds.slice(0, 20);
  if (ids.length === 0) return Object.assign([], { skipped: 0 });
  const { data, error } = await supabaseAdmin()
    .from("whatsapp_connections")
    .select("id, tenant_id, app_secret_enc")
    .eq("method", "manual_byo")
    .in("phone_number_id", ids);
  if (error) throw new WebhookDbError("secret lookup", error.code);
  const found: { connectionId: string; secret: string }[] = [];
  let skipped = 0;
  for (const row of data ?? []) {
    if (typeof row.app_secret_enc !== "string") {
      skipped++;
      continue;
    }
    try {
      const context = connectionSecretContext({ column: "app_secret_enc", tenantId: String(row.tenant_id), connectionId: String(row.id) });
      found.push({ connectionId: String(row.id), secret: decryptSecret(row.app_secret_enc, context) });
    } catch {
      // wrong key or tampered value: this connection cannot verify
      skipped++;
    }
  }
  return Object.assign(found, { skipped });
}
