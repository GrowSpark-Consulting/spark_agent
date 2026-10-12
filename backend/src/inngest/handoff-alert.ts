import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase-admin";
import { sendStaffAlert, staffAlertRecipients, type StaffAlert, type StaffAlertKind } from "../notify/staff-alerts";
import type { SendOutcome } from "../notify/send";
import { inngest } from "./client";

// handoff.opened → a staff alert to every recipient (docs/contracts.md, section 5). Dev 1's reply step opens the
// handoff and emits the event (id handoff_opened:<handoffId>, so Inngest drops a repeat); this is the one place
// the alert is sent from. One step per recipient: a retry never re-sends to someone who already got it. A
// failure WhatsApp may still have delivered (outcomeUnknown) is not retried. Each recipient's alert carries the lead
// card and their own take-over links (notify/staff-alerts.ts); the card is built inside the step, so no customer's
// words are kept in Inngest's step results.

const HandoffOpened = z.object({ tenantId: z.guid(), handoffId: z.guid(), conversationId: z.guid() });

/** Which alert a handoff trigger raises. */
export function alertKindFor(trigger: string): StaffAlertKind {
  if (trigger === "credits_exhausted") return "credits_exhausted";
  if (trigger === "stuck") return "setup_problem";
  if (trigger === "opt_out") return "opted_out";
  return "handoff_opened";
}

type StepResult = { status: "sent" } | { status: "skipped"; reason: string } | { status: "failed"; code: string };

export interface HandoffAlertDeps {
  db: SupabaseClient;
  recipients: (tenantId: string) => Promise<string[]>;
  alert: (tenantId: string, userId: string, alert: StaffAlert) => Promise<SendOutcome>;
}

const defaults = (): HandoffAlertDeps => ({
  db: supabaseAdmin(),
  recipients: (tenantId) => staffAlertRecipients(tenantId),
  alert: (tenantId, userId, alert) => sendStaffAlert(tenantId, userId, alert),
});

interface Step {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

export async function handleHandoffOpened(
  { event, step }: { event: { data: unknown }; step: Step },
  deps: HandoffAlertDeps = defaults(),
) {
  const { tenantId, handoffId, conversationId } = HandoffOpened.parse(event.data);

  const handoff = await step.run("load-handoff", async () => {
    const { data, error } = await deps.db
      .from("handoffs")
      .select("trigger, priority, resolved_at")
      .eq("tenant_id", tenantId)
      .eq("id", handoffId)
      .maybeSingle();
    if (error) throw new Error(`handoff-alert: handoff read failed: ${error.message}`);
    return (data as { trigger: string; priority: string | null; resolved_at: string | null } | null) ?? null;
  });
  if (!handoff) return { skipped: "handoff_not_found" as const };
  if (handoff.resolved_at) return { skipped: "already_resolved" as const };

  const kind = alertKindFor(handoff.trigger);
  const recipients = await step.run("recipients", () => deps.recipients(tenantId));
  const results: ({ userId: string } & StepResult)[] = [];
  for (const userId of recipients) {
    const result = await step.run(`alert-${userId}`, async (): Promise<StepResult> => {
      const outcome = await deps.alert(tenantId, userId, { kind, conversationId, handoffId, priority: handoff.priority === "high" ? "high" : "normal" });
      if (outcome.status === "sent") return { status: "sent" };
      if (outcome.status === "skipped") return { status: "skipped", reason: outcome.reason };
      // Throwing makes Inngest retry this step; never when WhatsApp may already have delivered it.
      if (outcome.error.retryable && !outcome.error.outcomeUnknown) throw new Error(`staff alert not sent (${outcome.error.code}), will retry`);
      return { status: "failed", code: outcome.error.code };
    });
    results.push({ userId, ...result });
  }
  return { kind, results };
}

// Every step value above is plain JSON, so Inngest's serialised step results are the same values.
export const handoffAlert = inngest.createFunction({ id: "handoff-alert", triggers: [{ event: "handoff.opened" }] }, (ctx) =>
  handleHandoffOpened({
    event: ctx.event,
    step: { run: <T>(id: string, fn: () => Promise<T>) => ctx.step.run(id, fn) as unknown as Promise<T> },
  }),
);
