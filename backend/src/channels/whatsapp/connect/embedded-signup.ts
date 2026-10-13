import { randomUUID } from "node:crypto";
import { WhatsAppConnectionPublic, type TenantContext } from "@pakka/types";
import { z } from "zod";
import { assertNumberAvailable } from "../../../billing/plan-limits";
import { inngest } from "../../../inngest/client";
import { writeAudit, type AuditEntry } from "../../../lib/audit";
import { connectionSecretContext, encryptSecret } from "../../../lib/crypto";
import { serverEnv } from "../../../lib/env";
import { AppError, zodFieldErrors } from "../../../lib/errors";
import { supabaseAdmin } from "../../../lib/supabase-admin";
import { requireRole } from "../../../lib/tenant";
import { sendConnectedEvent, type SendConnectedEvent } from "./connected-event";
import { graph as realGraph, SAFE, subscribeApp, withCheck, withTestMessage, type Check, type Graph } from "./checks";
import { readMessagingLimit } from "./health";
import { probeMeta, realDb, type ConnectionRecord, type ManualConnectDb, type MetaProbe } from "./manual";
import { runConnectionChecks } from "./run-checks";
import { checkTestMessage } from "./test-message-check";
import { webhookWasSeen } from "./webhook-seen";

// POST /api/onboarding/whatsapp/embedded-signup (docs/whatsapp-connection-contract.md, "Embedded Signup exchange"). The browser has run Meta's popup
// and sends the one-time `code` with the ids of the account and number the client picked. Order: flag, role, input, the plan's number limit, then Meta:
// exchange the code for a business token, subscribe our app to the account, register the number (not a coexistence one), read it, run the same checks as a
// manual connection, save the token encrypted, and send `whatsapp/connected`. The answer is the public connection shape; the code, the token and our app
// secret are never returned, logged or put in an audit row. Our own app signs this connection's webhooks (META_APP_SECRET), so no app secret is stored.
//
// Behind EMBEDDED_SIGNUP_ENABLED (off until Meta approves the app): off, the route answers not_available before it reads anything.
// UNVERIFIED against a live Meta account: the exchange, `subscribed_apps` and `register` follow Meta's Embedded Signup pages (checked 13 Oct 2026, API
// version pinned by META_GRAPH_API_VERSION), but nothing here has run against Meta. Open points, all UNVERIFIED: that `redirect_uri` is not needed on the
// exchange (Meta's examples send none), whether a code can be used twice (it lives about 30 seconds), how long the token lives, and what `register` does
// for a coexistence number (we do not call it).

const metaId = (message: string) => z.string({ error: message }).regex(/^\d{5,20}$/, message);

/** Other keys (a `tenantId`, a `connectToken`) are dropped here: the business is the caller's or the link's (connect-link.ts), never the body's. */
const Body = z
  .object({
    code: z.string().min(1, "The Facebook sign-in did not give a code.").max(2048, "The Facebook sign-in did not give a code.").regex(/^\S+$/, "The Facebook sign-in did not give a code."),
    wabaId: metaId("The WhatsApp Business Account ID is missing or not digits."),
    phoneNumberId: metaId("Pick or add a phone number in the Facebook sign-in, then try again."),
    coexistence: z.boolean(),
  });

const NOT_AVAILABLE = "Connecting WhatsApp with Facebook isn't available yet. Ask us to connect your number instead.";
const CODE_FAILED = "Facebook didn't accept that sign-in. It may have expired or been used already. Start the Facebook sign-in again.";
const UNREACHABLE = "We couldn't reach Meta to finish connecting. Start the Facebook sign-in again in a moment.";

export type EmbeddedSignupConfig = { enabled: boolean; appId?: string | undefined; appSecret?: string | undefined; registerPin?: string | undefined };
export type ExchangeResult = { state: "ok"; token: string } | { state: "rejected" } | { state: "unreachable" };

export interface EmbeddedSignupDeps {
  config: () => EmbeddedSignupConfig;
  db: ManualConnectDb;
  /** The one-time code for a business token (`exchangeCode`). */
  exchange: (code: string) => Promise<ExchangeResult>;
  graph: Graph;
  probe: (args: { wabaId: string; phoneNumberId: string; token: string }) => Promise<MetaProbe>;
  messagingLimit: (args: { phoneNumberId: string; token: string }) => Promise<string | null>;
  webhookSeen: (tenantId: string, connectionId: string) => Promise<boolean>;
  /** The sixth check: a test message to the owner's number, through notify.send (test-message-check.ts). */
  testMessage: (tenantId: string, actor: string) => Promise<Check>;
  encrypt: typeof encryptSecret;
  now: () => Date;
  newId: () => string;
  audit: (entry: AuditEntry) => Promise<void>;
  /** The plan's WhatsApp numbers (billing/plan-limits.ts); asked before Meta is. */
  numberLimit?: ((tenantId: string, keepConnectionId: string | null) => Promise<void>) | undefined;
  sendEvent: SendConnectedEvent;
}

/**
 * Exchanges the code Embedded Signup gave the browser for the client's business token: `GET /oauth/access_token` with our app id, our app secret and the code.
 * UNVERIFIED against a live Meta account. Meta's page shows the answer as the token alone; a JSON `{ access_token }` is read too. Never logs, and no error
 * carries the URL (it holds our app secret).
 */
export async function exchangeCode(code: string, config: { appId: string; appSecret: string }, fetchFn: typeof fetch = fetch): Promise<ExchangeResult> {
  try {
    const query = new URLSearchParams({ client_id: config.appId, client_secret: config.appSecret, code });
    const res = await fetchFn(`https://graph.facebook.com/${serverEnv().META_GRAPH_API_VERSION}/oauth/access_token?${query.toString()}`, { method: "GET", signal: AbortSignal.timeout(10_000) });
    if (res.status >= 500 || res.status === 429) return { state: "unreachable" };
    if (!res.ok) return { state: "rejected" };
    const text = (await res.text()).trim();
    let token: unknown = text;
    try {
      token = (JSON.parse(text) as { access_token?: unknown } | null)?.access_token;
    } catch {
      // not JSON: the page shows the bare token
    }
    return typeof token === "string" && /^[A-Za-z0-9_\-.]{10,2048}$/.test(token) ? { state: "ok", token } : { state: "rejected" };
  } catch {
    return { state: "unreachable" };
  }
}

/** The flag and our app's credentials, from the environment. Reads nothing else. */
export const embeddedSignupConfig = (): EmbeddedSignupConfig => {
  const env = serverEnv();
  return { enabled: env.EMBEDDED_SIGNUP_ENABLED, appId: env.NEXT_PUBLIC_META_APP_ID, appSecret: env.META_APP_SECRET, registerPin: env.WHATSAPP_REGISTER_PIN };
};

export const embeddedSignupDefaults = (): EmbeddedSignupDeps => {
  const env = serverEnv();
  return {
    config: embeddedSignupConfig,
    db: realDb(),
    exchange: (code) => exchangeCode(code, { appId: env.NEXT_PUBLIC_META_APP_ID ?? "", appSecret: env.META_APP_SECRET ?? "" }),
    graph: realGraph,
    probe: probeMeta,
    messagingLimit: (args) => readMessagingLimit(args),
    webhookSeen: (tenantId, connectionId) => webhookWasSeen(supabaseAdmin(), tenantId, connectionId),
    testMessage: (tenantId, actor) => checkTestMessage(tenantId, actor),
    encrypt: encryptSecret,
    now: () => new Date(),
    newId: randomUUID,
    audit: writeAudit,
    numberLimit: (tenantId, keepConnectionId) => assertNumberAvailable(tenantId, keepConnectionId),
    sendEvent: (event) => inngest.send(event),
  };
};

export type SignupInput = z.infer<typeof Body>;

/** The flag is on and our app id and secret are set; otherwise not_available. Reads no database and calls no one. */
export function assertEmbeddedSignupAvailable(config: EmbeddedSignupConfig): void {
  if (!config.enabled || !config.appId || !config.appSecret) throw new AppError("not_available", NOT_AVAILABLE);
}

/** The body the browser sends after Meta's popup, or validation_failed with the fields. */
export function parseSignupBody(rawBody: unknown): SignupInput {
  const parsed = Body.safeParse(rawBody);
  if (!parsed.success) throw new AppError("validation_failed", "Some details need fixing.", zodFieldErrors(parsed.error));
  return parsed.data;
}

/** Connects (or reconnects) a business's number through Embedded Signup. The business is the caller's own, never the body's. */
export async function connectEmbeddedSignup(context: TenantContext, rawBody: unknown, deps?: EmbeddedSignupDeps): Promise<WhatsAppConnectionPublic> {
  // The flag is read from the environment alone; the database client is only made once the flag, the role and the body are settled.
  assertEmbeddedSignupAvailable(deps ? deps.config() : embeddedSignupConfig());
  requireRole(context, ["owner", "admin"], "connect WhatsApp");
  const input = parseSignupBody(rawBody);
  return connectNumber({ tenantId: context.tenant.id, actor: context.user.id, method: "embedded_signup" }, input, deps ?? embeddedSignupDefaults());
}

/** Who the number is connected for: the signed-in member's business, or the business an assisted link names (connect-link.ts). */
export type SignupCaller = { tenantId: string; actor: string; method: "embedded_signup" | "assisted" };

/** The flow after the flag, the caller and the body are settled. Also used by the assisted link. */
export async function connectNumber(caller: SignupCaller, input: SignupInput, deps: EmbeddedSignupDeps): Promise<WhatsAppConnectionPublic> {
  const config = deps.config();
  const { tenantId, actor } = caller;

  // A number is connected to one business at a time. Our own failed, disconnected or pending row (by either method) may be retried in place; an active one is a
  // repeat, and does not spend a second code.
  const existing = await deps.db.findByPhoneNumberId(input.phoneNumberId);
  const retry = existing !== null && existing.tenantId === tenantId && ["failed", "disconnected", "pending"].includes(existing.status);
  if (existing !== null && !retry) throw new AppError("conflict", "This phone number is already connected.", { phoneNumberId: "This phone number is already connected." });
  await deps.numberLimit?.(tenantId, retry ? existing.id : null);

  const exchanged = await deps.exchange(input.code);
  if (exchanged.state === "unreachable") throw new AppError("upstream_failed", UNREACHABLE);
  if (exchanged.state === "rejected") throw new AppError("upstream_failed", CODE_FAILED);
  const token = exchanged.token;

  // Both best effort: a refusal shows up in the checks (no app subscribed, number not registered), never stops the connection.
  const subscribedByUs = await subscribeApp({ wabaId: input.wabaId, token }, deps.graph);
  let registered = false;
  if (!input.coexistence && config.registerPin) {
    try {
      const answer = await deps.graph("POST", `${input.phoneNumberId}/register`, token, { messaging_product: "whatsapp", pin: config.registerPin });
      registered = answer.state === "answered" && answer.ok;
    } catch {
      registered = false;
    }
  }

  const id = existing?.id ?? deps.newId();
  const run = await runConnectionChecks(
    { tenantId, connectionId: id, method: caller.method, wabaId: input.wabaId, phoneNumberId: input.phoneNumberId, token },
    { probe: deps.probe, graph: deps.graph, webhookSeen: deps.webhookSeen, now: deps.now },
  );
  if (run.state === "unreachable") throw new AppError("upstream_failed", UNREACHABLE);
  // A token that cannot read this number (not expired: that is saved failed, below) or a number that is not in this account was not chosen in this sign-in. Nothing is saved:
  // a failed row would hold the number id against the business that really owns it.
  if ((run.probe.state === "rejected" && run.probe.reason !== "token_expired") || (run.probe.state === "ok" && !run.probe.numberInAccount)) {
    throw new AppError("validation_failed", "Some details need fixing.", { phoneNumberId: "That phone number is not in the WhatsApp account you signed in with. Start the Facebook sign-in again and pick your number." });
  }
  // Another app (a BSP the number is leaving) may be the one subscribed. When our own subscription did not go through we cannot say it is ours: a warning, never a pass.
  const lastCheck = subscribedByUs || run.lastCheck.checks.find((c) => c.key === "webhook_subscribed")?.status !== "pass"
    ? run.lastCheck
    : withCheck(run.lastCheck, { key: "webhook_subscribed", status: "warn", message: SAFE.webhookCouldNotSubscribe, checked_at: run.lastCheck.ran_at });

  const info = run.probe.state === "ok" ? run.probe.info : { displayPhone: null, verifiedName: null, qualityRating: null };
  const messagingLimit = run.probe.state === "ok" ? await deps.messagingLimit({ phoneNumberId: input.phoneNumberId, token }).catch(() => null) : null;

  const record: ConnectionRecord = {
    id,
    tenantId,
    channelId: existing?.channelId ?? (await deps.db.channelIdFor(tenantId)),
    wabaId: input.wabaId,
    phoneNumberId: input.phoneNumberId,
    displayPhone: info.displayPhone,
    verifiedName: info.verifiedName,
    clientBusinessId: null,
    tokenEnc: deps.encrypt(token, connectionSecretContext({ column: "token_enc", tenantId, connectionId: id })),
    tokenType: "business",
    appSecretEnc: null,
    status: lastCheck.overall === "fail" ? "failed" : "active",
    lastCheck,
    qualityRating: info.qualityRating,
    connectedBy: actor,
    method: caller.method,
    coexistence: input.coexistence,
    messagingLimit,
    tokenExpiresAt: run.tokenExpiresAt ?? null, // unknown clears an expiry kept from the token this one replaces
  };
  const saved = WhatsAppConnectionPublic.safeParse(await deps.db.save(record, retry));
  if (!saved.success) throw new AppError("upstream_failed", "We couldn't save the connection. Try again in a moment.");

  // After the save, so the connection exists whatever happens here. The diff carries ids and outcomes only.
  try {
    await deps.audit({
      tenantId: saved.data.tenant_id,
      actor,
      action: "whatsapp_connection.connected",
      entity: "whatsapp_connection",
      entityId: saved.data.id,
      diff: {
        method: saved.data.method,
        status: saved.data.status,
        waba_id: saved.data.waba_id,
        phone_number_id: saved.data.phone_number_id,
        reconnected: retry,
        coexistence: input.coexistence,
        subscribed: subscribedByUs ? true : run.subscribed === null ? null : false,
        registered,
      },
    });
  } catch {
    console.error("[whatsapp-connect] audit write failed");
  }
  if (saved.data.status !== "active") return saved.data;

  // `whatsapp/connected` (connected-event.ts): ids only, best effort.
  await sendConnectedEvent(deps.sendEvent, saved.data, lastCheck.ran_at);

  // The sixth check, only for an active number (notify.send refuses any other). It never changes the status.
  try {
    const withSixth = withTestMessage(lastCheck, await deps.testMessage(saved.data.tenant_id, actor));
    await deps.db.updateLastCheck(saved.data.id, saved.data.tenant_id, withSixth);
    return { ...saved.data, last_check: withSixth };
  } catch {
    console.error("[whatsapp-connect] the test message check could not be recorded");
    return saved.data;
  }
}
