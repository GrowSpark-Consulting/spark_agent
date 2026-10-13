import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { formatError, type FormattedError } from "@/lib/errors";
import { hasOwnHours, parseHours, parsePincodes, parseServiceArea, validateHours, type HoursDraft, type HoursErrors, type WeeklyHours } from "./hours";

// Staff and resources, and the business's hours, for the booking setup page (Day 3: "services and
// resources settings"). Members read and write their own business's resources and tenants.business_hours
// directly under row-level security (migration 0002: resources tenant_insert / tenant_update /
// tenant_delete; tenants update of name, timezone, business_hours, agent_settings). Every query also names
// the session's tenant; a write that RLS turns into "0 rows" is reported, never ignored. The slot engine
// (Dev 2's findSlots) reads these rows; nothing here works out slots.

const RESOURCE_COLUMNS = "id, tenant_id, type, name, working_hours, service_area, active";

export const RESOURCE_NAME_MAX = 120;
export const RESOURCE_TYPE_MAX = 40;

export const ResourceRow = z.object({
  id: z.guid(),
  tenant_id: z.guid(),
  type: z.string(),
  name: z.string(),
  working_hours: z.unknown(),
  service_area: z.unknown(),
  active: z.boolean(),
});
export type ResourceRow = z.input<typeof ResourceRow>;

export interface Resource {
  id: string;
  name: string;
  type: string;
  active: boolean;
  /** Its own hours; null when the stored value doesn't match the contract. {} = the business's hours. */
  hours: WeeklyHours | null;
  /** Pincodes it covers; null = every pincode. */
  pincodes: string[] | null;
}

export function toResource(row: z.output<typeof ResourceRow>): Resource {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    active: row.active,
    hours: parseHours(row.working_hours),
    pincodes: parseServiceArea(row.service_area),
  };
}

// Errors -------------------------------------------------------------------------------------------

/** A failure the UI explains specifically; everything else goes through formatError. */
export class SetupError extends Error {
  constructor(
    readonly reason: "not_found" | "in_use" | "invalid_response",
    message: string,
  ) {
    super(message);
    this.name = "SetupError";
  }
}

/** formatError words database failures for reads; a write gets a write message. */
export function describeSetupWriteError(err: unknown, title: string): FormattedError {
  if (err instanceof SetupError) {
    return { code: err.reason === "in_use" ? "conflict" : "not_found", title, message: err.message, retryable: false };
  }
  const e = formatError(err);
  if (e.code === "upstream_failed") return { ...e, title, message: "Nothing was changed. Try again in a moment." };
  return { ...e, title };
}

/** Postgres foreign_key_violation: bookings.resource_id still points at the resource. */
const FOREIGN_KEY_VIOLATION = "23503";

function parseResources(data: unknown): Resource[] {
  const parsed = z.array(ResourceRow).safeParse(data ?? []);
  if (!parsed.success) throw new SetupError("invalid_response", "The staff and resources data had an unexpected shape.");
  return parsed.data.map(toResource);
}

export function byResourceName(a: Resource, b: Resource): number {
  return a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.id.localeCompare(b.id);
}

// Resources: reads and writes ------------------------------------------------------------------------

export async function listResources(client: SupabaseClient, tenantId: string): Promise<Resource[]> {
  const { data, error } = await client.from("resources").select(RESOURCE_COLUMNS).eq("tenant_id", tenantId).order("name", { ascending: true });
  if (error) throw error;
  return parseResources(data).sort(byResourceName);
}

/** The values written to resources (column names). */
export interface ResourceInput {
  name: string;
  type: string;
  active: boolean;
  working_hours: WeeklyHours;
  service_area: { pincodes: string[] } | null;
}

export async function createResource(client: SupabaseClient, tenantId: string, input: ResourceInput): Promise<Resource> {
  const { data, error } = await client
    .from("resources")
    .insert({ ...input, tenant_id: tenantId })
    .select(RESOURCE_COLUMNS);
  if (error) throw error;
  const [created] = parseResources(data);
  if (!created) throw new SetupError("invalid_response", "The resource was not returned after saving.");
  return created;
}

export async function updateResource(client: SupabaseClient, tenantId: string, id: string, input: ResourceInput): Promise<Resource> {
  const { data, error } = await client.from("resources").update(input).eq("id", id).eq("tenant_id", tenantId).select(RESOURCE_COLUMNS);
  if (error) throw error;
  const [updated] = parseResources(data);
  if (!updated) throw new SetupError("not_found", "This resource no longer exists. Refresh to see the current list.");
  return updated;
}

export async function deleteResource(client: SupabaseClient, tenantId: string, id: string): Promise<void> {
  const { data, error } = await client.from("resources").delete().eq("id", id).eq("tenant_id", tenantId).select("id");
  if (error) {
    if (error.code === FOREIGN_KEY_VIOLATION) {
      throw new SetupError("in_use", "This resource has bookings, so it can't be deleted. Edit it and switch it off instead.");
    }
    throw error;
  }
  if (!Array.isArray(data) || data.length === 0) {
    throw new SetupError("not_found", "This resource no longer exists. Refresh to see the current list.");
  }
}

// Resources: the form ------------------------------------------------------------------------------

export interface ResourceDraft {
  name: string;
  type: string;
  active: boolean;
  /** "business": working_hours {} (the business's hours); "own": the hours below. */
  hoursMode: "business" | "own";
  hours: HoursDraft;
  pincodes: string;
}

export type ResourceFieldErrors = Partial<Record<"name" | "type" | "pincodes" | "hours", string>> & { hoursFields?: HoursErrors };

/**
 * Validates the resource form before anything is sent. A name already used by another of the business's
 * resources is refused: the calendar and the AI's slot offers tell resources apart by name.
 */
export function validateResourceDraft(
  draft: ResourceDraft,
  existing: Resource[],
  editingId: string | null,
): { ok: true; input: ResourceInput } | { ok: false; fields: ResourceFieldErrors } {
  const fields: ResourceFieldErrors = {};
  const name = draft.name.trim();
  const type = draft.type.trim();
  if (!name) fields.name = "Give it a name, like the person's name or the room";
  else if (name.length > RESOURCE_NAME_MAX) fields.name = `Keep the name under ${RESOURCE_NAME_MAX} characters`;
  else if (existing.some((r) => r.id !== editingId && r.name.trim().toLowerCase() === name.toLowerCase())) {
    fields.name = "You already have a resource with this name";
  }
  if (!type) fields.type = "Say what kind it is, like staff — services booked with this kind can use it";
  else if (type.length > RESOURCE_TYPE_MAX) fields.type = `Keep this under ${RESOURCE_TYPE_MAX} characters`;

  let working_hours: WeeklyHours = {};
  if (draft.hoursMode === "own") {
    const hours = validateHours(draft.hours);
    if (!hours.ok) {
      fields.hoursFields = hours.errors;
      fields.hours = "Check the hours below";
    } else if (!Object.values(hours.hours).some((d) => d.length > 0)) {
      fields.hours = "Add hours for at least one day, or use the business's hours";
    } else {
      working_hours = hours.hours;
    }
  }

  const area = parsePincodes(draft.pincodes);
  if (!area.ok) fields.pincodes = area.error;

  if (Object.keys(fields).length > 0 || !area.ok) return { ok: false, fields };
  return {
    ok: true,
    input: { name, type, active: draft.active, working_hours, service_area: area.pincodes ? { pincodes: area.pincodes } : null },
  };
}

// Business hours -------------------------------------------------------------------------------------

export interface BusinessHours {
  timezone: string;
  /** null when the stored value doesn't match the contract. */
  hours: WeeklyHours | null;
}

const TenantHoursRow = z.object({ id: z.guid(), timezone: z.string(), business_hours: z.unknown() });

export async function readBusinessHours(client: SupabaseClient, tenantId: string): Promise<BusinessHours> {
  const { data, error } = await client.from("tenants").select("id, timezone, business_hours").eq("id", tenantId).maybeSingle();
  if (error) throw error;
  const parsed = TenantHoursRow.safeParse(data);
  if (!parsed.success || parsed.data.id !== tenantId) throw new SetupError("invalid_response", "The business hours had an unexpected shape.");
  return { timezone: parsed.data.timezone, hours: parseHours(parsed.data.business_hours) };
}

export async function saveBusinessHours(client: SupabaseClient, tenantId: string, hours: Required<WeeklyHours>): Promise<BusinessHours> {
  const { data, error } = await client.from("tenants").update({ business_hours: hours }).eq("id", tenantId).select("id, timezone, business_hours");
  if (error) throw error;
  const rows = z.array(TenantHoursRow).safeParse(data ?? []);
  if (!rows.success) throw new SetupError("invalid_response", "The business hours were not returned after saving.");
  const [row] = rows.data;
  if (!row) throw new SetupError("not_found", "Nothing was changed. Only an owner or admin can change this, so check your role, then refresh and try again.");
  return { timezone: row.timezone, hours: parseHours(row.business_hours) };
}

/** Whether a resource works the business's hours (findSlots: no days set). */
export function usesBusinessHours(resource: Resource): boolean {
  return resource.hours !== null && !hasOwnHours(resource.hours);
}
