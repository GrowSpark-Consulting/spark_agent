import { z } from "zod";
import { loadOwnNumberHandoff, outcomeButtons, outcomeDelay, type OwnNumberHandoff } from "../leads/own-number-outcome";
import { supabaseAdmin } from "../lib/supabase-admin";
import { send, type NotifyPayload, type SendOutcome } from "../notify/send";
import { staffAlertContent, type StaffAlert } from "../notify/staff-alerts";
import { inngest } from "./client";

// handoff.own_number → after 4 hours (the business's `outcome_after_minutes`), the staff member who took the chat to
// their own number is asked how it went: Booked, Follow-up or Lost buttons inside their 24-hour window, the staff_alert
// template (the question and the chat's link) outside it. A handoff that already has an answer is not asked about.
// Dev 1 sends handoff.own_number when the own-number takeover lands; until then this job waits for it.

const OwnNumber = z.object({ tenantId: z.guid(), handoffId: z.guid() });

type StepResult = { status: "sent" } | { status: "skipped"; reason: string } | { status: "failed"; code: string };

export interface OwnNumberOutcomeDeps {
  delay: (tenantId: string) => Promise<number>;
  handoff: (tenantId: string, handoffId: string) => Promise<OwnNumberHandoff | null>;
  content: (tenantId: string, alert: StaffAlert) => Promise<{ headline: string; link: string }>;
  send: (tenantId: string, kind: "staff_alert", payload: NotifyPayload) => Promise<SendOutcome>;
}

const defaults = (): OwnNumberOutcomeDeps => ({
  delay: (tenantId) => outcomeDelay(tenantId, supabaseAdmin()),
  handoff: (tenantId, handoffId) => loadOwnNumberHandoff(tenantId, handoffId, supabaseAdmin()),
  content: (tenantId, alert) => staffAlertContent(tenantId, alert),
  send: (tenantId, kind, payload) => send(tenantId, kind, payload),
});

interface Step {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
  sleep(id: string, duration: string): Promise<unknown>;
}

export async function handleOwnNumberOutcome({ event, step }: { event: { data: unknown }; step: Step }, deps: OwnNumberOutcomeDeps = defaults()) {
  const { tenantId, handoffId } = OwnNumber.parse(event.data);
  const minutes = await step.run("delay", () => deps.delay(tenantId));
  await step.sleep("wait-outcome", `${minutes}m`);

  const ask = await step.run("ask", async (): Promise<StepResult> => {
    const handoff = await deps.handoff(tenantId, handoffId);
    if (!handoff) return { status: "skipped", reason: "handoff_not_found" };
    if (handoff.outcome) return { status: "skipped", reason: "already_answered" };
    if (!handoff.staffUserId) return { status: "skipped", reason: "no_staff_member" };
    const { headline, link } = await deps.content(tenantId, { kind: "own_number_outcome", conversationId: handoff.conversationId });
    const outcome = await deps.send(tenantId, "staff_alert", {
      staffUserId: handoff.staffUserId,
      interactive: outcomeButtons(handoffId, headline),
      text: `${headline}\n${link}`,
      templateParams: [headline, link],
      idempotencyKey: `own_number_outcome:${handoffId}`,
    });
    if (outcome.status === "sent") return { status: "sent" };
    if (outcome.status === "skipped") return { status: "skipped", reason: outcome.reason };
    // Throwing makes Inngest retry this step; never when WhatsApp may already have delivered it.
    if (outcome.error.retryable && !outcome.error.outcomeUnknown) throw new Error(`outcome question not sent (${outcome.error.code}), will retry`);
    return { status: "failed", code: outcome.error.code };
  });
  return { minutes, ask };
}

export const ownNumberOutcome = inngest.createFunction({ id: "own-number-outcome", triggers: [{ event: "handoff.own_number" }] }, (ctx) =>
  handleOwnNumberOutcome({
    event: ctx.event,
    step: {
      run: <T>(id: string, fn: () => Promise<T>) => ctx.step.run(id, fn) as unknown as Promise<T>,
      sleep: (id: string, duration: string) => ctx.step.sleep(id, duration),
    },
  }),
);
