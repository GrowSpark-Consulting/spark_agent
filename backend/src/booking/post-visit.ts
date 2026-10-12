import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { inngest } from "../inngest/client";
import { supabaseAdmin } from "../lib/supabase-admin";
import type { Interactive } from "../notify/interactive";
import { oneLine, type ReminderBooking } from "./reminders";

// After a visit (docs/handover.md, jobs: post-visit): the rating question some time after the booking's end, the
// review link for a 4 or 5, and an outcome prompt to staff. The job is inngest/post-visit.ts; this file has the
// settings, the messages, and what Dev 1's pipeline calls when the customer taps a rating.

export const DEFAULT_FEEDBACK_DELAY_MINUTES = 120;
export const DelaySettings = z.object({ offset_minutes: z.number().int().min(0).max(7 * 24 * 60) });

/** Minutes after the booking's end before the rating question (feedback_request's `offset_minutes`), else 120. */
export async function feedbackDelay(tenantId: string, db: SupabaseClient): Promise<number> {
  const { data, error } = await db.from("tenant_features").select("settings").eq("tenant_id", tenantId).eq("feature_key", "feedback_request").limit(1);
  if (error) throw new Error(`post-visit: feedback settings read failed: ${error.message}`);
  const [row] = z.array(z.object({ settings: z.unknown() })).max(1).parse(data ?? []);
  const set = DelaySettings.safeParse(row?.settings);
  return set.success ? set.data.offset_minutes : DEFAULT_FEEDBACK_DELAY_MINUTES;
}

const RATING_WORDS: Record<number, string> = { 5: "Excellent", 4: "Good", 3: "Okay", 2: "Poor", 1: "Very poor" };

/** The rating question: a list of five ratings inside the window, or the feedback template outside it ({{1}} what, {{2}} business). */
export function ratingMessage(booking: ReminderBooking): { interactive: Interactive; templateParams: string[]; templateButtons: string[] } {
  const what = oneLine(booking.what, 40);
  const business = oneLine(booking.business, 40);
  return {
    interactive: {
      type: "list",
      body: `How was your ${what} with ${business}? Tap a rating, it takes a second.`,
      button: "Rate it",
      sections: [
        {
          rows: [5, 4, 3, 2, 1].map((n) => ({ id: `rating:${booking.bookingId}:${n}`, title: `${"★".repeat(n)} ${n}/5`, description: RATING_WORDS[n] })),
        },
      ],
    },
    templateParams: [what, business],
    // The template's five rating buttons, best first, carry the list's ids.
    templateButtons: [5, 4, 3, 2, 1].map((n) => `rating:${booking.bookingId}:${n}`),
  };
}

const RatingButton = /^rating:([0-9a-f-]{36}):([1-5])$/i;

/** A tap on the rating list (the inbound message's buttonId), or null for any other id. */
export function parseRatingButton(buttonId: string): { bookingId: string; rating: number } | null {
  const match = RatingButton.exec(buttonId);
  if (!match || !z.guid().safeParse(match[1]).success) return null;
  return { bookingId: match[1].toLowerCase(), rating: Number(match[2]) };
}

export interface RatingDeps {
  db: SupabaseClient;
  send: (event: { id: string; name: string; data: Record<string, unknown> }) => Promise<unknown>;
}

const ratingDefaults = (): RatingDeps => ({ db: supabaseAdmin(), send: (event) => inngest.send(event) });

/**
 * Records the customer's rating (Dev 1's pipeline calls this on a tap): saves it on the booking's lead
 * (leads.feedback_rating) and sends booking.rated, which the post-visit job waits for. The event id makes the first
 * rating the one the job acts on. False when this business has no such booking.
 */
export async function recordVisitRating(tenantId: string, bookingId: string, rating: number, deps: RatingDeps = ratingDefaults()): Promise<boolean> {
  if (!z.guid().safeParse(bookingId).success || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new Error("recordVisitRating: a booking id and a rating from 1 to 5 are required");
  }
  const bookingRead = await deps.db.from("bookings").select("lead_id").eq("tenant_id", tenantId).eq("id", bookingId).limit(1);
  if (bookingRead.error) throw new Error(`post-visit: booking read failed: ${bookingRead.error.message}`);
  const [booking] = z.array(z.object({ lead_id: z.guid() })).max(1).parse(bookingRead.data ?? []);
  if (!booking) return false;

  const saved = await deps.db.from("leads").update({ feedback_rating: rating }).eq("tenant_id", tenantId).eq("id", booking.lead_id);
  if (saved.error) throw new Error(`post-visit: saving the rating failed: ${saved.error.message}`);
  await deps.send({ id: `booking.rated:${bookingId}`, name: "booking.rated", data: { tenantId, bookingId, rating } });
  return true;
}

export const ReviewSettings = z.object({ review_url: z.url({ protocol: /^https$/ }) });

/** The business's review link (review_request's `review_url`, https only), or null when it has none. */
export async function reviewLink(tenantId: string, db: SupabaseClient): Promise<string | null> {
  const { data, error } = await db.from("tenant_features").select("settings").eq("tenant_id", tenantId).eq("feature_key", "review_request").limit(1);
  if (error) throw new Error(`post-visit: review settings read failed: ${error.message}`);
  const [row] = z.array(z.object({ settings: z.unknown() })).max(1).parse(data ?? []);
  const set = ReviewSettings.safeParse(row?.settings);
  return set.success ? set.data.review_url : null;
}

/** The thank-you with the review link: free text inside the window, or the review template outside it ({{1}} business, {{2}} link). */
export function reviewMessage(business: string, url: string): { text: string; templateParams: string[] } {
  const name = oneLine(business, 40);
  return { text: `Thank you! Would you leave ${name} a quick review? It really helps: ${url}`, templateParams: [name, url] };
}

/** True when this member of the business has an alert number, so a staff alert can reach them. */
export async function hasAlertNumber(tenantId: string, userId: string, db: SupabaseClient): Promise<boolean> {
  const { data, error } = await db.from("memberships").select("user_id").eq("tenant_id", tenantId).eq("user_id", userId).not("whatsapp_phone", "is", null).limit(1);
  if (error) throw new Error(`post-visit: member read failed: ${error.message}`);
  return z.array(z.object({ user_id: z.string() })).max(1).parse(data ?? []).length === 1;
}
