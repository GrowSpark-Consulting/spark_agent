import type { FeatureList, FeatureRow, Role } from "@pakka/types";
import { changeFor, isPlanRequired, planName, rowControl, withRow, featureService, type FeatureService } from "@/features/toggles/feature-api";
import { formatError } from "@/lib/errors";

// The onboarding Team step's "What your assistant does" switches, saved for real. Each of the wizard's six rows is one or two of the
// business's feature rows (supabase/seed/features.sql). They are read from GET /api/features and written with PATCH /api/features/:key
// (owner or admin; the plan check, the audit row and the cache are the server's), the same calls as the Features screen. So a switch shows
// what the server holds: it moves only after the server answers, a refresh or a return to the wizard reads it again, and a switch the plan
// does not include is shown as that, never as on. Nothing here is kept in React memory as the truth.

export interface WizardFeatureSpec {
  /** The wizard's label (features/onboarding/data FEATURES, same order). */
  label: string;
  /** The feature rows it controls. */
  keys: readonly string[];
}

export const WIZARD_FEATURES: readonly WizardFeatureSpec[] = [
  { label: "AI auto-reply", keys: ["ai_auto_reply"] },
  { label: "Lead qualification", keys: ["lead_qualification"] },
  { label: "Booking in chat", keys: ["booking"] },
  { label: "Reminders", keys: ["reminder_24h", "reminder_2h"] },
  { label: "Staff WhatsApp alerts", keys: ["staff_alerts"] },
  { label: "Feedback request", keys: ["feedback_request"] },
];

/** What one wizard row shows, from the server's rows. */
export type WizardFeatureView =
  | { kind: "missing" }
  /** The switch works. `checked` is the server's. */
  | { kind: "interactive"; checked: boolean }
  /** Shown, not usable, with the reason in words. */
  | { kind: "fixed"; checked: boolean; why: string };

export function rowsFor(list: FeatureList, spec: WizardFeatureSpec): FeatureRow[] {
  const all = list.groups.flatMap((g) => g.features);
  return spec.keys.map((key) => all.find((f) => f.key === key)).filter((f): f is FeatureRow => f !== undefined);
}

/**
 * A wizard row is on only when every row behind it is on. It is fixed when any of its rows is (the plan lacks it, it cannot work
 * now, or the member is not an owner or admin): the first reason is shown.
 */
export function viewOf(list: FeatureList, spec: WizardFeatureSpec, role: Role): WizardFeatureView {
  const rows = rowsFor(list, spec);
  if (rows.length === 0) return { kind: "missing" };
  const controls = rows.map((row) => rowControl(row, role));
  const fixed = controls.find((c) => c.kind === "fixed");
  const checked = rows.every((row, i) => controls[i].checked && row.enabled);
  return fixed && fixed.kind === "fixed" ? { kind: "fixed", checked: checked && fixed.checked, why: fixed.why } : { kind: "interactive", checked };
}

export interface SetResult {
  list: FeatureList;
  /** The rows the server changed. */
  changed: number;
}

/**
 * Sets one wizard row. Only rows that actually differ are sent, one at a time; each answer replaces its row in the list, so the result
 * is the server's state even when a later row fails (the error carries on, the list in `partial` shows what did change).
 */
export async function setWizardFeature(
  tenantId: string,
  list: FeatureList,
  spec: WizardFeatureSpec,
  role: Role,
  wantOn: boolean,
  service: FeatureService = featureService,
): Promise<SetResult> {
  let next = list;
  let changed = 0;
  for (const row of rowsFor(list, spec)) {
    const change = changeFor(row, role, wantOn);
    if (!change) continue;
    const updated = await service.update(tenantId, row.key, change).catch((err: unknown) => {
      throw new PartialFeatureError(err, next, changed);
    });
    next = withRow(next, updated);
    changed += 1;
  }
  return { list: next, changed };
}

/** A save that failed part-way: `list` is what the server holds now, `changed` how many of its rows had already been saved. */
export class PartialFeatureError extends Error {
  constructor(
    readonly cause: unknown,
    readonly list: FeatureList,
    readonly changed: number,
  ) {
    super("A feature could not be saved.");
    this.name = "PartialFeatureError";
  }
}

/** Words for a failed save of a wizard row. A row the plan lacks says which plan has it. */
export function describeSaveError(err: unknown, spec: WizardFeatureSpec, list: FeatureList): string {
  const cause = err instanceof PartialFeatureError ? err.cause : err;
  if (isPlanRequired(cause)) {
    const needed = rowsFor(list, spec).find((r) => r.requiredPlan)?.requiredPlan;
    return needed ? `${spec.label} needs the ${planName(needed)} plan. Nothing was changed.` : `${spec.label} isn't in your plan. Nothing was changed.`;
  }
  const shown = formatError(cause);
  const saved = err instanceof PartialFeatureError && err.changed > 0 ? `${spec.label} was only partly saved: reload to see what is on.` : `${spec.label} was not changed.`;
  return `${shown.message} ${saved}`;
}
