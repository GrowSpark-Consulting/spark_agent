import {
  SaveWebhookEndpoint,
  WEBHOOK_EVENTS,
  type TenantContext,
  type WebhookEndpoint,
  type WebhookEndpointSaved,
  type WebhookSecret,
  type WebhookSettings,
  type WebhookTestResult,
} from "@pakka/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getFeatureStates } from "../features/is-enabled";
import { decryptSecret, encryptSecret, webhookEndpointSecretContext } from "../lib/crypto";
import type { ServerEnv } from "../lib/env";
import { AppError, zodFieldErrors } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase-admin";
import { requireRole } from "../lib/tenant";
import { failureOf, sendSigned } from "./deliver";
import { newSigningSecret, secretHint } from "./signing";
import { checkWebhookUrl, makePost, type Post } from "./transport";

// The business's webhook endpoint (Pro), from the dashboard. Owner or admin. The routes and their shapes are in
// packages/types/src/integrations.ts; saving, rotating and deleting each write their audit row in the same transaction
// (0050). The secret is shown once, when it is made, and is otherwise only ever decrypted to sign.

export interface EndpointDeps {
  db: SupabaseClient;
  post: Post;
  features: (tenantId: string) => Promise<{ key: string; inPlan: boolean; enabled: boolean }[]>;
  now: () => Date;
  env?: Pick<ServerEnv, "ENCRYPTION_KEY">;
}

const defaults = (): EndpointDeps => ({
  db: supabaseAdmin(),
  post: makePost(),
  features: (tenantId) => getFeatureStates(tenantId, { fresh: true }),
  now: () => new Date(),
});

const ACTION = "manage webhooks";
const NONE = "There is no webhook set up yet.";
const NOT_IN_PLAN = "Outbound webhooks needs the Pro plan.";

const Row = z.object({
  url: z.string(),
  events: z.array(z.enum(WEBHOOK_EVENTS)),
  secret_enc: z.string(),
  secret_hint: z.string(),
  active: z.boolean(),
  created_at: z.string(),
  last_success_at: z.string().nullable(),
  last_failure_at: z.string().nullable(),
  last_failure: z.string().nullable(),
});
type Row = z.infer<typeof Row>;

const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);
const toEndpoint = (r: Row): WebhookEndpoint => ({
  url: r.url,
  events: r.events,
  secretHint: r.secret_hint,
  active: r.active,
  createdAt: new Date(r.created_at).toISOString(),
  lastSuccessAt: iso(r.last_success_at),
  lastFailureAt: iso(r.last_failure_at),
  lastFailure: r.last_failure,
});

async function readRow(db: SupabaseClient, tenantId: string): Promise<Row | null> {
  const { data, error } = await db
    .from("webhook_endpoints")
    .select("url, events, secret_enc, secret_hint, active, created_at, last_success_at, last_failure_at, last_failure")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) throw new Error(`webhook_endpoints read failed: ${error.message}`);
  return data ? Row.parse(data) : null;
}

async function state(deps: EndpointDeps, tenantId: string): Promise<{ inPlan: boolean; enabled: boolean }> {
  const feature = (await deps.features(tenantId)).find((f) => f.key === "outbound_webhooks");
  return { inPlan: feature?.inPlan ?? false, enabled: feature?.enabled ?? false };
}

export async function getWebhookSettings(context: TenantContext, deps: EndpointDeps = defaults()): Promise<WebhookSettings> {
  requireRole(context, ["owner", "admin"], ACTION);
  const [{ inPlan, enabled }, row] = await Promise.all([state(deps, context.tenant.id), readRow(deps.db, context.tenant.id)]);
  return { inPlan, sending: enabled && (row?.active ?? false), endpoint: row ? toEndpoint(row) : null };
}

export async function saveWebhookEndpoint(context: TenantContext, body: unknown, deps: EndpointDeps = defaults()): Promise<WebhookEndpointSaved> {
  requireRole(context, ["owner", "admin"], ACTION);
  const parsed = SaveWebhookEndpoint.safeParse(body);
  if (!parsed.success) throw new AppError("validation_failed", "Check the highlighted fields and try again.", zodFieldErrors(parsed.error));
  const urlProblem = checkWebhookUrl(parsed.data.url);
  if (urlProblem) throw new AppError("validation_failed", "Check the highlighted fields and try again.", { url: urlProblem });
  if (!(await state(deps, context.tenant.id)).inPlan) throw new AppError("plan_required", NOT_IN_PLAN);

  const tenantId = context.tenant.id;
  const secret = newSigningSecret();
  const { data, error } = await deps.db.rpc("save_webhook_endpoint", {
    p_tenant_id: tenantId,
    p_url: parsed.data.url,
    p_events: WEBHOOK_EVENTS.filter((e) => parsed.data.events.includes(e)),
    p_secret_enc: encryptSecret(secret, webhookEndpointSecretContext(tenantId), deps.env),
    p_secret_hint: secretHint(secret),
    p_actor: context.user.id,
  });
  if (error) throw new Error(`save_webhook_endpoint failed: ${error.message}`);
  const [{ created }] = z.array(z.object({ created: z.boolean() })).length(1).parse(data);
  const row = await readRow(deps.db, tenantId);
  if (!row) throw new Error("save_webhook_endpoint: the endpoint is missing after saving");
  return { endpoint: toEndpoint(row), secret: created ? secret : null };
}

export async function rotateWebhookSecret(context: TenantContext, deps: EndpointDeps = defaults()): Promise<WebhookSecret> {
  requireRole(context, ["owner", "admin"], ACTION);
  const tenantId = context.tenant.id;
  const secret = newSigningSecret();
  const { data, error } = await deps.db.rpc("rotate_webhook_secret", {
    p_tenant_id: tenantId,
    p_secret_enc: encryptSecret(secret, webhookEndpointSecretContext(tenantId), deps.env),
    p_secret_hint: secretHint(secret),
    p_actor: context.user.id,
  });
  if (error) throw new Error(`rotate_webhook_secret failed: ${error.message}`);
  if (data !== true) throw new AppError("not_found", NONE);
  return { secret, secretHint: secretHint(secret) };
}

/** Removes the endpoint and anything still queued for it. Nothing there is not an error. */
export async function deleteWebhookEndpoint(context: TenantContext, deps: EndpointDeps = defaults()): Promise<void> {
  requireRole(context, ["owner", "admin"], ACTION);
  const { error } = await deps.db.rpc("delete_webhook_endpoint", { p_tenant_id: context.tenant.id, p_actor: context.user.id });
  if (error) throw new Error(`delete_webhook_endpoint failed: ${error.message}`);
}

/** A signed `ping` to the saved endpoint, now: whether the receiver accepts our requests. Changes nothing. */
export async function testWebhook(context: TenantContext, deps: EndpointDeps = defaults()): Promise<WebhookTestResult> {
  requireRole(context, ["owner", "admin"], ACTION);
  const tenantId = context.tenant.id;
  if (!(await state(deps, tenantId)).inPlan) throw new AppError("plan_required", NOT_IN_PLAN);
  const row = await readRow(deps.db, tenantId);
  if (!row) throw new AppError("not_found", NONE);
  const secret = decryptSecret(row.secret_enc, webhookEndpointSecretContext(tenantId), deps.env);
  const now = deps.now();
  const result = await sendSigned(deps.post, row.url, secret, { id: crypto.randomUUID(), type: "ping", occurredAt: now.toISOString(), businessId: tenantId, data: {} }, now);
  const failure = failureOf(result);
  return { delivered: failure === null, status: "status" in result ? result.status : null, error: failure };
}
