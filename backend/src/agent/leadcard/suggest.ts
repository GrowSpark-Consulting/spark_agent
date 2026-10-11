import type { TenantContext } from "@pakka/types";
import { z } from "zod";
import { AppError } from "../../lib/errors";
import { requireRole } from "../../lib/tenant";
import { buildLeadCard } from "./build";

// POST /api/conversations/:id/suggest (docs/handover.md, module 7): the reply a staff member can send as it is, written for the customer's last message.
// It is the lead card's suggested reply (build.ts keeps it on the customer's latest message, so asking again costs no model call), which already passes the
// same checks as everything the assistant writes: no number or link that the chat, the lead's details or the booking did not give, at most two questions,
// short enough to read at a glance. Owner, admin or staff of the business; the business comes from the caller's own session. Free: no credits, nothing is
// sent: the staff member sends it themselves (or edits it first) through the staff reply route.
//
// When there is nothing safe to suggest (the model is down, or its words did not pass the checks) the answer is still a 200 with `reply: null` and the reason,
// so the button can say "No suggestion this time" instead of showing an error.

const ConversationId = z.guid();

export type Suggestion = {
  reply: string | null;
  /** The customer's language as the assistant has it, so the staff member can see which language the reply is in. */
  language: string | null;
  /** Why there is no reply: the assistant could not write one this time. Null when there is a reply. */
  reason: "unavailable" | null;
};

export async function suggestReply(context: TenantContext, conversationId: string, build: typeof buildLeadCard = buildLeadCard): Promise<Suggestion> {
  requireRole(context, ["owner", "admin", "staff"], "get a suggested reply");
  if (!ConversationId.safeParse(conversationId).success) throw new AppError("not_found", "That conversation was not found.");
  const card = await build(context.tenant.id, conversationId);
  if (!card) throw new AppError("not_found", "That conversation was not found.");
  const reply = card.aiWritten && card.suggestedReply ? card.suggestedReply : null;
  return { reply, language: card.contact.language, reason: reply === null ? "unavailable" : null };
}
