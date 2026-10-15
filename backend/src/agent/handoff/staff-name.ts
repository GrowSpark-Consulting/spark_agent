import { supabaseAdmin } from "../../lib/supabase-admin";
import { cleanDisplayText } from "../scoring/area-text";

// The name a customer reads for the staff member who takes their chat to their own WhatsApp number (takeover.ts, external-notice.ts): the first name from the account's own
// profile, or none. Never the start of an email address, which would show a customer something like "nithishareddy113 from Acme". With none, the wording names the business
// instead (texts.ts).

/** The first word of the profile's `full_name`, else of its `name`; null when neither is usable (empty, a link, an "@", a phone number). */
export function staffFirstName(meta: unknown): string | null {
  if (typeof meta !== "object" || meta === null) return null;
  const profile = meta as Record<string, unknown>;
  for (const field of [profile.full_name, profile.name]) {
    if (typeof field !== "string") continue;
    const first = cleanDisplayText(field, 40, 7)?.split(" ")[0];
    if (first) return first;
  }
  return null;
}

export async function lookupStaffName(userId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin().auth.admin.getUserById(userId);
  if (error || !data.user) return null;
  return staffFirstName(data.user.user_metadata);
}
