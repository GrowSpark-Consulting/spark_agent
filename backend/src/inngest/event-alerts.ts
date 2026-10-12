import { z } from "zod";
import { WAITING_EVENT } from "../agent/handoff/external-notice";
import { HOT_LEAD_EVENT, VOICE_NOTE_EVENT } from "../agent/pipeline/events";
import { supabaseAdmin } from "../lib/supabase-admin";
import type { SendOutcome } from "../notify/send";
import { sendStaffAlert, staffAlertRecipients, type StaffAlert, type StaffAlertKind } from "../notify/staff-alerts";
import { inngest } from "./client";

// Dev 1's events that tell staff something (docs/task-notes/2026-10-11-day4-dev1-handoff.md, section 3), as staff alerts:
//   lead.hot              → owners and admins: "Hot lead", with the lead card (Raja: a hot-lead alert says "hot lead" with
//                           the 2 to 5 line summary). Not a handoff, so no take-over links: the chat's dashboard link.
//   voice_note.received   → owners and admins: a voice note is waiting to be listened to.
//   chat.external_waiting → the staff member who has the chat on their own WhatsApp (conversations.assigned_user_id): the
//                           customer wrote again. Owners and admins if nobody has it.
// The events carry ids only; every word is read from the database. Free (staff_alert, behind staff_alerts). Each alert
// is keyed by the event and the member, so a retry never sends it twice.

const KIND_FOR_EVENT: Readonly<Record<string, StaffAlertKind>> = {
  [HOT_LEAD_EVENT]: "hot_lead",
  [VOICE_NOTE_EVENT]: "voice_note",
  [WAITING_EVENT]: "external_waiting",
};

const EventData = z.object({ tenantId: z.guid(), conversationId: z.guid() });

type StepResult = { status: "sent" } | { status: "skipped"; reason: string } | { status: "failed"; code: string };

export interface EventAlertDeps {
  recipients: (tenantId: string) => Promise<string[]>;
  /** The member who has the chat (own-number takeover), or null. */
  assignedTo: (tenantId: string, conversationId: string) => Promise<string | null>;
  alert: (tenantId: string, userId: string, alert: StaffAlert, idempotencyKey: string) => Promise<SendOutcome>;
}

async function assignedMember(tenantId: string, conversationId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin().from("conversations").select("assigned_user_id").eq("tenant_id", tenantId).eq("id", conversationId).maybeSingle();
  if (error) throw new Error(`event alerts: conversation read failed: ${error.message}`);
  return z.object({ assigned_user_id: z.string().nullable() }).nullable().parse(data)?.assigned_user_id ?? null;
}

const defaults = (): EventAlertDeps => ({
  recipients: (tenantId) => staffAlertRecipients(tenantId),
  assignedTo: assignedMember,
  alert: (tenantId, userId, alert, idempotencyKey) => sendStaffAlert(tenantId, userId, alert, undefined, { idempotencyKey }),
});

interface Step {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

export async function handleStaffEvent(
  { event, step }: { event: { name: string; id?: string; data: unknown }; step: Step },
  deps: EventAlertDeps = defaults(),
) {
  const kind = Object.hasOwn(KIND_FOR_EVENT, event.name) ? KIND_FOR_EVENT[event.name] : undefined;
  if (!kind) return { skipped: "unknown_event" as const };
  const { tenantId, conversationId } = EventData.parse(event.data);
  // Dev 1's ids name the moment (lead_hot:<lead>, voice_note:<message>, external_waiting:<message>).
  const eventKey = event.id ?? `${event.name}:${conversationId}`;

  const recipients = await step.run("recipients", async () => {
    if (kind === "external_waiting") {
      const member = await deps.assignedTo(tenantId, conversationId);
      if (member) return [member];
    }
    return deps.recipients(tenantId);
  });
  const results: ({ userId: string } & StepResult)[] = [];
  for (const userId of recipients) {
    const result = await step.run(`alert-${userId}`, async (): Promise<StepResult> => {
      const outcome = await deps.alert(tenantId, userId, { kind, conversationId }, `${eventKey}:${userId}`);
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

export const eventAlerts = inngest.createFunction(
  { id: "event-alerts", triggers: [{ event: HOT_LEAD_EVENT }, { event: VOICE_NOTE_EVENT }, { event: WAITING_EVENT }] },
  (ctx) =>
    handleStaffEvent({
      event: ctx.event,
      step: { run: <T>(id: string, fn: () => Promise<T>) => ctx.step.run(id, fn) as unknown as Promise<T> },
    }),
);
