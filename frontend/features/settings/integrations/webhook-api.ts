import {
  SaveWebhookEndpoint,
  WebhookEndpointSaved,
  WebhookSecret,
  WebhookSettings,
  WebhookTestResult,
} from "@pakka/types";
import { getJson, postJson, putJson, sendNoContent } from "@/lib/api/client";

// Outbound webhooks (docs/contracts.md, "Outbound webhooks"; shapes in packages/types/src/integrations.ts, built by Dev 2, migration 0050).
// Every answer is parsed with the shared schema before it is drawn; a body of another shape is an error, not a half-drawn screen. Owner or
// admin only: the server checks the role on every route, this file only asks. Nothing here logs or stores a secret: `secret` leaves this
// module once, in the value the caller receives, and the screen holds it in memory until the person dismisses it.
//   GET    /api/integrations/webhook               → WebhookSettings
//   PUT    /api/integrations/webhook               SaveWebhookEndpoint → WebhookEndpointSaved (secret only when created)
//   DELETE /api/integrations/webhook               → 204
//   POST   /api/integrations/webhook/rotate-secret → WebhookSecret
//   POST   /api/integrations/webhook/test          → WebhookTestResult

export class WebhookDataError extends Error {
  constructor(what: string) {
    super(`The ${what} answer had an unexpected shape.`);
    this.name = "WebhookDataError";
  }
}

export interface WebhookService {
  load: (tenantId: string, signal?: AbortSignal) => Promise<WebhookSettings>;
  save: (tenantId: string, input: SaveWebhookEndpoint) => Promise<WebhookEndpointSaved>;
  remove: (tenantId: string) => Promise<void>;
  rotate: (tenantId: string) => Promise<WebhookSecret>;
  test: (tenantId: string) => Promise<WebhookTestResult>;
}

function parse<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } }, what: string, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new WebhookDataError(what);
  return parsed.data;
}

const PATH = "/api/integrations/webhook" as const;

export const webhookService: WebhookService = {
  async load(tenantId, signal) {
    return parse(WebhookSettings, "webhook settings", await getJson<unknown>(PATH, { tenantId, signal }));
  },
  async save(tenantId, input) {
    // Checked here as well as on the server, so a malformed form never leaves the browser; the server's own checks (https, port, address) decide the rest.
    const body = SaveWebhookEndpoint.safeParse(input);
    if (!body.success) throw new WebhookDataError("webhook form");
    return parse(WebhookEndpointSaved, "webhook save", await putJson<unknown>(PATH, body.data, { tenantId }));
  },
  async remove(tenantId) {
    await sendNoContent(PATH, "DELETE", { tenantId });
  },
  async rotate(tenantId) {
    return parse(WebhookSecret, "secret rotation", await postJson<unknown>(`${PATH}/rotate-secret`, undefined, { tenantId }));
  },
  async test(tenantId) {
    return parse(WebhookTestResult, "webhook test", await postJson<unknown>(`${PATH}/test`, undefined, { tenantId }));
  },
};
