import type { WebhookEvent } from "@pakka/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { isEnabled } from "../features/is-enabled";
import { decryptSecret, webhookEndpointSecretContext } from "../lib/crypto";
import type { ServerEnv } from "../lib/env";
import { supabaseAdmin } from "../lib/supabase-admin";
import { SIGNATURE_HEADER, signatureHeader } from "./signing";
import { makePost, type Post, type PostResult } from "./transport";

// Sends what the outbox (0050) queued: the outbound-webhooks job claims due deliveries and hands each to deliverWebhook,
// which builds the body from the record as it is now, signs it with the business's secret and records what happened. A
// record that is gone (a customer's deletion request) or a business that may not send webhooks now (not Pro, switched
// off, paused) is dropped, never sent later. Delivery is at least once: a receiver dedupes on X-Pakka-Event-Id.

export interface DeliverDeps {
  db: SupabaseClient;
  post: Post;
  enabled: (tenantId: string) => Promise<boolean>;
  now: () => Date;
  env?: Pick<ServerEnv, "ENCRYPTION_KEY">;
}

export const deliverDeps = (): DeliverDeps => ({
  db: supabaseAdmin(),
  post: makePost(),
  enabled: (tenantId) => isEnabled(tenantId, "outbound_webhooks"),
  now: () => new Date(),
});

export const ClaimedDelivery = z.object({
  id: z.string(),
  tenant_id: z.string(),
  event: z.enum(["lead.created", "lead.qualified", "booking.confirmed", "booking.cancelled", "handoff.opened"]),
  entity_id: z.string(),
  occurred_at: z.string(),
  attempts: z.number().int(),
});
export type ClaimedDelivery = z.infer<typeof ClaimedDelivery>;

export const MAX_PER_RUN = 50;

/** Up to 50 due deliveries, held for this run for 5 minutes. */
export async function claimDeliveries(run: string, deps: Pick<DeliverDeps, "db"> = deliverDeps()): Promise<ClaimedDelivery[]> {
  const { data, error } = await deps.db.rpc("claim_webhook_deliveries", { p_run: run, p_limit: MAX_PER_RUN });
  if (error) throw new Error(`claim_webhook_deliveries failed: ${error.message}`);
  return z.array(ClaimedDelivery).parse(data ?? []);
}

type Contact = { id: string; name: string | null; phone: string };
const ContactRow = z.object({ id: z.string(), name: z.string().nullable(), phone: z.string() });
const one = <T extends z.ZodType>(schema: T) => z.union([schema, z.array(schema).length(1).transform((rows) => rows[0])]);

const LeadRow = z.object({
  id: z.string(),
  stage: z.string(),
  score: z.number().nullable(),
  temperature: z.string().nullable(),
  fields: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  contact: one(ContactRow),
});
const BookingRow = z.object({
  id: z.string(),
  status: z.string(),
  start_at: z.string(),
  end_at: z.string(),
  lead_id: z.string(),
  service: one(z.object({ name: z.string() })).nullable(),
  resource: one(z.object({ name: z.string() })),
  lead: one(z.object({ contact: one(ContactRow) })),
});
const HandoffRow = z.object({
  id: z.string(),
  trigger: z.string(),
  priority: z.string(),
  conversation_id: z.string(),
  conversation: one(z.object({ contact: one(ContactRow) })),
});

const iso = (value: string) => new Date(value).toISOString();
const contactOf = (c: Contact) => ({ id: c.id, name: c.name, phone: c.phone });

/** The event's `data`, from the record as it is now; null when the record is gone. */
export async function eventData(db: SupabaseClient, tenantId: string, event: WebhookEvent, entityId: string): Promise<Record<string, unknown> | null> {
  if (event === "lead.created" || event === "lead.qualified") {
    const { data, error } = await db
      .from("leads")
      .select("id, stage, score, temperature, fields, created_at, contact:contacts(id, name, phone)")
      .eq("tenant_id", tenantId)
      .eq("id", entityId)
      .maybeSingle();
    if (error) throw new Error(`webhook body: reading the lead failed: ${error.message}`);
    if (!data) return null;
    const lead = LeadRow.parse(data);
    return {
      lead: { id: lead.id, stage: lead.stage, score: lead.score, temperature: lead.temperature, fields: lead.fields, createdAt: iso(lead.created_at) },
      contact: contactOf(lead.contact),
    };
  }
  if (event === "booking.confirmed" || event === "booking.cancelled") {
    const { data, error } = await db
      .from("bookings")
      .select("id, status, start_at, end_at, lead_id, service:services(name), resource:resources(name), lead:leads(contact:contacts(id, name, phone))")
      .eq("tenant_id", tenantId)
      .eq("id", entityId)
      .maybeSingle();
    if (error) throw new Error(`webhook body: reading the booking failed: ${error.message}`);
    if (!data) return null;
    const booking = BookingRow.parse(data);
    return {
      booking: {
        id: booking.id,
        status: booking.status,
        startAt: iso(booking.start_at),
        endAt: iso(booking.end_at),
        service: booking.service?.name ?? null,
        resource: booking.resource.name,
        leadId: booking.lead_id,
      },
      contact: contactOf(booking.lead.contact),
    };
  }
  const { data, error } = await db
    .from("handoffs")
    .select("id, trigger, priority, conversation_id, conversation:conversations(contact:contacts(id, name, phone))")
    .eq("tenant_id", tenantId)
    .eq("id", entityId)
    .maybeSingle();
  if (error) throw new Error(`webhook body: reading the handoff failed: ${error.message}`);
  if (!data) return null;
  const handoff = HandoffRow.parse(data);
  return {
    handoff: { id: handoff.id, reason: handoff.trigger, priority: handoff.priority, conversationId: handoff.conversation_id },
    contact: contactOf(handoff.conversation.contact),
  };
}

/** Signs and POSTs one event body. */
export function sendSigned(post: Post, url: string, secret: string, body: Record<string, unknown> & { id: string; type: string }, now: Date): Promise<PostResult> {
  const raw = JSON.stringify(body);
  return post(url, raw, {
    [SIGNATURE_HEADER]: signatureHeader(secret, raw, Math.floor(now.getTime() / 1000)),
    "x-pakka-event": body.type,
    "x-pakka-event-id": body.id,
  });
}

export const failureOf = (result: PostResult): string | null =>
  "error" in result ? result.error : result.status >= 200 && result.status < 300 ? null : `http_${result.status}`;

const Endpoint = z.object({ url: z.string(), secret_enc: z.string(), active: z.boolean() });

/** Delivers one claimed event and records it. Returns its new status (null when this run no longer held it). */
export async function deliverWebhook(delivery: ClaimedDelivery, run: string, deps: DeliverDeps = deliverDeps()): Promise<string | null> {
  const record = async (outcome: "delivered" | "failed" | "dropped", status: number | null, reason: string | null) => {
    const { data, error } = await deps.db.rpc("record_webhook_attempt", { p_id: delivery.id, p_run: run, p_outcome: outcome, p_status: status, p_error: reason });
    if (error) throw new Error(`record_webhook_attempt failed: ${error.message}`);
    return z.string().nullable().parse(data);
  };

  if (!(await deps.enabled(delivery.tenant_id))) return record("dropped", null, "not_enabled");
  const { data: row, error } = await deps.db.from("webhook_endpoints").select("url, secret_enc, active").eq("tenant_id", delivery.tenant_id).maybeSingle();
  if (error) throw new Error(`webhook: reading the endpoint failed: ${error.message}`);
  const endpoint = row ? Endpoint.parse(row) : null;
  if (!endpoint?.active) return record("dropped", null, "endpoint_off");
  const data = await eventData(deps.db, delivery.tenant_id, delivery.event, delivery.entity_id);
  if (!data) return record("dropped", null, "gone");

  const secret = decryptSecret(endpoint.secret_enc, webhookEndpointSecretContext(delivery.tenant_id), deps.env);
  const body = { id: delivery.id, type: delivery.event, occurredAt: iso(delivery.occurred_at), businessId: delivery.tenant_id, data };
  const result = await sendSigned(deps.post, endpoint.url, secret, body, deps.now());
  const failure = failureOf(result);
  if (failure === null) return record("delivered", "status" in result ? result.status : null, null);
  console.error(`[webhooks] ${delivery.event} ${delivery.id} for ${delivery.tenant_id} was not delivered: ${failure} (attempt ${delivery.attempts + 1})`);
  return record("failed", "status" in result ? result.status : null, failure);
}
