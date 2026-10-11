import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { supabaseAdmin } from "../../../lib/supabase-admin";
import { send, type NotifyPayload, type SendOutcome } from "../../../notify/send";
import type { Check } from "./checks";

// The sixth check: "a test message is delivered to the owner's number" (Day 5; Raja's answer to question: through notify.send). It goes out as a
// `test_message` (0 credits, free text), so it follows every rule of a message: the business's connection must be active, and WhatsApp only allows free text
// to a number that wrote to the business in the last 24 hours. A number that did not is not a failure: the check says what to do and waits for a recheck.
// It never changes whether the connection is active; the first five checks decide that.
//
// "Delivered" here means WhatsApp accepted it (a delivery receipt arrives later as a status webhook).

export const TEST_TEXT = "Spark Agent: your WhatsApp number is connected. This is a test message.";

const SAFE = {
  sent: "A test message was sent to the owner's number.",
  noPhone: "Add your WhatsApp number under Team settings so we can send a test message to it, then check again.",
  outsideWindow: "WhatsApp only lets us message a number that wrote to this number in the last 24 hours. Send a message to this number from the owner's phone, then check again.",
  notSent: "The test message was not sent. Check again in a moment.",
  failed: "The test message could not be sent. Check again in a moment.",
} as const;

export interface TestMessageDeps {
  db: SupabaseClient;
  send: (tenantId: string, kind: "test_message", payload: NotifyPayload) => Promise<SendOutcome>;
  now: () => Date;
}

const defaults = (): TestMessageDeps => ({ db: supabaseAdmin(), send: (tenantId, kind, payload) => send(tenantId, kind, payload), now: () => new Date() });

const Phone = z.array(z.object({ whatsapp_phone: z.string().nullable() }));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The owner's alert number, or else the number of the person doing the connecting. Read for this business only. */
async function ownerNumber(db: SupabaseClient, tenantId: string, actor: string | null): Promise<string | null> {
  const owner = await db.from("memberships").select("whatsapp_phone").eq("tenant_id", tenantId).eq("role", "owner").not("whatsapp_phone", "is", null).limit(1);
  if (owner.error) return null;
  const [first] = Phone.parse(owner.data ?? []);
  if (first?.whatsapp_phone) return first.whatsapp_phone;
  if (actor === null) return null;
  const own = await db.from("memberships").select("whatsapp_phone").eq("tenant_id", tenantId).eq("user_id", actor).limit(1);
  if (own.error) return null;
  return Phone.parse(own.data ?? [])[0]?.whatsapp_phone ?? null;
}

/** `actor` is a user id, or `admin:<id>` for the platform team (then only the owner's number is tried). */
export async function checkTestMessage(tenantId: string, actor: string | null, deps: TestMessageDeps = defaults()): Promise<Check> {
  const checked_at = deps.now().toISOString();
  const answer = (status: Check["status"], message: string): Check => ({ key: "test_message_delivered", status, message, checked_at });
  const userId = actor !== null && UUID.test(actor) ? actor : null;

  const to = await ownerNumber(deps.db, tenantId, userId);
  if (to === null) return answer("skipped", SAFE.noPhone);

  let outcome: SendOutcome;
  try {
    outcome = await deps.send(tenantId, "test_message", { to, text: TEST_TEXT, ...(userId ? { actorId: userId } : {}) });
  } catch {
    return answer("warn", SAFE.failed);
  }
  if (outcome.status === "sent") return answer("pass", SAFE.sent);
  if (outcome.status === "skipped") return answer("not_verified", outcome.reason === "outside_window" ? SAFE.outsideWindow : SAFE.notSent);
  return answer("warn", SAFE.failed);
}
