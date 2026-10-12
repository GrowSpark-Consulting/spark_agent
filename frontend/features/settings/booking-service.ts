import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Service } from "@/features/knowledge/data";
import { SetupError } from "./resources-data";

// Which service the assistant books when a business offers several: `tenants.agent_settings.bookingServiceId`, the id of an
// active service (backend/src/agent/pipeline/persona.ts, reply.ts `chosenService`; Dev 1's Day 3 note, section 4). With one active
// service the assistant books it on its own; with several and no choice it hands the chat to a person, and it never picks one
// itself. Members update `tenants.agent_settings` under RLS (0002), so this reads and writes that one key directly.
//
// agent_settings holds other keys too (persona, tone, privacyNotice, handoffTriggers: persona.ts), so a save keeps every one of
// them: it reads the settings immediately before writing, changes only this key, and refuses to write at all when the stored
// value isn't a plain object (it would have to throw something away to do so).

export const BOOKING_SERVICE_KEY = "bookingServiceId";

const ServiceId = z.guid();
const TenantSettingsRow = z.object({ id: z.guid(), agent_settings: z.unknown() });
const COLUMNS = "id, agent_settings";

/** agent_settings as a plain object ({} when there is none), or null when it is some other shape. */
function plainSettings(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return {};
  return typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The service id the business chose, or null when there is none (or it isn't an id). */
export function chosenServiceId(settings: unknown): string | null {
  const parsed = ServiceId.safeParse(plainSettings(settings)?.[BOOKING_SERVICE_KEY]);
  return parsed.success ? parsed.data : null;
}

export type BookingServiceView =
  /** Nothing active to book. */
  | { kind: "none" }
  /** Exactly one active service: the assistant books it, whatever was chosen. */
  | { kind: "only"; service: Service }
  /** Several: the chosen one is booked; `stale` is a choice that no longer names an active service (then it is as if none was chosen). */
  | { kind: "several"; services: Service[]; chosen: Service | null; stale: boolean };

/** What the section says, from the services and the choice: the same rule the assistant applies (reply.ts `chosenService`). */
export function describeBookingService(services: Service[], chosenId: string | null): BookingServiceView {
  const active = services.filter((s) => s.active);
  if (active.length === 0) return { kind: "none" };
  if (active.length === 1) return { kind: "only", service: active[0] };
  const chosen = chosenId ? (active.find((s) => s.id === chosenId) ?? null) : null;
  return { kind: "several", services: active, chosen, stale: chosenId !== null && chosen === null };
}

async function readSettings(client: SupabaseClient, tenantId: string): Promise<unknown> {
  const { data, error } = await client.from("tenants").select(COLUMNS).eq("id", tenantId).maybeSingle();
  if (error) throw error;
  const parsed = TenantSettingsRow.safeParse(data);
  if (!parsed.success || parsed.data.id !== tenantId) throw new SetupError("invalid_response", "Your assistant's settings had an unexpected shape.");
  return parsed.data.agent_settings;
}

/** The service the business chose for the assistant to book, or null. */
export async function readBookingService(client: SupabaseClient, tenantId: string): Promise<string | null> {
  return chosenServiceId(await readSettings(client, tenantId));
}

/**
 * Sets the service the assistant books (or, with null, clears the choice) and returns what is stored afterwards. Every other
 * setting is kept. Row-level security refuses a business that isn't the member's by updating nothing, so no row back means
 * nothing was saved.
 */
export async function saveBookingService(client: SupabaseClient, tenantId: string, serviceId: string | null): Promise<string | null> {
  if (serviceId !== null && !ServiceId.safeParse(serviceId).success) throw new SetupError("invalid_response", "That isn't a service of yours.");
  const current = plainSettings(await readSettings(client, tenantId));
  if (current === null) {
    throw new SetupError("invalid_response", "Your assistant's settings are in a form this page can't safely change, so nothing was changed.");
  }
  const next = { ...current };
  if (serviceId === null) delete next[BOOKING_SERVICE_KEY];
  else next[BOOKING_SERVICE_KEY] = serviceId;

  const { data, error } = await client.from("tenants").update({ agent_settings: next }).eq("id", tenantId).select(COLUMNS);
  if (error) throw error;
  const rows = z.array(TenantSettingsRow).safeParse(data ?? []);
  if (!rows.success) throw new SetupError("invalid_response", "The choice was not returned after saving.");
  const [row] = rows.data;
  if (!row) throw new SetupError("not_found", "Your business couldn't be updated. Refresh and try again.");
  const saved = chosenServiceId(row.agent_settings);
  if (saved !== serviceId) throw new SetupError("invalid_response", "The choice that came back after saving wasn't the one sent. Refresh and check it.");
  return saved;
}
