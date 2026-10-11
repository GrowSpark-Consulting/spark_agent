import { z } from "zod";
import { MESSAGE_RECEIVED_EVENT } from "../agent/pipeline/events";
import { loadNudgeState, moveToNurture, nudgeBlocker, nudgeMessage, nudgeTiming, type NudgeState, type NudgeTiming } from "../leads/nudges";
import { supabaseAdmin } from "../lib/supabase-admin";
import { send, type NotifyPayload, type SendOutcome } from "../notify/send";
import { inngest } from "./client";

// whatsapp/message.received → lead nudges (docs/handover.md, jobs: lead-nudges). Every customer message starts a run
// and cancels the chat's earlier one, so only the latest message's run is alive: if the customer stays quiet after
// the assistant's answer, it nudges at the first and second offsets (2 h and 23 h by default) and, still quiet,
// moves the lead to nurture. Each step reads the chat again: a reply, a person taking the chat, a booked or closed
// lead, or a message the assistant never answered stops it. notify.send applies the followup_nudges toggle and plan,
// opt-out, the window and 1 credit per nudge.

const MessageReceived = z.object({ tenantId: z.guid(), conversationId: z.guid(), messageId: z.guid() });

type StepResult = { status: "sent" } | { status: "skipped"; reason: string } | { status: "failed"; code: string };

export interface LeadNudgesDeps {
  timing: (tenantId: string) => Promise<NudgeTiming>;
  state: (tenantId: string, conversationId: string, messageId: string) => Promise<NudgeState | null>;
  send: (tenantId: string, kind: "followup_nudge", payload: NotifyPayload) => Promise<SendOutcome>;
  nurture: (tenantId: string, leadId: string) => Promise<boolean>;
}

const defaults = (): LeadNudgesDeps => ({
  timing: (tenantId) => nudgeTiming(tenantId, supabaseAdmin()),
  state: (tenantId, conversationId, messageId) => loadNudgeState(tenantId, conversationId, messageId, supabaseAdmin()),
  send: (tenantId, kind, payload) => send(tenantId, kind, payload),
  nurture: (tenantId, leadId) => moveToNurture(tenantId, leadId, supabaseAdmin()),
});

interface Step {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
  sleepUntil(id: string, until: string): Promise<unknown>;
}

const after = (iso: string, minutes: number) => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

export async function handleLeadNudges({ event, step }: { event: { data: unknown }; step: Step }, deps: LeadNudgesDeps = defaults()) {
  const { tenantId, conversationId, messageId } = MessageReceived.parse(event.data);

  const plan = await step.run("plan", async () => {
    const state = await deps.state(tenantId, conversationId, messageId);
    if (!state) return null;
    return { messageAt: state.messageAt, timing: await deps.timing(tenantId) };
  });
  if (!plan) return { skipped: "message_not_found" as const };

  const nudges: ({ n: 1 | 2 } & StepResult)[] = [];
  for (const n of [1, 2] as const) {
    await step.sleepUntil(`wait-nudge-${n}`, after(plan.messageAt, plan.timing.offsetMinutes[n - 1]));
    const result = await step.run(`nudge-${n}`, async (): Promise<StepResult> => {
      const state = await deps.state(tenantId, conversationId, messageId);
      if (!state) return { status: "skipped", reason: "message_not_found" };
      const blocker = nudgeBlocker(state);
      if (blocker) return { status: "skipped", reason: blocker };
      const outcome = await deps.send(tenantId, "followup_nudge", {
        conversationId,
        ...nudgeMessage(n, state.customerName),
        idempotencyKey: `followup_nudge:${messageId}:${n}`,
      });
      if (outcome.status === "sent") return { status: "sent" };
      if (outcome.status === "skipped") return { status: "skipped", reason: outcome.reason };
      // Throwing makes Inngest retry this step; never when WhatsApp may already have delivered it.
      if (outcome.error.retryable && !outcome.error.outcomeUnknown) throw new Error(`nudge not sent (${outcome.error.code}), will retry`);
      return { status: "failed", code: outcome.error.code };
    });
    nudges.push({ n, ...result });
    // A nudge that could not go (the customer replied, the toggle is off, they opted out…) ends the follow-up.
    if (result.status !== "sent") return { nudges };
  }

  await step.sleepUntil("wait-nurture", after(plan.messageAt, plan.timing.nurtureAfterMinutes));
  const nurture = await step.run("nurture", async () => {
    const state = await deps.state(tenantId, conversationId, messageId);
    if (!state?.lead) return { moved: false, reason: "no_lead" };
    const blocker = nudgeBlocker(state);
    if (blocker) return { moved: false, reason: blocker };
    return { moved: await deps.nurture(tenantId, state.lead.id) };
  });
  return { nudges, nurture };
}

// Every step value above is plain JSON, so Inngest's serialised step results are the same values.
export const leadNudges = inngest.createFunction(
  {
    id: "lead-nudges",
    triggers: [{ event: MESSAGE_RECEIVED_EVENT }],
    // The chat's next customer message starts a fresh run; this one stops.
    cancelOn: [{ event: MESSAGE_RECEIVED_EVENT, match: "data.conversationId" }],
  },
  (ctx) =>
    handleLeadNudges({
      event: ctx.event,
      step: {
        run: <T>(id: string, fn: () => Promise<T>) => ctx.step.run(id, fn) as unknown as Promise<T>,
        sleepUntil: (id: string, until: string) => ctx.step.sleepUntil(id, until),
      },
    }),
);
