import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase-admin";
import type { SendOutcome } from "../notify/send";
import { sendStaffAlert, staffAlertRecipients, type StaffAlert } from "../notify/staff-alerts";
import { inngest } from "./client";

// handoff.opened → if no one has picked the chat up within the SLA, the owner is alerted again (docs/handover.md,
// jobs: handoff-sla). The SLA is the business's `sla_minutes` (tenant_features.settings of handoff_triggers), else
// 15 minutes (Proposed, to confirm with Raja), counted from when the event arrives (handoffs has no opened time).
// Picked up means any of: the handoff was picked up, assigned or resolved; a staff member took the chat over (it
// has an assigned person); or the chat is no longer waiting for a person (back with the AI, or handled from the
// business's own number). One step per owner, so a retry never re-alerts someone.

const HandoffOpened = z.object({ tenantId: z.guid(), handoffId: z.guid(), conversationId: z.guid() });

export const DEFAULT_SLA_MINUTES = 15;
export const SlaSettings = z.object({ sla_minutes: z.number().int().min(1).max(24 * 60) });

/** The business's SLA in minutes (1 to 1440), else the default. */
export async function slaMinutes(tenantId: string, db: SupabaseClient): Promise<number> {
  const { data, error } = await db.from("tenant_features").select("settings").eq("tenant_id", tenantId).eq("feature_key", "handoff_triggers").limit(1);
  if (error) throw new Error(`handoff-sla: settings read failed: ${error.message}`);
  const [row] = z.array(z.object({ settings: z.unknown() })).max(1).parse(data ?? []);
  const set = SlaSettings.safeParse(row?.settings);
  return set.success ? set.data.sla_minutes : DEFAULT_SLA_MINUTES;
}

const HandoffRow = z.object({ picked_at: z.string().nullable(), resolved_at: z.string().nullable(), assigned_user_id: z.string().nullable() });
const ConversationRow = z.object({ mode: z.string(), assigned_user_id: z.string().nullable() });

/** Whether someone has the chat: true or false, or null when the handoff or chat no longer exists. */
export async function isPickedUp(tenantId: string, handoffId: string, conversationId: string, db: SupabaseClient): Promise<boolean | null> {
  const handoffRead = await db.from("handoffs").select("picked_at, resolved_at, assigned_user_id").eq("tenant_id", tenantId).eq("id", handoffId).limit(1);
  if (handoffRead.error) throw new Error(`handoff-sla: handoff read failed: ${handoffRead.error.message}`);
  const [handoff] = z.array(HandoffRow).max(1).parse(handoffRead.data ?? []);
  if (!handoff) return null;
  if (handoff.picked_at || handoff.resolved_at || handoff.assigned_user_id) return true;

  const chatRead = await db.from("conversations").select("mode, assigned_user_id").eq("tenant_id", tenantId).eq("id", conversationId).limit(1);
  if (chatRead.error) throw new Error(`handoff-sla: conversation read failed: ${chatRead.error.message}`);
  const [chat] = z.array(ConversationRow).max(1).parse(chatRead.data ?? []);
  if (!chat) return null;
  return chat.mode !== "human" || chat.assigned_user_id !== null;
}

type StepResult = { status: "sent" } | { status: "skipped"; reason: string } | { status: "failed"; code: string };

export interface HandoffSlaDeps {
  slaMinutes: (tenantId: string) => Promise<number>;
  pickedUp: (tenantId: string, handoffId: string, conversationId: string) => Promise<boolean | null>;
  owners: (tenantId: string) => Promise<string[]>;
  /** `idempotencyKey` names this exact alert, so a replayed event or a repeat run never sends it twice (notify.send). */
  alert: (tenantId: string, userId: string, alert: StaffAlert, idempotencyKey: string) => Promise<SendOutcome>;
}

const defaults = (): HandoffSlaDeps => ({
  slaMinutes: (tenantId) => slaMinutes(tenantId, supabaseAdmin()),
  pickedUp: (tenantId, handoffId, conversationId) => isPickedUp(tenantId, handoffId, conversationId, supabaseAdmin()),
  owners: (tenantId) => staffAlertRecipients(tenantId, undefined, ["owner"]),
  alert: (tenantId, userId, alert, idempotencyKey) => sendStaffAlert(tenantId, userId, alert, undefined, { idempotencyKey }),
});

interface Step {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
  sleep(id: string, duration: string): Promise<unknown>;
}

export async function handleHandoffSla({ event, step }: { event: { data: unknown }; step: Step }, deps: HandoffSlaDeps = defaults()) {
  const { tenantId, handoffId, conversationId } = HandoffOpened.parse(event.data);

  const minutes = await step.run("sla", () => deps.slaMinutes(tenantId));
  await step.sleep("wait-sla", `${minutes}m`);

  const pickedUp = await step.run("check", () => deps.pickedUp(tenantId, handoffId, conversationId));
  if (pickedUp === null) return { skipped: "handoff_not_found" as const };
  if (pickedUp) return { skipped: "picked_up" as const };

  const owners = await step.run("owners", () => deps.owners(tenantId));
  const results: ({ userId: string } & StepResult)[] = [];
  for (const userId of owners) {
    const result = await step.run(`escalate-${userId}`, async (): Promise<StepResult> => {
      const outcome = await deps.alert(tenantId, userId, { kind: "handoff_waiting", conversationId, waitedMinutes: minutes }, `handoff_sla:${handoffId}:${userId}`);
      if (outcome.status === "sent") return { status: "sent" };
      if (outcome.status === "skipped") return { status: "skipped", reason: outcome.reason };
      // Throwing makes Inngest retry this step; never when WhatsApp may already have delivered it.
      if (outcome.error.retryable && !outcome.error.outcomeUnknown) throw new Error(`escalation not sent (${outcome.error.code}), will retry`);
      return { status: "failed", code: outcome.error.code };
    });
    results.push({ userId, ...result });
  }
  return { minutes, results };
}

// Every step value above is plain JSON, so Inngest's serialised step results are the same values.
export const handoffSla = inngest.createFunction({ id: "handoff-sla", triggers: [{ event: "handoff.opened" }] }, (ctx) =>
  handleHandoffSla({
    event: ctx.event,
    step: {
      run: <T>(id: string, fn: () => Promise<T>) => ctx.step.run(id, fn) as unknown as Promise<T>,
      sleep: (id: string, duration: string) => ctx.step.sleep(id, duration),
    },
  }),
);
