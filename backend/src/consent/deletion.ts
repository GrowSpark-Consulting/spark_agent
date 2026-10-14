import { type ContactDeletionPreview, type ContactDeletionResult, type TenantContext } from "@pakka/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { removeGoogleEvent, type RemoveResult } from "../booking/google-sync";
import { AppError } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase-admin";
import { requireRole } from "../lib/tenant";
import { errorTextForLog } from "../lib/redact";

// A customer's request to delete their data (DPDP; migration 0043), from the dashboard's Data & privacy settings. Owner
// or admin; the business is the caller's own (TenantContext), so another business's contact is just "not found".
//   GET  /api/contacts/:id/deletion → ContactDeletionPreview
//   POST /api/contacts/:id/deletion → ContactDeletionResult
// delete_contact_data removes the chats and leads, scrubs the contact and writes consent_logs (deletion_requested,
// deleted) and the audit row in one transaction. Then the past bookings' Google Calendar events, which carry the
// customer's name, are taken down here: one that can't be is logged and counted as left, never thrown, since the data
// itself is already gone.

export interface DeletionDeps {
  db: SupabaseClient;
  removeEvent: (tenantId: string, event: { resourceId: string; eventId: string }) => Promise<RemoveResult>;
}

const defaults = (): DeletionDeps => ({ db: supabaseAdmin(), removeEvent: (tenantId, event) => removeGoogleEvent(tenantId, event) });

const ContactId = z.guid();
const NOT_FOUND = "That contact was not found.";
const UPCOMING =
  "This customer has a booking coming up. Cancel it first (that tells them and takes it off your calendar), then delete their data.";

function contactId(id: string): string {
  if (!ContactId.safeParse(id).success) throw new AppError("not_found", NOT_FOUND);
  return id;
}

const Preview = z.object({
  deleted_at: z.string().nullable(),
  conversations: z.number().int(),
  messages: z.number().int(),
  leads: z.number().int(),
  bookings: z.number().int(),
  upcoming_bookings: z.number().int(),
});

export async function contactDeletionPreview(context: TenantContext, id: string, deps: DeletionDeps = defaults()): Promise<ContactDeletionPreview> {
  requireRole(context, ["owner", "admin"], "delete a customer's data");
  const { data, error } = await deps.db.rpc("contact_deletion_preview", { p_tenant_id: context.tenant.id, p_contact_id: contactId(id) });
  if (error) throw new Error(`contact_deletion_preview failed: ${error.message}`);
  const [row] = z.array(Preview).parse(data ?? []);
  if (!row) throw new AppError("not_found", NOT_FOUND);
  return {
    contactId: id,
    deletedAt: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
    conversations: row.conversations,
    messages: row.messages,
    leads: row.leads,
    bookings: row.bookings,
    upcomingBookings: row.upcoming_bookings,
  };
}

const Deleted = z
  .array(
    z.object({
      outcome: z.enum(["deleted", "already_deleted"]),
      conversations: z.number().int(),
      messages: z.number().int(),
      leads: z.number().int(),
      bookings: z.number().int(),
      calendar_events: z.array(z.object({ resource_id: z.string(), event_id: z.string() })),
    }),
  )
  .length(1);

export async function deleteContactData(context: TenantContext, id: string, deps: DeletionDeps = defaults()): Promise<ContactDeletionResult> {
  requireRole(context, ["owner", "admin"], "delete a customer's data");
  const { data, error } = await deps.db.rpc("delete_contact_data", { p_tenant_id: context.tenant.id, p_contact_id: contactId(id), p_actor: context.user.id });
  if (error) {
    if (error.code === "PA404") throw new AppError("not_found", NOT_FOUND);
    if (error.code === "PA409") throw new AppError("conflict", UPCOMING);
    throw new Error(`delete_contact_data failed: ${error.message}`);
  }
  const [row] = Deleted.parse(data);

  const calendarEvents = { removed: 0, left: 0 };
  for (const event of row.calendar_events) {
    try {
      // no_calendar: the calendar was disconnected since, so the event is still there and can't be reached from here.
      const result = await deps.removeEvent(context.tenant.id, { resourceId: event.resource_id, eventId: event.event_id });
      if (result === "no_calendar") {
        calendarEvents.left++;
        console.error(`[deletion] contact ${id}: a Google Calendar event was not taken down: the calendar is no longer connected`);
      } else {
        calendarEvents.removed++;
      }
    } catch (e) {
      calendarEvents.left++;
      console.error(`[deletion] contact ${id}: a Google Calendar event was not taken down: ${errorTextForLog(e)}`);
    }
  }
  return {
    status: row.outcome,
    removed: { conversations: row.conversations, messages: row.messages, leads: row.leads, bookings: row.bookings },
    calendarEvents,
  };
}
