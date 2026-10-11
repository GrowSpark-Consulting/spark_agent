import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { inngest } from "../../inngest/client";
import { supabaseAdmin } from "../../lib/supabase-admin";
import { send, type NotifyPayload, type SendOutcome } from "../../notify/send";
import { externalNotice } from "./texts";

// A customer writes again while a staff member handles the chat from their own WhatsApp number (conversation mode `external`; Raja, 11 Oct, question 4).
// The AI stays out of the conversation, but not in silence: at most once every 30 minutes it says that the team member is looking after the chat (one AI
// reply, 1 credit, best effort), and `chat.external_waiting` (ids only) is sent at the same time so staff can be pinged. Nothing else is said or changed.
//
// The 30 minutes are read from the audit log (`conversation.external_notice`, one row per notice), so a retry or a second run never says it twice: the
// message carries an idempotency key from the customer's message, and the audit row is written after it. Service role; every query names the business.

export const NOTICE_ACTION = "conversation.external_notice";
export const WAITING_EVENT = "chat.external_waiting";
export const NOTICE_EVERY_MS = 30 * 60_000;

const Ids = z.object({ tenantId: z.guid(), conversationId: z.guid(), messageId: z.guid() });
const MessageRow = z.object({ direction: z.string(), sender: z.string() });
const ConversationRow = z.object({ contact_id: z.string(), mode: z.string(), assigned_user_id: z.string().nullable() });
const ContactRow = z.object({ language: z.string().nullable(), opted_out_at: z.string().nullable() });

export type ExternalNoticeResult =
  | { status: "told" }
  | { status: "skipped"; reason: "not_a_customer_message" | "not_external" | "no_staff_member" | "opted_out" | "told_recently" | "not_sent" };

export interface ExternalNoticeDeps {
  db: SupabaseClient;
  now: () => Date;
  userName: (userId: string) => Promise<string | null>;
  send: (tenantId: string, kind: "ai_reply", payload: NotifyPayload) => Promise<SendOutcome>;
  sendEvent: (event: { id: string; name: string; data: Record<string, string> }) => Promise<unknown>;
}

const defaults = (): ExternalNoticeDeps => ({
  db: supabaseAdmin(),
  now: () => new Date(),
  userName: async (userId) => {
    const { data, error } = await supabaseAdmin().auth.admin.getUserById(userId);
    if (error || !data.user) return null;
    const meta = data.user.user_metadata as Record<string, unknown> | undefined;
    const named = [meta?.full_name, meta?.name].find((v): v is string => typeof v === "string" && v.trim() !== "");
    return (named ?? data.user.email?.split("@")[0] ?? "").trim() || null;
  },
  send: (tenantId, kind, payload) => send(tenantId, kind, payload),
  sendEvent: (event) => inngest.send(event),
});

function rows<S extends z.ZodType>(schema: S, result: { data: unknown; error: { code?: string } | null }, what: string): z.infer<S>[] {
  if (result.error) throw new Error(`external-notice: ${what} could not be read (database error ${result.error.code ?? "none"})`);
  return (Array.isArray(result.data) ? result.data : []).flatMap((row) => {
    const parsed = schema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

export async function tellCustomerTeamIsHandling(rawIds: unknown, deps: ExternalNoticeDeps = defaults()): Promise<ExternalNoticeResult> {
  const { tenantId, conversationId, messageId } = Ids.parse(rawIds);
  const { db } = deps;

  const [message] = rows(MessageRow, await db.from("messages").select("direction, sender").eq("tenant_id", tenantId).eq("conversation_id", conversationId).eq("id", messageId).limit(1), "the message");
  if (!message || message.direction !== "in" || message.sender !== "customer") return { status: "skipped", reason: "not_a_customer_message" };

  const [chat] = rows(ConversationRow, await db.from("conversations").select("contact_id, mode, assigned_user_id").eq("tenant_id", tenantId).eq("id", conversationId).limit(1), "the chat");
  if (!chat || chat.mode !== "external") return { status: "skipped", reason: "not_external" };
  if (!chat.assigned_user_id) return { status: "skipped", reason: "no_staff_member" };

  const [contact] = rows(ContactRow, await db.from("contacts").select("language, opted_out_at").eq("tenant_id", tenantId).eq("id", chat.contact_id).limit(1), "the customer");
  if (!contact || contact.opted_out_at) return { status: "skipped", reason: "opted_out" };

  const since = new Date(deps.now().getTime() - NOTICE_EVERY_MS).toISOString();
  const recent = await db.from("audit_logs").select("id").eq("tenant_id", tenantId).eq("action", NOTICE_ACTION).eq("entity_id", conversationId).gt("created_at", since).limit(1);
  if (rows(z.object({ id: z.string() }), recent, "the last notice").length > 0) return { status: "skipped", reason: "told_recently" };

  const name = (await deps.userName(chat.assigned_user_id).catch(() => null)) ?? "A team member";
  const outcome = await deps.send(tenantId, "ai_reply", { conversationId, text: externalNotice(contact.language, name), idempotencyKey: `external_notice:${messageId}` }).catch(() => null);
  if (!outcome) return { status: "skipped", reason: "not_sent" }; // the send threw: nothing is marked, the customer's next message tries again

  // The window starts when the customer was last spoken to or, if the business had no credits or the window was closed, when they were last tried.
  await db.from("audit_logs").insert({ tenant_id: tenantId, actor: "ai", action: NOTICE_ACTION, entity: "conversation", entity_id: conversationId, diff: { staff_user_id: chat.assigned_user_id } });
  await deps.sendEvent({ id: `external_waiting:${messageId}`, name: WAITING_EVENT, data: { tenantId, conversationId, messageId } }).catch(() => console.error(`[external-notice] the waiting event could not be sent (business ${tenantId})`));
  return outcome.status === "sent" ? { status: "told" } : { status: "skipped", reason: "not_sent" };
}
