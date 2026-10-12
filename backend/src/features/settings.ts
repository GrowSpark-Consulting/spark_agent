import { z } from "zod";
import type { FeatureKey } from "../billing/credit-costs";
import { DelaySettings as FeedbackSettings, ReviewSettings } from "../booking/post-visit";
import { OffsetSettings as ReminderSettings } from "../booking/reminders";
import { SlaSettings } from "../inngest/handoff-sla";
import { TimingSettings as NudgeSettings } from "../leads/nudges";
import { DelaySettings as OutcomeSettings } from "../leads/own-number-outcome";
import { AppError } from "../lib/errors";

// What a business may save in tenant_features.settings, per feature (docs/contracts.md, section 3). The schema is the
// one the feature's job reads, imported from the job, so the two cannot drift. A job uses its defaults when the
// settings do not parse, so the API refuses anything the job would quietly ignore.

interface SettingsRule {
  keys: readonly string[];
  schema: z.ZodType;
  /** Said when the settings do not parse. */
  hint: string;
}

const MINUTES_IN_A_WEEK = 7 * 24 * 60;

export const FEATURE_SETTINGS: Partial<Record<FeatureKey, SettingsRule>> = {
  reminder_24h: { keys: ["offset_minutes"], schema: ReminderSettings, hint: `offset_minutes is the minutes before the booking, a whole number from 1 to ${MINUTES_IN_A_WEEK}.` },
  reminder_2h: { keys: ["offset_minutes"], schema: ReminderSettings, hint: `offset_minutes is the minutes before the booking, a whole number from 1 to ${MINUTES_IN_A_WEEK}.` },
  feedback_request: { keys: ["offset_minutes"], schema: FeedbackSettings, hint: `offset_minutes is the minutes after the visit, a whole number from 0 to ${MINUTES_IN_A_WEEK}.` },
  review_request: {
    keys: ["review_url"],
    schema: ReviewSettings.refine((s) => s.review_url.length <= 500),
    hint: "review_url is your review page's link, starting with https://, at most 500 characters.",
  },
  followup_nudges: {
    keys: ["offset_minutes", "nurture_after_minutes"],
    schema: NudgeSettings,
    hint: `offset_minutes is two numbers of minutes after the customer's message, the second larger, and nurture_after_minutes is later than both; each from 1 to ${MINUTES_IN_A_WEEK}, sent together.`,
  },
  handoff_triggers: { keys: ["sla_minutes"], schema: SlaSettings, hint: "sla_minutes is how long a chat may wait for a person, a whole number from 1 to 1440." },
  handoff_own_number: {
    keys: ["outcome_after_minutes"],
    schema: OutcomeSettings,
    hint: `outcome_after_minutes is the minutes before staff are asked how the chat went, a whole number from 1 to ${MINUTES_IN_A_WEEK}.`,
  },
};

const invalid = (message: string) => new AppError("validation_failed", message, { settings: message });

/**
 * The settings after a change: the saved ones with the sent ones merged in key by key (a key sent as null is
 * removed), checked against what the feature's job reads. Empty settings are always fine: the job uses its defaults.
 */
export function mergeSettings(key: string, saved: Record<string, unknown>, sent: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...saved };
  for (const [name, value] of Object.entries(sent)) {
    if (value === null) delete merged[name];
    else merged[name] = value;
  }
  if (Object.keys(merged).length === 0) return merged;

  const rule = Object.hasOwn(FEATURE_SETTINGS, key) ? FEATURE_SETTINGS[key as FeatureKey] : undefined;
  if (!rule) throw invalid("This feature has no settings.");
  const unknown = Object.keys(merged).filter((name) => !rule.keys.includes(name));
  if (unknown.length > 0) throw invalid(`${unknown.join(", ")} ${unknown.length === 1 ? "is not a setting" : "are not settings"} of this feature. ${rule.hint}`);
  if (!rule.schema.safeParse(merged).success) throw invalid(rule.hint);
  return merged;
}
