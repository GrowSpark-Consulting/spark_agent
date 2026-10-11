import { z } from "zod";
import { addBookingToGoogle, removeBookingFromGoogle, type AddResult, type RemoveResult } from "../booking/google-sync";
import { inngest } from "./client";

// booking.confirmed → the booking goes on its resource's Google Calendar; booking.changed (cancelled or rescheduled) →
// it comes off. A reschedule confirms a new booking, so the new time arrives as its own booking.confirmed. Completed and
// no-show leave the event as it is. Only resources with a connected calendar are touched (booking/google-sync.ts). A
// Google error throws, so Inngest retries the step; the fixed event id makes a retry safe.

const BookingEvent = z.object({ tenantId: z.guid(), bookingId: z.guid(), change: z.string().optional() });

export interface GoogleCalendarSyncDeps {
  add: (tenantId: string, bookingId: string) => Promise<AddResult>;
  remove: (tenantId: string, bookingId: string) => Promise<RemoveResult>;
}

const defaults = (): GoogleCalendarSyncDeps => ({
  add: (tenantId, bookingId) => addBookingToGoogle(tenantId, bookingId),
  remove: (tenantId, bookingId) => removeBookingFromGoogle(tenantId, bookingId),
});

interface Step {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

export async function handleGoogleCalendarSync(
  { event, step }: { event: { name: string; data: unknown }; step: Step },
  deps: GoogleCalendarSyncDeps = defaults(),
) {
  const { tenantId, bookingId, change } = BookingEvent.parse(event.data);
  if (event.name === "booking.confirmed") return { added: await step.run("add", () => deps.add(tenantId, bookingId)) };
  if (change === "cancelled" || change === "rescheduled") return { removed: await step.run("remove", () => deps.remove(tenantId, bookingId)) };
  return { skipped: "nothing_to_change" as const };
}

export const googleCalendarSync = inngest.createFunction(
  { id: "google-calendar-sync", triggers: [{ event: "booking.confirmed" }, { event: "booking.changed" }] },
  (ctx) =>
    handleGoogleCalendarSync({
      event: { name: ctx.event.name, data: ctx.event.data },
      step: { run: <T>(id: string, fn: () => Promise<T>) => ctx.step.run(id, fn) as unknown as Promise<T> },
    }),
);
