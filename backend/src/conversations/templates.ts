import type { TenantContext } from "@pakka/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase-admin";
import { templateVariableCount } from "../notify/send";

// GET /api/conversations/:id/templates: the approved templates staff can send in this chat, for the inbox's template
// picker. A template belongs to one WhatsApp number (whatsapp_templates.connection_id), and the browser cannot tell which
// number a chat is on (whatsapp_connections_public has no channel_id), so the server picks it the way notify.send does:
// the active connection on the chat's channel (notify_target, 0009). Sending one is POST /api/conversations/:id/messages
// with { template: { name, language, params } }. Any member.

export interface ConversationTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  /** How many {{n}} values the body takes, or null when the body can't be read (Meta then checks). */
  variableCount: number | null;
  /** The body text with its {{n}} placeholders, for a preview; null when it can't be read. */
  body: string | null;
}

export interface ConversationTemplates {
  /** The WhatsApp number the chat is on; null when that number is not connected (then nothing can be sent). */
  connectionId: string | null;
  templates: ConversationTemplate[];
}

const Id = z.guid();
const NOT_FOUND = "That conversation was not found.";
const Row = z.object({ id: z.string(), name: z.string(), language: z.string(), category: z.string(), components: z.unknown() });

/** A template's body text, from Meta's components ([{ type: "BODY", text }]) or as submitted ({ body }). */
export function templateBody(components: unknown): string | null {
  if (Array.isArray(components)) {
    const body = components.find((c) => typeof c === "object" && c !== null && String((c as { type?: unknown }).type).toUpperCase() === "BODY") as { text?: unknown } | undefined;
    return typeof body?.text === "string" ? body.text : null;
  }
  const body = typeof components === "object" && components !== null ? (components as { body?: unknown }).body : undefined;
  return typeof body === "string" ? body : null;
}

export async function conversationTemplates(context: TenantContext, conversationId: string, db: SupabaseClient = supabaseAdmin()): Promise<ConversationTemplates> {
  if (!Id.safeParse(conversationId).success) throw new AppError("not_found", NOT_FOUND);
  const tenantId = context.tenant.id;
  const chat = await db.from("conversations").select("channel_id").eq("tenant_id", tenantId).eq("id", conversationId).maybeSingle();
  if (chat.error) throw new Error(`conversation templates: chat read failed: ${chat.error.message}`);
  if (!chat.data) throw new AppError("not_found", NOT_FOUND);
  const channelId = z.object({ channel_id: z.string() }).parse(chat.data).channel_id;

  const connection = await db.from("whatsapp_connections").select("id").eq("tenant_id", tenantId).eq("channel_id", channelId).eq("status", "active").limit(1);
  if (connection.error) throw new Error(`conversation templates: connection read failed: ${connection.error.message}`);
  const [active] = z.array(z.object({ id: z.string() })).parse(connection.data ?? []);
  if (!active) return { connectionId: null, templates: [] };

  const rows = await db
    .from("whatsapp_templates")
    .select("id, name, language, category, components")
    .eq("tenant_id", tenantId)
    .eq("connection_id", active.id)
    .eq("status", "approved")
    .order("name", { ascending: true })
    .order("language", { ascending: true });
  if (rows.error) throw new Error(`conversation templates: templates read failed: ${rows.error.message}`);
  return {
    connectionId: active.id,
    templates: z
      .array(Row)
      .parse(rows.data ?? [])
      .map((t) => ({
        id: t.id,
        name: t.name,
        language: t.language,
        category: t.category,
        variableCount: templateVariableCount(t.components),
        body: templateBody(t.components),
      })),
  };
}
