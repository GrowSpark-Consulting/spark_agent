import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

// Message template approval status, as the WhatsApp screen shows it. Read from `whatsapp_templates` under RLS (migration 0007: members
// read their own business's rows, server code is the only writer: Dev 2's createTemplate inserts a row as `pending`, and Dev 1's
// webhook moves it with Meta's own status). Nothing here submits or changes a template, and a status is shown as stored, never guessed.

export const TEMPLATE_STATUSES = ["draft", "pending", "approved", "rejected", "paused", "disabled"] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

const TemplateRow = z.object({
  id: z.guid(),
  tenant_id: z.guid(),
  connection_id: z.guid(),
  name: z.string(),
  language: z.string(),
  category: z.string(),
  status: z.enum(TEMPLATE_STATUSES),
  rejection_reason: z.string().nullable(),
});

export interface TemplateStatusRow {
  id: string;
  connectionId: string;
  name: string;
  language: string;
  category: string;
  status: TemplateStatus;
  /** Meta's reason when it rejected the template; null otherwise. */
  rejectionReason: string | null;
}

const COLUMNS = "id, tenant_id, connection_id, name, language, category, status, rejection_reason";

/** The business's templates, newest name order. A row that isn't in the contract's shape fails the read: it is never half shown. */
export async function fetchTemplates(client: SupabaseClient, tenantId: string): Promise<TemplateStatusRow[]> {
  const { data, error } = await client.from("whatsapp_templates").select(COLUMNS).eq("tenant_id", tenantId).order("name", { ascending: true });
  if (error) throw error;
  const parsed = z.array(TemplateRow).safeParse(data ?? []);
  if (!parsed.success) throw new Error("The template data had an unexpected shape.");
  return parsed.data
    .filter((r) => r.tenant_id === tenantId)
    .map((r) => ({
      id: r.id,
      connectionId: r.connection_id,
      name: r.name,
      language: r.language,
      category: r.category,
      status: r.status,
      rejectionReason: r.rejection_reason?.trim() || null,
    }));
}

export const STATUS_TEXT: Record<TemplateStatus, { label: string; tone: "ok" | "warn" | "off"; detail: string }> = {
  approved: { label: "Approved", tone: "ok", detail: "Can be sent outside the 24-hour window." },
  pending: { label: "Waiting for Meta", tone: "off", detail: "Submitted. It can't be sent until Meta approves it." },
  draft: { label: "Draft", tone: "off", detail: "Not submitted to Meta yet." },
  rejected: { label: "Rejected", tone: "warn", detail: "Meta didn't approve it, so it can't be sent." },
  paused: { label: "Paused", tone: "warn", detail: "Meta paused it (usually low quality), so it can't be sent right now." },
  disabled: { label: "Disabled", tone: "warn", detail: "Meta disabled it, so it can't be sent." },
};

export interface TemplateSummary {
  total: number;
  counts: Record<TemplateStatus, number>;
}

export function summarizeTemplates(rows: readonly Pick<TemplateStatusRow, "status">[]): TemplateSummary {
  const counts = Object.fromEntries(TEMPLATE_STATUSES.map((s) => [s, 0])) as Record<TemplateStatus, number>;
  for (const r of rows) counts[r.status] += 1;
  return { total: rows.length, counts };
}

const LANGUAGE: Record<string, string> = { en: "English", ta: "Tamil", hi: "Hindi", te: "Telugu", kn: "Kannada", ml: "Malayalam" };

/** "ta" → "Tamil"; a code it doesn't know is shown as it is. */
export const languageName = (code: string): string => LANGUAGE[code.toLowerCase()] ?? code;

/** One sentence for the whole set, only counting what is stored: "2 approved, 1 waiting for Meta, 1 rejected." */
export function summaryLine(summary: TemplateSummary): string {
  if (summary.total === 0) return "No templates have been submitted for this number yet.";
  const parts: string[] = [];
  const add = (n: number, text: string) => n > 0 && parts.push(`${n} ${text}`);
  add(summary.counts.approved, "approved");
  add(summary.counts.pending, "waiting for Meta");
  add(summary.counts.draft, summary.counts.draft === 1 ? "draft" : "drafts");
  add(summary.counts.rejected, "rejected");
  add(summary.counts.paused, "paused");
  add(summary.counts.disabled, "disabled");
  return `${parts.join(", ")}.`;
}
