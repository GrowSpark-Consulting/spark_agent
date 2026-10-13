import { WHATSAPP_TEXT_MAX } from "@pakka/types";
import { z } from "zod";
import { getJson } from "@/lib/api/client";

// The template picker's data (docs/contracts.md, section 4, staff_reply; `SendStaffTemplateInput` in @pakka/types). Outside the 24-hour
// window WhatsApp only takes an approved template, so staff choose one and fill its {{n}} values. The list comes from
// GET /api/conversations/:id/templates (backend/src/conversations/templates.ts): the server picks the WhatsApp number the chat is on (the
// browser can't tell) and returns only that number's approved templates, so nothing is filtered or guessed here. `connectionId: null` means
// that number is not connected and nothing can be sent. The send checks again (not_found, validation_failed) and the screen shows its answer.

const TemplateRow = z.object({
  id: z.string(),
  name: z.string(),
  language: z.string(),
  category: z.string(),
  /** How many {{n}} values the body takes; null when the server could not read the body. */
  variableCount: z.number().int().nonnegative().nullable(),
  body: z.string().nullable(),
});

export const ConversationTemplatesAnswer = z.object({
  connectionId: z.string().nullable(),
  templates: z.array(TemplateRow),
});

export interface SendableTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  /** The body text with its {{n}} placeholders, or null when the server could not read one (then it can't be offered). */
  body: string | null;
  /** The numbers of the body's variables, in order: the values are sent in this order. */
  variables: number[];
}

export interface ConversationTemplateList {
  /** The chat's WhatsApp number, or null when it is not connected. */
  connectionId: string | null;
  templates: SendableTemplate[];
}

export function bodyVariables(body: string): number[] {
  return [...new Set([...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}

/**
 * The templates this chat's number can send, as the server answered. An answer that isn't in the contract's shape fails the read: never
 * half shown. A template whose body the server could not read, or whose value count disagrees with its body, carries `body: null` so it is
 * never offered (a wrong count would only be refused).
 */
export async function fetchConversationTemplates(tenantId: string, conversationId: string, signal?: AbortSignal): Promise<ConversationTemplateList> {
  const raw = await getJson<unknown>(`/api/conversations/${encodeURIComponent(conversationId)}/templates`, { tenantId, signal });
  const parsed = ConversationTemplatesAnswer.safeParse(raw);
  if (!parsed.success) throw new Error("The template data had an unexpected shape.");
  return {
    connectionId: parsed.data.connectionId,
    templates: parsed.data.templates.map((t) => {
      const variables = t.body === null ? [] : bodyVariables(t.body);
      const readable = t.body !== null && (t.variableCount === null || t.variableCount === variables.length);
      return { id: t.id, name: t.name, language: t.language, category: t.category, body: readable ? t.body : null, variables: readable ? variables : [] };
    }),
  };
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
