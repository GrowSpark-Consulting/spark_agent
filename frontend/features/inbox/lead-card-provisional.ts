import { z } from "zod";

// PROVISIONAL. Not an API contract.
//
// Dev 1 has not published the lead-card JSON. The only description of it is a PROPOSAL: the `LeadCard` interface in
// docs/dashboard-screen-contracts.md (Inbox section, "buildLeadCard(leadId), Dev 1"), whose route
// (`GET /api/conversations/:id/lead-card`) is itself marked PROPOSED and is open question 2 ("a route, or a column/view
// the inbox reads?"). There is no such route in backend/src/server/routes.ts and no `LeadCard` in packages/types.
//
// So this file is the smallest thing that lets the panel be built and tested before the real schema lands:
//   - `ProvisionalLeadCardJson` copies the proposal field for field. It is NOT in packages/types and nothing in the
//     app calls an endpoint for it. When Dev 1's schema exists, it replaces this schema; the panel does not change.
//   - `LeadCardAi` is what the PANEL reads: our own shape, independent of the wire format. Only `fromProvisionalLeadCard`
//     knows the wire format, so the final schema costs one new adapter and this file's deletion, not a panel rewrite.
//   - In production nothing produces a `LeadCardAi`, so the panel shows exactly what it showed before. The sample in
//     fixtures/inbox/provisional-lead-card.ts is used by tests only, and anything built from it says it is a sample.
//
// Assumptions in the proposal that need Dev 1's answer (each is why this is provisional):
//   1. `score: number` and `temperature: string`: leads.score is nullable and temperature is hot|warm|cold|disqualified
//      (migration 0001). Does buildLeadCard send null for an unscored lead? Is temperature the same four values?
//   2. `answers: string[]`: already-formatted strings? The panel shows the stored answers itself (labelled by the pack, from
//      leads.fields), so `answers`, `score`, `temperature`, `booking` and `trigger` of the proposal are NOT drawn from here.
//      The database values are the source for those rows; drawing them twice could make the card disagree with itself.
//   3. `booking` and `trigger` are strings in the proposal; the panel's booking and "Handed over" rows come from bookings
//      and handoffs. Should the AI card replace them once it exists?
//   4. `sentiment: string`: free text or an enum (the extraction's is positive|neutral|negative|angry)?
//   5. `source` and `owner`: what do they hold (the channel? a staff member's name or user id)?
//   6. Links: handover.md module 6 says the card carries "links", but the proposal has no link field. None is shown.
//   7. Language: `languageNote` is free text in the proposal; the conversation already has `language`.

/** The proposal, transcribed. Unknown extra fields are dropped. */
export const ProvisionalLeadCardJson = z.object({
  need: z.string(),
  languageNote: z.string(),
  source: z.string(),
  answers: z.array(z.string()),
  score: z.number(),
  temperature: z.string(),
  booking: z.string().nullable(),
  trigger: z.string().nullable(),
  sentiment: z.string(),
  summary: z.string(),
  nextStep: z.string(),
  owner: z.string().nullable(),
});
export type ProvisionalLeadCardJson = z.infer<typeof ProvisionalLeadCardJson>;

/** What the panel needs from an AI-written lead card: the parts the database cannot give it. */
export interface LeadCardAi {
  /** The conversation this was made for. The panel shows it only beside that conversation, never another. */
  conversationId: string;
  /** Where it came from. `provisional` is a sample in the proposed shape, not a live answer. */
  origin: "provisional";
  need: string | null;
  summary: string | null;
  nextStep: string | null;
  sentiment: string | null;
  languageNote: string | null;
  source: string | null;
  owner: string | null;
}

/** A line of a lead card is read by staff at a glance: a long one is cut, not allowed to take over the panel. */
export const AI_TEXT_MAX = 600;

const clean = (value: string): string | null => {
  const text = value.replace(/\s+/g, " ").trim();
  if (text === "") return null;
  return text.length > AI_TEXT_MAX ? `${text.slice(0, AI_TEXT_MAX - 1)}…` : text;
};

/**
 * The panel's AI rows from a lead card in the proposed shape, for one conversation. null when the JSON does not match
 * the proposal (a wrong shape is never half shown) or has no AI-written text at all.
 */
export function fromProvisionalLeadCard(json: unknown, conversationId: string): LeadCardAi | null {
  const parsed = ProvisionalLeadCardJson.safeParse(json);
  if (!parsed.success || conversationId.trim() === "") return null;
  const c = parsed.data;
  const ai: LeadCardAi = {
    conversationId,
    origin: "provisional",
    need: clean(c.need),
    summary: clean(c.summary),
    nextStep: clean(c.nextStep),
    sentiment: clean(c.sentiment),
    languageNote: clean(c.languageNote),
    source: clean(c.source),
    owner: c.owner === null ? null : clean(c.owner),
  };
  const hasText = [ai.need, ai.summary, ai.nextStep, ai.sentiment, ai.languageNote, ai.source, ai.owner].some((v) => v !== null);
  return hasText ? ai : null;
}
