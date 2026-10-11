import { z } from "zod";
import { noShowMessage } from "../booking/no-show";
import { loadReminderBooking, type ReminderBooking } from "../booking/reminders";
import { supabaseAdmin } from "../lib/supabase-admin";
import { send, type NotifyPayload, type SendOutcome } from "../notify/send";
import { inngest } from "./client";

// booking.changed with change "no_show" → the customer is offered a new time (noshow_rebooking: the toggle and plan,
// opt-out, the window and 1 credit are notify.send's). Read again first: a booking no longer marked no-show (staff
// corrected it) gets nothing. One offer per booking (idempotency key).

const NoShow = z.object({ tenantId: z.guid(), bookingId: z.guid() });

type StepResult = { status: "sent" } | { status: "skipped"; reason: string } | { status: "failed"; code: string };

export interface NoShowRebookingDeps {
  load: (tenantId: string, bookingId: string) => Promise<ReminderBooking | null>;
  send: (tenantId: string, kind: "noshow_rebooking", payload: NotifyPayload) => Promise<SendOutcome>;
}

const defaults = (): NoShowRebookingDeps => ({
  load: (tenantId, bookingId) => loadReminderBooking(tenantId, bookingId, supabaseAdmin()),
  send: (tenantId, kind, payload) => send(tenantId, kind, payload),
});

interface Step {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

export async function handleNoShowRebooking({ event, step }: { event: { data: unknown }; step: Step }, deps: NoShowRebookingDeps = defaults()) {
  const { tenantId, bookingId } = NoShow.parse(event.data);
  const offer = await step.run("offer", async (): Promise<StepResult> => {
    const booking = await deps.load(tenantId, bookingId);
    if (!booking || booking.status !== "no_show") return { status: "skipped", reason: "not_a_no_show" };
    if (!booking.conversationId) return { status: "skipped", reason: "no_conversation" };
    const outcome = await deps.send(tenantId, "noshow_rebooking", {
      conversationId: booking.conversationId,
      ...noShowMessage(booking),
      idempotencyKey: `noshow_rebooking:${bookingId}`,
    });
    if (outcome.status === "sent") return { status: "sent" };
    if (outcome.status === "skipped") return { status: "skipped", reason: outcome.reason };
    // Throwing makes Inngest retry this step; never when WhatsApp may already have delivered it.
    if (outcome.error.retryable && !outcome.error.outcomeUnknown) throw new Error(`no-show offer not sent (${outcome.error.code}), will retry`);
    return { status: "failed", code: outcome.error.code };
  });
  return { offer };
}

export const noShowRebooking = inngest.createFunction(
  { id: "noshow-rebooking", triggers: [{ event: "booking.changed", if: "event.data.change == 'no_show'" }] },
  (ctx) =>
    handleNoShowRebooking({
      event: ctx.event,
      step: { run: <T>(id: string, fn: () => Promise<T>) => ctx.step.run(id, fn) as unknown as Promise<T> },
    }),
);
