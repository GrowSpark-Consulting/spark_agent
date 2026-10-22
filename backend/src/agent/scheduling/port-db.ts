import type { SupabaseClient } from "@supabase/supabase-js";
import { cancelBooking, confirmBooking, findSlots, holdSlot, rescheduleBooking } from "../../booking/bookings";
import { isEnabled } from "../../features/is-enabled";
import { supabaseAdmin } from "../../lib/supabase-admin";
import { withTimeout } from "../../lib/timeout";
import type { SchedulingDeps } from "./act";

// The real calendar for the booking step (act.ts): Dev 2's booking functions (booking/bookings.ts) for everything that finds, holds or
// confirms a time, and a few read-only queries for what the booking engine does not offer (the business's services and time zone, and the
// lead's next booking). Every query names the business. Nothing here writes to the database itself: all writes are Dev 2's functions.

export interface BookingFunctions {
  findSlots: typeof findSlots;
  holdSlot: typeof holdSlot;
  confirmBooking: typeof confirmBooking;
  rescheduleBooking: typeof rescheduleBooking;
  cancelBooking: typeof cancelBooking;
}

const READ_TIMEOUT_MS = 5000;
/** The product's default zone (docs/handover.md): used when a business has none, never the server's own. */
export const DEFAULT_TIME_ZONE = "Asia/Kolkata";
const MAX_SERVICES = 5;
const MAX_BOOKINGS_READ = 5;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function validZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || zone === "") return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function createSchedulingDeps(
  options: { db?: SupabaseClient; functions?: BookingFunctions; isEnabled?: SchedulingDeps["isEnabled"]; now?: () => Date } = {},
): SchedulingDeps {
  const db = () => options.db ?? supabaseAdmin();
  const functions: BookingFunctions = options.functions ?? { findSlots, holdSlot, confirmBooking, rescheduleBooking, cancelBooking };
  const now = options.now ?? (() => new Date());
  // The code only: a row can hold the business's own text.
  const failed = (what: string, error: { code?: string }) => new Error(`${what} (database error ${error.code || "none"})`);

  return {
    port: {
      findSlots: (tenantId, input) => functions.findSlots(tenantId, input),
      async holdSlot(tenantId, slot, leadId, kind) {
        const held = await functions.holdSlot(tenantId, { start: slot.start, end: slot.end, resourceId: slot.resourceId, serviceId: slot.serviceId }, leadId, { kind });
        return { id: held.id };
      },
      async confirmBooking(tenantId, bookingId) {
        const confirmed = await functions.confirmBooking(tenantId, bookingId);
        return { id: confirmed.id };
      },
      async rescheduleBooking(tenantId, bookingId, slot) {
        const moved = await functions.rescheduleBooking(tenantId, bookingId, { start: slot.start, end: slot.end, resourceId: slot.resourceId });
        return { id: moved.id };
      },
      cancelBooking: (tenantId, bookingId, reason) => functions.cancelBooking(tenantId, bookingId, reason),
      async activeBooking(tenantId, leadId) {
        const at = now();
        const { data, error } = await withTimeout(
          (signal) =>
            db()
              .from("bookings")
              .select("id, status, start_at, end_at, hold_expires_at")
              .eq("tenant_id", tenantId)
              .eq("lead_id", leadId)
              .in("status", ["held", "confirmed"])
              .gt("end_at", at.toISOString())
              .order("start_at")
              .limit(MAX_BOOKINGS_READ)
              .abortSignal(signal),
          READ_TIMEOUT_MS,
        );
        if (error) throw failed("the lead's booking could not be read", error);
        for (const row of Array.isArray(data) ? data : []) {
          if (!isObject(row) || typeof row.id !== "string" || typeof row.status !== "string" || typeof row.start_at !== "string" || typeof row.end_at !== "string") continue;
          // A hold that has run out is not a booking (Postgres marks it expired within a minute: pg_cron, 0053).
          if (row.status === "held" && (typeof row.hold_expires_at !== "string" || Date.parse(row.hold_expires_at) <= at.getTime())) continue;
          return { id: row.id, start: new Date(row.start_at).toISOString(), end: new Date(row.end_at).toISOString(), status: row.status };
        }
        return null;
      },
    },
    isEnabled: options.isEnabled ?? ((tenantId, feature) => isEnabled(tenantId, feature)),
    async services(tenantId) {
      const { data, error } = await withTimeout(
        (signal) => db().from("services").select("id").eq("tenant_id", tenantId).eq("active", true).limit(MAX_SERVICES).abortSignal(signal),
        READ_TIMEOUT_MS,
      );
      if (error) throw failed("the business's services could not be read", error);
      return (Array.isArray(data) ? data : []).filter((row): row is { id: string } => isObject(row) && typeof row.id === "string").map((row) => ({ id: row.id }));
    },
    async timeZone(tenantId) {
      const { data, error } = await withTimeout((signal) => db().from("tenants").select("timezone").eq("id", tenantId).abortSignal(signal).maybeSingle(), READ_TIMEOUT_MS);
      if (error) throw failed("the business's time zone could not be read", error);
      const zone = isObject(data) ? data.timezone : null;
      return validZone(zone) ? zone : DEFAULT_TIME_ZONE;
    },
  };
}
