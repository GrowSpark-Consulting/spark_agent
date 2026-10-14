// Step 3 of the pipeline, "gate" (docs/handover.md, module 2 and the message pipeline): whether the AI answers
// this conversation, and which of the customer's messages it can read. Plain code with no database and no
// model. A message turned away stays in the inbox for staff; nothing is sent and nothing is lost.

import type { AiLimit } from "../../lib/ai-limits";

export type GateReason = "opted_out" | "not_ai_mode" | "feature_off" | "unsupported_kind" | AiLimit;

export interface GateInput {
  /** contacts.opted_out_at is set: they said STOP. */
  optedOut: boolean;
  /** conversations.mode: 'ai', or 'human' / 'external' when a person has the chat. */
  mode: "ai" | "human" | "external";
  /** isEnabled(tenant, 'ai_auto_reply'): the plan has it, the business switched it on, and the business is live. */
  featureEnabled: boolean;
  /** A rate limit or the daily AI spend cap the chat has reached (lib/ai-limits.ts), or null/absent. */
  limit?: AiLimit | null;
}

/** The conversation-level decision, strongest reason first, so a trace says why the AI stayed out in the most useful words. */
export function decideGate(input: GateInput): { open: true } | { open: false; reason: Exclude<GateReason, "unsupported_kind"> } {
  if (input.optedOut) return { open: false, reason: "opted_out" };
  if (input.mode !== "ai") return { open: false, reason: "not_ai_mode" };
  if (!input.featureEnabled) return { open: false, reason: "feature_off" };
  if (input.limit) return { open: false, reason: input.limit };
  return { open: true };
}

/** The kinds of message the agent can read today. Voice notes and photos come later. */
export const SUPPORTED_KINDS: ReadonlySet<string> = new Set(["text", "interactive"]);

/** One message: `kind` is messages.kind, null on rows from before the column existed, which were text. */
export const isReadable = (kind: string | null): boolean => kind === null || SUPPORTED_KINDS.has(kind);

/**
 * What the assistant replies to: what it can read, and a voice note, which it cannot listen to yet (Raja, 11 Oct): it asks the customer, once, to
 * type. A photo, a document or a location is still left for staff, with no reply.
 */
export const isAnswerable = (kind: string | null): boolean => isReadable(kind) || kind === "audio";
