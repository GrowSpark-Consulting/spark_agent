import { z } from "zod";
import { feedbackDelay, hasAlertNumber, ratingMessage, reviewLink, reviewMessage } from "../booking/post-visit";
import { loadReminderBooking, type ReminderBooking } from "../booking/reminders";
import { supabaseAdmin } from "../lib/supabase-admin";
import { send, type NotifyPayload, type SendOutcome } from "../notify/send";
import { sendStaffAlert, staffAlertRecipients, type StaffAlert } from "../notify/staff-alerts";
import { inngest } from "./client";

// booking.confirmed → after the visit (docs/handover.md, jobs: post-visit). The run sleeps until the booking's end plus
// the business's delay (2 h by default), then, if the visit happened (the booking is still confirmed, or marked
// completed, at the same time):
//   - asks the customer for a 1–5 rating (feedback_request, a list inside the window, the feedback template outside);
//   - prompts staff for the outcome (staff_alert visit_outcome: the booked staff member if they have an alert number,
//     else the owners and admins);
//   - waits up to 3 days for booking.rated (recordVisitRating, called by Dev 1's pipeline on the tap): a 4 or 5 gets the
//     business's review link (review_request), a 1–3 alerts the owners (staff_alert low_rating).
// A cancelled, moved or no-show booking cancels the run; one marked completed does not. Every send has an idempotency
// key, and every staff alert its own step, so a retry never sends twice.

const BookingConfirmed = z.object({ tenantId: z.guid(), bookingId: z.guid() });
const BookingRated = z.object({ data: z.object({ rating: z.number().int().min(1).max(5) }) });
const VISITED = new Set(["confirmed", "completed"]);
export const RATING_WAIT = "3d";

type Kind = "feedback_request" | "review_request";
type StepResult = { status: "sent" } | { status: "skipped"; reason: string } | { status: "failed"; code: string };

export interface PostVisitDeps {
  load: (tenantId: string, bookingId: string) => Promise<ReminderBooking | null>;
  feedbackDelay: (tenantId: string) => Promise<number>;
  send: (tenantId: string, kind: Kind, payload: NotifyPayload) => Promise<SendOutcome>;
  reviewLink: (tenantId: string) => Promise<string | null>;
  /** The booked staff member if they can get alerts, else the owners and admins. */
  outcomeRecipients: (tenantId: string, staffUserId: string | null) => Promise<string[]>;
  owners: (tenantId: string) => Promise<string[]>;
  /** `idempotencyKey` names this exact alert, so a replayed event or a repeat run never sends it twice (notify.send). */
  alert: (tenantId: string, userId: string, alert: StaffAlert, idempotencyKey: string) => Promise<SendOutcome>;
}

const defaults = (): PostVisitDeps => ({
  load: (tenantId, bookingId) => loadReminderBooking(tenantId, bookingId, supabaseAdmin()),
  feedbackDelay: (tenantId) => feedbackDelay(tenantId, supabaseAdmin()),
  send: (tenantId, kind, payload) => send(tenantId, kind, payload),
  reviewLink: (tenantId) => reviewLink(tenantId, supabaseAdmin()),
  outcomeRecipients: async (tenantId, staffUserId) =>
    staffUserId && (await hasAlertNumber(tenantId, staffUserId, supabaseAdmin())) ? [staffUserId] : staffAlertRecipients(tenantId),
  owners: (tenantId) => staffAlertRecipients(tenantId, undefined, ["owner"]),
  alert: (tenantId, userId, alert, idempotencyKey) => sendStaffAlert(tenantId, userId, alert, undefined, { idempotencyKey }),
});

interface Step {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
  sleepUntil(id: string, until: string): Promise<unknown>;
  waitForEvent(id: string, options: { event: string; timeout: string; match: string }): Promise<unknown>;
}

/** notify.send's outcome as a step result. Throwing makes Inngest retry the step; never when WhatsApp may have delivered it. */
function settle(outcome: SendOutcome, what: string): StepResult {
  if (outcome.status === "sent") return { status: "sent" };
  if (outcome.status === "skipped") return { status: "skipped", reason: outcome.reason };
  if (outcome.error.retryable && !outcome.error.outcomeUnknown) throw new Error(`${what} not sent (${outcome.error.code}), will retry`);
  return { status: "failed", code: outcome.error.code };
}

export async function handlePostVisit({ event, step }: { event: { data: unknown }; step: Step }, deps: PostVisitDeps = defaults()) {
  const { tenantId, bookingId } = BookingConfirmed.parse(event.data);

  const plan = await step.run("plan", async () => {
    const booking = await deps.load(tenantId, bookingId);
    if (!booking || booking.status !== "confirmed") return null;
    const delay = await deps.feedbackDelay(tenantId);
    return { end: booking.end, at: new Date(Date.parse(booking.end) + delay * 60_000).toISOString() };
  });
  if (!plan) return { skipped: "not_confirmed" as const };
  await step.sleepUntil("wait-visit", plan.at);

  // Read again after the visit: a booking.changed event that came late still stops it.
  const visit = await step.run("visit", async () => {
    const booking = await deps.load(tenantId, bookingId);
    if (!booking || !VISITED.has(booking.status) || Date.parse(booking.end) !== Date.parse(plan.end)) return null;
    return booking;
  });
  if (!visit) return { skipped: "booking_changed" as const };

  const feedback = await step.run("feedback", async (): Promise<StepResult> => {
    if (!visit.conversationId) return { status: "skipped", reason: "no_conversation" };
    const outcome = await deps.send(tenantId, "feedback_request", {
      conversationId: visit.conversationId,
      ...ratingMessage(visit),
      idempotencyKey: `feedback_request:${bookingId}`,
    });
    return settle(outcome, "feedback request");
  });

  const outcomeAlerts = await alertEach(step, "outcome", await step.run("outcome-recipients", () => deps.outcomeRecipients(tenantId, visit.staffUserId)), (userId) =>
    deps.alert(tenantId, userId, { kind: "visit_outcome", conversationId: visit.conversationId ?? undefined, what: visit.what }, `visit_outcome:${bookingId}:${userId}`),
  );

  if (feedback.status !== "sent" || !visit.conversationId) return { feedback, outcomeAlerts };
  const conversationId = visit.conversationId;

  const rated = BookingRated.safeParse(await step.waitForEvent("rating", { event: "booking.rated", timeout: RATING_WAIT, match: "data.bookingId" }));
  if (!rated.success) return { feedback, outcomeAlerts, rating: null };
  const rating = rated.data.data.rating;

  if (rating >= 4) {
    const review = await step.run("review", async (): Promise<StepResult> => {
      const url = await deps.reviewLink(tenantId);
      if (!url) return { status: "skipped", reason: "no_review_link" };
      const outcome = await deps.send(tenantId, "review_request", {
        conversationId,
        ...reviewMessage(visit.business, url),
        idempotencyKey: `review_request:${bookingId}`,
      });
      return settle(outcome, "review request");
    });
    return { feedback, outcomeAlerts, rating, review };
  }

  const lowRatingAlerts = await alertEach(step, "low-rating", await step.run("owners", () => deps.owners(tenantId)), (userId) =>
    deps.alert(tenantId, userId, { kind: "low_rating", conversationId, what: visit.what, rating }, `low_rating:${bookingId}:${userId}`),
  );
  return { feedback, outcomeAlerts, rating, lowRatingAlerts };
}

/** One step per person, so a retry never alerts someone twice. */
async function alertEach(step: Step, name: string, userIds: string[], alert: (userId: string) => Promise<SendOutcome>) {
  const results: ({ userId: string } & StepResult)[] = [];
  for (const userId of userIds) {
    results.push({ userId, ...(await step.run(`${name}-${userId}`, async () => settle(await alert(userId), "staff alert"))) });
  }
  return results;
}

// Every step value above is plain JSON, so Inngest's serialised step results are the same values.
export const postVisit = inngest.createFunction(
  {
    id: "post-visit",
    triggers: [{ event: "booking.confirmed" }],
    // Cancelled, moved or no-show: no feedback. Marked completed: the visit happened, so the run goes on.
    cancelOn: [{ event: "booking.changed", if: "event.data.bookingId == async.data.bookingId && async.data.change != 'completed'" }],
  },
  (ctx) =>
    handlePostVisit({
      event: ctx.event,
      step: {
        run: <T>(id: string, fn: () => Promise<T>) => ctx.step.run(id, fn) as unknown as Promise<T>,
        sleepUntil: (id: string, until: string) => ctx.step.sleepUntil(id, until),
        waitForEvent: (id: string, options: { event: string; timeout: string; match: string }) => ctx.step.waitForEvent(id, options),
      },
    }),
);
