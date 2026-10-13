import { CreateTemplateInput, type CreateTemplateResult, type TenantContext } from "@pakka/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { templateBody } from "../conversations/templates";
import { writeAudit } from "../lib/audit";
import { AppError } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase-admin";
import { requireRole } from "../lib/tenant";

/**
 * Creates a WhatsApp message template and submits it to Meta on the business's own WhatsApp
 * account (Meta App Review flow).
 *
 * The WhatsApp adapter has no Meta submission yet (Dev 1), so this validates the template and the
 * role, then answers `not_available` instead of pretending it was submitted. Once it has one, this
 * submits and then stores the row with saveSubmittedTemplate.
 */
export async function createTemplate(
  context: TenantContext,
  rawInput: unknown,
): Promise<CreateTemplateResult> {
  CreateTemplateInput.parse(rawInput);
  requireRole(context, ["owner", "admin"], "create a template");

  throw new AppError(
    "not_available",
    "Submitting templates to Meta isn't switched on yet, so this template was not submitted.",
  );
}

const SubmittedTemplate = z.object({
  connectionId: z.guid(),
  /** As submitted, versioned (reminder_24h_v1); Meta's name rules. */
  name: z.string().regex(/^[a-z0-9_]{1,512}$/),
  language: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/),
  category: z.string().transform((c) => c.toLowerCase()).pipe(z.enum(["utility", "marketing", "authentication"])),
  /** What was sent to Meta: its components array ([{ type: "BODY", text }, …]) or { body, examples, buttons }. */
  components: z.unknown().refine((c) => templateBody(c) !== null, "must include the body text"),
  /** Meta's answer to the submission (POST /<waba>/message_templates): { id, status, category }. */
  meta: z.object({ id: z.string().min(1).max(64), status: z.string().optional(), category: z.string().optional() }),
  /** Who submitted it: a user id, or "system" for a job. */
  actor: z.union([z.literal("system"), z.guid()]).default("system"),
});
export type SubmittedTemplate = z.input<typeof SubmittedTemplate>;

export type TemplateStatus = "pending" | "approved" | "rejected";

/** Meta's status in a submission answer, as set_template_status (0007) reads its webhook; anything else is still pending. */
function submittedStatus(metaStatus: string | undefined): TemplateStatus {
  const s = (metaStatus ?? "").toLowerCase();
  return s === "approved" || s === "rejected" ? s : "pending";
}

/**
 * Stores a template Meta has accepted for review, for both callers that submit one: createTemplate (the dashboard)
 * and Dev 1's catalogue submission. Call it after the Graph submit succeeds, with Meta's answer. One row per number,
 * name and language: submitting the same one again (a retry, a resubmission) replaces it with Meta's latest id and
 * status. Meta's category wins over the submitted one, since Meta may move a template to another category. Later status
 * changes arrive through set_template_status from the webhook; one that arrives before this row exists finds nothing.
 *
 * The connection must belong to `tenantId`: for our shared platform number that is the platform business, which owns its
 * templates (0030). Throws when it doesn't, or when the input is not a submitted template.
 */
export async function saveSubmittedTemplate(
  tenantId: string,
  input: SubmittedTemplate,
  db: SupabaseClient = supabaseAdmin(),
): Promise<{ id: string; status: TemplateStatus }> {
  const t = SubmittedTemplate.parse(input);
  const connection = await db.from("whatsapp_connections").select("id").eq("tenant_id", tenantId).eq("id", t.connectionId).limit(1);
  if (connection.error) throw new Error(`saveSubmittedTemplate: connection read failed: ${connection.error.message}`);
  if (!connection.data?.length) throw new Error("saveSubmittedTemplate: that WhatsApp connection does not belong to this business");

  const status = submittedStatus(t.meta.status);
  const metaCategory = SubmittedTemplate.shape.category.safeParse(t.meta.category ?? "");
  const saved = await db
    .from("whatsapp_templates")
    .upsert(
      {
        tenant_id: tenantId,
        connection_id: t.connectionId,
        name: t.name,
        language: t.language,
        category: metaCategory.success ? metaCategory.data : t.category,
        components: t.components,
        status,
        rejection_reason: null,
        meta_template_id: t.meta.id,
      },
      { onConflict: "connection_id,name,language" },
    )
    .select("id, status")
    .single();
  if (saved.error) throw new Error(`saveSubmittedTemplate: save failed: ${saved.error.message}`);
  const row = z.object({ id: z.string(), status: z.enum(["pending", "approved", "rejected"]) }).parse(saved.data);

  // The row is what matters; a lost audit row is logged rather than failing a submission Meta already has.
  try {
    await writeAudit({
      tenantId,
      actor: t.actor,
      action: "template.submitted",
      entity: "whatsapp_template",
      entityId: row.id,
      diff: { name: t.name, language: t.language, status: row.status },
    });
  } catch (e) {
    console.error(`[templates] audit row not written for template ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return row;
}
