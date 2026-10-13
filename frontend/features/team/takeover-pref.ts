import type { FeatureList, FeatureRow, PaidPlanKey } from "@pakka/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { SetupError } from "@/features/settings/resources-data";

// How a member takes over a chat from a staff alert: `memberships.takeover_pref` ('inbox' | 'own_number' | 'ask'; 0001), which each member
// updates on their own row under RLS (0002, docs/contracts.md "Member writes from the browser"). Taking over from the member's own WhatsApp
// number is an entitlement: the `handoff_own_number` row of GET /api/features says whether this business has it. Nothing here knows which
// plan includes it; the row's `state` and `requiredPlan` are the answer, and the server checks again when the link is tapped
// (backend/src/agent/handoff/takeover.ts). Returning an own-number chat to the AI is not offered: that is a decision for Raja.

export const OWN_NUMBER_FEATURE = "handoff_own_number";

export const TAKEOVER_PREFS = ["inbox", "own_number", "ask"] as const;
export type TakeoverPref = (typeof TAKEOVER_PREFS)[number];

const OwnRow = z.object({ tenant_id: z.guid(), user_id: z.guid(), takeover_pref: z.enum(TAKEOVER_PREFS).nullable() });
const COLUMNS = "tenant_id, user_id, takeover_pref";

function readPref(data: unknown, tenantId: string, userId: string): TakeoverPref | null | undefined {
  const parsed = z.array(OwnRow).safeParse(data ?? []);
  if (!parsed.success) throw new SetupError("invalid_response", "Your takeover choice had an unexpected shape.");
  const row = parsed.data.find((r) => r.tenant_id === tenantId && r.user_id === userId);
  return row === undefined ? undefined : row.takeover_pref;
}

/** The member's choice, or null when they have not made one. */
export async function fetchTakeoverPref(client: SupabaseClient, tenantId: string, userId: string): Promise<TakeoverPref | null> {
  const { data, error } = await client.from("memberships").select(COLUMNS).eq("tenant_id", tenantId).eq("user_id", userId).limit(1);
  if (error) throw error;
  const pref = readPref(data, tenantId, userId);
  if (pref === undefined) throw new SetupError("not_found", "Your membership of this business couldn't be found. Refresh and try again.");
  return pref;
}

/** Saves the choice on the member's own row and returns what is stored. No row back means nothing was saved. */
export async function saveTakeoverPref(client: SupabaseClient, tenantId: string, userId: string, pref: TakeoverPref): Promise<TakeoverPref> {
  if (!TAKEOVER_PREFS.includes(pref)) throw new SetupError("invalid_response", "That isn't a way to take over a chat.");
  const { data, error } = await client.from("memberships").update({ takeover_pref: pref }).eq("tenant_id", tenantId).eq("user_id", userId).select(COLUMNS);
  if (error) throw error;
  const saved = readPref(data, tenantId, userId);
  if (saved === undefined) throw new SetupError("not_found", "Your choice wasn't saved. Refresh and try again.");
  if (saved !== pref) throw new SetupError("invalid_response", "The choice that came back after saving wasn't the one sent. Refresh and check it.");
  return saved;
}

// The entitlement ---------------------------------------------------------------------------------------------------

export type OwnNumberAccess =
  /** The plan includes it and the business has it on. */
  | { kind: "available" }
  /** The plan does not include it. `requiredPlan` is the cheapest plan that does, when the server names one. */
  | { kind: "locked"; requiredPlan: PaidPlanKey | null }
  /** The plan includes it but the business has switched it off (an owner or admin can switch it on under Features). */
  | { kind: "off" }
  /** In the plan but it cannot work right now; `reason` is the server's plain words. */
  | { kind: "disabled"; reason: string | null }
  /** The features answer has no such row: shown as unavailable, never guessed. */
  | { kind: "unknown" };

/** The `handoff_own_number` row from the features list, wherever the server grouped it. */
export function ownNumberRow(list: FeatureList): FeatureRow | null {
  for (const group of list.groups) {
    const row = group.features.find((f) => f.key === OWN_NUMBER_FEATURE);
    if (row) return row;
  }
  return null;
}

/** What the server says about the own-number feature, as it says it. No plan name is looked at. */
export function ownNumberAccess(list: FeatureList): OwnNumberAccess {
  const row = ownNumberRow(list);
  if (!row) return { kind: "unknown" };
  switch (row.state) {
    case "locked":
      return { kind: "locked", requiredPlan: row.requiredPlan };
    case "on":
      return { kind: "available" };
    case "off":
      return { kind: "off" };
    case "disabled":
      return { kind: "disabled", reason: row.disabledReason };
  }
}

export interface PrefOption {
  value: TakeoverPref;
  label: string;
  description: string;
  /** Why this choice cannot be picked, or null when it can. */
  unavailable: string | null;
}

/**
 * The three choices with what the entitlement allows. Inbox always works. Own number and Ask both mean using the member's own WhatsApp number,
 * so both need the feature; own number also needs the member's alert number, which the link needs to open WhatsApp.
 */
export function takeoverOptions(access: OwnNumberAccess, hasAlertNumber: boolean): PrefOption[] {
  const blocked = (() => {
    switch (access.kind) {
      case "available":
        return null;
      case "locked":
        return access.requiredPlan ? "Not available on your current plan." : "Not included in your plan.";
      case "off":
        return "Switched off for your business. An owner or admin can switch it on under Features.";
      case "disabled":
        return access.reason ?? "Can't be used right now.";
      case "unknown":
        return "Couldn't tell whether your plan includes this.";
    }
  })();
  return [
    { value: "inbox", label: "In the inbox", description: "Alert buttons open the chat in this dashboard.", unavailable: null },
    {
      value: "own_number",
      label: "From my own WhatsApp number",
      description: "Alert buttons open WhatsApp on your own number. The AI stops replying on that chat.",
      unavailable: blocked ?? (hasAlertNumber ? null : "Add your WhatsApp number above first."),
    },
    { value: "ask", label: "Ask me each time", description: "Alerts offer both buttons and you choose.", unavailable: blocked },
  ];
}
