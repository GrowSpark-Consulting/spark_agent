import type { AdminConnection, ConnectionCheckView } from "@pakka/types";
import { ConnectionMethod, ConnectionStatus } from "@pakka/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase-admin";

// GET /api/admin/whatsapp/connections (Day 7; Dev 3's admin panel, "Connection list with method, status and last check").
// Platform admins only (adminRoute). Every business's connections, newest first. Only browser-safe columns are read: the
// encrypted token and app secret are never selected, so they cannot reach the answer by mistake.

export interface AdminConnectionsDeps {
  db: SupabaseClient;
}

const defaults = (): AdminConnectionsDeps => ({ db: supabaseAdmin() });

const COLUMNS =
  "id, tenant_id, method, status, display_phone, verified_name, coexistence, quality_rating, messaging_limit, token_expires_at, last_check, created_at, updated_at, tenants(name)";

const Row = z.object({
  id: z.string(),
  tenant_id: z.string(),
  method: ConnectionMethod,
  status: ConnectionStatus,
  display_phone: z.string().nullable(),
  verified_name: z.string().nullable(),
  coexistence: z.boolean(),
  quality_rating: z.string().nullable(),
  messaging_limit: z.string().nullable(),
  token_expires_at: z.string().nullable(),
  last_check: z.unknown(),
  created_at: z.string(),
  updated_at: z.string(),
  tenants: z.object({ name: z.string() }).nullable(),
});

/** last_check as the connection jobs store it (docs/whatsapp-connection-contract.md); {} means never checked. */
const StoredCheck = z.object({
  ran_at: z.string(),
  overall: z.enum(["pass", "warn", "fail"]),
  checks: z.array(
    z.object({
      key: z.string(),
      status: z.enum(["pass", "warn", "fail", "not_verified", "skipped"]),
      message: z.string().nullable().optional(),
    }),
  ),
});

/** The stored check in the panel's shape; null when there is none, or it is in an older shape this does not read. */
export function checkView(stored: unknown): ConnectionCheckView | null {
  const parsed = StoredCheck.safeParse(stored);
  if (!parsed.success) return null;
  return {
    ranAt: new Date(parsed.data.ran_at).toISOString(),
    overall: parsed.data.overall,
    checks: parsed.data.checks.map((c) => ({ key: c.key, status: c.status, message: c.message ?? null })),
  };
}

const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);

export async function listConnections(_admin: { actor: string }, deps: AdminConnectionsDeps = defaults()): Promise<AdminConnection[]> {
  const { data, error } = await deps.db.from("whatsapp_connections").select(COLUMNS).order("created_at", { ascending: false }).limit(500);
  if (error) throw new Error(`admin connections: read failed: ${error.message}`);
  return z
    .array(Row)
    .parse(data ?? [])
    .map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      tenantName: r.tenants?.name ?? "",
      method: r.method,
      status: r.status,
      displayPhone: r.display_phone,
      verifiedName: r.verified_name,
      coexistence: r.coexistence,
      qualityRating: r.quality_rating,
      messagingLimit: r.messaging_limit,
      tokenExpiresAt: iso(r.token_expires_at),
      lastCheck: checkView(r.last_check),
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    }));
}
