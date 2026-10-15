import { AGENT_PERSONA_MAX_LENGTH, AgentSettings, UpdateAgentSettings, type AgentTone, type AgentTriggerChange, type Role } from "@pakka/types";
import { getJson, patchJson } from "@/lib/api/client";
import { ApiError, formatError } from "@/lib/errors";

// The Agent settings screen's two routes (backend/src/agent/settings/agent-settings.ts; packages/types/src/agent-settings.ts;
// docs/task-notes/2026-10-15-feat-day8-agent-settings-route.md, "For the frontend"):
//   GET   /api/agent/settings   → AgentSettings                                  any member
//   PATCH /api/agent/settings   UpdateAgentSettings → AgentSettings (as now saved) owner or admin
// Both shapes are the backend's own schemas, and every answer is parsed before it is used. The server decides what is valid (the persona's
// wording, that nothing but the five switchable handovers is accepted) and merges a change into what is stored; this file only decides
// which fields a save sends (the ones that changed, and for the handovers only the ones that changed) and how a refusal reads.
// The booking service is not saved here: the Booking setup screen keeps that flow, so a save from this screen never sends it.

export { AgentSettings, UpdateAgentSettings, AGENT_PERSONA_MAX_LENGTH };

/** An answer that is not the contract's shape (a proxy, or a server on another version). Never shown half drawn. */
export class AgentSettingsDataError extends Error {
  constructor() {
    super("The agent settings answer had an unexpected shape.");
    this.name = "AgentSettingsDataError";
  }
}

/** What the screen calls. Injected in tests. */
export interface AgentSettingsService {
  load: (tenantId: string, signal?: AbortSignal) => Promise<AgentSettings>;
  update: (tenantId: string, patch: UpdateAgentSettings) => Promise<AgentSettings>;
}

export const agentSettingsService: AgentSettingsService = {
  async load(tenantId, signal) {
    const parsed = AgentSettings.safeParse(await getJson<unknown>("/api/agent/settings", { tenantId, signal }));
    if (!parsed.success) throw new AgentSettingsDataError();
    return parsed.data;
  },
  async update(tenantId, patch) {
    // Nothing is sent that the contract would refuse for its shape (an empty change, an unknown key): that would only come back as a 422.
    const body = UpdateAgentSettings.safeParse(patch);
    if (!body.success) throw new AgentSettingsDataError();
    const parsed = AgentSettings.safeParse(await patchJson<unknown>("/api/agent/settings", body.data, { tenantId }));
    if (!parsed.success) throw new AgentSettingsDataError();
    return parsed.data;
  },
};

// What the form holds ------------------------------------------------------------------------------------------

/** What the member is editing. The booking service is not in it: it is not saved from this screen. */
export interface AgentSettingsDraft {
  /** The text box; empty means no name. */
  persona: string;
  tone: AgentTone;
  privacyNotice: boolean;
  /** handover key → on, for the rows the server listed. */
  triggers: Record<string, boolean>;
}

/** The form's starting point: the server's values, so "changed" always means changed from what the server has. */
export function draftFrom(settings: AgentSettings): AgentSettingsDraft {
  return {
    persona: settings.persona ?? "",
    tone: settings.tone,
    privacyNotice: settings.privacyNotice,
    triggers: Object.fromEntries(settings.handoffTriggers.map((t) => [t.key, t.enabled])),
  };
}

/** The name as the server will read it: extra spaces tidied, and empty means no name. */
export function personaValue(text: string): string | null {
  const tidy = text.trim().replace(/\s+/g, " ");
  return tidy === "" ? null : tidy;
}

export const PERSONA_TOO_LONG = `Use ${AGENT_PERSONA_MAX_LENGTH} characters or fewer: a name, not a sentence.`;

export interface Changes {
  /** Only what differs from the server's values: send exactly this, or nothing when it is empty. */
  patch: UpdateAgentSettings;
  /** Problems the form can see before sending. The server still checks the persona's wording. */
  errors: { persona?: string };
}

export function changedFields(original: AgentSettings, draft: AgentSettingsDraft): Changes {
  const patch: UpdateAgentSettings = {};
  const errors: Changes["errors"] = {};
  const persona = personaValue(draft.persona);
  if (persona !== null && persona.length > AGENT_PERSONA_MAX_LENGTH) errors.persona = PERSONA_TOO_LONG;
  else if (persona !== original.persona) patch.persona = persona;
  if (draft.tone !== original.tone) patch.tone = draft.tone;
  if (draft.privacyNotice !== original.privacyNotice) patch.privacyNotice = draft.privacyNotice;
  const triggers: AgentTriggerChange[] = original.handoffTriggers.flatMap((t) => (draft.triggers[t.key] !== undefined && draft.triggers[t.key] !== t.enabled ? [{ key: t.key, enabled: draft.triggers[t.key] }] : []));
  if (triggers.length > 0) patch.handoffTriggers = triggers;
  return { patch, errors };
}

export const hasChanges = (c: Changes): boolean => Object.keys(c.patch).length > 0;

// Who may save ---------------------------------------------------------------------------------------------------

/** The server lets owners and admins write and every member read. It checks again on every PATCH (403 for staff). */
export const canEditAgentSettings = (role: Role | null | undefined): boolean => role === "owner" || role === "admin";

/** A save is offered only to someone who may write, when something changed, nothing is wrong and no save is already in flight. */
export function canSave(role: Role | null | undefined, changes: Changes, saving: boolean): boolean {
  return canEditAgentSettings(role) && !saving && hasChanges(changes) && Object.keys(changes.errors).length === 0;
}

// How a refusal reads ----------------------------------------------------------------------------------------------

export interface SaveFailure {
  message: string;
  /** Field-named problems from a 422 (`persona`, `tone`, ...). */
  fields: Record<string, string>;
  /** Someone else changed the settings (409): what is on screen is out of date, and the member can load the current ones. */
  stale: boolean;
}

/** The documented errors: 401, 403 (staff, or no business), 409 conflict, 422 validation_failed with `fields`. The draft is never touched by any of them. */
export function saveFailure(err: unknown): SaveFailure {
  // The server may have saved and answered in a shape this screen cannot read (or the change itself was malformed, before anything was sent): either way, don't say "nothing was saved".
  if (err instanceof AgentSettingsDataError) {
    return { message: "We couldn't read the server's answer, so we can't tell whether this was saved. Load the current settings to check.", fields: {}, stale: true };
  }
  const shown = formatError(err);
  const fields = err instanceof ApiError ? (shown.fields ?? {}) : {};
  switch (shown.code) {
    case "unauthenticated":
      return { message: "You're signed out, so nothing was saved. Sign in again; your changes are still here until you leave this page.", fields, stale: false };
    case "forbidden":
    case "no_membership":
      return { message: "Only an owner or admin can change these settings. Nothing was saved.", fields, stale: false };
    case "conflict":
      return { message: "These settings were changed somewhere else, so nothing was saved. Load the current ones, then make your change again.", fields, stale: true };
    case "validation_failed":
      return { message: Object.keys(fields).length > 0 ? "Nothing was saved. Check the highlighted fields." : `Nothing was saved. ${shown.message}`, fields, stale: false };
    default:
      return { message: `Nothing was saved. ${shown.message}`, fields, stale: false };
  }
}
