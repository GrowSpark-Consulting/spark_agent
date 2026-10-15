import { z } from "zod";
import { inngest } from "../inngest/client";
import { auditQuietly } from "../lib/audit";
import { supabaseAdmin } from "../lib/supabase-admin";

// Server-only. Call after verifying the signed-up user's session: userId comes from that session,
// never from the browser.

export type TrialSignup = {
  tenantId: string;
  routeCode: string;
  trialEndsAt: string;
  created: boolean; // false: this account's existing trial business was returned
};

// Intl accepts IANA names and their aliases (Asia/Kolkata and Asia/Calcutta) and throws for
// anything else ("India Standard Time", "IST"). Intl.supportedValuesOf would wrongly reject
// Asia/Kolkata, because ICU lists only the old canonical Asia/Calcutta.
function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$|^UTC$/.test(tz);
  } catch {
    return false;
  }
}

const Input = z.object({
  userId: z.guid(),
  name: z.string().trim().min(1).max(120),
  // Same rule as PackDefinition.key in @pakka/types.
  vertical: z.string().regex(/^[a-z][a-z0-9-]*$/, "must be a pack key: lowercase letters, digits and hyphens"),
  timezone: z
    .string()
    .refine(isTimeZone, "must be a time zone name such as Asia/Kolkata")
    .optional(),
});
const Row = z.object({
  tenant_id: z.guid(),
  route_code: z.string(),
  trial_ends_at: z.string(),
  created: z.boolean(),
});

/**
 * Creates the business, the owner membership, the trial credits and a TRIAL-xxxx route code in
 * one transaction (create_trial_tenant). A repeat call while the account's business is still in
 * trial returns that business instead of creating another.
 */
export async function createTrialTenant(input: z.input<typeof Input>): Promise<TrialSignup> {
  const { userId, name, vertical, timezone } = Input.parse(input);
  const { data, error } = await supabaseAdmin().rpc("create_trial_tenant", {
    p_user_id: userId,
    p_name: name,
    p_vertical: vertical,
    p_timezone: timezone ?? "Asia/Kolkata",
  });
  if (error) throw new Error(`create_trial_tenant failed: ${error.message}`);
  const [row] = z.array(Row).length(1).parse(data);
  const signup: TrialSignup = {
    tenantId: row.tenant_id,
    routeCode: row.route_code,
    trialEndsAt: row.trial_ends_at,
    created: row.created,
  };

  // A new business is a business-traceable action (Day 7 audit coverage): the owner who signed up made it. A repeat signup made nothing.
  if (signup.created) {
    await auditQuietly({ tenantId: signup.tenantId, actor: userId, action: "tenant.created", entity: "tenant", entityId: signup.tenantId, diff: { plan: "trial", vertical } });
  }

  // Starts the trial-lifecycle job. The fixed event id makes Inngest drop duplicates, so sending again
  // on a repeat signup is safe and recovers a lost first send. The business already exists and is
  // funded, so a send failure is logged instead of failing the signup.
  try {
    await inngest.send({
      id: `trial_started:${signup.tenantId}`,
      name: "tenant.trial_started",
      data: { tenantId: signup.tenantId },
    });
  } catch (e) {
    console.error(`tenant.trial_started not sent for tenant ${signup.tenantId}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return signup;
}
