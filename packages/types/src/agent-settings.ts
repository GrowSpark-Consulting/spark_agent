import { z } from "zod";

// The Agent settings screen (docs/dashboard-screen-contracts.md, "Agent settings"): what the business tells the assistant, saved in tenants.agent_settings.
//   GET   /api/agent/settings → AgentSettings          any member
//   PATCH /api/agent/settings   UpdateAgentSettings → AgentSettings (the settings as they now stand)    owner or admin
// backend/src/agent/settings/agent-settings.ts builds its checks from the field schemas below and types its answer with AgentSettings, so the screen and the
// route cannot drift. The server adds the rules that need the business or the agent's own cleaning: the persona's wording (a name, not a sentence) and that a
// booking service is an active service of the business. Errors are the usual envelope: 401, 403 (staff), 409 conflict, 422 validation_failed with `fields`.

/**
 * The five handovers and alerts a business can switch off, in the order the screen shows them. `stuck`, `credits_exhausted` and `opt_out` also hand a chat to
 * a person, but the business cannot switch those off. The agent also reads the older names `gap`, `human`, `price_negotiation` and `hot`; they are read,
 * never written.
 */
export const AGENT_TRIGGER_KEYS = ["kb_gap", "asked_human", "complaint", "negotiation", "hot_lead"] as const;
export const AgentTriggerKey = z.enum(AGENT_TRIGGER_KEYS);
export type AgentTriggerKey = z.infer<typeof AgentTriggerKey>;

/** The most characters of the assistant's name (after extra spaces are tidied). */
export const AGENT_PERSONA_MAX_LENGTH = 30;

export const AgentTone = z.enum(["friendly", "formal"]);
export type AgentTone = z.infer<typeof AgentTone>;

/** The service the assistant books when the business has several: an id, or null for none. The server checks it is an active service of the business. */
export const AgentBookingServiceId = z.guid().nullable();

/** One of the five rows of the screen's "Hand over to a person" list. */
export const AgentTriggerRow = z.object({
  key: AgentTriggerKey,
  label: z.string(),
  example: z.string(),
  /** The handover is opened as high priority. */
  highPriority: z.boolean(),
  enabled: z.boolean(),
});
export type AgentTriggerRow = z.infer<typeof AgentTriggerRow>;

/** GET /api/agent/settings, and the answer of a PATCH: the settings as the agent reads them (an unknown tone is "friendly", a persona is cleaned). */
export const AgentSettings = z.object({
  /** The assistant's name, or null for the default. */
  persona: z.string().nullable(),
  tone: AgentTone,
  /** The first AI reply to a contact carries the privacy notice. Off by default. */
  privacyNotice: z.boolean(),
  bookingServiceId: z.string().nullable(),
  /** Always the five, in the order of AGENT_TRIGGER_KEYS. */
  handoffTriggers: z.array(AgentTriggerRow),
});
export type AgentSettings = z.infer<typeof AgentSettings>;

/** One trigger that changed: send only the ones the business changed, never the whole list. */
export const AgentTriggerChange = z.strictObject({ key: AgentTriggerKey, enabled: z.boolean() });
export type AgentTriggerChange = z.infer<typeof AgentTriggerChange>;

/** The triggers that changed: at least one, each key once. The server merges them by key into what is stored. */
export const AgentTriggerChanges = z
  .array(AgentTriggerChange)
  .min(1)
  .refine((list) => new Set(list.map((t) => t.key)).size === list.length, "Send each trigger once.");
export type AgentTriggerChanges = z.infer<typeof AgentTriggerChanges>;

/**
 * The body of PATCH /api/agent/settings: any of these, at least one, and nothing else. The server merges them into the stored settings (keys that are not sent
 * are kept). `persona` null or empty clears the name; `bookingServiceId` null clears the choice. The persona's wording rule (letters, numbers, spaces and
 * . ' & -, up to AGENT_PERSONA_MAX_LENGTH) is checked by the server.
 */
export const UpdateAgentSettings = z
  .strictObject({
    persona: z.string().nullable(),
    tone: AgentTone,
    privacyNotice: z.boolean(),
    bookingServiceId: AgentBookingServiceId,
    handoffTriggers: AgentTriggerChanges,
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: "Send at least one setting to change." });
export type UpdateAgentSettings = z.infer<typeof UpdateAgentSettings>;
