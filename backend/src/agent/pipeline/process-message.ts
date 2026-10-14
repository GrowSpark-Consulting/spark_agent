import { NonRetriableError } from "inngest";
import type { AiLimit } from "../../lib/ai-limits";
import { MessageReceived } from "./events";
import { decideGate, isAnswerable, type GateReason } from "./gate";
import type { PendingMessage, PipelineStore } from "./store";

// The message pipeline, steps 2 and 3 (docs/handover.md, "Message pipeline"): who wrote, their open lead, and
// whether the AI answers. Written against a minimal `step.run` so it is tested without Inngest, and as a plain
// function the later steps (4 extraction, 5 decide, 6 act, 7 reply, 8 charge and send) extend: `runTurn`
// returns the `TurnContext` they start from.
//
// Every stage is a step, so a failure retries that stage only and what finished is not repeated. What a step
// returns is what Inngest remembers, in its own storage: ids, flags and small facts only. A message's text, a
// phone number or a name is never returned; a later step reads what it needs from the database when it runs.
//
// The run answers a BATCH, not the one message whose event started it. Messages from one customer within a few
// seconds start one run (a debounce keeps only the LAST event), so the run collects the customer's unanswered
// messages itself, and the event is only where to look. The gate decides for the conversation (opted out, a
// person's chat, the feature off) and then for each message (a photo or voice note is left for staff, the rest
// are answered): a photo sent after a text must not take the text with it.
//
// Idempotent: a message that has been answered is skipped however often its event arrives. "Answered" is an
// audit row (ANSWERED_ACTION) that the reply step writes after it sends, for EVERY message of the batch, in the
// same step as the send (a crash between the two would otherwise send the reply twice). A repeated run finds the
// lead the first run made. The reply step must also re-read the chat's mode and the opt-out flag right before it
// sends: staff may have taken over, or the customer sent STOP, since this run looked.

export interface StepRunner {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

export interface TurnDeps {
  store: PipelineStore;
  /** isEnabled(tenantId, "ai_auto_reply"): the plan has it, the business switched it on and is live. */
  isEnabled: (tenantId: string, feature: "ai_auto_reply") => Promise<boolean>;
  /** The rate limit or daily AI spend cap the chat has reached (lib/ai-limits.ts aiLimitFor), or null. Without it, no limits apply. */
  aiLimit?: (tenantId: string, conversationId: string) => Promise<AiLimit | null>;
}

/**
 * Customer messages from this long before the one that started the run are answered with it. A burst starts one
 * run 3 seconds after its last message, and never later than 15 seconds after its first (the debounce limit).
 */
export const BATCH_WINDOW_MS = 15_000;

/** What steps 4 to 8 start from. Ids and small facts only. */
export interface TurnContext {
  tenantId: string;
  conversationId: string;
  contactId: string;
  leadId: string;
  /** True when this turn made the lead (the contact's first message about this business). */
  leadCreated: boolean;
  /**
   * The customer messages to answer together: the unanswered ones the agent can read, oldest first. Photos and
   * voice notes are not in it (they wait for staff). Write `message.answered` for every one of them after sending.
   */
  messageIds: string[];
  language: string | null;
  /** The pack to load for this business (key and pinned version). */
  vertical: string;
  verticalVersion: number;
}

export type SkipReason = "message_not_found" | "not_customer_message" | "already_answered" | "conversation_not_found" | "contact_not_found" | "tenant_not_found";

export type TurnResult =
  | { status: "skipped"; reason: SkipReason }
  | { status: "gated_off"; reason: GateReason; leadId: string }
  | { status: "ready"; turn: TurnContext };

type Resolved =
  | { skip: SkipReason }
  | {
      createdAt: string;
      kind: string | null;
      contactId: string;
      mode: "ai" | "human" | "external";
      optedOut: boolean;
      language: string | null;
      vertical: string;
      verticalVersion: number;
    };

export async function runTurn(step: StepRunner, rawEvent: unknown, deps: TurnDeps): Promise<TurnResult> {
  const parsed = MessageReceived.safeParse(rawEvent);
  if (!parsed.success) throw new NonRetriableError("The message event is not valid.");
  const { tenantId, conversationId, messageId } = parsed.data;
  const { store } = deps;

  // Step 2, part one: who and what. Everything is read for this business, and the message must be this
  // business's and this conversation's: the ids in an event are only a way to look things up.
  const resolved = await step.run<Resolved>("resolve", async () => {
    const message = await store.getMessage(tenantId, conversationId, messageId);
    if (!message) return { skip: "message_not_found" };
    if (message.direction !== "in" || message.sender !== "customer") return { skip: "not_customer_message" };
    const conversation = await store.getConversation(tenantId, conversationId);
    if (!conversation) return { skip: "conversation_not_found" };
    const [contact, tenant] = await Promise.all([store.getContact(tenantId, conversation.contactId), store.getTenant(tenantId)]);
    if (!contact) return { skip: "contact_not_found" };
    if (!tenant) return { skip: "tenant_not_found" };
    // Built field by field, never the rows themselves: a step's result is kept by Inngest.
    return {
      createdAt: message.createdAt,
      kind: message.kind,
      contactId: contact.id,
      mode: conversation.mode,
      optedOut: contact.optedOut,
      language: contact.language,
      vertical: tenant.vertical,
      verticalVersion: tenant.verticalVersion,
    };
  });
  if ("skip" in resolved) return { status: "skipped", reason: resolved.skip };

  // The messages to answer together, and the idempotency check, before anything is written. The event's own
  // message is in the batch if it has not been answered; if it has, the batch may still hold newer messages (a
  // late or repeated event can be the one a debounce kept), and only an empty batch means there is nothing to do.
  // Only the newest ten are ever read (store.ts BATCH_LIMIT). A message that is NOT among them has more than ten newer ones, so it is not the
  // newest and a newer turn answers for it: this run must not add it back (that sent a second reply per older message in a flood of more than ten).
  const batch = await step.run<PendingMessage[]>("batch", async () => {
    const since = new Date(Date.parse(resolved.createdAt) - BATCH_WINDOW_MS).toISOString();
    // Copied field by field: what a step returns is kept by Inngest.
    const pending: PendingMessage[] = (await store.recentUnanswered(tenantId, conversationId, since)).map((m) => ({ id: m.id, kind: m.kind }));
    return pending;
  });
  if (batch.length === 0) return { status: "skipped", reason: "already_answered" };

  // Step 2, part two: the contact's open lead. Made even when the AI will not answer (a person has the chat, the
  // feature is off, the business is not live): a customer who wrote is a lead the business wants to see.
  const lead = await step.run("lead", async () => {
    const found = await store.findOrCreateOpenLead(tenantId, resolved.contactId);
    return { leadId: found.id, created: found.created };
  });

  // Step 3: the gate, for the conversation. isEnabled (a database read, cached for a minute) is only asked when no
  // earlier reason already decides, and the limits (rate limits, the daily AI spend cap) only when the AI would answer.
  const gate = await step.run("gate", async () => {
    const needsFeature = !resolved.optedOut && resolved.mode === "ai";
    const featureEnabled = needsFeature ? await deps.isEnabled(tenantId, "ai_auto_reply") : true;
    const limit = needsFeature && featureEnabled && deps.aiLimit ? await deps.aiLimit(tenantId, conversationId) : null;
    return decideGate({ optedOut: resolved.optedOut, mode: resolved.mode, featureEnabled, limit });
  });
  if (!gate.open) return { status: "gated_off", reason: gate.reason, leadId: lead.leadId };

  // Step 3, for each message: the ones the agent can read are answered; photos and voice notes wait for staff.
  const messageIds = batch.filter((m) => isAnswerable(m.kind)).map((m) => m.id);
  if (messageIds.length === 0) return { status: "gated_off", reason: "unsupported_kind", leadId: lead.leadId };

  return {
    status: "ready",
    turn: {
      tenantId,
      conversationId,
      contactId: resolved.contactId,
      leadId: lead.leadId,
      leadCreated: lead.created,
      messageIds,
      language: resolved.language,
      vertical: resolved.vertical,
      verticalVersion: resolved.verticalVersion,
    },
  };
}
