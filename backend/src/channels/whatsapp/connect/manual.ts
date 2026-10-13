import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { ManualConnectInput, WhatsAppConnectionPublic } from "@pakka/types";
import { z } from "zod";
import { assertNumberAvailable, planLimitError } from "../../../billing/plan-limits";
import { connectionSecretContext, encryptSecret } from "../../../lib/crypto";
import { serverEnv } from "../../../lib/env";
import { writeAudit, type AuditEntry } from "../../../lib/audit";
import { AppError, zodFieldErrors } from "../../../lib/errors";
import { supabaseAdmin } from "../../../lib/supabase-admin";
import { graph as realGraph, isExpiredTokenAnswer, runGraphChecks, withTestMessage, withWebhookConfirmed, type Check, type Graph, type LastCheck, type NumberFacts } from "./checks";
import { checkTestMessage } from "./test-message-check";
import { webhookWasSeen } from "./webhook-seen";

// Manual connection (method `manual_byo`): a business that runs its own Meta app gives us the account id,
// the number's id, a token and the app secret (docs/whatsapp-connection-contract.md, "Admin: manual
// connection"). Order: validate the input, ask Meta whether the token reaches the number, then store the
// token and the app secret encrypted. The answer is the public connection shape only; the secrets are never
// echoed, logged or kept after the call. Meta's text is never passed on: the UI gets fixed messages.

const metaId = (message: string) => z.string().regex(/^\d{5,20}$/, message);
const secretText = (message: string, max: number) => z.string().min(8, message).max(max, message).regex(/^\S+$/, message);

/** `ManualConnectInput` with the shape rules Meta's identifiers and credentials follow. */
const StrictInput = ManualConnectInput.extend({
  wabaId: metaId("Enter the WhatsApp Business Account ID: digits only."),
  phoneNumberId: metaId("Enter the Phone number ID: digits only (not the phone number itself)."),
  token: secretText("Enter the access token without spaces.", 2048),
  appSecret: secretText("Enter the app secret without spaces.", 256),
});

// The six checks are in checks.ts (and the sixth in test-message-check.ts); the types are kept importable from here.
export type { Check, CheckKey, CheckStatus, LastCheck } from "./checks";

export type ConnectionRecord = {
  id: string;
  tenantId: string;
  channelId: string;
  wabaId: string;
  phoneNumberId: string;
  displayPhone: string | null;
  verifiedName: string | null;
  clientBusinessId: string | null;
  tokenEnc: string;
  tokenType: "business" | "system_user";
  /** The business's own app secret (manual_byo); null for a connection whose webhooks our own app signs. */
  appSecretEnc: string | null;
  status: "active" | "failed";
  lastCheck: LastCheck;
  qualityRating: string | null;
  connectedBy: string;
  /** Left out by a manual connection: `manual_byo`, and the columns keep their defaults. */
  method?: "manual_byo" | "embedded_signup" | "assisted";
  coexistence?: boolean;
  messagingLimit?: string | null;
  tokenExpiresAt?: Date | null;
};

export interface ManualConnectDb {
  tenantExists(tenantId: string): Promise<boolean>;
  findByPhoneNumberId(phoneNumberId: string): Promise<{ id: string; tenantId: string; channelId: string; method: string; status: string } | null>;
  channelIdFor(tenantId: string): Promise<string>;
  /** Writes the record (insert, or update when `replace` is true) and returns the public row. */
  save(record: ConnectionRecord, replace: boolean): Promise<unknown>;
  /** Replaces `last_check` of one connection of this business (the sixth check, once the number is active). */
  updateLastCheck(connectionId: string, tenantId: string, lastCheck: LastCheck): Promise<void>;
}

export type NumberInfo = { displayPhone: string | null; verifiedName: string | null; qualityRating: string | null; facts?: NumberFacts };
export type MetaProbe =
  | { state: "ok"; info: NumberInfo; numberInAccount: boolean }
  | { state: "rejected"; reason?: "token_expired" } // Meta answered, and the token or ids are not accepted; `token_expired` when Meta says the token itself has expired or is no longer valid
  | { state: "unreachable" }; // we could not get an answer

export type ManualConnectDeps = {
  db: ManualConnectDb;
  probe(args: { wabaId: string; phoneNumberId: string; token: string }): Promise<MetaProbe>;
  encrypt: typeof encryptSecret;
  now: () => Date;
  newId: () => string;
  /** Records who connected the number. Never given a secret. */
  audit: (entry: AuditEntry) => Promise<void>;
  /** Meta's Graph API, for the checks after the first read (checks.ts). */
  graph: Graph;
  /** Whether a signed webhook from this connection's own app has arrived (webhook-seen.ts). */
  webhookSeen: (tenantId: string, connectionId: string) => Promise<boolean>;
  /** The sixth check: a test message to the owner's number, through notify.send (test-message-check.ts). */
  testMessage: (tenantId: string, actor: string) => Promise<Check>;
  /**
   * The plan's WhatsApp numbers (Dev 2's billing/plan-limits.ts): throws plan_required when this number would go past
   * them. `keepConnectionId` is the row being connected again in place. Asked before Meta is; the database (0027) has
   * the last word.
   */
  numberLimit?: (tenantId: string, keepConnectionId: string | null) => Promise<void>;
};

const PLATFORM_APP_SECRET_MESSAGE = "This is Spark Agent's own Meta app, which our team connects, not this form. Enter the app secret of the business's own Meta app.";

/** Whether `secret` is the app secret of Spark Agent's own Meta app (`META_APP_SECRET`), compared in constant time. False when ours is not set. */
function isPlatformAppSecret(secret: string): boolean {
  const platform = serverEnv().META_APP_SECRET;
  if (!platform) return false;
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(secret), digest(platform));
}

/**
 * Asks the Graph API, with the client's token, whether the number is reachable and belongs to the account.
 * UNVERIFIED against a live Meta account: the two reads and their field names follow Meta's Cloud API
 * documentation as we understand it and must be confirmed with a real test number.
 */
export async function probeMeta(args: { wabaId: string; phoneNumberId: string; token: string }): Promise<MetaProbe> {
  const version = serverEnv().META_GRAPH_API_VERSION;
  const get = async (path: string) => {
    const res = await fetch(`https://graph.facebook.com/${version}/${path}`, {
      headers: { authorization: `Bearer ${args.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: res.ok, status: res.status, body: (await res.json().catch(() => null)) as unknown };
  };
  try {
    const number = await get(`${args.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,name_status,platform_type`);
    if (number.status >= 500 || number.status === 429) return { state: "unreachable" };
    if (!number.ok) return isExpiredTokenAnswer(number.status, number.body) ? { state: "rejected", reason: "token_expired" } : { state: "rejected" };
    const n = (number.body ?? {}) as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);

    const account = await get(`${args.wabaId}/phone_numbers?fields=id&limit=100`);
    if (account.status >= 500 || account.status === 429) return { state: "unreachable" };
    if (!account.ok && isExpiredTokenAnswer(account.status, account.body)) return { state: "rejected", reason: "token_expired" };
    const list = account.ok ? ((account.body as { data?: { id?: unknown }[] } | null)?.data ?? []) : [];
    return {
      state: "ok",
      info: {
        displayPhone: text(n.display_phone_number),
        verifiedName: text(n.verified_name),
        qualityRating: text(n.quality_rating),
        facts: { nameStatus: text(n.name_status), platformType: text(n.platform_type) },
      },
      numberInAccount: list.some((item) => String(item?.id) === args.phoneNumberId),
    };
  } catch {
    return { state: "unreachable" };
  }
}

/**
 * Connects (or reconnects) a business's own Meta app number. `actor` is the audit value for
 * `connected_by`: a user id, or `admin:<id>` from the platform route. `rawInput.tenantId` has already been
 * decided by the caller (the signed-in member's business, or the one an admin named), never by the browser.
 */
export async function connectManual(
  rawInput: unknown,
  actor: string,
  deps: ManualConnectDeps = {
    db: realDb(),
    probe: probeMeta,
    encrypt: encryptSecret,
    now: () => new Date(),
    newId: randomUUID,
    audit: writeAudit,
    graph: realGraph,
    webhookSeen: (tenantId, connectionId) => webhookWasSeen(supabaseAdmin(), tenantId, connectionId),
    testMessage: (tenantId, actor) => checkTestMessage(tenantId, actor),
    numberLimit: (tenantId, keepConnectionId) => assertNumberAvailable(tenantId, keepConnectionId),
  },
): Promise<WhatsAppConnectionPublic> {
  const parsed = StrictInput.safeParse(rawInput);
  if (!parsed.success) throw new AppError("validation_failed", "Some details need fixing.", zodFieldErrors(parsed.error));
  const input = parsed.data;

  // Spark Agent's own app is connected by the team, never here: its webhooks are signed with META_APP_SECRET, so a connection saved with that secret would have
  // every message dropped on purpose (inbound.ts trusts a manual_byo connection only on its own secret).
  if (isPlatformAppSecret(input.appSecret)) throw new AppError("validation_failed", "Some details need fixing.", { appSecret: PLATFORM_APP_SECRET_MESSAGE });

  if (!(await deps.db.tenantExists(input.tenantId))) throw new AppError("not_found", "We couldn't find that business.");

  // A number is connected to one business at a time. Our own failed, disconnected or pending row may be retried in place.
  const existing = await deps.db.findByPhoneNumberId(input.phoneNumberId);
  const retry = existing !== null && existing.method === "manual_byo" && existing.tenantId === input.tenantId && ["failed", "disconnected", "pending"].includes(existing.status);
  if (existing !== null && !retry) {
    throw new AppError("conflict", "This phone number is already connected.", { phoneNumberId: "This Phone number ID is already connected." });
  }
  await deps.numberLimit?.(input.tenantId, retry ? existing.id : null);

  const probe = await deps.probe({ wabaId: input.wabaId, phoneNumberId: input.phoneNumberId, token: input.token });
  if (probe.state === "unreachable") throw new AppError("upstream_failed", "We couldn't reach Meta to check these details. Try again in a moment.");

  const id = existing?.id ?? deps.newId();
  const info = probe.state === "ok" ? probe.info : { displayPhone: null, verifiedName: null, qualityRating: null };
  // Whether an app ends up subscribed to the account's webhooks (null: not asked). The webhook check subscribes ours when none is, best effort.
  let subscribed: boolean | null = null;
  let seenBefore: boolean | undefined; // what the proof read said while the checks ran
  // The five checks that need only Meta's answers. The sixth (a test message) waits until the number is saved as active.
  const lastCheck = await runGraphChecks(
    {
      wabaId: input.wabaId,
      token: input.token,
      method: "manual_byo",
      accepted: probe.state === "ok",
      tokenExpired: probe.state === "rejected" && probe.reason === "token_expired",
      onSubscribed: (value) => {
        subscribed = value;
      },
      inAccount: probe.state === "ok" && probe.numberInAccount,
      facts: { nameStatus: info.facts?.nameStatus ?? null, platformType: info.facts?.platformType ?? null },
      webhookSeen: async () => (seenBefore = await deps.webhookSeen(input.tenantId, id)),
    },
    deps.graph,
    deps.now(),
  );

  const record: ConnectionRecord = {
    id,
    tenantId: input.tenantId,
    channelId: existing?.channelId ?? (await deps.db.channelIdFor(input.tenantId)),
    wabaId: input.wabaId,
    phoneNumberId: input.phoneNumberId,
    displayPhone: info.displayPhone ?? input.displayPhone ?? null,
    verifiedName: info.verifiedName,
    clientBusinessId: input.clientBusinessId ?? null,
    tokenEnc: deps.encrypt(input.token, connectionSecretContext({ column: "token_enc", tenantId: input.tenantId, connectionId: id })),
    tokenType: input.tokenType,
    appSecretEnc: deps.encrypt(input.appSecret, connectionSecretContext({ column: "app_secret_enc", tenantId: input.tenantId, connectionId: id })),
    status: lastCheck.overall === "fail" ? "failed" : "active",
    lastCheck,
    qualityRating: info.qualityRating,
    connectedBy: actor,
  };
  const saved = WhatsAppConnectionPublic.safeParse(await deps.db.save(record, retry));
  if (!saved.success) throw new AppError("upstream_failed", "We couldn't save the connection. Try again in a moment.");

  // After the save, so the connection exists whatever happens here. A failed audit write is logged with a
  // fixed line (no values) and does not undo or fail the connect. The diff carries ids and the outcome only.
  try {
    await deps.audit({
      tenantId: saved.data.tenant_id,
      actor,
      action: "whatsapp_connection.connected",
      entity: "whatsapp_connection",
      entityId: saved.data.id,
      diff: { method: saved.data.method, status: saved.data.status, waba_id: saved.data.waba_id, phone_number_id: saved.data.phone_number_id, reconnected: retry, subscribed },
    });
  } catch {
    console.error("[whatsapp-connect] audit write failed");
  }

  // The sixth check, only for a number that is active (notify.send refuses any other). It never changes the status; a failure here keeps the connection as saved.
  if (saved.data.status !== "active") return saved.data;
  try {
    const sixth = withTestMessage(lastCheck, await deps.testMessage(saved.data.tenant_id, actor));
    // The test message can bring the first signed webhook of the business's own app; read the proof again so the result saved now does not undo what it cleared.
    const withSixth = seenBefore !== true && (await deps.webhookSeen(saved.data.tenant_id, saved.data.id)) ? withWebhookConfirmed(sixth, deps.now()) : sixth;
    await deps.db.updateLastCheck(saved.data.id, saved.data.tenant_id, withSixth);
    return { ...saved.data, last_check: withSixth };
  } catch {
    console.error("[whatsapp-connect] the test message check could not be recorded");
    return saved.data;
  }
}

const PUBLIC_COLUMNS =
  "id, tenant_id, method, waba_id, phone_number_id, display_phone, verified_name, coexistence, status, last_check, quality_rating, messaging_limit, created_at";

export function realDb(): ManualConnectDb {
  const db = supabaseAdmin();
  const fail = (what: string) => new AppError("upstream_failed", `We couldn't ${what}. Try again in a moment.`);
  return {
    async tenantExists(tenantId) {
      const { data, error } = await db.from("tenants").select("id").eq("id", tenantId).maybeSingle();
      if (error) throw fail("look up the business");
      return data !== null;
    },
    async findByPhoneNumberId(phoneNumberId) {
      const { data, error } = await db.from("whatsapp_connections").select("id, tenant_id, channel_id, method, status").eq("phone_number_id", phoneNumberId).maybeSingle();
      if (error) throw fail("check the number");
      return data ? { id: String(data.id), tenantId: String(data.tenant_id), channelId: String(data.channel_id), method: String(data.method), status: String(data.status) } : null;
    },
    async channelIdFor(tenantId) {
      const found = await db.from("channels").select("id").eq("tenant_id", tenantId).eq("type", "whatsapp").order("created_at", { ascending: true }).limit(1);
      if (found.error) throw fail("read the channel");
      if (found.data && found.data.length > 0) return String(found.data[0].id);
      const made = await db.from("channels").insert({ tenant_id: tenantId, type: "whatsapp", status: "active" }).select("id").single();
      if (made.error) throw fail("create the channel");
      return String(made.data.id);
    },
    async save(r, replace) {
      const columns = {
        channel_id: r.channelId,
        method: r.method ?? "manual_byo",
        waba_id: r.wabaId,
        phone_number_id: r.phoneNumberId,
        display_phone: r.displayPhone,
        verified_name: r.verifiedName,
        client_business_id: r.clientBusinessId,
        token_enc: r.tokenEnc,
        token_type: r.tokenType,
        app_secret_enc: r.appSecretEnc,
        status: r.status,
        last_check: r.lastCheck,
        quality_rating: r.qualityRating,
        connected_by: r.connectedBy,
        ...(r.coexistence === undefined ? {} : { coexistence: r.coexistence }),
        ...(r.messagingLimit === undefined ? {} : { messaging_limit: r.messagingLimit }),
        ...(r.tokenExpiresAt === undefined ? {} : { token_expires_at: r.tokenExpiresAt === null ? null : r.tokenExpiresAt.toISOString() }),
      };
      // Both writes are filtered by the business, so a retry can never touch another business's row.
      const { error } = replace
        ? await db.from("whatsapp_connections").update(columns).eq("id", r.id).eq("tenant_id", r.tenantId)
        : await db.from("whatsapp_connections").insert({ id: r.id, tenant_id: r.tenantId, ...columns });
      if (error) {
        // The number was connected by someone else between our check and this write.
        if (error.code === "23505") throw new AppError("conflict", "This phone number is already connected.");
        // Another number of this business was connected between the plan check and this write (0027).
        throw planLimitError(error) ?? fail("save the connection");
      }
      const row = await db.from("whatsapp_connections").select(PUBLIC_COLUMNS).eq("id", r.id).eq("tenant_id", r.tenantId).single();
      if (row.error) throw fail("read the connection");
      return row.data;
    },
    async updateLastCheck(connectionId, tenantId, lastCheck) {
      const { error } = await db.from("whatsapp_connections").update({ last_check: lastCheck }).eq("id", connectionId).eq("tenant_id", tenantId);
      if (error) throw fail("save the check");
    },
  };
}
