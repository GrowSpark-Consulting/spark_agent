import type { TenantContext } from "@pakka/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { AppError, zodFieldErrors } from "../../lib/errors";
import { auditQuietly, writeAudit, type AuditEntry } from "../../lib/audit";
import { supabaseAdmin } from "../../lib/supabase-admin";
import { requireRole } from "../../lib/tenant";
import { nameForPrompt } from "../prompts/shared";
import { parseReplySettings, type ReplySettings } from "../pipeline/persona";

// GET and PATCH /api/agent/settings: what the Agent settings screen reads and saves in `tenants.agent_settings`, the jsonb agent/pipeline/persona.ts reads
// (persona, tone, privacyNotice, bookingServiceId, handoffTriggers). The screen used to write it straight from the browser under row-level security;
// this is the checked way (docs/dashboard-screen-contracts.md, "Agent settings": PATCH /api/agent/settings, Dev 1).
//
//   GET    any member: the settings as the agent reads them (an unknown tone is "friendly", a name is cleaned), with the five handover rows.
//   PATCH  owner or admin: a partial update, Zod-checked. It MERGES into the stored JSON: the keys it was not given, and keys it does not know
//          (the column holds others), are kept. A persona or a booking service can be cleared with null. The booking service must be an active
//          service of the business. The triggers merge by key and an alias entry (`gap`, `human`, ...) of a trigger that was sent is replaced, so
//          the stored list can never hold two answers the agent would pick between.
//
// Written with the service role (the member's role is checked here, and the business comes from the verified session, never from the request), so the
// 0049 trigger that audits browser writes skips it: this writes its own audit row (agent_settings.updated: the keys that changed, and the old and new
// values of the ones that are not text; never the persona). The write is a compare-and-set on the JSON that was read, retried three times, so two
// writers at once cannot silently overwrite each other (checked against a real local PostgREST on 15 Oct: a stale value updates nothing, whatever the
// key order). A browser write that reads then writes the whole object (the booking-service section does) is not covered by that: see the task note.

const TAG = "[agent-settings]";
const TRIES = 3;

export interface HandoffTriggerInfo {
  key: "kb_gap" | "asked_human" | "complaint" | "negotiation" | "hot_lead";
  /** Other names the agent also reads for the same trigger (persona.ts); never written by this route. */
  aliases: readonly string[];
  label: string;
  example: string;
  /** The handover is opened as high priority (plan.ts), or for hot_lead the alert is. */
  highPriority: boolean;
}

/**
 * The five triggers a business can switch off, in the order the screen shows them, with the words for the screen. The agent reads exactly these
 * (persona.ts `TRIGGER_KEYS`; a test keeps the aliases in step). `stuck`, `credits_exhausted` and `opt_out` are handovers the business cannot switch off.
 */
export const HANDOFF_TRIGGERS: readonly HandoffTriggerInfo[] = [
  { key: "kb_gap", aliases: ["gap"], label: "Doesn't know the answer twice in a row", example: "Asks something that is not in your knowledge base, twice in the same chat", highPriority: false },
  { key: "asked_human", aliases: ["human"], label: "Asks for a person", example: "“Can I talk to someone?”", highPriority: true },
  { key: "complaint", aliases: [], label: "Complaint or an angry customer", example: "“This is the third time nobody called me back!”", highPriority: true },
  { key: "negotiation", aliases: ["price_negotiation"], label: "Asks for a discount", example: "“Can you do it for 70?” (the assistant never agrees to a price)", highPriority: true },
  { key: "hot_lead", aliases: ["hot"], label: "A lead turns hot", example: "Budget, timing and area all match: staff get one alert", highPriority: false },
];

export interface AgentSettingsView {
  /** The assistant's name, or null for the default. */
  persona: string | null;
  tone: "friendly" | "formal";
  /** The first AI reply to a contact carries the privacy notice. */
  privacyNotice: boolean;
  /** The service the assistant books when the business has several, or null. */
  bookingServiceId: string | null;
  handoffTriggers: { key: HandoffTriggerInfo["key"]; label: string; example: string; highPriority: boolean; enabled: boolean }[];
}

export interface AgentSettingsDeps {
  db: SupabaseClient;
  /** Writes one audit_logs row; a failure is logged, never thrown (the change is already made). */
  audit: (entry: AuditEntry) => Promise<void>;
}

const defaults = (): AgentSettingsDeps => ({ db: supabaseAdmin(), audit: writeAudit });

const TriggerKey = z.enum(HANDOFF_TRIGGERS.map((t) => t.key) as [HandoffTriggerInfo["key"], ...HandoffTriggerInfo["key"][]]);

const Persona = z
  .union([z.string(), z.null()])
  .transform((value, ctx) => {
    const tidy = (value ?? "").replace(/\s+/g, " ").trim();
    if (tidy === "") return null; // clears it
    if ([...tidy].length > 30) {
      ctx.addIssue({ code: "custom", message: "Use 30 characters or fewer: a name, not a sentence." });
      return z.NEVER;
    }
    if (nameForPrompt(tidy, 30) !== tidy) {
      ctx.addIssue({ code: "custom", message: "Use a name only: letters, numbers, spaces and . ' & -" });
      return z.NEVER;
    }
    return tidy;
  });

const UpdateInput = z
  .strictObject({
    persona: Persona,
    tone: z.enum(["friendly", "formal"]),
    privacyNotice: z.boolean(),
    bookingServiceId: z.guid().nullable(),
    handoffTriggers: z
      .array(z.strictObject({ key: TriggerKey, enabled: z.boolean() }))
      .min(1)
      .refine((list) => new Set(list.map((t) => t.key)).size === list.length, "Send each trigger once."),
  })
  .partial()
  .refine((input) => Object.keys(input).length > 0, { message: "Send at least one setting to change." });

/** One message per field, as zodFieldErrors gives; a key that is not a setting is named as its own field, so the screen can say which one. */
function fieldErrors(error: z.ZodError): Record<string, string> {
  const fields = zodFieldErrors(error);
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      delete fields.form;
      for (const key of issue.keys) fields[key] = "That is not a setting you can change here.";
    }
  }
  return fields;
}

type Stored = Record<string, unknown>;
const isObject = (value: unknown): value is Stored => typeof value === "object" && value !== null && !Array.isArray(value);

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

function view(raw: unknown): AgentSettingsView {
  const settings = parseReplySettings(raw);
  const enabled: Record<HandoffTriggerInfo["key"], boolean> = {
    kb_gap: settings.kbGapHandoffEnabled,
    asked_human: settings.askedHumanHandoffEnabled,
    complaint: settings.complaintHandoffEnabled,
    negotiation: settings.negotiationHandoffEnabled,
    hot_lead: settings.hotLeadAlertEnabled,
  };
  return {
    persona: settings.persona,
    tone: settings.tone,
    privacyNotice: settings.privacyNotice,
    bookingServiceId: settings.bookingServiceId,
    handoffTriggers: HANDOFF_TRIGGERS.map((t) => ({ key: t.key, label: t.label, example: t.example, highPriority: t.highPriority, enabled: enabled[t.key] })),
  };
}

/** The business's agent_settings as stored (any shape), or not_found. A database failure is an error whose message holds the code only. */
async function readStored(db: SupabaseClient, tenantId: string): Promise<unknown> {
  const { data, error } = await db.from("tenants").select("agent_settings").eq("id", tenantId).limit(1);
  if (error) throw new Error(`${TAG} could not read the settings (database error ${error.code ?? "none"})`);
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) throw new AppError("not_found", "That business was not found.");
  return (row as { agent_settings?: unknown }).agent_settings;
}

/** GET /api/agent/settings. Any member. */
export async function getAgentSettings(context: TenantContext, deps: AgentSettingsDeps = defaults()): Promise<AgentSettingsView> {
  return view(await readStored(deps.db, context.tenant.id));
}

function merge(current: Stored, input: z.infer<typeof UpdateInput>): Stored {
  const next: Stored = { ...current };
  if (input.persona !== undefined) {
    if (input.persona === null) delete next.persona;
    else next.persona = input.persona;
  }
  if (input.tone !== undefined) next.tone = input.tone;
  if (input.privacyNotice !== undefined) next.privacyNotice = input.privacyNotice;
  if (input.bookingServiceId !== undefined) {
    if (input.bookingServiceId === null) delete next.bookingServiceId;
    else next.bookingServiceId = input.bookingServiceId;
  }
  if (input.handoffTriggers !== undefined) {
    // Each trigger that was sent takes the place of its first stored entry (under its canonical key); any other entry for it (an alias, a repeat) is dropped, so
    // the list never holds two answers for one trigger. An entry that already says the same stays exactly as it was. Triggers not sent, and entries that are
    // not triggers at all, keep their place. A trigger not stored yet goes at the end.
    const namesOf = (key: string) => {
      const info = HANDOFF_TRIGGERS.find((t) => t.key === key);
      return info ? [info.key, ...info.aliases] : [key];
    };
    const pending = new Map(input.handoffTriggers.map((t) => [t.key as string, t.enabled]));
    const owner = (name: unknown): string | undefined => [...pending.keys()].find((key) => typeof name === "string" && namesOf(key).includes(name));
    const placed = new Set<string>();
    const merged: unknown[] = [];
    for (const entry of Array.isArray(current.handoffTriggers) ? current.handoffTriggers : []) {
      const key = isObject(entry) ? owner(entry.key) : undefined;
      if (key === undefined) merged.push(entry);
      else if (!placed.has(key)) {
        placed.add(key);
        merged.push(isObject(entry) && entry.key === key && entry.enabled === pending.get(key) ? entry : { key, enabled: pending.get(key) });
      }
    }
    for (const [key, enabled] of pending) if (!placed.has(key)) merged.push({ key, enabled });
    next.handoffTriggers = merged;
  }
  return next;
}

/** What goes in the audit row: the keys that changed, and from and to for everything that is not text. Never the persona. */
function auditDiff(before: Stored, after: Stored): Record<string, unknown> {
  const KEYS = ["bookingServiceId", "handoffTriggers", "persona", "privacyNotice", "tone"] as const;
  const changed = KEYS.filter((k) => canonical(before[k]) !== canonical(after[k]));
  const was = parseReplySettings(before);
  const now = parseReplySettings(after);
  const diff: Record<string, unknown> = { changed };
  if (changed.includes("tone")) diff.tone = { from: was.tone, to: now.tone };
  if (changed.includes("privacyNotice")) diff.privacyNotice = { from: was.privacyNotice, to: now.privacyNotice };
  if (changed.includes("bookingServiceId")) diff.bookingServiceId = { from: was.bookingServiceId, to: now.bookingServiceId };
  if (changed.includes("handoffTriggers")) {
    const flags = (s: ReplySettings): Record<string, boolean> => ({ kb_gap: s.kbGapHandoffEnabled, asked_human: s.askedHumanHandoffEnabled, complaint: s.complaintHandoffEnabled, negotiation: s.negotiationHandoffEnabled, hot_lead: s.hotLeadAlertEnabled });
    const [a, b] = [flags(was), flags(now)];
    diff.handoffTriggers = Object.fromEntries(Object.keys(a).filter((k) => a[k] !== b[k]).map((k) => [k, { from: a[k], to: b[k] }]));
  }
  return diff;
}

/** PATCH /api/agent/settings. Owner or admin. Answers the settings as they now stand. */
export async function updateAgentSettings(context: TenantContext, body: unknown, deps: AgentSettingsDeps = defaults()): Promise<AgentSettingsView> {
  requireRole(context, ["owner", "admin"], "change the assistant's settings");
  const parsed = UpdateInput.safeParse(body);
  if (!parsed.success) throw new AppError("validation_failed", "Check the fields and try again.", fieldErrors(parsed.error));
  const input = parsed.data;
  const tenantId = context.tenant.id;
  const { db } = deps;

  if (typeof input.bookingServiceId === "string") {
    const { data, error } = await db.from("services").select("id").eq("tenant_id", tenantId).eq("id", input.bookingServiceId).eq("active", true).limit(1);
    if (error) throw new Error(`${TAG} could not check the service (database error ${error.code ?? "none"})`);
    if (!Array.isArray(data) || data.length === 0) throw new AppError("validation_failed", "Check the fields and try again.", { bookingServiceId: "That isn't an active service of your business." });
  }

  for (let attempt = 1; attempt <= TRIES; attempt++) {
    const raw = await readStored(db, tenantId);
    const current: Stored | null = raw === null || raw === undefined ? {} : isObject(raw) ? raw : null;
    if (current === null) throw new AppError("conflict", "Your assistant's settings are stored in an unexpected format, so nothing was changed. Contact support.");
    const next = merge(current, input);
    if (canonical(next) === canonical(current)) return view(current);

    // Compare-and-set: the row is updated only if it still holds exactly what was read.
    const { data, error } = await db.from("tenants").update({ agent_settings: next }).eq("id", tenantId).eq("agent_settings", JSON.stringify(raw ?? null)).select("id");
    if (error) throw new Error(`${TAG} could not save the settings (database error ${error.code ?? "none"})`);
    if (!Array.isArray(data) || data.length === 0) continue; // changed by someone else meanwhile: read again and apply this change on top

    await auditQuietly({ tenantId, actor: context.user.id, action: "agent_settings.updated", entity: "tenant", entityId: tenantId, diff: auditDiff(current, next) }, deps.audit);
    return view(next);
  }
  throw new AppError("conflict", "Someone else just changed these settings. Reload and try again.");
}
