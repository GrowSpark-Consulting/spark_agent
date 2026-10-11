import type { Interactive } from "../notify/interactive";
import { oneLine, type ReminderBooking } from "./reminders";

// No-show rebooking (docs/handover.md, notifications: "no-show rebooking"): when staff mark a booking as a no-show, the
// customer is offered a new time. The button is the reminders' reschedule button (`booking:<id>:reschedule`), so the
// pipeline answers it the same way: by offering slots.

/** The offer: one "Pick a new time" button inside the window, or the noshow_rebook template outside it ({{1}} what, {{2}} business). */
export function noShowMessage(booking: ReminderBooking): { interactive: Interactive; templateParams: string[] } {
  const what = oneLine(booking.what, 40);
  const business = oneLine(booking.business, 40);
  return {
    interactive: {
      type: "buttons",
      body: `Sorry we missed you for your ${what} with ${business}. Would you like to pick a new time?`,
      buttons: [{ id: `booking:${booking.bookingId}:reschedule`, title: "Pick a new time" }],
    },
    templateParams: [what, business],
  };
}
