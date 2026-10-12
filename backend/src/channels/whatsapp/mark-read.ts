import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { TURN_TARGET_MS } from "../../agent/pipeline/turn-deadline";
import { supabaseAdmin } from "../../lib/supabase-admin";
import { markRead } from "./adapter";
import { loadSendConnection } from "./message-sender";

// The blue ticks. When the assistant is going to handle a customer's message (the pipeline's gate is open), the message is marked read through the Cloud
// API, so the customer sees it was received while the reply is worked out. It runs in the pipeline, not in the webhook: the webhook cannot know whether the
// assistant will answer, and its answer to Meta is never held up by anything here.
//
// Best effort in every way: a database failure, no connection, Meta refusing or not answering all end as a "skipped" status with a fixed reason, never an
// error, and nothing the customer said, no phone number and no id is ever logged. It uses the connection the reply goes out on (the conversation's channel,
// the business's oldest active connection, as notify_target does) and only ever reads. Marking a message read marks every earlier one too, so the newest of
// the turn's messages is enough; a repeat does nothing new.

/** The longest the call to Meta may take. The adapter's own default is 10 seconds, far too long to hold a reply for. */
export const MARK_READ_TIMEOUT_MS = 3000;
/** Less than this much of the turn's 10-second target left: the receipt is skipped, so it can never push a reply past its target. */
export const MARK_READ_MIN_LEFT_MS = 8000;

export type MarkReadResult = { status: "marked" } | { status: "skipped"; reason: "late" | "no_message" | "no_connection" | "refused" | "error" };

export interface MarkReadDeps {
  db: SupabaseClient;
  markRead: typeof markRead;
  now: () => number;
}

const defaults = (): MarkReadDeps => ({ db: supabaseAdmin(), markRead, now: Date.now });

const Wamid = z.array(z.object({ provider_msg_id: z.string().nullable() })).max(1);
const Channel = z.array(z.object({ channel_id: z.string() })).max(1);
const Connection = z.array(z.object({ id: z.string() })).max(1);

export async function markCustomerMessageRead(
  turn: { tenantId: string; conversationId: string; messageIds: string[] },
  deps: MarkReadDeps = defaults(),
): Promise<MarkReadResult> {
  try {
    if (turn.messageIds.length === 0) return { status: "skipped", reason: "no_message" };
    const { db } = deps;

    const messages = await db
      .from("messages")
      .select("provider_msg_id")
      .eq("tenant_id", turn.tenantId)
      .eq("conversation_id", turn.conversationId)
      .eq("direction", "in")
      .eq("sender", "customer")
      .in("id", turn.messageIds)
      .order("created_at", { ascending: false })
      .limit(1);
    if (messages.error) return { status: "skipped", reason: "error" };
    const [message] = Wamid.parse(messages.data ?? []);
    if (!message?.provider_msg_id) return { status: "skipped", reason: "no_message" };

    const conversation = await db.from("conversations").select("channel_id").eq("tenant_id", turn.tenantId).eq("id", turn.conversationId).limit(1);
    if (conversation.error) return { status: "skipped", reason: "error" };
    const [channel] = Channel.parse(conversation.data ?? []);
    if (!channel) return { status: "skipped", reason: "no_connection" };

    const connections = await db
      .from("whatsapp_connections")
      .select("id")
      .eq("tenant_id", turn.tenantId)
      .eq("channel_id", channel.channel_id)
      .eq("status", "active")
      .order("created_at", { ascending: true })
      .limit(1);
    if (connections.error) return { status: "skipped", reason: "error" };
    const [connection] = Connection.parse(connections.data ?? []);
    if (!connection) return { status: "skipped", reason: "no_connection" };

    const loaded = await loadSendConnection(db, { tenantId: turn.tenantId, connectionId: connection.id });
    const result = await deps.markRead(loaded, message.provider_msg_id, { timeoutMs: MARK_READ_TIMEOUT_MS });
    return result.ok ? { status: "marked" } : { status: "skipped", reason: "refused" };
  } catch {
    return { status: "skipped", reason: "error" };
  }
}

/**
 * The pipeline step: one memoised step, so a replay never decides twice. Skipped without touching the database or Meta when less than
 * `MARK_READ_MIN_LEFT_MS` of the turn's target remains (`startedAt` is when the turn began). Logs one fixed line.
 */
export async function markReadStep(
  steps: { run: <T>(id: string, fn: () => Promise<T>) => Promise<T> },
  turn: { tenantId: string; conversationId: string; messageIds: string[] },
  startedAt: number,
  deps?: MarkReadDeps,
): Promise<MarkReadResult> {
  const result = await steps.run("mark-read", async (): Promise<MarkReadResult> => {
    try {
      const d = deps ?? defaults();
      if (TURN_TARGET_MS - (d.now() - startedAt) < MARK_READ_MIN_LEFT_MS) return { status: "skipped", reason: "late" };
      return await markCustomerMessageRead(turn, d);
    } catch {
      return { status: "skipped", reason: "error" }; // even setting up the client (a missing setting) is never a reason to stop
    }
  });
  console.log(`[pipeline] mark read: ${result.status === "marked" ? "marked" : `skipped (${result.reason})`}`);
  return result;
}
