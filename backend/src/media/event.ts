import { z } from "zod";

// The event the webhook starts for a customer's photo or document (ids only: no number, text or media id). The Inngest event id is
// media_received:<messageId>, so Meta's retry of the same message starts it once.

export const MEDIA_RECEIVED_EVENT = "whatsapp/media.received";

export const MediaReceivedEvent = z.object({ tenantId: z.guid(), conversationId: z.guid(), messageId: z.guid() });
export type MediaReceivedEvent = z.infer<typeof MediaReceivedEvent>;
