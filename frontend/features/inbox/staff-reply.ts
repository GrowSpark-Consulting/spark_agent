import { z } from "zod";
import { postJson } from "@/lib/api/client";
import { ApiError, formatError, type FormattedError } from "@/lib/errors";

// A staff member's free-text reply, POST /api/conversations/:id/messages (backend/src/conversations/staff-reply.ts).
// The business goes in X-Pakka-Tenant, never the body. The API refuses free text outside the 24-hour window
// (`outside_window`) and a customer who opted out (`conflict`), so the UI's own window check is only a courtesy.
// The new message reaches the chat through realtime; nothing is added to the list here.
//
// A template chosen by staff is the route's other body (sendStaffTemplate, below). Not offered: a retry
// key. Without a key, sending the same text again sends a second message, so a failure whose outcome is
// unknown is reported as such (see replyFailure) and never retried automatically.

const Result = z.object({ messageId: z.string().min(1), providerMsgId: z.string().min(1), status: z.literal("accepted") });
export type StaffReplyResult = z.infer<typeof Result>;

export class StaffReplyDataError extends Error {
  constructor() {
    super("The reply answer had an unexpected shape.");
    this.name = "StaffReplyDataError";
  }
}

export async function sendStaffReply(tenantId: string, conversationId: string, body: string): Promise<StaffReplyResult> {
  const json = await postJson<unknown>(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, { body }, { tenantId });
  const parsed = Result.safeParse(json);
  if (!parsed.success) throw new StaffReplyDataError();
  return parsed.data;
}

/** What the composer shows for a failed send. `keepsText` is always true: the draft is never thrown away. */
export interface ReplyFailure extends FormattedError {
  /** The message may have gone out anyway: ask staff to look at the chat before sending again. */
  maybeSent: boolean;
}

export function replyFailure(err: unknown): ReplyFailure {
  const formatted = formatError(err);
  // The request got no answer (offline, dropped) or the API had a server fault after possibly reaching WhatsApp.
  // not_available (501) is the API saying WhatsApp sending isn't switched on: refused before anything was sent.
  const serverFault = err instanceof ApiError && err.body.error.code !== "not_available" && (err.status >= 500 || err.body.error.code === "upstream_failed");
  const maybeSent = formatted.code === "network" || serverFault || err instanceof StaffReplyDataError;
  if (err instanceof StaffReplyDataError) {
    return { ...formatted, code: "internal", title: "Couldn't confirm the message", message: "We couldn't confirm whether the message was sent.", retryable: false, maybeSent };
  }
  return { ...formatted, maybeSent };
}

/**
 * An approved template, for a chat whose 24-hour window has closed (or any chat): `{ template: { name, language, params } }`,
 * the other body of the same route (`SendStaffTemplateInput`). The server refuses a template that isn't approved for the chat's number
 * (`not_found`) and a wrong number of values (`validation_failed`). Same answer, same rules about an unknown outcome as free text.
 */
export async function sendStaffTemplate(
  tenantId: string,
  conversationId: string,
  template: { name: string; language: string; params: string[] },
): Promise<StaffReplyResult> {
  const body = { template: { name: template.name, language: template.language, params: template.params.map((p) => p.trim()) } };
  const json = await postJson<unknown>(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, body, { tenantId });
  const parsed = Result.safeParse(json);
  if (!parsed.success) throw new StaffReplyDataError();
  return parsed.data;
}
