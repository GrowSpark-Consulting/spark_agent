import { z } from "zod";
import { maskPhone } from "../channels/whatsapp/phone";
import { supabaseAdmin } from "./supabase-admin";

// audit_logs (migration 0001): who did what, for any action a business would want to trace
// (docs/handover.md, "audit log everywhere"). Members read their business's rows under RLS; only
// server code writes them. Sent messages are recorded by notify_record (0009), not here.

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A phone number inside a string: E.164 or bare digits as Meta sends them ("919812345621").
const PHONE = /\+?(?<!\d)[1-9]\d{9,14}(?!\d)/g;

const AuditEntry = z.object({
  /** null only for platform actions that belong to no business, such as editing a plan. */
  tenantId: z.guid().nullable(),
  /** The user id, "ai", "system", or "admin:<user id>" for internal admins. */
  actor: z
    .string()
    .refine(
      (a) => a === "ai" || a === "system" || GUID.test(a.replace(/^admin:/, "")),
      "must be a user id, ai, system or admin:<user id>",
    ),
  /** "<entity>.<verb>", for example "feature.toggled" or "booking.cancelled". */
  action: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, "must look like feature.toggled"),
  entity: z.string().min(1).optional(),
  entityId: z.guid().optional(),
  /** What changed, for example { enabled: { from: false, to: true } }. Phone numbers are masked. */
  diff: z.record(z.string(), z.unknown()).optional(),
});
export type AuditEntry = z.input<typeof AuditEntry>;

function maskPhones(value: unknown): unknown {
  if (typeof value === "string") return value.replace(PHONE, (phone) => maskPhone(phone));
  if (Array.isArray(value)) return value.map(maskPhones);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskPhones(v)]));
  }
  return value;
}

/**
 * Writes one audit_logs row. Call it after the change has been made; it throws if the row could not
 * be written, so the caller decides whether that fails the request.
 */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  const e = AuditEntry.parse(entry);
  const { error } = await supabaseAdmin()
    .from("audit_logs")
    .insert({
      tenant_id: e.tenantId,
      actor: e.actor,
      action: e.action,
      entity: e.entity ?? null,
      entity_id: e.entityId ?? null,
      diff: e.diff === undefined ? null : maskPhones(e.diff),
    });
  if (error) throw new Error(`audit_logs insert failed: ${error.message}`);
}

/**
 * For a route whose change has already been made (Day 7 audit coverage): the row is written, and a failure is logged, never
 * thrown, so the member is not told the change failed and does not make it twice.
 */
export async function auditQuietly(entry: AuditEntry, write: (entry: AuditEntry) => Promise<void> = writeAudit): Promise<void> {
  try {
    await write(entry);
  } catch (e) {
    console.error(`[audit] ${entry.action} was not recorded: ${e instanceof Error ? e.name : "a thrown value"}`);
  }
}
