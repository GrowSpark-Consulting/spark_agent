import { z } from "zod";
import { getJson } from "@/lib/api/client";
import { formatError } from "@/lib/errors";

// The AI-written part of the lead card: GET /api/conversations/:id/lead-card (backend/src/agent/leadcard/card.ts, route.ts; Dev 1, Day 4).
// Owner, admin or staff; the business is the caller's own (X-Pakka-Tenant, checked against the session), so a chat of another business is
// `not_found`. Free. The route builds the card from the database and the chat; its words (`need`, `summary`, `nextStep`, `suggestedReply`,
// `discount`) are written by the model when it can be and by code when it cannot (`aiWritten`).
//
// What the panel takes from it: the words and the flags below. What it does NOT take: `score`, `temperature`, `answers`, `booking` and
// `trigger`, which the panel already shows from the database rows it reads under RLS (lead-card-data.ts); drawing them twice could make
// the card disagree with itself. The customer's full number (`contact.phone`) is dropped here, so it can never reach the page; the panel
// shows the masked one it already has. `owner` is always null today (Dev 1 doesn't know a lead's owner), so it is shown only when set.

const Temperature = z.enum(["hot", "warm", "cold", "disqualified"]);
const Sentiment = z.enum(["positive", "neutral", "negative", "angry"]);

/** The response, as the contract sends it. Unknown extra fields (and `contact.phone`) are dropped; a missing or mistyped one rejects it. */
export const LeadCardResponse = z.object({
  contact: z.object({ name: z.string().nullable(), phoneMasked: z.string(), language: z.string().nullable() }),
  need: z.string(),
  languageNote: z.string(),
  source: z.string(),
  answers: z.array(z.string()),
  /** null for a lead that hasn't been scored: it is not zero. */
  score: z.number().nullable(),
  temperature: Temperature.nullable(),
  isHot: z.boolean(),
  booking: z.string().nullable(),
  trigger: z.string().nullable(),
  priority: z.enum(["high", "normal"]).nullable(),
  sentiment: Sentiment,
  summary: z.string(),
  nextStep: z.string(),
  suggestedReply: z.string().nullable(),
  discount: z.string().nullable(),
  owner: z.string().nullable(),
  aiWritten: z.boolean(),
});
export type LeadCardResponse = z.infer<typeof LeadCardResponse>;

const SENTIMENT_LABEL: Record<z.infer<typeof Sentiment>, string> = {
  positive: "Positive",
  neutral: "Neutral",
  negative: "Negative",
  angry: "Angry",
};

/** What the panel needs from the response. A field the response left empty is null: nothing is filled in for it. */
export interface LeadCardAi {
  /** The conversation this was made for. The panel shows it only beside that conversation, never another. */
  conversationId: string;
  need: string | null;
  /** Two to five short lines, separated by line breaks. */
  summary: string | null;
  nextStep: string | null;
  sentiment: string | null;
  languageNote: string | null;
  source: string | null;
  owner: string | null;
  priority: "high" | "normal" | null;
  /** The score says hot, or the alert was raised because the lead turned hot. */
  isHot: boolean;
  /** What the customer asked for in a discount request. */
  discount: string | null;
  /** A reply staff can send as it is; shown for reading, never sent from the card. */
  suggestedReply: string | null;
  /** The words were written by the model (true) or by code (false). */
  aiWritten: boolean;
}

/** The AI part of the card as the panel sees it: it is read apart from the stored lead, and fails apart from it. */
export type LeadCardAiState = { status: "loading" } | { status: "unavailable"; message: string } | { status: "ready"; ai: LeadCardAi };

/** A line of the card is read at a glance: a long one is cut, not allowed to take over the panel. */
export const AI_TEXT_MAX = 600;

/** Lines trimmed, blank lines dropped, cut at the limit. null when nothing is left. */
function tidy(value: string): string | null {
  const lines = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .filter((line) => line !== "");
  const text = lines.join("\n");
  if (text === "") return null;
  return text.length > AI_TEXT_MAX ? `${text.slice(0, AI_TEXT_MAX - 1)}…` : text;
}

export class LeadCardDataError extends Error {
  constructor() {
    super("The lead card answer had an unexpected shape.");
    this.name = "LeadCardDataError";
  }
}

/** The panel's AI part from a response, for one conversation. null when the JSON doesn't match the contract: a wrong shape is never half shown. */
export function toLeadCardAi(json: unknown, conversationId: string): LeadCardAi | null {
  const parsed = LeadCardResponse.safeParse(json);
  if (!parsed.success || conversationId.trim() === "") return null;
  const c = parsed.data;
  return {
    conversationId,
    need: tidy(c.need),
    summary: tidy(c.summary),
    nextStep: tidy(c.nextStep),
    sentiment: SENTIMENT_LABEL[c.sentiment],
    languageNote: tidy(c.languageNote),
    source: tidy(c.source),
    owner: c.owner === null ? null : tidy(c.owner),
    priority: c.priority,
    isHot: c.isHot,
    discount: c.discount === null ? null : tidy(c.discount),
    suggestedReply: c.suggestedReply === null ? null : tidy(c.suggestedReply),
    aiWritten: c.aiWritten,
  };
}

/** Reads the AI part of the lead card for one of the member's chats. Throws ApiError, or LeadCardDataError for an answer that doesn't fit the contract. */
export async function fetchLeadCardAi(tenantId: string, conversationId: string, signal?: AbortSignal): Promise<LeadCardAi> {
  const json = await getJson<unknown>(`/api/conversations/${encodeURIComponent(conversationId)}/lead-card`, { tenantId, signal });
  const ai = toLeadCardAi(json, conversationId);
  if (!ai) throw new LeadCardDataError();
  return ai;
}

/** What the card says when the AI part can't be shown. Never the raw error: formatError keeps provider text and secrets out. */
export function unavailableAi(err: unknown): LeadCardAiState {
  if (err instanceof LeadCardDataError) return { status: "unavailable", message: "The AI summary came back in a form we couldn't read." };
  return { status: "unavailable", message: formatError(err).message };
}
