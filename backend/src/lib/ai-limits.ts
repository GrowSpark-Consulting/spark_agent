import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { LlmError, type LlmClient } from "../agent/llm/anthropic";
import type { NoticeCounts, NoticeMessage } from "../notify/account-notices";

/** The service-role client, loaded at the first call: the model client imports this module, and stays light. */
const adminDb = async (): Promise<SupabaseClient> => (await import("./supabase-admin")).supabaseAdmin();

// Rate limits and the daily AI spend cap (migration 0044; Production Blueprint: "rate limits per tenant and per contact to
// stop spam and runaway costs; daily LLM spend cap per tenant"). The numbers are PLACEHOLDERS until Raja decides:
//   * one chat: at most 20 AI replies an hour (a customer flooding the assistant, or another bot talking to it)
//   * one business: at most 300 AI replies an hour
//   * one business: its daily model spend (tenants.ai_daily_cap_usd, else the plan's: monthly credits x USD 0.002, at
//     least USD 1), in India's day
// The pipeline's gate checks them before any model call (aiLimitFor): the customer's messages then wait in the inbox for
// staff, as for a chat a person has, and the owners and admins hear once (tellOwnersAboutLimit). The model client also
// refuses calls once the cap is reached (withSpendGuard), so the lead card and suggested replies, which cost no credits,
// stop too, and it records what every call cost (record_ai_spend).

export const CONTACT_AI_REPLIES_PER_HOUR = 20;
export const TENANT_AI_REPLIES_PER_HOUR = 300;

export const AI_LIMITS = ["ai_spend_cap", "tenant_rate_limit", "contact_rate_limit"] as const;
export type AiLimit = (typeof AI_LIMITS)[number];
export const isAiLimit = (reason: string): reason is AiLimit => (AI_LIMITS as readonly string[]).includes(reason);

const Limits = z.array(
  z.object({
    spend_today_usd: z.coerce.number(),
    cap_usd: z.coerce.number(),
    contact_replies_hour: z.number().int(),
    tenant_replies_hour: z.number().int(),
  }),
);

/** The limit this chat has reached, the strongest first (the business's spend, then its pace, then the chat's), or null. */
export async function aiLimitFor(tenantId: string, conversationId: string | null, db?: SupabaseClient): Promise<AiLimit | null> {
  const { data, error } = await (db ?? (await adminDb())).rpc("ai_limits", { p_tenant_id: tenantId, p_conversation_id: conversationId });
  if (error) throw new Error(`ai_limits failed: ${error.message}`);
  const [row] = Limits.parse(data ?? []);
  if (!row) return null;
  if (row.spend_today_usd >= row.cap_usd) return "ai_spend_cap";
  if (row.tenant_replies_hour >= TENANT_AI_REPLIES_PER_HOUR) return "tenant_rate_limit";
  if (row.contact_replies_hour >= CONTACT_AI_REPLIES_PER_HOUR) return "contact_rate_limit";
  return null;
}

// The model client ---------------------------------------------------------------------------------------------------------

export interface SpendGuard {
  /** Whether the business has reached today's cap. Never throws. */
  overCap: (tenantId: string) => Promise<boolean>;
  /** Adds one call's cost to today's spend. Never throws. */
  record: (tenantId: string, costUsd: number | null) => Promise<void>;
}

/** The model client, refusing calls (LlmError over_budget) for a business past today's cap, and recording what each call cost. */
export function withSpendGuard(client: LlmClient, guard: SpendGuard): LlmClient {
  return {
    async complete(request) {
      if (await guard.overCap(request.tenantId)) throw new LlmError("over_budget");
      const result = await client.complete(request);
      // Not awaited: the turn doesn't wait on bookkeeping, and record never throws.
      void guard.record(request.tenantId, result.costUsd);
      return result;
    },
  };
}

/**
 * Whether a business is over its cap, read at most once a minute per business (a turn makes two model calls). A read
 * that fails counts as not over: a database blip must not stop the assistant; the gate's own check still runs.
 */
export function cachedOverCap(read: (tenantId: string) => Promise<boolean>, ttlMs = 60_000, now: () => number = Date.now): SpendGuard["overCap"] {
  const cache = new Map<string, { at: number; over: boolean }>();
  return async (tenantId) => {
    const hit = cache.get(tenantId);
    if (hit && now() - hit.at < ttlMs) return hit.over;
    let over = false;
    try {
      over = await read(tenantId);
    } catch (e) {
      console.error(`[ai-limits] the spend cap could not be read for business ${tenantId}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    cache.set(tenantId, { at: now(), over });
    return over;
  };
}

/** The server's guard, on the service role. Nothing is read or written until the first model call. */
export function serverSpendGuard(): SpendGuard {
  return {
    overCap: cachedOverCap(async (tenantId) => (await aiLimitFor(tenantId, null)) === "ai_spend_cap"),
    record: async (tenantId, costUsd) => {
      try {
        const { error } = await (await adminDb()).rpc("record_ai_spend", { p_tenant_id: tenantId, p_cost_usd: costUsd ?? 0 });
        if (error) throw new Error(error.message);
      } catch (e) {
        console.error(`[ai-limits] a model call's cost was not recorded for business ${tenantId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  };
}

// Telling the owners -------------------------------------------------------------------------------------------------------

const INDIA = "Asia/Kolkata";
const dayInIndia = (at: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: INDIA, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
const hourOf = (at: Date) => at.toISOString().slice(0, 13);

/** The notice for a limit. Placeholder wording until Raja's. */
export function limitNotice(limit: AiLimit, appUrl: string, conversationId: string | null): NoticeMessage {
  const base = `${appUrl.replace(/\/$/, "")}/dashboard/inbox`;
  const link = limit === "contact_rate_limit" && conversationId ? `${base}?chat=${conversationId}` : base;
  const notices: Record<AiLimit, { headline: string; next: string }> = {
    ai_spend_cap: {
      headline: "Spark Agent has paused AI replies for today: your business reached its daily AI limit.",
      next: "Customers' messages are waiting in your inbox. AI replies start again tomorrow; contact us to raise the limit.",
    },
    tenant_rate_limit: {
      headline: `Spark Agent has paused AI replies for a while: your business sent more than ${TENANT_AI_REPLIES_PER_HOUR} in the last hour.`,
      next: "Customers' messages are waiting in your inbox. AI replies start again within the hour.",
    },
    contact_rate_limit: {
      headline: `Spark Agent has stopped replying to one customer for now: it sent them ${CONTACT_AI_REPLIES_PER_HOUR} replies in the last hour.`,
      next: "Their chat is waiting in your inbox. The assistant answers them again within the hour.",
    },
  };
  const { headline, next } = notices[limit];
  return { text: `${headline}\n${next}\n${link}`, templateParams: [headline, link] };
}

/**
 * One notice per business per day for the cap, and per business per hour for its pace and for a chat reaching its limit: a bot
 * flooding 50 chats in an hour sends the owners one alert (with the first chat's link), not 50.
 */
export function limitNoticeKey(limit: AiLimit, tenantId: string, conversationId: string | null, at: Date): string {
  if (limit === "ai_spend_cap") return `ai_limit:spend:${tenantId}:${dayInIndia(at)}`;
  if (limit === "tenant_rate_limit") return `ai_limit:pace:${tenantId}:${hourOf(at)}`;
  return `ai_limit:chat:${tenantId}:${hourOf(at)}`;
}

export interface LimitNoticeDeps {
  appUrl: string;
  now: () => Date;
  notify: (tenantId: string, message: NoticeMessage, keyBase: string) => Promise<NoticeCounts>;
}

/**
 * Tells the business's owners and admins that a limit stopped the assistant, once per key. `notify` is sendAccountNotice
 * for owners and admins (inngest/process-message.ts), passed in so this module, which the model client loads, stays light.
 */
export async function tellOwnersAboutLimit(tenantId: string, limit: AiLimit, conversationId: string | null, deps: LimitNoticeDeps): Promise<NoticeCounts> {
  return deps.notify(tenantId, limitNotice(limit, deps.appUrl, conversationId), limitNoticeKey(limit, tenantId, conversationId, deps.now()));
}
