import { z } from "zod";

// A customer's request to delete their data (DPDP; migration 0043, backend/src/consent/deletion.ts), from the dashboard's
// Data & privacy settings. Owner or admin.
//   GET  /api/contacts/:id/deletion → ContactDeletionPreview: what a deletion would remove, for the confirmation
//   POST /api/contacts/:id/deletion → ContactDeletionResult (no body)

const Counts = z.object({
  conversations: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
  leads: z.number().int().nonnegative(),
  bookings: z.number().int().nonnegative(),
});

export const ContactDeletionPreview = Counts.extend({
  contactId: z.string(),
  /** Set once the contact's data was deleted: there is nothing left to remove. */
  deletedAt: z.string().nullable(),
  /** Held or confirmed bookings still to come. While there are any, a deletion is refused (conflict): cancel them first. */
  upcomingBookings: z.number().int().nonnegative(),
});
export type ContactDeletionPreview = z.infer<typeof ContactDeletionPreview>;

export const ContactDeletionResult = z.object({
  /** already_deleted: it had been done before, and nothing changed now. */
  status: z.enum(["deleted", "already_deleted"]),
  removed: Counts,
  /**
   * Past bookings' events on the business's Google Calendar carry the customer's name and are taken down too. `left` is
   * how many could not be (Google unreachable, the calendar disconnected): the business removes those by hand.
   */
  calendarEvents: z.object({ removed: z.number().int().nonnegative(), left: z.number().int().nonnegative() }),
});
export type ContactDeletionResult = z.infer<typeof ContactDeletionResult>;
