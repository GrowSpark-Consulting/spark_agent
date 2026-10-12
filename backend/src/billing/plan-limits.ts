import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { AppError } from "../lib/errors";
import { supabaseAdmin } from "../lib/supabase-admin";

// Plan limits (9-day plan, Day 5; migration 0027): a business's team seats and WhatsApp numbers (plans.seats and
// plans.whatsapp_numbers: Starter and Growth 1 number, Pro 3). The API asks these first, so a member gets a plain answer
// before an invite goes out or anything is sent to Meta. The database triggers have the last word, also for two
// requests at the same moment. A business over its limit after a downgrade keeps what it has; only additions are
// refused.

/** plans.seats at or above this means unlimited (the seed's Pro has 999). */
export const UNLIMITED_SEATS = 999;

const PlanRow = z.object({ plans: z.object({ name: z.string(), seats: z.number().int(), whatsapp_numbers: z.number().int() }) });

async function planOf(tenantId: string, db: SupabaseClient) {
  const { data, error } = await db.from("tenants").select("plans(name, seats, whatsapp_numbers)").eq("id", tenantId).maybeSingle();
  if (error) throw new Error(`plan limits: plan read failed: ${error.message}`);
  if (!data) throw new AppError("not_found", "We couldn't find that business.");
  return PlanRow.parse(data).plans;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Team seats in use and the plan's limit, for the Team screen and the invite route. */
export async function seatUsage(tenantId: string, db: SupabaseClient = supabaseAdmin()): Promise<{ used: number; limit: number | "unlimited"; planName: string }> {
  const [plan, members] = await Promise.all([planOf(tenantId, db), db.from("memberships").select("user_id", { count: "exact", head: true }).eq("tenant_id", tenantId)]);
  if (members.error) throw new Error(`plan limits: members count failed: ${members.error.message}`);
  return { used: members.count ?? 0, limit: plan.seats >= UNLIMITED_SEATS ? "unlimited" : plan.seats, planName: plan.name };
}

/** Throws seat_limit when the business has no free seat. For the invite route (Dev 3), before an invite goes out. */
export async function assertSeatAvailable(tenantId: string, db: SupabaseClient = supabaseAdmin()): Promise<void> {
  const usage = await seatUsage(tenantId, db);
  if (usage.limit !== "unlimited" && usage.used >= usage.limit) {
    throw new AppError("seat_limit", `Your ${usage.planName} plan includes ${plural(usage.limit, "team member")}. Upgrade to add more.`);
  }
}

/**
 * WhatsApp numbers in use (every connection that is not disconnected, a failed one included; our own platform numbers
 * never count) and the plan's limit. `keepConnectionId` is a row being connected again in place, which is not counted
 * against itself.
 */
export async function numberUsage(
  tenantId: string,
  keepConnectionId: string | null,
  db: SupabaseClient = supabaseAdmin(),
): Promise<{ used: number; limit: number; planName: string }> {
  let query = db
    .from("whatsapp_connections")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .neq("method", "platform")
    .neq("status", "disconnected");
  if (keepConnectionId) query = query.neq("id", keepConnectionId);
  const [plan, numbers] = await Promise.all([planOf(tenantId, db), query]);
  if (numbers.error) throw new Error(`plan limits: numbers count failed: ${numbers.error.message}`);
  return { used: numbers.count ?? 0, limit: plan.whatsapp_numbers, planName: plan.name };
}

/** Throws plan_required when another number would go past the plan's numbers. For the connect routes, before Meta is asked. */
export async function assertNumberAvailable(tenantId: string, keepConnectionId: string | null, db: SupabaseClient = supabaseAdmin()): Promise<void> {
  const usage = await numberUsage(tenantId, keepConnectionId, db);
  if (usage.used >= usage.limit) {
    throw new AppError(
      "plan_required",
      `Your ${usage.planName} plan includes ${plural(usage.limit, "WhatsApp number")}. Disconnect one, or upgrade to add another.`,
    );
  }
}

/** The API's answer for the database's refusal (0027), or null for any other error. */
export function planLimitError(error: { code?: string; message: string }): AppError | null {
  if (error.code === "PA413") return new AppError("seat_limit", "Every team seat on your plan is taken. Upgrade to add more.");
  if (error.code === "PA403" && error.message.includes("whatsapp_number_limit")) {
    return new AppError("plan_required", "Every WhatsApp number on your plan is in use. Disconnect one, or upgrade to add another.");
  }
  return null;
}
