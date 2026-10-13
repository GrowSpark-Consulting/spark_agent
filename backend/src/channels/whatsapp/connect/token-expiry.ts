import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { HEALTH_METHODS } from "./health";
import { maskPhone } from "../phone";
import { expiryMessage, sendToAdmins, type AlertCounts, type AlertSendDeps } from "./health-alert";

// The warning a week before an access token runs out (Day 6). `token_expires_at` is filled by the daily health check (health.ts) from debug_token;
// a token that never expires has none. Only active connections are warned about: one that has failed or is disconnected has been dealt with, and
// one whose token has already run out is marked failed by the health check, which tells the owners.

export const WARN_DAYS = 7;
const DAY_MS = 86_400_000;

/** `phoneMasked`: the number as maskPhone writes it; the full number is not carried past the read (a job step's result is stored). */
export type ExpiringConnection = { tenantId: string; connectionId: string; phoneMasked: string | null; expiresAt: Date };

const Row = z.object({ id: z.string(), tenant_id: z.string(), display_phone: z.string().nullable(), token_expires_at: z.string() });

/** Active manual connections whose token runs out after now and before `WARN_DAYS` days from now, the soonest first. */
export async function expiringConnections(deps: { db: SupabaseClient; now: () => Date }): Promise<ExpiringConnection[]> {
  const now = deps.now();
  const { data, error } = await deps.db
    .from("whatsapp_connections")
    .select("id, tenant_id, display_phone, token_expires_at")
    .eq("status", "active")
    .in("method", [...HEALTH_METHODS])
    .gt("token_expires_at", now.toISOString())
    .lt("token_expires_at", new Date(now.getTime() + WARN_DAYS * DAY_MS).toISOString())
    .order("token_expires_at", { ascending: true })
    .limit(1000);
  if (error) throw new Error(`token expiry: connection read failed (${error.code ?? "unknown"})`);
  const found: ExpiringConnection[] = [];
  for (const row of z.array(Row).parse(data ?? [])) {
    const expiresAt = new Date(row.token_expires_at);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime() || expiresAt.getTime() >= now.getTime() + WARN_DAYS * DAY_MS) continue;
    found.push({ tenantId: row.tenant_id, connectionId: row.id, phoneMasked: row.display_phone ? maskPhone(row.display_phone) : null, expiresAt });
  }
  return found.sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
}

export interface WarnDeps extends AlertSendDeps {
  appUrl: () => string;
}

/** Warns each owner and admin of the connection's business, once per expiry date: a renewed token has a new date, so it is warned about again. */
export function warnExpiring(connection: ExpiringConnection, deps: WarnDeps): Promise<AlertCounts> {
  const key = `token_expiring:${connection.connectionId}:${connection.expiresAt.toISOString().slice(0, 10)}`;
  return sendToAdmins(connection.tenantId, expiryMessage({ phoneMasked: connection.phoneMasked, expiresAt: connection.expiresAt }, deps.appUrl()), key, deps);
}
