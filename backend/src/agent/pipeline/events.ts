import { z } from "zod";

/** Sent by the WhatsApp webhook for every stored inbound message (channels/whatsapp/inbound.ts), replays included. */
export const MESSAGE_RECEIVED_EVENT = "whatsapp/message.received";

/** Ids only (docs/contracts.md, section 5): never a phone number, a name or message text. */
export const MessageReceived = z.object({ tenantId: z.guid(), conversationId: z.guid(), messageId: z.guid() });
export type MessageReceived = z.infer<typeof MessageReceived>;

/** The audit action that says a customer message has been answered: written by the reply step, read here. */
export const ANSWERED_ACTION = "message.answered";

/** The audit action that says staff were told this lead turned hot: written by the reply step, read back so it is told once per lead. */
export const HOT_LEAD_ACTION = "lead.hot_alerted";

/** The audit action that says staff were told a customer with no booking on record asked to cancel or move one: written by the reply step after a send that went out, read back so a later message's reply can still say the team has been told. */
export const BOOKING_REMINDER_ACTION = "lead.booking_change_reminder";

/** The event the reply step emits when a lead turns hot (ids only). Whoever sends staff alerts listens to it; nothing is changed by it. */
export const HOT_LEAD_EVENT = "lead.hot";

/** The event the reply step emits when a customer sent a voice note that was answered with the request to type (ids only), so staff can listen to it. */
export const VOICE_NOTE_EVENT = "voice_note.received";
