import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { writeAudit } from "../lib/audit";
import type { Interactive } from "../notify/interactive";

// The own-number outcome (docs/handover.md, jobs: own-number-outcome, "asks the staff member for the outcome after 4 h"):
// a staff member who took a chat to their own WhatsApp number is asked how it went, with Booked, Follow-up and Lost
// buttons. The job is inngest/own-number-outcome.ts; Dev 1's pipeline records the tap with recordHandoffOutcome.

export const OUTCOMES = ["booked", "follow_up", "lost"] as const;
export type HandoffOutcome = (typeof OUTCOMES)[number];
const TITLES: Record<HandoffOutcome, string> = { booked: "Booked", follow_up: "Follow-up", lost: "Lost" };

export const DEFAULT_OUTCOME_AFTER_MINUTES = 240;
const DelaySettings = z.object({ outcome_after_minutes: z.number().int().min(1).max(7 * 24 * 60) });

/** Minutes after the takeover before asking (handoff_own_number's `outcome_after_minutes`), else 4 hours. */
export async function outcomeDelay(tenantId: string, db: SupabaseClient): Promise<number> {
  const { data, error } = await db.from("tenant_features").select("settings").eq("tenant_id", tenantId).eq("feature_key", "handoff_own_number").limit(1);
  if (error) throw new Error(`own-number outcome: settings read failed: ${error.message}`);
  const [row] = z.array(z.object({ settings: z.unknown() })).max(1).parse(data ?? []);
  const set = DelaySettings.safeParse(row?.settings);
  return set.success ? set.data.outcome_after_minutes : DEFAULT_OUTCOME_AFTER_MINUTES;
}

export interface OwnNumberHandoff {
  conversationId: string;
  /** The staff member who took it (handoffs.assigned_user_id). */
  staffUserId: string | null;
  outcome: string | null;
}

const HandoffRow = z.object({ conversation_id: z.guid(), assigned_user_id: z.string().nullable(), outcome: z.string().nullable() });

/** The handoff, read for this business only; null when it has no such handoff. */
export async function loadOwnNumberHandoff(tenantId: string, handoffId: string, db: SupabaseClient): Promise<OwnNumberHandoff | null> {
  const { data, error } = await db.from("handoffs").select("conversation_id, assigned_user_id, outcome").eq("tenant_id", tenantId).eq("id", handoffId).limit(1);
  if (error) throw new Error(`own-number outcome: handoff read failed: ${error.message}`);
  const [row] = z.array(HandoffRow).max(1).parse(data ?? []);
  return row ? { conversationId: row.conversation_id, staffUserId: row.assigned_user_id, outcome: row.outcome } : null;
}

/** The question with the three answers as buttons; each id names the handoff (`outcome:<handoffId>:<outcome>`). */
export function outcomeButtons(handoffId: string, question: string): Interactive {
  return { type: "buttons", body: question, buttons: OUTCOMES.map((o) => ({ id: `outcome:${handoffId}:${o}`, title: TITLES[o] })) };
}

const OutcomeButton = /^outcome:([0-9a-f-]{36}):(booked|follow_up|lost)$/i;

/** A tap on an outcome button (the inbound message's buttonId), or null for any other id. */
export function parseOutcomeButton(buttonId: string): { handoffId: string; outcome: HandoffOutcome } | null {
  const match = OutcomeButton.exec(buttonId);
  if (!match || !z.guid().safeParse(match[1]).success) return null;
  return { handoffId: match[1].toLowerCase(), outcome: match[2].toLowerCase() as HandoffOutcome };
}

/** Lead stage for an answer; follow-up leaves the lead where it is. */
const STAGE_FOR: Partial<Record<HandoffOutcome, string>> = { booked: "booked", lost: "lost" };

/**
 * Records the staff member's answer: the handoff gets its outcome and is resolved, the lead moves to booked or lost
 * (follow-up leaves it), and it is audited. The first answer wins. False when the handoff is not this business's or
 * already has an answer.
 */
export async function recordHandoffOutcome(
  tenantId: string,
  handoffId: string,
  outcome: HandoffOutcome,
  actor: string,
  db: SupabaseClient,
): Promise<boolean> {
  if (!(OUTCOMES as readonly string[]).includes(outcome)) throw new Error("recordHandoffOutcome: unknown outcome");
  const saved = await db
    .from("handoffs")
    .update({ outcome, resolved_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("id", handoffId)
    .is("outcome", null)
    .select("conversation_id");
  if (saved.error) throw new Error(`own-number outcome: saving the outcome failed: ${saved.error.message}`);
  const [handoff] = z.array(z.object({ conversation_id: z.guid() })).max(1).parse(saved.data ?? []);
  if (!handoff) return false;

  const stage = STAGE_FOR[outcome];
  if (stage) {
    const chat = await db.from("conversations").select("contact_id").eq("tenant_id", tenantId).eq("id", handoff.conversation_id).limit(1);
    if (chat.error) throw new Error(`own-number outcome: conversation read failed: ${chat.error.message}`);
    const [row] = z.array(z.object({ contact_id: z.guid() })).max(1).parse(chat.data ?? []);
    if (row) {
      const moved = await db.from("leads").update({ stage, updated_at: new Date().toISOString() }).eq("tenant_id", tenantId).eq("contact_id", row.contact_id).not("stage", "in", "(won,lost)");
      if (moved.error) throw new Error(`own-number outcome: lead update failed: ${moved.error.message}`);
    }
  }
  await writeAudit({ tenantId, actor, action: "handoff.outcome_recorded", entity: "handoff", entityId: handoffId, diff: { outcome } });
  return true;
}
