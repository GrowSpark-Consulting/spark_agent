import { z } from "zod";
import { nameForPrompt } from "../prompts/shared";

// What the reply step reads from `tenants.agent_settings` (jsonb the dashboard writes; members may update it under
// RLS). The keys are the ones the Agent settings screen saves (docs/dashboard-screen-contracts.md, "Agent settings":
// `persona`, `tone`, `handoffTriggers`, and `privacyNotice` for the consent notice), validated here, because a business can type anything into it. Anything that
// is missing or not the expected shape is ignored (the default persona and tone are used), never an error: a broken
// setting must not stop a customer's reply.

const TRIGGER_KEYS = { kb_gap: ["kb_gap", "gap"], asked_human: ["asked_human", "human"], complaint: ["complaint"] } as const;

const Settings = z.object({
  persona: z.string().optional().catch(undefined),
  tone: z.enum(["friendly", "formal"]).optional().catch(undefined),
  privacyNotice: z.boolean().optional().catch(undefined),
  bookingServiceId: z.guid().optional().catch(undefined),
  handoffTriggers: z
    .array(z.object({ key: z.string(), enabled: z.boolean().optional().catch(undefined) }).catch({ key: "", enabled: undefined }))
    .optional()
    .catch(undefined),
});

export interface ReplySettings {
  /** The assistant's name, if the business chose one (a name, not a sentence). */
  persona: string | null;
  tone: "friendly" | "formal";
  /** The business switched the "doesn't know the answer twice" handover off. */
  kbGapHandoffEnabled: boolean;
  /** The business switched off the handover for "wants a person" or for a complaint / an angry customer. */
  askedHumanHandoffEnabled: boolean;
  complaintHandoffEnabled: boolean;
  /** The first AI reply to a contact carries the privacy notice. Off unless the business turns it on (Raja, 9 Oct: switchable if legal review requires it). */
  privacyNotice: boolean;
  /**
   * The service the assistant books when the business has several active ones (a service's id). Without it the assistant books on its own only
   * when there is exactly one, and otherwise hands the chat to a person: it never picks a service for the customer.
   */
  bookingServiceId: string | null;
}

export function parseReplySettings(raw: unknown): ReplySettings {
  const parsed = Settings.safeParse(raw);
  const settings = parsed.success ? parsed.data : {};
  const persona = nameForPrompt(settings.persona ?? "", 30);
  const enabled = (keys: readonly string[]) => settings.handoffTriggers?.find((t) => keys.includes(t.key))?.enabled !== false;
  return {
    persona: persona || null,
    tone: settings.tone ?? "friendly",
    kbGapHandoffEnabled: enabled(TRIGGER_KEYS.kb_gap),
    askedHumanHandoffEnabled: enabled(TRIGGER_KEYS.asked_human),
    complaintHandoffEnabled: enabled(TRIGGER_KEYS.complaint),
    privacyNotice: settings.privacyNotice === true,
    bookingServiceId: settings.bookingServiceId ?? null,
  };
}
