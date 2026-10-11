import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase-admin";
import { inngest } from "./client";

// chat.phone_reply → 24 hours later, the AI takes the chat back if nobody on the team has replied since (Raja, 11 Oct, question 6: "the customer
// never goes unanswered"). The event is sent by the webhook when the owner's reply from the phone app (a coexistence echo) switched an AI chat to a
// person (channels/whatsapp/inbound.ts). One run per echo, each waiting 24 hours and then looking: a later reply by the team makes the earlier
// runs do nothing and the last run decide, so no debounce is needed and a repeat is harmless.
//
// It only hands back a chat nobody has claimed: still with a person (`human`), no team member assigned, and no reply from the team (the owner's phone
// replies and inbox replies are both `staff` messages) in the last 24 hours. A chat staff took over in the inbox, or are handling from their own
// number, is theirs to hand back. Handing it back adds a note, closes the chat's open handoffs (as Return to AI does, so "needs a person" goes off and
// the escalation job is not misled) and writes an audit row. Service role: every query names the business from the event.

export const WAIT = "24h";
const WAIT_MS = 24 * 60 * 60_000;
export const RETURN_NOTE = "No one on the team replied for 24 hours, so the AI has taken this chat back. It will reply to new messages.";

const PhoneReply = z.object({ tenantId: z.guid(), conversationId: z.guid() });

interface Step {
  sleep(id: string, duration: string): Promise<unknown>;
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

export interface PhoneReplyReturnDeps {
  db: SupabaseClient;
  now: () => Date;
}

const defaults = (): PhoneReplyReturnDeps => ({ db: supabaseAdmin(), now: () => new Date() });

type Result = { returned: true } | { skipped: "chat_not_found" | "not_waiting_for_the_team" | "team_replied_recently" };

export async function handlePhoneReplyReturn({ event, step }: { event: { data: unknown }; step: Step }, deps: PhoneReplyReturnDeps = defaults()): Promise<Result> {
  const { tenantId, conversationId } = PhoneReply.parse(event.data);
  await step.sleep("wait-24h", WAIT);

  return step.run("return", async (): Promise<Result> => {
    const { db } = deps;
    const now = deps.now();

    const chat = await db.from("conversations").select("id, mode, assigned_user_id").eq("tenant_id", tenantId).eq("id", conversationId).limit(1);
    if (chat.error) throw new Error(`phone-reply-return: the chat could not be read (database error ${chat.error.code ?? "none"})`);
    const [conversation] = z.array(z.object({ mode: z.string(), assigned_user_id: z.string().nullable() })).parse(chat.data ?? []);
    if (!conversation) return { skipped: "chat_not_found" };
    if (conversation.mode !== "human" || conversation.assigned_user_id !== null) return { skipped: "not_waiting_for_the_team" };

    const lastReply = await db
      .from("messages")
      .select("created_at")
      .eq("tenant_id", tenantId)
      .eq("conversation_id", conversationId)
      .eq("sender", "staff")
      .order("created_at", { ascending: false })
      .limit(1);
    if (lastReply.error) throw new Error(`phone-reply-return: the last reply could not be read (database error ${lastReply.error.code ?? "none"})`);
    const [last] = z.array(z.object({ created_at: z.string() })).parse(lastReply.data ?? []);
    if (last && now.getTime() - Date.parse(last.created_at) < WAIT_MS) return { skipped: "team_replied_recently" };

    // Compare-and-set on what we read: if the team claimed the chat, or the AI got it back, meanwhile, nothing is overwritten.
    const switched = await db
      .from("conversations")
      .update({ mode: "ai" })
      .eq("id", conversationId)
      .eq("tenant_id", tenantId)
      .eq("mode", "human")
      .is("assigned_user_id", null)
      .select("id");
    if (switched.error) throw new Error(`phone-reply-return: the chat could not be switched (database error ${switched.error.code ?? "none"})`);
    if (!Array.isArray(switched.data) || switched.data.length === 0) return { skipped: "not_waiting_for_the_team" };

    // The switch is what matters; the note, the handoffs and the audit row are best effort and never undo it.
    await db.from("messages").insert({ tenant_id: tenantId, conversation_id: conversationId, direction: "out", sender: "system", body: RETURN_NOTE, meta: { event: "auto_return" } });
    await db.from("handoffs").update({ resolved_at: now.toISOString(), outcome: "auto_returned" }).eq("tenant_id", tenantId).eq("conversation_id", conversationId).is("resolved_at", null);
    await db.from("audit_logs").insert({
      tenant_id: tenantId,
      actor: "system",
      action: "conversation.mode_changed",
      entity: "conversation",
      entity_id: conversationId,
      diff: { from: "human", to: "ai", reason: "no_team_reply_24h" },
    });
    return { returned: true };
  });
}

export const phoneReplyReturn = inngest.createFunction({ id: "phone-reply-return", triggers: [{ event: "chat.phone_reply" }] }, (ctx) =>
  handlePhoneReplyReturn({
    event: ctx.event,
    step: {
      sleep: (id, duration) => ctx.step.sleep(id, duration),
      run: <T>(id: string, fn: () => Promise<T>) => ctx.step.run(id, fn) as unknown as Promise<T>,
    },
  }),
);
