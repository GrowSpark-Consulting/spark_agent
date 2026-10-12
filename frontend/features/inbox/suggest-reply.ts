import { z } from "zod";
import { postJson } from "@/lib/api/client";
import { formatError, type FormattedError } from "@/lib/errors";

// A reply staff can send as it is: POST /api/conversations/:id/suggest, no body (backend/src/agent/leadcard/suggest.ts).
// Owner, admin or staff; free. The business goes in X-Pakka-Tenant, never the body. Nothing is sent by this route: the
// suggestion goes into the reply box for the staff member to read, edit and send (or not) through the staff reply route.
//
// Answers: `{ reply, language, reason }`. When there is nothing safe to suggest (the model is down, or its words didn't
// pass the API's checks) the answer is still a 200 with `reply: null` and `reason: "unavailable"`; that is "no suggestion
// this time", not an error. `not_found` is a chat that isn't this business's (or is gone).

const Answer = z.object({
  reply: z.string().nullable(),
  language: z.string().nullable(),
  reason: z.enum(["unavailable"]).nullable(),
});

export type SuggestionResult = { kind: "reply"; reply: string; language: string | null } | { kind: "unavailable" };

export class SuggestionDataError extends Error {
  constructor() {
    super("The suggested reply answer had an unexpected shape.");
    this.name = "SuggestionDataError";
  }
}

export async function requestSuggestion(tenantId: string, conversationId: string): Promise<SuggestionResult> {
  const json = await postJson<unknown>(`/api/conversations/${encodeURIComponent(conversationId)}/suggest`, undefined, { tenantId });
  const parsed = Answer.safeParse(json);
  if (!parsed.success) throw new SuggestionDataError();
  const reply = parsed.data.reply?.trim() ?? "";
  // A reply wins over a stray reason; a blank reply is no reply.
  return reply === "" ? { kind: "unavailable" } : { kind: "reply", reply, language: parsed.data.language };
}

const LANGUAGE_LABEL: Record<string, string> = { en: "English", ta: "Tamil", "ta-en": "Tanglish", hi: "Hindi", ml: "Malayalam" };

/** The customer's language in words, or null when it isn't one we have a name for (nothing is guessed). */
export function languageLabel(language: string | null): string | null {
  return language !== null && Object.hasOwn(LANGUAGE_LABEL, language) ? LANGUAGE_LABEL[language] : null;
}

/** What the composer shows when asking failed. Never the raw error. */
export function suggestionFailure(err: unknown): FormattedError {
  if (err instanceof SuggestionDataError) {
    return { code: "internal", title: "Couldn't read the suggestion", message: "The suggestion came back in a form we couldn't read.", retryable: true };
  }
  return formatError(err);
}

/** What happens when a suggestion arrives, given the draft in the box at that moment. */
export function placeSuggestion(draft: string): "fill" | "ask" {
  // An empty (or blank) draft is filled at once; anything the staff member typed is never overwritten without asking.
  return draft.trim() === "" ? "fill" : "ask";
}
