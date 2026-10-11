import type { TenantContext } from "@pakka/types";
import { z } from "zod";
import { AppError } from "../../lib/errors";
import { requireRole } from "../../lib/tenant";
import { buildLeadCard } from "./build";
import type { LeadCard } from "./card";

// GET /api/conversations/:id/lead-card (docs/dashboard-screen-contracts.md, Inbox): the card pinned beside a chat. Owner, admin or staff of the
// business; the business comes from the caller's own session (never from the request), so a chat of another business is just "not found". Free: a
// lead card costs no credits (docs/handover.md, module 7). The route only checks who and which; buildLeadCard does the work.

const ConversationId = z.guid();

export async function getLeadCard(context: TenantContext, conversationId: string, build: typeof buildLeadCard = buildLeadCard): Promise<LeadCard> {
  requireRole(context, ["owner", "admin", "staff"], "see a lead card");
  if (!ConversationId.safeParse(conversationId).success) throw new AppError("not_found", "That conversation was not found.");
  const card = await build(context.tenant.id, conversationId);
  if (!card) throw new AppError("not_found", "That conversation was not found.");
  return card;
}
