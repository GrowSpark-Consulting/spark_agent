import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { claimTrialPhone } from "../../../billing/trial-phone";
import { supabaseAdmin } from "../../../lib/supabase-admin";
import { WebhookDbError } from "../inbound-db";
import type { DemoDeps } from "./route";
import type { MenuEntry } from "./text";

// The demo number's database access (migrations 0029 and 0031), service role, server only. A failure carries the Postgres error code only: its message can
// hold phone numbers or text. The lookups by route code and by message id are the queries that cannot filter by tenant_id (they are how the business is
// found); demo_visitors is keyed by phone and is never read by a business.

const Admit = z.array(z.object({ allowed: z.boolean(), notify_limit: z.boolean(), replay: z.boolean(), message_tenant_id: z.guid().nullable() })).length(1);
const Route = z.object({ tenant_id: z.guid().nullable(), kind: z.enum(["demo", "trial"]), expires_at: z.string().nullable() });
const Status = z.object({ status: z.string() });
const Visitor = z.object({ tenant_id: z.guid().nullable(), routed_at: z.string().nullable() });

/** Businesses that can take a visitor's message: the others are paused or cancelled. */
const LIVE_STATUSES = new Set(["trial", "active"]);
/** A route is good for 24 hours from when it started (demo_admit). */
const ROUTE_MS = 24 * 3_600_000;
/** The menu has single-digit numbers: at most nine entries. */
const MENU_MAX = 9;

export function demoDb(db: SupabaseClient = supabaseAdmin(), now: () => Date = () => new Date()): DemoDeps & {
  /** The business whose conversation on this channel holds a message, for a delivery status; null when none does. */
  messageTenant(args: { providerMsgId: string; channelId: string }): Promise<string | null>;
} {
  const fail = (what: string, error: { code?: string }) => new WebhookDbError(what, error.code ?? "unknown");
  return {
    async findRoute(code) {
      const { data, error } = await db.from("route_codes").select("tenant_id, kind, expires_at").eq("code", code).maybeSingle();
      if (error) throw fail("route code lookup", error);
      if (!data) return null;
      const row = Route.parse(data);
      if (row.tenant_id === null) return null;
      if (row.expires_at !== null && Date.parse(row.expires_at) <= now().getTime()) return null;
      return { tenantId: row.tenant_id, kind: row.kind };
    },

    async isLive(tenantId) {
      const { data, error } = await db.from("tenants").select("status").eq("id", tenantId).maybeSingle();
      if (error) throw fail("business status lookup", error);
      return data ? LIVE_STATUSES.has(Status.parse(data).status) : false;
    },

    claimTrialPhone: (tenantId, phone) => claimTrialPhone(tenantId, phone, db),

    async hasRoute(phone) {
      const { data, error } = await db.from("demo_visitors").select("tenant_id, routed_at").eq("phone", phone).maybeSingle();
      if (error) throw fail("demo visitor lookup", error);
      if (!data) return false;
      const row = Visitor.parse(data);
      if (row.tenant_id === null || row.routed_at === null || Date.parse(row.routed_at) <= now().getTime() - ROUTE_MS) return false;
      // A route to a business that has been paused or cancelled leads nowhere, so the visitor is one with no route: a pick can start a new one.
      const tenant = await db.from("tenants").select("status").eq("id", row.tenant_id).maybeSingle();
      if (tenant.error) throw fail("business status lookup", tenant.error);
      return tenant.data ? LIVE_STATUSES.has(Status.parse(tenant.data).status) : false;
    },

    async menu() {
      const codes = await db.from("route_codes").select("code, tenant_id, expires_at").eq("kind", "demo").order("code", { ascending: true }).limit(200);
      if (codes.error) throw fail("demo code lookup", codes.error);
      const open = z
        .array(z.object({ code: z.string(), tenant_id: z.guid().nullable(), expires_at: z.string().nullable() }))
        .parse(codes.data ?? [])
        .filter((row) => row.tenant_id !== null && (row.expires_at === null || Date.parse(row.expires_at) > now().getTime()));
      if (open.length === 0) return [];

      const tenants = await db.from("tenants").select("id, name, vertical, status").in("id", [...new Set(open.map((row) => row.tenant_id as string))]);
      if (tenants.error) throw fail("demo business lookup", tenants.error);
      const live = new Map(
        z
          .array(z.object({ id: z.string(), name: z.string(), vertical: z.string(), status: z.string() }))
          .parse(tenants.data ?? [])
          .filter((t) => LIVE_STATUSES.has(t.status))
          .map((t) => [t.id, t]),
      );

      const verticals = [...new Set([...live.values()].map((t) => t.vertical))];
      const packs = verticals.length === 0 ? { data: [], error: null } : await db.from("vertical_packs").select("key, version, definition").in("key", verticals).eq("active", true);
      if (packs.error) throw fail("pack lookup", packs.error);
      const newest = new Map<string, { version: number; label: string | null }>();
      for (const pack of z.array(z.object({ key: z.string(), version: z.number(), definition: z.unknown() })).parse(packs.data ?? [])) {
        const label = z.object({ label: z.string() }).safeParse(pack.definition);
        const kept = newest.get(pack.key);
        if (!kept || pack.version > kept.version) newest.set(pack.key, { version: pack.version, label: label.success && label.data.label.trim() !== "" ? label.data.label.trim() : null });
      }

      // One entry per business (its first code), however many codes it has.
      const entries: MenuEntry[] = [];
      const seen = new Set<string>();
      for (const row of open) {
        const tenant = live.get(row.tenant_id as string);
        if (!tenant || seen.has(tenant.id)) continue;
        seen.add(tenant.id);
        entries.push({ code: row.code, label: newest.get(tenant.vertical)?.label ?? tenant.name });
      }
      return entries.slice(0, MENU_MAX);
    },

    async admit({ phone, wamid, limit, routeTenantId }) {
      const { data, error } = await db.rpc("demo_admit", { p_phone: phone, p_wamid: wamid, p_limit: limit, p_now: now().toISOString(), p_route_tenant: routeTenantId });
      if (error) throw fail("demo_admit", error);
      const [row] = Admit.parse(data);
      return { allowed: row.allowed, replay: row.replay, notifyLimit: row.notify_limit, tenantId: row.message_tenant_id };
    },

    async messageTenant({ providerMsgId, channelId }) {
      const message = await db.from("messages").select("tenant_id, conversation_id").eq("provider_msg_id", providerMsgId).limit(1);
      if (message.error) throw fail("message lookup", message.error);
      const [row] = z.array(z.object({ tenant_id: z.string(), conversation_id: z.string() })).max(1).parse(message.data ?? []);
      if (!row) return null;
      // The chat must be that business's own and on this number's channel: a status can only name a message that went out on it.
      const chat = await db.from("conversations").select("id").eq("tenant_id", row.tenant_id).eq("id", row.conversation_id).eq("channel_id", channelId).limit(1);
      if (chat.error) throw fail("conversation lookup", chat.error);
      return (chat.data ?? []).length > 0 ? row.tenant_id : null;
    },
  };
}
