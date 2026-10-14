import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { supabaseAdmin } from "../lib/supabase-admin";

// One free trial per WhatsApp number (migration 0033). Server-only. The routing step on the shared demo number (Dev 1)
// calls this for a message that carries a TRIAL code, with the sender WhatsApp names (wa_id): the only verified phone a
// trial owner gives us. The phone typed during onboarding is not verified, so it is never claimed.

export const TrialPhoneClaim = z.enum(["claimed", "other_sender", "taken"]);
export type TrialPhoneClaim = z.infer<typeof TrialPhoneClaim>;

/**
 * "claimed": the sender is this trial's phone (recorded now or before); route as usual. "other_sender": the trial
 * already has another phone, so this is someone else trying it; route as usual. "taken": the sender already started
 * another trial and this trial has no phone yet; don't route it, and tell the sender a trial was already used.
 * `phone` is the full international number (wa_id or E.164); it throws for anything else or an unknown business.
 */
export async function claimTrialPhone(tenantId: string, phone: string, db: SupabaseClient = supabaseAdmin()): Promise<TrialPhoneClaim> {
  const { data, error } = await db.rpc("claim_trial_phone", { p_tenant_id: tenantId, p_phone: phone });
  if (error) throw new Error(`claim_trial_phone failed: ${error.message}`);
  return TrialPhoneClaim.parse(data);
}

/** The key trial_phones keeps for a number: a SHA-256 of its digits, as claim_trial_phone computes it (0033). */
export function trialPhoneHash(phone: string): string {
  return createHash("sha256").update(phone.replace(/[^0-9]/g, ""), "utf8").digest("hex");
}

/**
 * Whether a number has already had a free trial, for the onboarding wizard's early warning (POST /api/onboarding/trial).
 * Reads only: the claim itself happens on the WhatsApp TRIAL-code message, the one verified number.
 */
export async function trialPhoneUsed(phone: string, db: SupabaseClient = supabaseAdmin()): Promise<boolean> {
  const { data, error } = await db.from("trial_phones").select("phone_hash").eq("phone_hash", trialPhoneHash(phone)).limit(1);
  if (error) throw new Error(`trial phone check failed: ${error.message}`);
  return (data ?? []).length > 0;
}
