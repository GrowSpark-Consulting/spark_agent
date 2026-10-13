import type { WhatsAppConnectionPublic } from "@pakka/types";
import { z } from "zod";
import { writeAudit, type AuditEntry } from "../../../lib/audit";
import { hashConnectLinkToken, isConnectLinkToken, newConnectLinkToken } from "../../../lib/connect-link-token";
import { serverEnv } from "../../../lib/env";
import { AppError, zodFieldErrors } from "../../../lib/errors";
import { supabaseAdmin } from "../../../lib/supabase-admin";
import { connectLinkLimiter } from "./connect-link-rate-limit";
import { assertEmbeddedSignupAvailable, connectNumber, embeddedSignupConfig, embeddedSignupDefaults, parseSignupBody, type SignupCaller, type SignupInput } from "./embedded-signup";

// The assisted connect link (docs/whatsapp-connection-contract.md, "Assisted connect link"). A platform admin makes a link for a business; the business owner opens it
// without signing in and runs Meta's Embedded Signup; the same exchange as embedded-signup.ts then connects the number, as `assisted`.
//
//   createConnectLink  POST /api/admin/whatsapp/connect-link  { tenantId } → { url, expiresAt }. 32 random bytes, valid 24 hours. connect_links keeps only the
//                      SHA-256 of the token (0016); the raw token exists in this answer and nowhere else: never stored, audited or logged.
//   readConnectLink    GET /api/connect-links/:token (public) → { tenantName, expiresAt }.
//   connectWithLink    POST /api/onboarding/whatsapp/embedded-signup with `connectToken` (public): the business comes only from the link.
//
// All three answer not_available before anything else while EMBEDDED_SIGNUP_ENABLED is off (no limit, no claim, no database read). A malformed, unknown, used or
// expired token gets one and the same not_found, so the answer says nothing about which. Single use is one conditional UPDATE (`claim`), so two people at once
// cannot both have the link. The claim is released if the connection fails or is saved `failed`, so the owner can open the popup again with the same link; it stays
// used only once the connection is active.

const LINK_HOURS = 24;
const CreateBody = z.object({ tenantId: z.guid("Name the business.") });

/** The one answer for every link that cannot be used. Never says which of malformed, unknown, used or expired it is. */
const invalidLink = () => new AppError("not_found", "This link isn't valid. Ask for a new one.");

export interface ConnectLinkDb {
  tenantExists(tenantId: string): Promise<boolean>;
  insert(row: { tokenHash: string; tenantId: string; createdBy: string; expiresAt: Date }): Promise<void>;
  /** A link that is not used and not expired, with its business's name; null otherwise (and for a business that cannot be read). */
  readLive(tokenHash: string, now: Date): Promise<{ tenantName: string; expiresAt: Date } | null>;
  /** One conditional UPDATE: marks the link used only if it is unused and unexpired, and says who it was for. null when there is nothing to claim. */
  claim(tokenHash: string, now: Date): Promise<{ tenantId: string; createdBy: string; claimedAt: string } | null>;
  /** Frees a claim, only if the link is still marked used at that very time (so it never frees a claim someone else made). */
  release(tokenHash: string, claimedAt: string): Promise<void>;
  /** Whether this business has an ACTIVE connection for the number (the claim is not freed when it has: see connectWithLink). */
  activeConnectionExists(tenantId: string, phoneNumberId: string): Promise<boolean>;
}

export interface ConnectLinkDeps {
  /** Throws not_available unless the flag is on and our app id and secret are set. Reads nothing. */
  assertAvailable: () => void;
  db: ConnectLinkDb;
  now: () => Date;
  newToken: () => { token: string; tokenHash: string };
  /** The frontend's origin, for the link. */
  appOrigin: () => string;
  audit: (entry: AuditEntry) => Promise<void>;
  /** True when this caller may go on (30 a minute per address). */
  limit: (key: string) => boolean;
  /** The Embedded Signup flow (embedded-signup.ts `connectNumber`). */
  connect: (caller: SignupCaller, input: SignupInput) => Promise<WhatsAppConnectionPublic>;
}

export const connectLinkDefaults = (): ConnectLinkDeps => ({
  assertAvailable: () => assertEmbeddedSignupAvailable(embeddedSignupConfig()),
  db: connectLinkDb(),
  now: () => new Date(),
  newToken: newConnectLinkToken,
  appOrigin: () => new URL(serverEnv().NEXT_PUBLIC_APP_URL).origin,
  audit: writeAudit,
  limit: connectLinkLimiter,
  connect: (caller, input) => connectNumber(caller, input, embeddedSignupDefaults()),
});

/** The flag is on and our app id and secret are set; otherwise not_available. Reads nothing: the admin route calls it before it looks anyone up. */
export function assertConnectLinksAvailable(): void {
  connectLinkDefaults().assertAvailable();
}

/** Makes a link for a business. `admin.actor` is `admin:<user id>`. The route has already checked the caller is a platform admin. */
export async function createConnectLink(
  admin: { actor: string; userId: string },
  rawBody: unknown,
  deps: ConnectLinkDeps = connectLinkDefaults(),
): Promise<{ url: string; expiresAt: string }> {
  deps.assertAvailable();
  const parsed = CreateBody.safeParse(rawBody);
  if (!parsed.success) throw new AppError("validation_failed", "Some details need fixing.", zodFieldErrors(parsed.error));
  const { tenantId } = parsed.data;
  if (!(await deps.db.tenantExists(tenantId))) throw new AppError("not_found", "We couldn't find that business.");

  const { token, tokenHash } = deps.newToken();
  const expiresAt = new Date(deps.now().getTime() + LINK_HOURS * 3600_000);
  await deps.db.insert({ tokenHash, tenantId, createdBy: admin.userId, expiresAt });

  // After the insert, so the link exists whatever happens here. The row carries no token: ids and the expiry only.
  try {
    await deps.audit({ tenantId, actor: admin.actor, action: "whatsapp_connect_link.created", entity: "connect_link", diff: { expires_at: expiresAt.toISOString(), created_by: admin.userId } });
  } catch {
    console.error("[whatsapp-connect] connect link audit write failed");
  }
  return { url: `${deps.appOrigin()}/connect/${token}`, expiresAt: expiresAt.toISOString() };
}

/** What the public page may say about a link: the business's name and when it ends. Public: `clientKey` is the caller's address, for the limit. */
export async function readConnectLink(token: string, clientKey: string, deps: ConnectLinkDeps = connectLinkDefaults()): Promise<{ tenantName: string; expiresAt: string }> {
  deps.assertAvailable();
  if (!deps.limit(clientKey)) throw new AppError("rate_limited", "Too many tries. Wait a minute and try again.");
  if (!isConnectLinkToken(token)) throw invalidLink();
  const link = await deps.db.readLive(hashConnectLinkToken(token), deps.now());
  if (link === null) throw invalidLink();
  return { tenantName: link.tenantName, expiresAt: link.expiresAt.toISOString() };
}

/**
 * Embedded Signup for a business that has an assisted link (the body carries `connectToken`, no bearer token). Order: flag, limit, token shape, the body (a bad body
 * never touches the link), then the claim, then the connection. The business is the link's, never the body's.
 */
export async function connectWithLink(rawBody: unknown, clientKey: string, deps: ConnectLinkDeps = connectLinkDefaults()): Promise<WhatsAppConnectionPublic> {
  deps.assertAvailable();
  if (!deps.limit(clientKey)) throw new AppError("rate_limited", "Too many tries. Wait a minute and try again.");
  const token = typeof rawBody === "object" && rawBody !== null ? (rawBody as { connectToken?: unknown }).connectToken : undefined;
  if (typeof token !== "string" || !isConnectLinkToken(token)) throw invalidLink();
  const input = parseSignupBody(rawBody);

  const tokenHash = hashConnectLinkToken(token);
  const claim = await deps.db.claim(tokenHash, deps.now());
  if (claim === null) throw invalidLink();

  const release = async () => {
    try {
      await deps.db.release(tokenHash, claim.claimedAt);
    } catch {
      console.error("[whatsapp-connect] a connect link could not be freed");
    }
  };
  let connection: WhatsAppConnectionPublic;
  try {
    connection = await deps.connect({ tenantId: claim.tenantId, actor: `assisted:${claim.createdBy}`, method: "assisted" }, input);
  } catch (err) {
    // The flow can throw after the connection was saved (reading it back, checking its shape). A number that is now active for this business means the link did its
    // job, so it stays used (a freed link would let anyone holding it connect a second number); the person sees the error and the dashboard shows the connection.
    let connected = false;
    try {
      connected = await deps.db.activeConnectionExists(claim.tenantId, input.phoneNumberId);
    } catch {
      connected = false;
    }
    if (!connected) await release();
    throw err;
  }
  if (connection.status !== "active") await release();
  return connection;
}

export function connectLinkDb(): ConnectLinkDb {
  const fail = (what: string) => new AppError("upstream_failed", `We couldn't ${what}. Try again in a moment.`);
  const db = () => supabaseAdmin();
  return {
    async tenantExists(tenantId) {
      const { data, error } = await db().from("tenants").select("id").eq("id", tenantId).maybeSingle();
      if (error) throw fail("look up the business");
      return data !== null;
    },
    async insert(row) {
      const { error } = await db().from("connect_links").insert({ token_hash: row.tokenHash, tenant_id: row.tenantId, created_by: row.createdBy, expires_at: row.expiresAt.toISOString() });
      if (error) throw fail("make the link");
    },
    async readLive(tokenHash, now) {
      const { data, error } = await db()
        .from("connect_links")
        .select("expires_at, tenants(name)")
        .eq("token_hash", tokenHash)
        .is("used_at", null)
        .gt("expires_at", now.toISOString())
        .maybeSingle();
      if (error) throw fail("read the link");
      if (data === null) return null;
      const tenant = (data as unknown as { tenants: { name?: unknown } | { name?: unknown }[] | null }).tenants;
      const name = (Array.isArray(tenant) ? tenant[0] : tenant)?.name;
      return typeof name === "string" && name !== "" ? { tenantName: name, expiresAt: new Date(String((data as { expires_at: unknown }).expires_at)) } : null;
    },
    async claim(tokenHash, now) {
      // One statement: only an unused, unexpired link is marked used, and only one caller can get its row back.
      const stamp = now.toISOString();
      const { data, error } = await db().from("connect_links").update({ used_at: stamp }).eq("token_hash", tokenHash).is("used_at", null).gt("expires_at", stamp).select("tenant_id, created_by");
      if (error) throw fail("use the link");
      const row = data?.[0] as { tenant_id?: unknown; created_by?: unknown } | undefined;
      return row ? { tenantId: String(row.tenant_id), createdBy: String(row.created_by), claimedAt: stamp } : null;
    },
    async activeConnectionExists(tenantId, phoneNumberId) {
      const { data, error } = await db().from("whatsapp_connections").select("id").eq("tenant_id", tenantId).eq("phone_number_id", phoneNumberId).eq("status", "active").maybeSingle();
      if (error) throw fail("check the connection");
      return data !== null;
    },
    async release(tokenHash, claimedAt) {
      const { error } = await db().from("connect_links").update({ used_at: null }).eq("token_hash", tokenHash).eq("used_at", claimedAt);
      if (error) throw fail("free the link");
    },
  };
}
