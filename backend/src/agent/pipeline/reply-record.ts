import { keyedMessageId } from "../../notify/send";
import { replyKey, type ReplyDeps } from "./reply";
import type { PipelineStore } from "./store";

// How the failure handler (reply.ts answerAfterFailure) tells that notify.send RECORDED a reply for a turn even when the reply step's own marker and
// answered rows were lost. notify.send gives a send under an idempotency key the message id keyedMessageId(business, kind, key); the reply goes out under
// `reply:<id of the turn's last message>`, and a send that fell back to the template (the window closed mid-send) is recorded under `<key>#template`
// (notify/send.ts earlierSend looks for both). So the reply's row, if it was recorded, is a message of the chat with one of these ids. If notify_record
// itself failed or never ran there is no row, and nothing of ours can tell (KNOWN GAP in the Day 6 reply-key note, section 3.1).

/** A burst is answered from its newest ten messages, and the turn's last message is the newest. */
const NEWEST = 10;

/** The ids a recorded reply for the newest of these messages would have: its key and its template fallback key. */
export function replyRecordIds(tenantId: string, messageIds: string[]): string[] {
  return messageIds.slice(-NEWEST).flatMap((id) => [keyedMessageId(tenantId, "ai_reply", replyKey(id)), keyedMessageId(tenantId, "ai_reply", `${replyKey(id)}#template`)]);
}

/**
 * Which of these customer messages a RECORDED reply belongs to (the reply is named by the turn's last message, so that message). A store that cannot be
 * read throws: the handler decides what to do.
 */
export function createSentReplyRecorded(store: Pick<PipelineStore, "recordedMessageIds" | "claimedMessageIds">): NonNullable<ReplyDeps["sentReplyRecorded"]> {
  return async (tenantId, conversationId, messageIds) => {
    const ids = replyRecordIds(tenantId, messageIds);
    if (ids.length === 0) return [];
    // A row notify_record wrote, or a claim notify.send made before it asked WhatsApp and never released (it may have gone out; a refusal for certain
    // releases it). Either one is enough; either read failing throws and the handler fails open.
    const [rows, claims] = await Promise.all([store.recordedMessageIds(tenantId, conversationId, ids), store.claimedMessageIds(tenantId, ids)]);
    const recorded = new Set([...rows, ...claims]);
    return messageIds.slice(-NEWEST).filter((id) => recorded.has(keyedMessageId(tenantId, "ai_reply", replyKey(id))) || recorded.has(keyedMessageId(tenantId, "ai_reply", `${replyKey(id)}#template`)));
  };
}
