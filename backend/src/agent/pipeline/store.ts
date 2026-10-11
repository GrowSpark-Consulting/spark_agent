import type { SupabaseClient } from "@supabase/supabase-js";
import { NonRetriableError } from "inngest";
import { z } from "zod";
import { AppError } from "../../lib/errors";
import { supabaseAdmin } from "../../lib/supabase-admin";
import { TimeoutError, withTimeout } from "../../lib/timeout";
import { ANSWERED_ACTION } from "./events";

// The message pipeline's reads and writes, with the service role. It bypasses row-level security, so every
// query names its business (`tenant_id`; for the tenants table, its own `id`), and the business always comes
// from the event of a verified inbound message, re-checked against the message row: a message is only found
// if it belongs to that business and that conversation.
//
// What is read is what a step may remember. Inngest keeps every step's result, so only the columns the pipeline
// uses are selected, and nothing here returns a message's text, a phone number or a name: the pipeline re-reads
// what it needs, when it needs it.
//
// Failures are fixed words: the log has the Postgres code (or "timed out") and nothing else. Every call has a
// deadline and is aborted when it passes. A failure that waiting can fix (the database unreachable, a timeout) is
// an ordinary error, which Inngest retries; one that it cannot (a refused statement, a row that is not the
// shape expected) is non-retriable, so a bug is not repeated three times.

export interface InboundMessage {
  id: string;
  direction: "in" | "out";
  sender: "customer" | "ai" | "staff" | "system";
  kind: string | null;
  createdAt: string;
}
export interface ConversationRow {
  id: string;
  contactId: string;
  mode: "ai" | "human" | "external";
}
export interface ContactRow {
  id: string;
  language: string | null;
  optedOut: boolean;
  /** When the privacy notice was first shown to this contact (null: not yet, so the next AI reply carries it). */
  consentAt: string | null;
}
export interface TenantRow {
  id: string;
  vertical: string;
  verticalVersion: number;
}
export interface LeadRow {
  id: string;
  stage: string;
  created: boolean;
}
/** A customer message that has not been answered: its id and kind, never its text. */
export interface PendingMessage {
  id: string;
  kind: string | null;
}

/** A lead as the pipeline needs it: its stage and the answers collected so far (business details, never contact details). */
export interface LeadState {
  id: string;
  stage: string;
  fields: Record<string, unknown>;
}
/** The text of one customer message. Only read inside the step that needs it: a step's result is kept by Inngest. */
export interface BatchText {
  id: string;
  body: string | null;
  createdAt: string;
  /** The id of the reply button or list row the customer tapped (the inbound message's `meta.buttonId`), or null for typed text. */
  buttonId: string | null;
}
export interface HistoryItem {
  sender: "customer" | "ai" | "staff";
  body: string;
}

/** What the reply step needs to know about the business: its name (shown to the model) and the settings the dashboard saved. */
export interface TenantReplyInfo {
  name: string;
  /** tenants.agent_settings, as stored: not trusted, parsed by persona.ts. */
  agentSettings: unknown;
}
export type HandoffPriority = "high" | "normal";
/** Where an opt-out came from (consent_logs.source): the customer typed a STOP phrase, or the model read a clear request (0020). */
export type OptOutSource = "stop_keyword" | "model_intent";

export interface PipelineStore {
  /** The message, only if it is this business's and this conversation's. */
  getMessage(tenantId: string, conversationId: string, messageId: string): Promise<InboundMessage | null>;
  getConversation(tenantId: string, conversationId: string): Promise<ConversationRow | null>;
  getContact(tenantId: string, contactId: string): Promise<ContactRow | null>;
  getTenant(tenantId: string): Promise<TenantRow | null>;
  /** Whether the reply step has recorded (an audit row) that this message was answered. `since`: the message's own time. */
  isAnswered(tenantId: string, messageId: string, since: string): Promise<boolean>;
  /**
   * The contact's open lead (any stage but won and lost; the oldest if there are several), or a new one. One open
   * lead per contact: a business has one pack, so one need. The database does not enforce it (no unique index; see
   * the task notes): it holds because the job runs one conversation at a time and a contact has one open
   * conversation per channel. Two conversations of one contact running at once (an old one closed and a new one
   * opened) could make two. `created` is therefore a hint, not a count: a retried run that finds the lead its first
   * attempt made reports false.
   */
  findOrCreateOpenLead(tenantId: string, contactId: string): Promise<LeadRow>;
  /**
   * The customer's most recent messages in this conversation since `since` (the newest 10, oldest first) that have
   * not been answered.
   */
  recentUnanswered(tenantId: string, conversationId: string, since: string): Promise<PendingMessage[]>;

  /** tenants.pack_overrides: what the business changed in its pack (labels, hidden fields, added fields). `{}` when none. */
  getPackOverrides(tenantId: string): Promise<unknown>;
  getLead(tenantId: string, leadId: string): Promise<LeadState | null>;
  /**
   * Adds the patch's keys to the lead's collected answers in one statement (merge_lead_fields: a key already there
   * is replaced, every other key, such as a member's edit, is kept), and with `engage` moves a lead that is still
   * `new` to `engaged`. The caller validates the patch first. False when the lead is not this business's.
   */
  mergeLeadFields(tenantId: string, leadId: string, patch: Record<string, unknown>, engage: boolean): Promise<boolean>;
  /** The text of these customer messages of this conversation, oldest first. */
  getBatchTexts(tenantId: string, conversationId: string, messageIds: string[]): Promise<BatchText[]>;
  /** The last `limit` messages (customer, AI and staff, with text) before `before`, oldest first: context for a short reply. */
  getHistory(tenantId: string, conversationId: string, before: string, limit: number): Promise<HistoryItem[]>;
  /**
   * Keeps what the turn worked out about a message under `messages.meta.agent`, leaving the rest of its meta alone.
   * False when the message is not this business's and conversation's. Where a later step finds the extraction: the
   * words of the customer's question are not kept in Inngest's step results.
   */
  saveAgentMeta(tenantId: string, conversationId: string, messageId: string, agent: Record<string, unknown>): Promise<boolean>;
  getAgentMeta(tenantId: string, conversationId: string, messageId: string): Promise<Record<string, unknown> | null>;

  /** record_notice_shown (0021): sets consent_at (if still null) and logs `notice_shown` in one transaction. True when this call recorded it. */
  recordNoticeShown(tenantId: string, contactId: string, messageId: string | null): Promise<boolean>;
  /** record_opt_out (0021, and 0022 for model_intent): sets opted_out_at (if still null) and logs `opted_out` in one transaction. True when this call opted the contact out. */
  recordOptOut(tenantId: string, contactId: string, source: OptOutSource, messageId: string | null): Promise<boolean>;
  /** Moves a lead that is still open (new, engaged, qualified, nurture) to `lost`. A booked, visited, won or already lost lead is left alone. True when it changed. */
  markLeadLost(tenantId: string, leadId: string): Promise<boolean>;
  /**
   * Keeps the lead's score and temperature (leads.score, leads.temperature: computed by server code, never by the dashboard) while the
   * lead is still open (new, engaged, qualified, nurture). A booked, visited, won or lost lead keeps what it had. True when it changed.
   */
  saveLeadScore(tenantId: string, leadId: string, result: { score: number; temperature: "hot" | "warm" | "cold" | "disqualified" }): Promise<boolean>;
  /** The plan case the chat's latest earlier turn kept on its customer message (`meta.agent.planCase`, before `before`), or null. */
  getPreviousPlanCase(tenantId: string, conversationId: string, before: string): Promise<string | null>;
  /** The business's name and agent settings, or null if it is gone. */
  getTenantReplyInfo(tenantId: string): Promise<TenantReplyInfo | null>;
  /**
   * The count of questions in a row the knowledge base could not answer in this chat, as the chat's latest earlier turn
   * left it (`messages.meta.agent.kbMisses` on the customer message that turn answered, before `before`); 0 when there is none.
   */
  getPreviousMisses(tenantId: string, conversationId: string, before: string): Promise<number>;
  /** record_kb_gap (0012): one upsert per business and normalised question. The count is business-wide; it only feeds the dashboard's most-asked list. */
  recordKbGap(tenantId: string, input: { question: string; questionNorm: string; contactId: string }): Promise<{ gapId: string; askedCount: number }>;
  /** The chat's open handoff (not resolved), or a new one: `created` says which. */
  openHandoff(tenantId: string, conversationId: string, trigger: string, priority: HandoffPriority): Promise<{ id: string; created: boolean }>;
  /** Switches a chat the AI has to a person (`human`). Only from `ai`: a chat already with a person, or on the owner's own number, is left alone. True when it changed. */
  setConversationMode(tenantId: string, conversationId: string, mode: "human"): Promise<boolean>;
}

export const PIPELINE_DB_TIMEOUT_MS = 10_000;
const BATCH_LIMIT = 10;
const OPEN_LEAD_STAGES = ["new", "engaged", "qualified", "nurture"];
/** How many earlier customer messages to look through for the last turn's count: a turn writes it on its newest message. */
const PREVIOUS_TURN_LOOKBACK = 20;
/**
 * An audit row says a message was answered; its time is our clock, a message's `created_at` is Meta's. A day of
 * slack on the lower bound keeps a Meta clock that runs ahead from hiding the row, and keeps the lookup on the
 * index (tenant_id, created_at) instead of reading the business's whole audit log.
 */
const AUDIT_SLACK_MS = 24 * 60 * 60 * 1000;

const Iso = z.string().transform((value) => new Date(value).toISOString());
const MessageRow = z.object({
  id: z.string(),
  direction: z.enum(["in", "out"]),
  sender: z.enum(["customer", "ai", "staff", "system"]),
  kind: z.string().nullable(),
  created_at: Iso,
});
const ConversationSchema = z.object({ id: z.string(), contact_id: z.string(), mode: z.enum(["ai", "human", "external"]) });
const ContactSchema = z.object({ id: z.string(), language: z.string().nullable(), opted_out_at: z.string().nullable(), consent_at: z.string().nullable() });
const TenantSchema = z.object({ id: z.string(), vertical: z.string(), vertical_version: z.number().int() });
const LeadSchema = z.object({ id: z.string(), stage: z.string() });
const PendingSchema = z.object({ id: z.string(), kind: z.string().nullable() });
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const LeadSchema2 = z.object({ id: z.string(), stage: z.string(), fields: z.unknown() });
const BatchTextSchema = z.object({ id: z.string(), body: z.string().nullable(), created_at: Iso, meta: z.unknown().optional() });
const TenantInfoSchema = z.object({ name: z.string(), agent_settings: z.unknown() });
const KbGapResult = z.array(z.object({ gap_id: z.string(), asked_count: z.number().int() })).min(1);
const HandoffSchema = z.object({ id: z.string() });
const HistorySchema = z.object({ sender: z.enum(["customer", "ai", "staff"]), body: z.string().nullable() });

// Postgres codes that mean the database was unreachable, restarting or overloaded: waiting can fix them.
const TRANSIENT_CODE = /^(08.{3}|53[23]00|57P0[123]|57014|40001|40P01|PGRST00[0-3])$/;
const isTransient = (code: string | undefined) => code === undefined || code === "" || TRANSIENT_CODE.test(code);

type Result = { data: unknown; error: { code?: string; message?: string } | null };

export function createPipelineStore(db: SupabaseClient = supabaseAdmin(), { timeoutMs = PIPELINE_DB_TIMEOUT_MS }: { timeoutMs?: number } = {}): PipelineStore {
  const WORDS = "We couldn't read the conversation just now. Try again in a moment.";

  async function run(op: string, query: (signal: AbortSignal) => PromiseLike<Result>): Promise<Result> {
    try {
      return await withTimeout(query, timeoutMs);
    } catch (error) {
      console.error(`[pipeline] ${op} ${error instanceof TimeoutError ? "timed out" : "threw"}`);
      throw new AppError("upstream_failed", WORDS);
    }
  }
  const fail = (op: string, error: { code?: string }): never => {
    console.error(`[pipeline] ${op} failed: code ${typeof error.code === "string" ? error.code.slice(0, 16) : "none"}`);
    if (isTransient(error.code)) throw new AppError("upstream_failed", WORDS);
    throw new NonRetriableError(WORDS);
  };
  /** A row that is not the shape expected will not change by waiting: not retried, and nothing of it is quoted. */
  function parse<T>(schema: z.ZodType<T>, data: unknown, op: string): T {
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      console.error(`[pipeline] ${op} returned an unexpected row`);
      throw new NonRetriableError(WORDS);
    }
    return parsed.data;
  }
  const auditFloor = (since: string) => new Date(Date.parse(since) - AUDIT_SLACK_MS).toISOString();

  return {
    async getMessage(tenantId, conversationId, messageId) {
      const { data, error } = await run("read message", (signal) =>
        db.from("messages").select("id, direction, sender, kind, created_at").eq("id", messageId).eq("tenant_id", tenantId).eq("conversation_id", conversationId).abortSignal(signal).maybeSingle(),
      );
      if (error) fail("read message", error);
      if (data === null) return null;
      const row = parse(MessageRow, data, "read message");
      return { id: row.id, direction: row.direction, sender: row.sender, kind: row.kind, createdAt: row.created_at };
    },

    async getConversation(tenantId, conversationId) {
      const { data, error } = await run("read conversation", (signal) =>
        db.from("conversations").select("id, contact_id, mode").eq("id", conversationId).eq("tenant_id", tenantId).abortSignal(signal).maybeSingle(),
      );
      if (error) fail("read conversation", error);
      if (data === null) return null;
      const row = parse(ConversationSchema, data, "read conversation");
      return { id: row.id, contactId: row.contact_id, mode: row.mode };
    },

    async getContact(tenantId, contactId) {
      const { data, error } = await run("read contact", (signal) =>
        db.from("contacts").select("id, language, opted_out_at, consent_at").eq("id", contactId).eq("tenant_id", tenantId).abortSignal(signal).maybeSingle(),
      );
      if (error) fail("read contact", error);
      if (data === null) return null;
      const row = parse(ContactSchema, data, "read contact");
      return { id: row.id, language: row.language, optedOut: row.opted_out_at !== null, consentAt: row.consent_at };
    },

    async getTenant(tenantId) {
      const { data, error } = await run("read business", (signal) =>
        db.from("tenants").select("id, vertical, vertical_version").eq("id", tenantId).abortSignal(signal).maybeSingle(),
      );
      if (error) fail("read business", error);
      if (data === null) return null;
      const row = parse(TenantSchema, data, "read business");
      return { id: row.id, vertical: row.vertical, verticalVersion: row.vertical_version };
    },

    async isAnswered(tenantId, messageId, since) {
      const { data, error } = await run("check answered", (signal) =>
        db.from("audit_logs").select("id").eq("tenant_id", tenantId).eq("action", ANSWERED_ACTION).eq("entity_id", messageId).gte("created_at", auditFloor(since)).limit(1).abortSignal(signal),
      );
      if (error) fail("check answered", error);
      return Array.isArray(data) && data.length > 0;
    },

    async findOrCreateOpenLead(tenantId, contactId) {
      const found = await run("read lead", (signal) =>
        db.from("leads").select("id, stage").eq("tenant_id", tenantId).eq("contact_id", contactId).not("stage", "in", "(won,lost)").order("created_at", { ascending: true }).limit(1).abortSignal(signal),
      );
      if (found.error) fail("read lead", found.error);
      if (Array.isArray(found.data) && found.data.length > 0) {
        const row = parse(LeadSchema, found.data[0], "read lead");
        return { id: row.id, stage: row.stage, created: false };
      }
      const made = await run("create lead", (signal) =>
        db.from("leads").insert({ tenant_id: tenantId, contact_id: contactId }).select("id, stage").abortSignal(signal).single(),
      );
      if (made.error) fail("create lead", made.error);
      const row = parse(LeadSchema, made.data, "create lead");
      return { id: row.id, stage: row.stage, created: true };
    },

    async recentUnanswered(tenantId, conversationId, since) {
      // The NEWEST ten, then put back in order: if there are more than ten, the latest are the ones to answer.
      const read = await run("read recent messages", (signal) =>
        db
          .from("messages")
          .select("id, kind")
          .eq("tenant_id", tenantId)
          .eq("conversation_id", conversationId)
          .eq("direction", "in")
          .eq("sender", "customer")
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(BATCH_LIMIT)
          .abortSignal(signal),
      );
      if (read.error) fail("read recent messages", read.error);
      const pending = parse(z.array(PendingSchema), read.data ?? [], "read recent messages").reverse();
      if (pending.length === 0) return [];
      const answered = await run("check answered", (signal) =>
        db
          .from("audit_logs")
          .select("entity_id")
          .eq("tenant_id", tenantId)
          .eq("action", ANSWERED_ACTION)
          .in("entity_id", pending.map((m) => m.id))
          .gte("created_at", auditFloor(since))
          .abortSignal(signal),
      );
      if (answered.error) fail("check answered", answered.error);
      const done = new Set(parse(z.array(z.object({ entity_id: z.string() })), answered.data ?? [], "check answered").map((row) => row.entity_id));
      return pending.filter((m) => !done.has(m.id));
    },

    async getPackOverrides(tenantId) {
      const { data, error } = await run("read pack overrides", (signal) =>
        db.from("tenants").select("pack_overrides").eq("id", tenantId).abortSignal(signal).maybeSingle(),
      );
      if (error) fail("read pack overrides", error);
      const value = isObject(data) ? data.pack_overrides : null;
      return isObject(value) ? value : {};
    },

    async getLead(tenantId, leadId) {
      const { data, error } = await run("read lead state", (signal) =>
        db.from("leads").select("id, stage, fields").eq("id", leadId).eq("tenant_id", tenantId).abortSignal(signal).maybeSingle(),
      );
      if (error) fail("read lead state", error);
      if (data === null) return null;
      const row = parse(LeadSchema2, data, "read lead state");
      return { id: row.id, stage: row.stage, fields: isObject(row.fields) ? row.fields : {} };
    },

    async mergeLeadFields(tenantId, leadId, patch, engage) {
      const { data, error } = await run("merge lead fields", (signal) =>
        db.rpc("merge_lead_fields", { p_tenant_id: tenantId, p_lead_id: leadId, p_patch: patch, p_engage: engage }).abortSignal(signal),
      );
      if (error) fail("merge lead fields", error);
      return data === true;
    },

    async getBatchTexts(tenantId, conversationId, messageIds) {
      if (messageIds.length === 0) return [];
      const { data, error } = await run("read message texts", (signal) =>
        db
          .from("messages")
          .select("id, body, created_at, meta")
          .eq("tenant_id", tenantId)
          .eq("conversation_id", conversationId)
          .eq("sender", "customer")
          .in("id", messageIds)
          .order("created_at", { ascending: true })
          .abortSignal(signal),
      );
      if (error) fail("read message texts", error);
      return parse(z.array(BatchTextSchema), data ?? [], "read message texts").map((row) => ({ id: row.id, body: row.body, createdAt: row.created_at, buttonId: isObject(row.meta) && typeof row.meta.buttonId === "string" ? row.meta.buttonId : null }));
    },

    async getHistory(tenantId, conversationId, before, limit) {
      const { data, error } = await run("read history", (signal) =>
        db
          .from("messages")
          .select("sender, body")
          .eq("tenant_id", tenantId)
          .eq("conversation_id", conversationId)
          .in("sender", ["customer", "ai", "staff"])
          .not("body", "is", null)
          .lt("created_at", before)
          .order("created_at", { ascending: false })
          .limit(limit)
          .abortSignal(signal),
      );
      if (error) fail("read history", error);
      return parse(z.array(HistorySchema), data ?? [], "read history")
        .flatMap((row) => (row.body ? [{ sender: row.sender, body: row.body }] : []))
        .reverse();
    },

    async saveAgentMeta(tenantId, conversationId, messageId, agent) {
      const { data, error } = await run("save message meta", (signal) =>
        db.rpc("merge_message_agent_meta", { p_tenant_id: tenantId, p_conversation_id: conversationId, p_message_id: messageId, p_agent: agent }).abortSignal(signal),
      );
      if (error) fail("save message meta", error);
      return data === true;
    },

    async recordNoticeShown(tenantId, contactId, messageId) {
      const { data, error } = await run("record privacy notice", (signal) =>
        db.rpc("record_notice_shown", { p_tenant_id: tenantId, p_contact_id: contactId, p_message_id: messageId }).abortSignal(signal),
      );
      if (error) fail("record privacy notice", error);
      return data === true;
    },

    async recordOptOut(tenantId, contactId, source, messageId) {
      const { data, error } = await run("record opt-out", (signal) =>
        db.rpc("record_opt_out", { p_tenant_id: tenantId, p_contact_id: contactId, p_source: source, p_message_id: messageId }).abortSignal(signal),
      );
      if (error) fail("record opt-out", error);
      return data === true;
    },

    async markLeadLost(tenantId, leadId) {
      const { data, error } = await run("mark lead lost", (signal) =>
        db.from("leads").update({ stage: "lost" }).eq("id", leadId).eq("tenant_id", tenantId).in("stage", OPEN_LEAD_STAGES).select("id").abortSignal(signal),
      );
      if (error) fail("mark lead lost", error);
      return Array.isArray(data) && data.length > 0;
    },

    async saveLeadScore(tenantId, leadId, result) {
      const { data, error } = await run("save lead score", (signal) =>
        db.from("leads").update({ score: result.score, temperature: result.temperature }).eq("id", leadId).eq("tenant_id", tenantId).in("stage", OPEN_LEAD_STAGES).select("id").abortSignal(signal),
      );
      if (error) fail("save lead score", error);
      return Array.isArray(data) && data.length > 0;
    },

    async getPreviousPlanCase(tenantId, conversationId, before) {
      const { data, error } = await run("read previous plan case", (signal) =>
        db
          .from("messages")
          .select("meta")
          .eq("tenant_id", tenantId)
          .eq("conversation_id", conversationId)
          .eq("sender", "customer")
          .lt("created_at", before)
          .order("created_at", { ascending: false })
          .limit(PREVIOUS_TURN_LOOKBACK)
          .abortSignal(signal),
      );
      if (error) fail("read previous plan case", error);
      for (const row of Array.isArray(data) ? data : []) {
        const agent = isObject(row) && isObject(row.meta) && isObject(row.meta.agent) ? row.meta.agent : null;
        if (agent && typeof agent.planCase === "string") return agent.planCase;
      }
      return null;
    },

    async getTenantReplyInfo(tenantId) {
      const { data, error } = await run("read business settings", (signal) =>
        db.from("tenants").select("name, agent_settings").eq("id", tenantId).abortSignal(signal).maybeSingle(),
      );
      if (error) fail("read business settings", error);
      if (data === null) return null;
      const row = parse(TenantInfoSchema, data, "read business settings");
      return { name: row.name, agentSettings: row.agent_settings };
    },

    async getPreviousMisses(tenantId, conversationId, before) {
      const { data, error } = await run("read previous turn", (signal) =>
        db
          .from("messages")
          .select("meta")
          .eq("tenant_id", tenantId)
          .eq("conversation_id", conversationId)
          .eq("sender", "customer")
          .lt("created_at", before)
          .order("created_at", { ascending: false })
          .limit(PREVIOUS_TURN_LOOKBACK)
          .abortSignal(signal),
      );
      if (error) fail("read previous turn", error);
      for (const row of Array.isArray(data) ? data : []) {
        const agent = isObject(row) && isObject(row.meta) && isObject(row.meta.agent) ? row.meta.agent : null;
        if (agent && typeof agent.kbMisses === "number" && Number.isInteger(agent.kbMisses) && agent.kbMisses >= 0) return agent.kbMisses;
      }
      return 0;
    },

    async recordKbGap(tenantId, { question, questionNorm, contactId }) {
      const { data, error } = await run("record knowledge gap", (signal) =>
        db.rpc("record_kb_gap", { p_tenant_id: tenantId, p_question: question, p_question_norm: questionNorm, p_summary: null, p_contact_id: contactId }).abortSignal(signal),
      );
      if (error) fail("record knowledge gap", error);
      const row = parse(KbGapResult, data, "record knowledge gap")[0];
      return { gapId: row.gap_id, askedCount: row.asked_count };
    },

    async openHandoff(tenantId, conversationId, trigger, priority) {
      const open = await run("read open handoff", (signal) =>
        db.from("handoffs").select("id").eq("tenant_id", tenantId).eq("conversation_id", conversationId).is("resolved_at", null).order("id").limit(1).abortSignal(signal),
      );
      if (open.error) fail("read open handoff", open.error);
      if (Array.isArray(open.data) && open.data.length > 0) return { id: parse(HandoffSchema, open.data[0], "read open handoff").id, created: false };
      const made = await run("open handoff", (signal) =>
        db.from("handoffs").insert({ tenant_id: tenantId, conversation_id: conversationId, trigger, priority }).select("id").abortSignal(signal).single(),
      );
      if (made.error) fail("open handoff", made.error);
      return { id: parse(HandoffSchema, made.data, "open handoff").id, created: true };
    },

    async setConversationMode(tenantId, conversationId, mode) {
      const { data, error } = await run("switch chat to a person", (signal) =>
        db.from("conversations").update({ mode }).eq("id", conversationId).eq("tenant_id", tenantId).eq("mode", "ai").select("id").abortSignal(signal),
      );
      if (error) fail("switch chat to a person", error);
      return Array.isArray(data) && data.length > 0;
    },

    async getAgentMeta(tenantId, conversationId, messageId) {
      const { data, error } = await run("read message meta", (signal) =>
        db.from("messages").select("meta").eq("id", messageId).eq("tenant_id", tenantId).eq("conversation_id", conversationId).abortSignal(signal).maybeSingle(),
      );
      if (error) fail("read message meta", error);
      const meta = isObject(data) ? data.meta : null;
      return isObject(meta) && isObject(meta.agent) ? meta.agent : null;
    },
  };
}
