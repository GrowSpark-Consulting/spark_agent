import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../lib/errors";

// The link in a staff alert (docs/handover.md, module 6): `/h/{token}?mode=inbox` and `?mode=own`. The token is signed (HMAC, with a key derived from
// ENCRYPTION_KEY for this one purpose, as the Google consent state is), tied to ONE staff member and ONE handoff of ONE business, and good for 24
// hours. It carries ids and a time only: no name, no number, no word of the chat. A forwarded link is useless to anyone else because the action it
// does is done AS the staff member it names, and only once: whether it was used is the handoff's own state (takeover.ts: `picked_at`), not the token's.

export const LINK_TTL_MS = 24 * 60 * 60_000;
const MAX_TOKEN_CHARS = 1024;

export interface HandoffLinkClaims {
  tenantId: string;
  handoffId: string;
  userId: string;
}

export type TokenCheck = { status: "ok"; claims: HandoffLinkClaims } | { status: "expired" } | { status: "invalid" };

type KeyEnv = { ENCRYPTION_KEY?: string };

const Payload = z.object({ t: z.guid(), h: z.guid(), u: z.guid(), exp: z.number().int(), n: z.string().min(1) });

function key(env: KeyEnv): Buffer | null {
  if (!env.ENCRYPTION_KEY) return null;
  return Buffer.from(hkdfSync("sha256", Buffer.from(env.ENCRYPTION_KEY, "base64"), Buffer.alloc(0), "pakka:handoff-link", 32));
}

const mac = (payload: string, k: Buffer) => createHmac("sha256", k).update(payload).digest();

export function signHandoffToken(claims: HandoffLinkClaims, env: KeyEnv, now: Date): string {
  const k = key(env);
  if (!k) throw new AppError("not_available", "Links to take over a chat aren't switched on yet.");
  const payload = Buffer.from(JSON.stringify({ t: claims.tenantId, h: claims.handoffId, u: claims.userId, exp: now.getTime() + LINK_TTL_MS, n: randomBytes(12).toString("base64url") })).toString("base64url");
  return `${payload}.${mac(payload, k).toString("base64url")}`;
}

/** What a token says, `expired` once its 24 hours are over, or `invalid` for anything else: changed, made with another key, or not a token at all. Never throws. */
export function verifyHandoffToken(token: string, env: KeyEnv, now: Date): TokenCheck {
  try {
    const k = key(env);
    if (!k || token.length === 0 || token.length > MAX_TOKEN_CHARS) return { status: "invalid" };
    const parts = token.split(".");
    if (parts.length !== 2 || parts[0] === "" || parts[1] === "") return { status: "invalid" };
    const [payload, given] = parts;
    const expected = mac(payload, k);
    const presented = Buffer.from(given, "base64url");
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return { status: "invalid" };
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return { status: "invalid" };
    }
    const parsed = Payload.safeParse(decoded);
    if (!parsed.success) return { status: "invalid" };
    if (parsed.data.exp < now.getTime()) return { status: "expired" };
    return { status: "ok", claims: { tenantId: parsed.data.t, handoffId: parsed.data.h, userId: parsed.data.u } };
  } catch {
    return { status: "invalid" };
  }
}

/**
 * The two buttons of a staff alert. Both carry the same token, so using one ends the other: one takeover per handoff. The own-number link exists only
 * on a plan that has it (`ownNumber`), so an alert on a plan without it shows the inbox button alone. The address is the API's own (API_PUBLIC_URL).
 */
export function createHandoffLinks(
  claims: HandoffLinkClaims,
  env: KeyEnv & { API_PUBLIC_URL?: string },
  now: Date,
  options: { ownNumber: boolean },
): { inbox: string; own: string | null } {
  if (!env.API_PUBLIC_URL) throw new AppError("not_available", "Links to take over a chat aren't switched on yet.");
  const token = signHandoffToken(claims, env, now);
  const link = (mode: "inbox" | "own") => `${env.API_PUBLIC_URL}/h/${token}?mode=${mode}`;
  return { inbox: link("inbox"), own: options.ownNumber ? link("own") : null };
}
