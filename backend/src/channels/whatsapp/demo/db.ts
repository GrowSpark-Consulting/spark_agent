import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { supabaseAdmin } from "../../../lib/supabase-admin";
import { WebhookDbError } from "../inbound-db";
import type { DemoDeps } from "./route";

// The demo number's database access (migration 0029), service role, server only. A failure carries the Postgres error
// code only: its message can hold phone numbers or text. The lookup by route code is the one query that cannot filter
// by tenant_id (it is how the business is found); demo_visitors is keyed by phone and is never read by a business.

const Admit = z.array(z.object({ allowed: z.boolean(), notify_limit: z.boolean(), replay: z.boolean(), message_tenant_id: z.guid().nullable() })).length(1);
const Route = z.object({ tenant_id: z.guid().nullable(), expires_at: z.string().nullable() });
const Status = z.object({ status: z.string() });

/** Businesses that can take a visitor's message: the others are paused or cancelled. */
const LIVE_STATUSES = new Set(["trial", "active"]);

export function demoDb(db: SupabaseClient = supabaseAdmin(), now: () => Date = () => new Date()): DemoDeps {
  return {
    async findRoute(code) {
      const { data, error } = await db.from("route_codes").select("tenant_id, expires_at").eq("code", code).maybeSingle();
      if (error) throw new WebhookDbError("route code lookup", error.code);
      if (!data) return null;
      const row = Route.parse(data);
      if (row.tenant_id === null) return null;
      if (row.expires_at !== null && Date.parse(row.expires_at) <= now().getTime()) return null;
      return { tenantId: row.tenant_id };
    },

    async isLive(tenantId) {
      const { data, error } = await db.from("tenants").select("status").eq("id", tenantId).maybeSingle();
      if (error) throw new WebhookDbError("business status lookup", error.code);
      return data ? LIVE_STATUSES.has(Status.parse(data).status) : false;
    },

    async admit({ phone, wamid, limit, routeTenantId }) {
      const { data, error } = await db.rpc("demo_admit", { p_phone: phone, p_wamid: wamid, p_limit: limit, p_now: now().toISOString(), p_route_tenant: routeTenantId });
      if (error) throw new WebhookDbError("demo_admit", error.code);
      const [row] = Admit.parse(data);
      return { allowed: row.allowed, replay: row.replay, tenantId: row.message_tenant_id };
    },
  };
}
