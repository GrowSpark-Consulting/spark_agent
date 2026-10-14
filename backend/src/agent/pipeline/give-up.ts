import { answerAfterFailure } from "./reply";
import { BATCH_WINDOW_MS } from "./process-message";
import { replyDeps } from "./runtime";
import { createPipelineStore } from "./store";

// The last resort of process-message (inngest/process-message.ts, `onFailure`): a run failed after its retries, so no
// step will ever answer this customer. If their messages are still unanswered and the chat is still the assistant's, one
// safe line goes out. Best effort and silent on failure: whatever went wrong is already in the log, and the message
// stays in the inbox for a person. Safe to call twice (it looks before it sends). Ids in, a word out.

export async function answerRunThatGaveUp(ids: { tenantId: string; conversationId: string; messageId: string }): Promise<"sent" | "opted_out" | "nothing_to_do" | "already_replied" | "not_sent"> {
  try {
    return await answerAfterFailure(ids, BATCH_WINDOW_MS, replyDeps(createPipelineStore()));
  } catch (error) {
    // The environment or the database is what failed: the class only (never a message), and the run's own failure is already logged.
    console.error(`[pipeline] the safe line after giving up could not be sent (${error instanceof Error ? error.name : "unknown"})`);
    return "not_sent";
  }
}
