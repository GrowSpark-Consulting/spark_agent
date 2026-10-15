import { z } from "zod";

// Outbound webhooks (Pro; migration 0050, backend/src/outbound-webhooks): the business's CRM or sheet hears about new and
// qualified leads, confirmed and cancelled bookings, and handoffs. Owner or admin.
//   GET    /api/integrations/webhook               → WebhookSettings
//   PUT    /api/integrations/webhook               SaveWebhookEndpoint → WebhookEndpointSaved (the secret only when created)
//   POST   /api/integrations/webhook/rotate-secret → WebhookSecret (the old secret stops working at once)
//   POST   /api/integrations/webhook/test          → WebhookTestResult (a signed `ping` now)
//   DELETE /api/integrations/webhook               → 204

export const WEBHOOK_EVENTS = ["lead.created", "lead.qualified", "booking.confirmed", "booking.cancelled", "handoff.opened"] as const;
export const WebhookEvent = z.enum(WEBHOOK_EVENTS);
export type WebhookEvent = z.infer<typeof WebhookEvent>;

export const SaveWebhookEndpoint = z.object({
  /** https only, on port 443 or 8443, at most 500 characters; an address on a private network is refused. */
  url: z.string().trim().min(1).max(500),
  events: z.array(WebhookEvent).min(1),
});
export type SaveWebhookEndpoint = z.infer<typeof SaveWebhookEndpoint>;

export const WebhookEndpoint = z.object({
  url: z.string(),
  events: z.array(WebhookEvent),
  /** The secret's last 4 characters, to tell which one the receiver has. */
  secretHint: z.string(),
  active: z.boolean(),
  createdAt: z.string(),
  lastSuccessAt: z.string().nullable(),
  lastFailureAt: z.string().nullable(),
  /** Why the last delivery failed: http_<status>, timeout, refused_address, connection_failed. */
  lastFailure: z.string().nullable(),
});
export type WebhookEndpoint = z.infer<typeof WebhookEndpoint>;

export const WebhookSettings = z.object({
  /** The plan includes outbound webhooks (Pro). Without it, saving is refused (plan_required). */
  inPlan: z.boolean(),
  /** Events are sent only while the Outbound webhooks switch is on (Features) and the business is live. */
  sending: z.boolean(),
  endpoint: WebhookEndpoint.nullable(),
});
export type WebhookSettings = z.infer<typeof WebhookSettings>;

export const WebhookEndpointSaved = z.object({
  endpoint: WebhookEndpoint,
  /** Shown once, when the endpoint is created: the receiver checks every request with it. null on a change. */
  secret: z.string().nullable(),
});
export type WebhookEndpointSaved = z.infer<typeof WebhookEndpointSaved>;

export const WebhookSecret = z.object({ secret: z.string(), secretHint: z.string() });
export type WebhookSecret = z.infer<typeof WebhookSecret>;

export const WebhookTestResult = z.object({
  delivered: z.boolean(),
  /** The receiver's HTTP status, when it answered. */
  status: z.number().int().nullable(),
  /** Why it was not delivered (as WebhookEndpoint.lastFailure). */
  error: z.string().nullable(),
});
export type WebhookTestResult = z.infer<typeof WebhookTestResult>;
