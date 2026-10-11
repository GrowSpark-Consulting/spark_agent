import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { slotLabel } from "../../booking/time";
import { supabaseAdmin } from "../../lib/supabase-admin";
import { withTimeout } from "../../lib/timeout";
import { llm as defaultLlm } from "../llm";
import type { LlmClient } from "../llm/anthropic";
import { resolvePack } from "../packs/load";
import { createDbPackSource } from "../packs/store";
import { createPipelineStore } from "../pipeline/store";
import type { HistoryMessage } from "../prompts/leadcard_v1";
import { assembleCard, type CardAnswer, type CardFacts, type CardWords, type LeadCard } from "./card";
import { writeCardWords } from "./summarise";

// buildLeadCard (docs/contracts.md, section "Fixed"): the card staff see for a chat, so they never have to read it. Read only, with the service role,
// so every query names the business, and a chat or lead of another business is never found, even with its id. Everything comes from named columns;
// nothing secret is selected. The words come from the model (summarise.ts) and are kept on the customer's latest message, so opening the inbox
// again costs no model call: they are written again only when the customer writes again or the reason staff are told changes.

const TAG = "[leadcard]";
const READ_TIMEOUT_MS = 5000;
const HISTORY_LIMIT = 20;
const LEAD_LIMIT = 50;
const BOOKING_LIMIT = 5;
const HOT_ALERT_ACTION = "lead.hot_alerted"; // written by the reply step (pipeline/events.ts HOT_LEAD_ACTION)
const DEFAULT_TIME_ZONE = "Asia/Kolkata";
const CLOSED = new Set(["won", "lost"]);

export interface LeadCardDeps {
  db: SupabaseClient;
  llm: LlmClient;
  /** A pack's definition by key and version, or null. */
  loadPackDefinition: (key: string, version: number) => Promise<unknown | null>;
  now: () => Date;
  /** Keeps something under `messages.meta.agent` of a message of this chat (the pipeline store's saveAgentMeta). False when the message is not this chat's. */
  saveCache: (tenantId: string, conversationId: string, messageId: string, agent: Record<string, unknown>) => Promise<boolean>;
}

const defaults = (): LeadCardDeps => {
  const db = supabaseAdmin();
  const packs = createDbPackSource(db);
  const store = createPipelineStore(db);
  return {
    db,
    llm: defaultLlm(),
    loadPackDefinition: (key, version) => packs.get(key, version),
    now: () => new Date(),
    saveCache: (tenantId, conversationId, messageId, agent) => store.saveAgentMeta(tenantId, conversationId, messageId, agent),
  };
};

const ConversationRow = z.object({ id: z.string(), contact_id: z.string() });
const ContactRow = z.object({ phone: z.string(), name: z.string().nullable(), language: z.string().nullable() });
const TenantRow = z.object({ timezone: z.unknown(), vertical: z.string(), vertical_version: z.number(), pack_overrides: z.unknown() });
const Temperature = z.enum(["hot", "warm", "cold", "disqualified"]);
const LeadRow = z.object({
  id: z.string(),
  stage: z.string(),
  score: z.number().nullable(),
  temperature: Temperature.nullable().catch(null),
  fields: z.record(z.string(), z.unknown()).catch({}),
  created_at: z.string(),
});
const Named = z.union([z.object({ name: z.string() }), z.array(z.object({ name: z.string() }))]).nullable().optional().catch(null);
const BookingRow = z.object({
  status: z.string(),
  start_at: z.string(),
  end_at: z.string(),
  hold_expires_at: z.string().nullable(),
  services: Named,
  resources: Named,
});
const HandoffRow = z.object({ trigger: z.string(), priority: z.enum(["high", "normal"]).catch("normal") });
const MessageRow = z.object({ id: z.string(), sender: z.enum(["customer", "ai", "staff", "system"]), body: z.string().nullable(), meta: z.unknown() });
const Sentiment = z.enum(["positive", "neutral", "negative", "angry"]);
const CachedWords = z.object({
  key: z.string(),
  words: z.object({ need: z.string(), summary: z.string(), nextStep: z.string(), suggestedReply: z.string().nullable(), discount: z.string().nullable() }),
});

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const nameOf = (value: z.infer<typeof Named>): string | null => (Array.isArray(value) ? value[0]?.name : value?.name) ?? null;

/** One read, with a deadline. The error is thrown with its code only: a row can hold a customer's words. */
async function read<T>(what: string, query: (signal: AbortSignal) => PromiseLike<{ data: T | null; error: { code?: string } | null }>): Promise<T | null> {
  const { data, error } = await withTimeout(query, READ_TIMEOUT_MS);
  if (error) throw new Error(`lead card: ${what} could not be read (database error ${error.code || "none"})`);
  return data;
}

const rowsOf = <S extends z.ZodType>(schema: S, data: unknown): z.infer<S>[] =>
  (Array.isArray(data) ? data : []).flatMap((row) => {
    const parsed = schema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });

/** The pack's fields by key, with the business's own labels, in the pack's order; without the pack, the saved keys themselves. */
async function answers(tenant: z.infer<typeof TenantRow>, fields: Record<string, unknown>, deps: LeadCardDeps): Promise<CardAnswer[]> {
  const scalar = (v: unknown): v is string | number | boolean => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
  try {
    const raw = await deps.loadPackDefinition(tenant.vertical, tenant.vertical_version);
    if (raw !== null && raw !== undefined) {
      const { pack } = resolvePack(raw, tenant.pack_overrides, { allowScoringOverrides: false });
      return pack.fields.flatMap((f) => (scalar(fields[f.key]) ? [{ label: f.label, value: fields[f.key] as string | number | boolean }] : []));
    }
  } catch {
    console.error(`${TAG} the pack could not be read, so the answers show with their keys (business ${tenant.vertical})`);
  }
  return Object.entries(fields).flatMap(([key, value]) => (scalar(value) ? [{ label: key, value }] : []));
}

const sentimentOf = (meta: unknown): CardFacts["sentiment"] => {
  const parsed = Sentiment.safeParse(isObject(meta) && isObject(meta.agent) && isObject(meta.agent.extraction) ? meta.agent.extraction.sentiment : undefined);
  return parsed.success ? parsed.data : "neutral";
};

/** The card for a chat, or null when the business has no such chat or its customer has no lead. */
export async function buildLeadCard(tenantId: string, conversationId: string, deps: LeadCardDeps = defaults()): Promise<LeadCard | null> {
  const { db } = deps;
  const now = deps.now();

  const [conversation] = rowsOf(ConversationRow, await read("the chat", (signal) => db.from("conversations").select("id, contact_id").eq("tenant_id", tenantId).eq("id", conversationId).limit(1).abortSignal(signal)));
  if (!conversation) return null;

  const [contactData, tenantData, leadData, messageData] = await Promise.all([
    read("the customer", (signal) => db.from("contacts").select("phone, name, language").eq("tenant_id", tenantId).eq("id", conversation.contact_id).limit(1).abortSignal(signal)),
    read("the business", (signal) => db.from("tenants").select("timezone, vertical, vertical_version, pack_overrides").eq("id", tenantId).limit(1).abortSignal(signal)),
    read("the lead", (signal) =>
      db.from("leads").select("id, stage, score, temperature, fields, created_at").eq("tenant_id", tenantId).eq("contact_id", conversation.contact_id).order("created_at", { ascending: true }).limit(LEAD_LIMIT).abortSignal(signal),
    ),
    read("the messages", (signal) =>
      db.from("messages").select("id, sender, body, meta").eq("tenant_id", tenantId).eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(HISTORY_LIMIT).abortSignal(signal),
    ),
  ]);
  const [contact] = rowsOf(ContactRow, contactData);
  const [tenant] = rowsOf(TenantRow, tenantData);
  const leads = rowsOf(LeadRow, leadData);
  if (!contact || !tenant) return null;
  // The lead the AI works with, as the pipeline chooses it: the oldest that is still open, else the newest of the closed ones.
  const lead = leads.find((l) => !CLOSED.has(l.stage)) ?? leads[leads.length - 1];
  if (!lead) return null;

  const timeZone = typeof tenant.timezone === "string" && tenant.timezone ? tenant.timezone : DEFAULT_TIME_ZONE;
  const messages = rowsOf(MessageRow, messageData).reverse(); // oldest first
  const latestCustomer = [...messages].reverse().find((m) => m.sender === "customer");

  const [bookingData, handoffData, fieldAnswers] = await Promise.all([
    read("the booking", (signal) =>
      db
        .from("bookings")
        .select("status, start_at, end_at, hold_expires_at, services(name), resources(name)")
        .eq("tenant_id", tenantId)
        .eq("lead_id", lead.id)
        .in("status", ["held", "confirmed"])
        .gt("end_at", now.toISOString())
        .order("start_at", { ascending: true })
        .limit(BOOKING_LIMIT)
        .abortSignal(signal),
    ),
    read("the handoff", (signal) => db.from("handoffs").select("trigger, priority").eq("tenant_id", tenantId).eq("conversation_id", conversationId).is("resolved_at", null).limit(1).abortSignal(signal)),
    answers(tenant, lead.fields, deps),
  ]);

  // The next booking that still counts: a hold that has run out is not one.
  const booking = rowsOf(BookingRow, bookingData).find((b) => b.status === "confirmed" || (b.hold_expires_at !== null && Date.parse(b.hold_expires_at) > now.getTime()));
  const bookingLabel = booking
    ? `${[nameOf(booking.services) ?? "Visit", slotLabel(new Date(booking.start_at), timeZone)].join(", ")}${nameOf(booking.resources) ? ` · ${nameOf(booking.resources)}` : ""}${booking.status === "held" ? " (held, not yet confirmed)" : ""}`
    : null;

  // Why staff are being told: the chat's open handoff, else that the lead turned hot (the audit row the reply step writes).
  const [handoff] = rowsOf(HandoffRow, handoffData);
  let trigger: string | null = handoff?.trigger ?? null;
  if (trigger === null) {
    const alerted = await read("the hot lead alert", (signal) =>
      db.from("audit_logs").select("id").eq("tenant_id", tenantId).eq("action", HOT_ALERT_ACTION).eq("entity_id", lead.id).limit(1).abortSignal(signal),
    );
    if (Array.isArray(alerted) && alerted.length > 0) trigger = "hot_lead";
  }

  const facts: CardFacts = {
    contact: { name: contact.name, phone: contact.phone, language: contact.language },
    fields: fieldAnswers,
    score: lead.score,
    temperature: lead.temperature,
    booking: bookingLabel,
    trigger,
    priority: handoff?.priority ?? null,
    sentiment: sentimentOf(latestCustomer?.meta),
    source: "WhatsApp",
    owner: null, // the name of the member who owns the lead comes with the Team screen's data; the card does not guess it
  };

  // The words: kept ones if they are for this message and this reason, else written (and kept, when the model wrote them).
  const history: HistoryMessage[] = messages.flatMap((m) => (m.body ? [{ sender: m.sender, text: m.body }] : []));
  const cacheKey = latestCustomer ? `${latestCustomer.id}|${trigger ?? "none"}` : null;
  const kept = latestCustomer && isObject(latestCustomer.meta) && isObject(latestCustomer.meta.agent) ? CachedWords.safeParse(latestCustomer.meta.agent.cardWords) : null;
  let words: CardWords & { aiWritten: boolean };
  if (kept?.success && kept.data.key === cacheKey) {
    words = { ...kept.data.words, aiWritten: true };
  } else {
    words = await writeCardWords({ tenantId, conversationId, llm: deps.llm, facts, history });
    if (words.aiWritten && latestCustomer && cacheKey) {
      try {
        const plainWords = { need: words.need, summary: words.summary, nextStep: words.nextStep, suggestedReply: words.suggestedReply, discount: words.discount };
        await deps.saveCache(tenantId, conversationId, latestCustomer.id, { cardWords: { key: cacheKey, words: plainWords } });
      } catch {
        console.error(`${TAG} the card words could not be kept (business ${tenantId})`);
      }
    }
  }
  return assembleCard(facts, words);
}
