import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { oneLine } from "../booking/reminders";
import { writeAudit } from "../lib/audit";

// Lead nudges (docs/handover.md, jobs: lead-nudges): a lead the assistant was talking to goes quiet, so it gets a
// nudge after 2 hours and another before its 24-hour window closes, and if it stays quiet it moves to nurture. The
// job is inngest/lead-nudges.ts; this file has the timing, the checks and the messages.

/** Stages where the conversation is still open: later stages (booked, visited, won, lost, nurture, human) get no nudge. */
export const NUDGEABLE_STAGES = ["new", "engaged", "qualified"] as const;

export interface NudgeTiming {
  /** Minutes after the customer's message for the first and second nudge. */
  offsetMinutes: [number, number];
  /** Minutes after the customer's message before a still-quiet lead moves to nurture. */
  nurtureAfterMinutes: number;
}

// The second nudge goes at 23 hours, so it is still free text inside the 24-hour window; outside it only the approved
// nudge template could go (decision 18).
export const DEFAULT_NUDGE_TIMING: NudgeTiming = { offsetMinutes: [120, 23 * 60], nurtureAfterMinutes: 48 * 60 };

const Minutes = z.number().int().min(1).max(7 * 24 * 60);
const TimingSettings = z
  .object({ offset_minutes: z.tuple([Minutes, Minutes]), nurture_after_minutes: Minutes })
  .refine((s) => s.offset_minutes[0] < s.offset_minutes[1] && s.offset_minutes[1] < s.nurture_after_minutes);

/** The business's timing (followup_nudges' settings), else the defaults. A test can set minutes. */
export async function nudgeTiming(tenantId: string, db: SupabaseClient): Promise<NudgeTiming> {
  const { data, error } = await db.from("tenant_features").select("settings").eq("tenant_id", tenantId).eq("feature_key", "followup_nudges").limit(1);
  if (error) throw new Error(`lead nudges: settings read failed: ${error.message}`);
  const [row] = z.array(z.object({ settings: z.unknown() })).max(1).parse(data ?? []);
  const set = TimingSettings.safeParse(row?.settings);
  return set.success ? { offsetMinutes: set.data.offset_minutes, nurtureAfterMinutes: set.data.nurture_after_minutes } : DEFAULT_NUDGE_TIMING;
}

/** Where the chat stands after the customer's message (the trigger): enough to decide whether to nudge. */
export interface NudgeState {
  /** The customer's message time, ISO 8601 UTC. */
  messageAt: string;
  /** The assistant answered that message (its message.answered audit marker). */
  answered: boolean;
  /** The customer has written again since. */
  repliedSince: boolean;
  mode: string;
  lead: { id: string; stage: string } | null;
  customerName: string | null;
}

const MessageRow = z.object({ created_at: z.string(), conversations: z.object({ mode: z.string(), contact_id: z.guid() }).nullable() });
const LeadRow = z.object({ id: z.guid(), stage: z.string() });

/** The chat's state for the trigger message, read for this business only; null when the message is not this business's. */
export async function loadNudgeState(tenantId: string, conversationId: string, messageId: string, db: SupabaseClient): Promise<NudgeState | null> {
  const messageRead = await db
    .from("messages")
    .select("created_at, conversations(mode, contact_id)")
    .eq("tenant_id", tenantId)
    .eq("conversation_id", conversationId)
    .eq("id", messageId)
    .eq("direction", "in")
    .limit(1);
  if (messageRead.error) throw new Error(`lead nudges: message read failed: ${messageRead.error.message}`);
  const [message] = z.array(MessageRow).max(1).parse(messageRead.data ?? []);
  if (!message?.conversations) return null;
  const { mode, contact_id: contactId } = message.conversations;

  const [answeredRead, laterRead, leadRead, contactRead] = await Promise.all([
    db.from("audit_logs").select("id").eq("tenant_id", tenantId).eq("action", "message.answered").eq("entity_id", messageId).limit(1),
    db.from("messages").select("id").eq("tenant_id", tenantId).eq("conversation_id", conversationId).eq("direction", "in").gt("created_at", message.created_at).limit(1),
    db.from("leads").select("id, stage").eq("tenant_id", tenantId).eq("contact_id", contactId).not("stage", "in", "(won,lost)").order("created_at", { ascending: true }).limit(1),
    db.from("contacts").select("name").eq("tenant_id", tenantId).eq("id", contactId).limit(1),
  ]);
  for (const read of [answeredRead, laterRead, leadRead, contactRead]) {
    if (read.error) throw new Error(`lead nudges: read failed: ${read.error.message}`);
  }
  const [lead] = z.array(LeadRow).max(1).parse(leadRead.data ?? []);
  const [contact] = z.array(z.object({ name: z.string().nullable() })).max(1).parse(contactRead.data ?? []);
  return {
    messageAt: new Date(message.created_at).toISOString(),
    answered: (answeredRead.data ?? []).length > 0,
    repliedSince: (laterRead.data ?? []).length > 0,
    mode,
    lead: lead ?? null,
    customerName: contact?.name?.trim() || null,
  };
}

/** Why there is no nudge, or null when one should go. */
export function nudgeBlocker(state: NudgeState): string | null {
  if (state.repliedSince) return "customer_replied";
  if (!state.answered) return "not_answered";
  if (state.mode !== "ai") return "not_with_assistant";
  if (!state.lead || !(NUDGEABLE_STAGES as readonly string[]).includes(state.lead.stage)) return "lead_not_open";
  return null;
}

/** The nudge: free text inside the window, or the nudge template outside it ({{1}} the customer's name). */
export function nudgeMessage(n: 1 | 2, customerName: string | null): { text: string; templateParams: string[] } {
  const name = customerName ? oneLine(customerName, 40) : "there";
  const text =
    n === 1
      ? `Hi ${name}, just checking in. Do you have any other questions? I'm happy to help.`
      : `Hi ${name}, if you'd still like help, just reply here and we'll pick up where we left off.`;
  return { text, templateParams: [name] };
}

/**
 * Moves a still-quiet lead to nurture, only from an open stage (a change made meanwhile wins), and audits it. True
 * when this call moved it.
 */
export async function moveToNurture(tenantId: string, leadId: string, db: SupabaseClient): Promise<boolean> {
  const { data, error } = await db
    .from("leads")
    .update({ stage: "nurture", updated_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("id", leadId)
    .in("stage", [...NUDGEABLE_STAGES])
    .select("id");
  if (error) throw new Error(`lead nudges: moving to nurture failed: ${error.message}`);
  if (!Array.isArray(data) || data.length === 0) return false;
  await writeAudit({ tenantId, actor: "system", action: "lead.stage_changed", entity: "lead", entityId: leadId, diff: { to: "nurture", reason: "no_reply_after_nudges" } });
  return true;
}
