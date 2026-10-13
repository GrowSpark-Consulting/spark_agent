import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { writeAudit, type AuditEntry } from "../../../lib/audit";
import { connectionSecretContext, decryptSecret } from "../../../lib/crypto";
import { supabaseAdmin } from "../../../lib/supabase-admin";
import { graph as realGraph, overallOf, runGraphChecks, SAFE, withTestMessage, type Check, type Graph } from "./checks";
import { probeMeta, type MetaProbe } from "./manual";
import { maskPhone } from "../phone";
import { runConnectionChecks, type ChecksRun } from "./run-checks";
import { webhookWasSeen } from "./webhook-seen";

// The daily check of a connection whose token is the client's own: manual, Embedded Signup and assisted (docs/handover.md, module 10, "Jobs": connection-health). The same five Graph checks as a recheck
// (run-checks.ts), run by the system instead of a person, so:
//   * the number is never put in `validating`: it keeps working while it is looked at, and a crash cannot leave it stuck. The write is a
//     compare-and-set on `status = 'active'`, so a recheck or a disconnect that came in meanwhile wins and this writes nothing;
//   * the sixth check (a test message to the owner) is not run: the stored one is kept, and no one is messaged every day;
//   * Meta not answering is not a failure: nothing is written and the next day tries again.
// What fails a connection (the status becomes `failed`, so the AI neither hears nor answers on it): at once only for a token Meta says has expired
// or is no longer valid, or that lacks a WhatsApp permission, because Meta said so in so many words. Anything else that fails (Meta refusing the
// token without saying why, such as a rate limit; a saved token that cannot be decrypted because a key was changed; a declined name; a number not
// in the account) only when the previous stored result, at least 12 hours older, also failed, so one bad night cannot stop businesses'
// assistants. Only the five Graph checks decide; a stale sixth check never does.
// The quality rating, messaging limit, display fields and the token's expiry date are refreshed along the way. UNVERIFIED against a live Meta account.

/** The connection methods checked daily: every method whose token is the client's own. Our own `platform` numbers are not (the team looks after those). */
export const HEALTH_METHODS = ["manual_byo", "embedded_signup", "assisted"] as const;
/** A connection checked less than this long ago (by a recheck, or an earlier run) is not checked again. */
export const RECHECK_AFTER_MS = 20 * 3_600_000;
/** A failure counts as a repeat only when the earlier failing result is at least this much older (a retried step must not count as a second day). */
export const REPEAT_AFTER_MS = 12 * 3_600_000;
/** The most connections one sweep starts. The rest are first in line the next day. */
export const DUE_LIMIT = 500;

const CHECK_KEYS = ["token_permissions", "number_registered", "webhook_subscribed", "display_name_approved", "payment_method", "test_message_delivered"] as const;
const CheckRow = z.object({
  key: z.enum(CHECK_KEYS),
  status: z.enum(["pass", "warn", "fail", "not_verified", "skipped"]),
  message: z.string(),
  checked_at: z.string(),
});
const StoredCheck = z.object({ ran_at: z.string(), overall: z.enum(["pass", "warn", "fail"]), checks: z.array(CheckRow) });
const Row = z.object({
  id: z.string(),
  method: z.string(),
  waba_id: z.string(),
  phone_number_id: z.string(),
  status: z.string(),
  token_enc: z.string(),
  display_phone: z.string().nullable(),
  updated_at: z.string(),
  quality_rating: z.string().nullable(),
  messaging_limit: z.string().nullable(),
  last_check: z.unknown(),
  coexistence: z.boolean().nullish(),
});
const COLUMNS = "id, method, waba_id, phone_number_id, status, token_enc, display_phone, updated_at, quality_rating, messaging_limit, last_check, coexistence";

export interface HealthDeps {
  db: SupabaseClient;
  decrypt: typeof decryptSecret;
  probe: (args: { wabaId: string; phoneNumberId: string; token: string }) => Promise<MetaProbe>;
  graph: Graph;
  webhookSeen: (tenantId: string, connectionId: string) => Promise<boolean>;
  /** The number's messaging limit as Meta says it now, or null when it does not say (never a failure). */
  messagingLimit: (args: { phoneNumberId: string; token: string }) => Promise<string | null>;
  audit: (entry: AuditEntry) => Promise<void>;
  now: () => Date;
}

/** The number's messaging limit tier (TIER_1K, ...): one read of the number, any failure meaning "not known". UNVERIFIED against a live account. */
export async function readMessagingLimit(args: { phoneNumberId: string; token: string }, call: Graph = realGraph): Promise<string | null> {
  try {
    const answer = await call("GET", `${args.phoneNumberId}?fields=messaging_limit_tier`, args.token);
    if (answer.state !== "answered" || !answer.ok) return null;
    const tier = (answer.body as { messaging_limit_tier?: unknown } | null)?.messaging_limit_tier;
    return typeof tier === "string" && /^[A-Z0-9_]{1,40}$/.test(tier) ? tier : null;
  } catch {
    return null;
  }
}

export const healthDefaults = (): HealthDeps => {
  const db = supabaseAdmin();
  return {
    db,
    decrypt: decryptSecret,
    probe: probeMeta,
    graph: realGraph,
    webhookSeen: (tenantId, connectionId) => webhookWasSeen(db, tenantId, connectionId),
    messagingLimit: (args) => readMessagingLimit(args),
    audit: writeAudit,
    now: () => new Date(),
  };
};

export type DueConnection = { tenantId: string; connectionId: string };

/** Active connections of the methods in `HEALTH_METHODS` not checked for 20 hours (or never), the longest-waiting first, at most `DUE_LIMIT`. Reads across businesses: it is how the jobs find them. */
export async function dueConnections(deps: Pick<HealthDeps, "db" | "now">): Promise<DueConnection[]> {
  const { data, error } = await deps.db
    .from("whatsapp_connections")
    .select("id, tenant_id, last_check")
    .eq("status", "active")
    .in("method", [...HEALTH_METHODS])
    .order("updated_at", { ascending: true })
    .limit(DUE_LIMIT * 2);
  if (error) throw new Error(`connection health: reading the due connections failed (${error.code ?? "unknown"})`);
  const cutoff = deps.now().getTime() - RECHECK_AFTER_MS;
  const due: { tenantId: string; connectionId: string; ranAt: number }[] = [];
  for (const row of z.array(z.object({ id: z.string(), tenant_id: z.string(), last_check: z.unknown() })).parse(data ?? [])) {
    const ran = z.object({ ran_at: z.string() }).safeParse(row.last_check);
    const ranAt = ran.success ? Date.parse(ran.data.ran_at) : Number.NaN;
    if (Number.isNaN(ranAt)) due.push({ tenantId: row.tenant_id, connectionId: row.id, ranAt: 0 });
    else if (ranAt <= cutoff) due.push({ tenantId: row.tenant_id, connectionId: row.id, ranAt });
  }
  return due
    .sort((a, b) => a.ranAt - b.ranAt)
    .slice(0, DUE_LIMIT)
    .map(({ tenantId, connectionId }) => ({ tenantId, connectionId }));
}

export type FailureAlert = {
  reason: "token" | "checks";
  /** The failing check's own words (checks.ts SAFE): fixed text, never what Meta said. */
  detail: string;
  /** The number as maskPhone writes it: this result is stored by the job runner, so the full number is not in it. */
  phoneMasked: string | null;
  /** Names this failure: the connection and the stored result it replaced, so a retry is the same alert. */
  key: string;
};

export type HealthResult =
  | { status: "skipped"; reason: "not_found" | "not_active" | "unreachable" | "changed" }
  | { status: "checked"; overall: "pass" | "warn" | "fail"; failed: false }
  | { status: "checked"; overall: "fail"; failed: true; alert: FailureAlert };

async function record(deps: HealthDeps, entry: AuditEntry): Promise<void> {
  try {
    await deps.audit(entry);
  } catch {
    console.error("[connection-health] audit write failed");
  }
}

/** Checks one connection and saves what Meta says. Never sends a message: a failure comes back for the caller to report. */
export async function checkConnectionHealth(ids: DueConnection, deps: HealthDeps = healthDefaults()): Promise<HealthResult> {
  const { tenantId, connectionId } = ids;
  const read = await deps.db.from("whatsapp_connections").select(COLUMNS).eq("tenant_id", tenantId).eq("id", connectionId).limit(1);
  if (read.error) throw new Error(`connection health: reading the connection failed (${read.error.code ?? "unknown"})`);
  const [row] = z.array(Row).max(1).parse(read.data ?? []);
  if (!row) return { status: "skipped", reason: "not_found" };
  if (row.status !== "active" || !(HEALTH_METHODS as readonly string[]).includes(row.method)) return { status: "skipped", reason: "not_active" };

  const stored = StoredCheck.safeParse(row.last_check);
  const previous = stored.success ? stored.data : null;
  const previousFive = previous ? overallOf(previous.checks.filter((c) => c.key !== "test_message_delivered")) : null;
  // Failing again the next day, not a retry of the same day's check.
  const repeated = previousFive === "fail" && previous !== null && deps.now().getTime() - Date.parse(previous.ran_at) >= REPEAT_AFTER_MS;

  let token: string | null = null;
  try {
    token = deps.decrypt(row.token_enc, connectionSecretContext({ column: "token_enc", tenantId, connectionId }));
  } catch {
    token = null; // a key that no longer opens it: nothing can be sent with this connection
  }

  const now = deps.now();
  let run: ChecksRun;
  if (token === null) {
    // Meta is not asked: the token check fails with its own message and the rest wait.
    const lastCheck = await runGraphChecks(
      { wabaId: row.waba_id, token: "", method: row.method, accepted: false, inAccount: false, facts: { nameStatus: null, platformType: null }, webhookSeen: async () => false },
      deps.graph,
      now,
    );
    run = { state: "done", probe: { state: "rejected" }, lastCheck, fresh: {}, subscribed: null, seenBefore: undefined, tokenExpiresAt: undefined };
  } else {
    run = await runConnectionChecks(
      { tenantId, connectionId, method: row.method, wabaId: row.waba_id, phoneNumberId: row.phone_number_id, token, allowSubscribe: false, coexistence: row.coexistence === true },
      { probe: deps.probe, graph: deps.graph, webhookSeen: deps.webhookSeen, now: deps.now },
    );
  }
  if (run.state === "unreachable") return { status: "skipped", reason: "unreachable" };

  // The five Graph checks decide. The test message check of the last connect or recheck is carried over as it was.
  const five = run.lastCheck;
  const fiveOverall = overallOf(five.checks.filter((c) => c.key !== "test_message_delivered"));
  const tokenCheck = five.checks.find((c) => c.key === "token_permissions");
  const tokenFailed = tokenCheck?.status === "fail";
  // Meta's own word that the token is finished: expired or no longer valid, or missing a WhatsApp permission. A refusal without a reason is not.
  const definitive = tokenFailed && (tokenCheck?.message === SAFE.tokenExpired || tokenCheck?.message === SAFE.tokenScopes);
  const failed = fiveOverall === "fail" && (definitive || repeated);
  const sixth = previous?.checks.find((c) => c.key === "test_message_delivered");
  const lastCheck = sixth ? withTestMessage(five, sixth as Check) : five;

  let limit: string | null = null;
  if (token !== null && run.probe.state === "ok") limit = await deps.messagingLimit({ phoneNumberId: row.phone_number_id, token }).catch(() => null);

  const quality = run.fresh.quality_rating ?? row.quality_rating;
  const messagingLimit = limit ?? row.messaging_limit;
  const saved = await deps.db
    .from("whatsapp_connections")
    .update({
      ...run.fresh,
      last_check: lastCheck,
      ...(limit !== null ? { messaging_limit: limit } : {}),
      ...(run.tokenExpiresAt !== undefined ? { token_expires_at: run.tokenExpiresAt === null ? null : run.tokenExpiresAt.toISOString() } : {}),
      ...(failed ? { status: "failed" } : {}),
    })
    .eq("tenant_id", tenantId)
    .eq("id", connectionId)
    .eq("status", "active")
    .eq("updated_at", row.updated_at)
    .select("id");
  if (saved.error) throw new Error(`connection health: saving the result failed (${saved.error.code ?? "unknown"})`);
  if (!Array.isArray(saved.data) || saved.data.length === 0) return { status: "skipped", reason: "changed" };

  const changes: Record<string, { from: string | null; to: string | null }> = {};
  if (quality !== row.quality_rating) changes.quality_rating = { from: row.quality_rating, to: quality };
  if (messagingLimit !== row.messaging_limit) changes.messaging_limit = { from: row.messaging_limit, to: messagingLimit };
  if (Object.keys(changes).length > 0) {
    await record(deps, { tenantId, actor: "system", action: "whatsapp_connection.health_changed", entity: "whatsapp_connection", entityId: connectionId, diff: changes });
  }

  if (!failed) return { status: "checked", overall: fiveOverall, failed: false };
  const reason = tokenFailed ? "token" : "checks";
  await record(deps, { tenantId, actor: "system", action: "whatsapp_connection.health_failed", entity: "whatsapp_connection", entityId: connectionId, diff: { from: "active", to: "failed", reason } });
  const failing = five.checks.find((c) => c.key === "token_permissions" && c.status === "fail") ?? five.checks.find((c) => c.status === "fail");
  return {
    status: "checked",
    overall: "fail",
    failed: true,
    alert: {
      reason,
      detail: failing?.message ?? "A check of this number failed.",
      phoneMasked: row.display_phone ? maskPhone(row.display_phone) : null,
      key: `connection_failed:${connectionId}:${previous?.ran_at ?? "never"}`,
    },
  };
}
