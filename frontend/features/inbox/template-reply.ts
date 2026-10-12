import type { SupabaseClient } from "@supabase/supabase-js";
import { WHATSAPP_TEXT_MAX } from "@pakka/types";
import { z } from "zod";

// The template picker's data (docs/contracts.md, section 4, staff_reply; `SendStaffTemplateInput` in @pakka/types). Outside the 24-hour
// window WhatsApp only takes an approved template, so staff choose one and fill its {{n}} values; the API checks the template is approved
// for the chat's own number and that the number of values matches (not_found, validation_failed). The list is read from
// `whatsapp_templates` under RLS (members read their own business's rows, 0007), only `approved` rows. The table does not say which
// number a chat is on and a Pro business can have several, so a template approved on another number can be listed and the API then
// answers not_found: the screen shows that answer, it does not guess.

const Row = z.object({
  id: z.guid(),
  tenant_id: z.guid(),
  name: z.string(),
  language: z.string(),
  category: z.string(),
  components: z.unknown(),
});

export interface SendableTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  /** The body text with its {{n}} placeholders, or null when the stored components don't have one (then it can't be offered). */
  body: string | null;
  /** The numbers of the body's variables, in order: the values are sent in this order. */
  variables: number[];
}

/**
 * The body text from `whatsapp_templates.components`, as submitted ({ body, … }) or as Meta lists it ([{ type: "BODY", text }]); the
 * same two shapes the server reads (backend/src/notify/send.ts, templateVariableCount).
 */
export function templateBody(components: unknown): string | null {
  let body: unknown;
  if (Array.isArray(components)) {
    const part = components.find((c) => typeof c === "object" && c !== null && String((c as { type?: unknown }).type).toUpperCase() === "BODY");
    body = (part as { text?: unknown } | undefined)?.text;
  } else if (typeof components === "object" && components !== null) {
    body = (components as { body?: unknown }).body;
  }
  return typeof body === "string" ? body : null;
}

export function bodyVariables(body: string): number[] {
  return [...new Set([...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}

/** The business's approved templates, by name then language. A row that isn't in the contract's shape fails the read: never half shown. */
export async function fetchSendableTemplates(client: SupabaseClient, tenantId: string): Promise<SendableTemplate[]> {
  const { data, error } = await client
    .from("whatsapp_templates")
    .select("id, tenant_id, name, language, category, components")
    .eq("tenant_id", tenantId)
    .eq("status", "approved")
    .order("name", { ascending: true });
  if (error) throw error;
  const parsed = z.array(Row).safeParse(data ?? []);
  if (!parsed.success) throw new Error("The template data had an unexpected shape.");
  return parsed.data
    .filter((r) => r.tenant_id === tenantId)
    .map((r) => {
      const body = templateBody(r.components);
      return { id: r.id, name: r.name, language: r.language, category: r.category, body, variables: body === null ? [] : bodyVariables(body) };
    });
}

/** The message as the customer will read it, with the values filled in; a value not typed yet leaves its {{n}} showing. */
export function renderPreview(template: Pick<SendableTemplate, "body" | "variables">, values: readonly string[]): string {
  const body = template.body ?? "";
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (whole, n: string) => {
    const at = template.variables.indexOf(Number(n));
    const value = at >= 0 ? values[at]?.trim() : "";
    return value ? value : whole;
  });
}

/** What stops this send, in words for the person filling the form; null when it can go. Mirrors the contract's own limits. */
export function paramProblem(values: readonly string[]): string | null {
  if (values.some((v) => v.trim() === "")) return "Fill in every value.";
  if (values.some((v) => v.trim().length > WHATSAPP_TEXT_MAX)) return `Keep each value under ${WHATSAPP_TEXT_MAX} characters.`;
  return null;
}
