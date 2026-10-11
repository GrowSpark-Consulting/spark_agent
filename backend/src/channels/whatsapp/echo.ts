import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { WebhookDbError } from "./inbound-db";

// Coexistence echoes (Day 4, Raja 11 Oct): the business owner replies to a customer from the WhatsApp Business APP on their phone. Meta sends us a
// copy (`smb_message_echoes`, parsed by parse.ts). Here it is kept as a STAFF message of the chat, and the chat goes to a person at once, so the
// assistant never answers on top of the owner. Only when the AI had the chat: a chat staff already have (human, or their own number) is left alone.
//
// What it never does: make a customer or a chat of its own (the owner may be writing to anyone), send anything, or charge a credit. Service role,
// so every query names the business, which comes from the verified connection, never from the payload. A database error is thrown with its code
// only (WebhookDbError): the webhook answers 500 and Meta retries, which is safe because the message id is unique.
//
// Live after Embedded Signup is approved. The 24-hour return to the AI is the phone-reply-return job (inngest/phone-reply-return.ts).

export const ECHO_NOTE = "The owner replied from the phone app, so the AI has paused. It will take over again after 24 hours without a reply from the team.";

export interface EchoArgs {
  tenantId: string;
  channelId: string;
  customerPhone: string;
  providerMsgId: string;
  kind: "text" | "unsupported";
  body: string | null;
  unsupportedType?: string;
  sentAt: string;
}

export type EchoOutcome =
  | { status: "stored"; conversationId: string; messageId: string; /** The chat was the AI's and is now a person's: the 24-hour return is waiting. */ switched: boolean }
  | { status: "duplicate" }
  | { status: "no_contact" }
  | { status: "no_conversation" };

const Id = z.object({ id: z.string() });
const Conversation = z.object({ id: z.string(), mode: z.enum(["ai", "human", "external"]) });

const rows = <S extends z.ZodType>(schema: S, data: unknown): z.infer<S>[] =>
  (Array.isArray(data) ? data : []).flatMap((row) => {
    const parsed = schema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });

export async function storeEchoedMessage(db: SupabaseClient, args: EchoArgs): Promise<EchoOutcome> {
  const { tenantId } = args;

  const contact = await db.from("contacts").select("id").eq("tenant_id", tenantId).eq("phone", args.customerPhone).limit(1);
  if (contact.error) throw new WebhookDbError("echo contact lookup", contact.error.code);
  const [customer] = rows(Id, contact.data);
  if (!customer) return { status: "no_contact" };

  const found = await db
    .from("conversations")
    .select("id, mode")
    .eq("tenant_id", tenantId)
    .eq("contact_id", customer.id)
    .eq("channel_id", args.channelId)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(1);
  if (found.error) throw new WebhookDbError("echo conversation lookup", found.error.code);
  const [conversation] = rows(Conversation, found.data);
  if (!conversation) return { status: "no_conversation" };

  const inserted = await db
    .from("messages")
    .insert({
      tenant_id: tenantId,
      conversation_id: conversation.id,
      direction: "out",
      sender: "staff",
      kind: args.kind,
      body: args.body,
      provider_msg_id: args.providerMsgId,
      delivery_status: "sent",
      credits_charged: 0,
      created_at: args.sentAt,
      meta: { source: "phone_app", ...(args.unsupportedType ? { unsupportedType: args.unsupportedType } : {}) },
    })
    .select("id");
  if (inserted.error) {
    if (inserted.error.code === "23505") return { status: "duplicate" }; // Meta repeats webhooks: the message id is the dedupe key
    throw new WebhookDbError("echo insert", inserted.error.code);
  }
  const [message] = rows(Id, inserted.data);
  if (!message) throw new WebhookDbError("echo insert", "none");

  let switched = false;
  if (conversation.mode === "ai") {
    // Compare-and-set on the mode we read: if a person or the AI changed it meanwhile, nothing is overwritten.
    const changed = await db.from("conversations").update({ mode: "human" }).eq("id", conversation.id).eq("tenant_id", tenantId).eq("mode", "ai").select("id");
    if (changed.error) throw new WebhookDbError("echo mode switch", changed.error.code);
    switched = rows(Id, changed.data).length > 0;
    if (switched) {
      // The switch is what matters; the note and the audit row are best effort and never undo it.
      await db.from("messages").insert({ tenant_id: tenantId, conversation_id: conversation.id, direction: "out", sender: "system", body: ECHO_NOTE, meta: { event: "phone_reply" } });
      await db.from("audit_logs").insert({
        tenant_id: tenantId,
        actor: "system",
        action: "conversation.mode_changed",
        entity: "conversation",
        entity_id: conversation.id,
        diff: { from: "ai", to: "human", reason: "phone_reply" },
      });
    }
  }
  return { status: "stored", conversationId: conversation.id, messageId: message.id, switched };
}
