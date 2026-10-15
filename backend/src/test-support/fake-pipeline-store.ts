import { parseChatCoverage, type HandoffPriority, type TenantReplyInfo } from "../agent/pipeline/store";
import { parsePendingState } from "../agent/scheduling/state";
import type { BatchText, ContactRow, ConversationRow, HistoryItem, InboundMessage, LeadRow, LeadState, PendingMessage, PipelineStore, TenantRow } from "../agent/pipeline/store";

// An in-memory PipelineStore for tests. It enforces the same filtering the real store does: a message,
// conversation or contact is only found for the business that owns it, an "answered" row only counts if it is
// no older than a day before the message, and a batch is the newest ten. Its rows also carry fields the
// pipeline must never keep (a message body, a phone number, a name), as the database's own rows do, so a
// pipeline that passed a row through to a step result would leak them in a test.

export const HIDDEN = { body: "HIDDEN-MESSAGE-TEXT", phone: "+919800000001", name: "Hidden Name" };
const DAY_MS = 24 * 60 * 60 * 1000;

export interface FakeMessage extends InboundMessage {
  tenantId: string;
  conversationId: string;
  /** The message's text. Only the methods that read text return it. */
  body?: string | null;
  meta?: Record<string, unknown>;
}
export interface FakeContact extends Omit<ContactRow, "consentAt"> {
  tenantId: string;
  /** The notice has been shown (an ISO time) or not (null, the default). */
  consentAt?: string | null;
}
export interface FakeConsentLog {
  tenantId: string;
  contactId: string;
  event: "notice_shown" | "opted_out";
  source: string;
  messageId: string | null;
}
export interface FakeConversation extends ConversationRow {
  tenantId: string;
}
export interface FakeHandoff {
  id: string;
  tenantId: string;
  conversationId: string;
  trigger: string;
  priority: HandoffPriority;
  resolved: boolean;
}
export interface FakeLead {
  id: string;
  tenantId: string;
  contactId: string;
  stage: string;
  createdAt: number;
  fields?: Record<string, unknown>;
  score?: number | null;
  temperature?: string | null;
}

export function fakePipelineStore(
  seed: {
    tenants?: TenantRow[];
    messages?: FakeMessage[];
    conversations?: FakeConversation[];
    contacts?: FakeContact[];
    leads?: FakeLead[];
    /** Message ids that have an "answered" audit row, written 10 seconds after the message unless `answeredAt` says otherwise. */
    answered?: string[];
    answeredAt?: Record<string, string>;
    /** tenants.pack_overrides by business id. */
    packOverrides?: Record<string, unknown>;
    /** The business's name and agent_settings, by business id. */
    tenantInfo?: Record<string, TenantReplyInfo>;
    handoffs?: FakeHandoff[];
  } = {},
) {
  const tenants = new Map((seed.tenants ?? []).map((t) => [t.id, t]));
  const messages = new Map((seed.messages ?? []).map((m) => [m.id, m]));
  const conversations = new Map((seed.conversations ?? []).map((c) => [c.id, c]));
  const contacts = new Map((seed.contacts ?? []).map((c) => [c.id, c]));
  const leads = new Map((seed.leads ?? []).map((l) => [l.id, l]));
  const answered = new Map<string, number>();
  for (const id of seed.answered ?? []) {
    const at = seed.answeredAt?.[id] ?? (messages.has(id) ? new Date(Date.parse(messages.get(id)!.createdAt) + 10_000).toISOString() : new Date().toISOString());
    answered.set(id, Date.parse(at));
  }
  const calls: string[] = [];
  const handoffs: FakeHandoff[] = [...(seed.handoffs ?? [])];
  const consentLogs: FakeConsentLog[] = [];
  /** record_kb_gap's rows: one per business and normalised question, with the business-wide count. */
  const gaps = new Map<string, { tenantId: string; norm: string; question: string; contactId: string; askedCount: number }>();
  const state = { /** Appended to the message of every simulated failure (a test puts things in it that must never be logged). */ failMessage: "", failNext: new Set<keyof PipelineStore>(), /** Fails on EVERY call, until removed. */ failAlways: new Set<keyof PipelineStore>(), leadCounter: 0, handoffCounter: 0, /** Which of these message ids notify.send holds a 'sending' claim for (notify_attempts): the world that owns the send fake points this at it. */ claimsFrom: ((): string[] => []) as (tenantId: string, ids: string[]) => string[] };
  const maybeFail = (op: keyof PipelineStore) => {
    if (state.failAlways.has(op)) throw new Error(`${op} failed (simulated, always)${state.failMessage}`);
    if (state.failNext.delete(op)) throw new Error(`${op} failed (simulated)${state.failMessage}`);
  };
  /** Leads staff were told are hot (the audit row the reply step writes; a test's audit fake adds to it). */
  const hotAlerted = new Set<string>();
  /** Leads staff were told asked to cancel or move a booking they do not have (the audit row a test's audit fake adds to it). */
  const bookingReminded = new Set<string>();
  const isAnsweredAt = (id: string, since: string) => {
    const at = answered.get(id);
    return at !== undefined && at >= Date.parse(since) - DAY_MS;
  };

  const store: PipelineStore = {
    async getMessage(tenantId, conversationId, messageId) {
      calls.push("getMessage");
      maybeFail("getMessage");
      const m = messages.get(messageId);
      return m && m.tenantId === tenantId && m.conversationId === conversationId ? ({ id: m.id, direction: m.direction, sender: m.sender, kind: m.kind, createdAt: m.createdAt, ...HIDDEN } as InboundMessage) : null;
    },
    async getConversation(tenantId, conversationId) {
      calls.push("getConversation");
      maybeFail("getConversation");
      const c = conversations.get(conversationId);
      return c && c.tenantId === tenantId ? ({ id: c.id, contactId: c.contactId, mode: c.mode, ...HIDDEN } as ConversationRow) : null;
    },
    async getContact(tenantId, contactId) {
      calls.push("getContact");
      maybeFail("getContact");
      const c = contacts.get(contactId);
      return c && c.tenantId === tenantId ? ({ id: c.id, language: c.language, optedOut: c.optedOut, consentAt: c.consentAt ?? null, ...HIDDEN } as ContactRow) : null;
    },
    async getTenant(tenantId) {
      calls.push("getTenant");
      maybeFail("getTenant");
      const t = tenants.get(tenantId);
      return t ? ({ ...t, ...HIDDEN, name: "Hidden Business Name" } as TenantRow) : null;
    },
    async isAnswered(tenantId, messageId, since) {
      calls.push("isAnswered");
      maybeFail("isAnswered");
      return messages.get(messageId)?.tenantId === tenantId && isAnsweredAt(messageId, since);
    },
    async findOrCreateOpenLead(tenantId, contactId): Promise<LeadRow> {
      calls.push("findOrCreateOpenLead");
      maybeFail("findOrCreateOpenLead");
      const open = [...leads.values()]
        .filter((l) => l.tenantId === tenantId && l.contactId === contactId && l.stage !== "won" && l.stage !== "lost")
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (open) return { id: open.id, stage: open.stage, created: false };
      const lead: FakeLead = { id: `10000000-0000-0000-0000-${String(++state.leadCounter).padStart(12, "0")}`, tenantId, contactId, stage: "new", createdAt: Date.now() + state.leadCounter };
      leads.set(lead.id, lead);
      return { id: lead.id, stage: lead.stage, created: true };
    },
    async getPackOverrides(tenantId) {
      calls.push("getPackOverrides");
      maybeFail("getPackOverrides");
      return seed.packOverrides?.[tenantId] ?? {};
    },
    async getLead(tenantId, leadId): Promise<LeadState | null> {
      calls.push("getLead");
      maybeFail("getLead");
      const l = leads.get(leadId);
      return l && l.tenantId === tenantId ? { id: l.id, stage: l.stage, fields: structuredClone(l.fields ?? {}) } : null;
    },
    async mergeLeadFields(tenantId, leadId, patch, engage) {
      calls.push("mergeLeadFields");
      maybeFail("mergeLeadFields");
      const l = leads.get(leadId);
      if (!l || l.tenantId !== tenantId) return false;
      l.fields = { ...(l.fields ?? {}), ...structuredClone(patch) };
      if (engage && l.stage === "new") l.stage = "engaged";
      return true;
    },
    async getBatchTexts(tenantId, conversationId, messageIds): Promise<BatchText[]> {
      calls.push("getBatchTexts");
      maybeFail("getBatchTexts");
      return messageIds
        .map((id) => messages.get(id))
        .filter((m): m is FakeMessage => !!m && m.tenantId === tenantId && m.conversationId === conversationId && m.sender === "customer")
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
        .map((m) => ({ id: m.id, body: m.body ?? null, createdAt: m.createdAt, buttonId: typeof m.meta?.buttonId === "string" ? m.meta.buttonId : null, kind: m.kind }));
    },
    async getHistory(tenantId, conversationId, before, limit): Promise<HistoryItem[]> {
      calls.push("getHistory");
      maybeFail("getHistory");
      return [...messages.values()]
        .filter((m) => m.tenantId === tenantId && m.conversationId === conversationId && m.sender !== "system" && Date.parse(m.createdAt) < Date.parse(before) && m.body)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, limit)
        .reverse()
        .map((m) => ({ sender: m.sender as HistoryItem["sender"], body: m.body as string }));
    },
    async saveAgentMeta(tenantId, conversationId, messageId, agent) {
      calls.push("saveAgentMeta");
      maybeFail("saveAgentMeta");
      const m = messages.get(messageId);
      if (!m || m.tenantId !== tenantId || m.conversationId !== conversationId) return false;
      const existing = m.meta?.agent && typeof m.meta.agent === "object" ? (m.meta.agent as Record<string, unknown>) : {};
      m.meta = { ...(m.meta ?? {}), agent: { ...existing, ...structuredClone(agent) } };
      return true;
    },
    async getAgentMeta(tenantId, conversationId, messageId) {
      calls.push("getAgentMeta");
      maybeFail("getAgentMeta");
      const m = messages.get(messageId);
      const agent = m && m.tenantId === tenantId && m.conversationId === conversationId ? m.meta?.agent : undefined;
      return agent && typeof agent === "object" ? (structuredClone(agent) as Record<string, unknown>) : null;
    },
    async recordNoticeShown(tenantId, contactId, messageId) {
      calls.push("recordNoticeShown");
      maybeFail("recordNoticeShown");
      const c = contacts.get(contactId);
      if (!c || c.tenantId !== tenantId || c.consentAt) return false;
      c.consentAt = new Date().toISOString();
      consentLogs.push({ tenantId, contactId, event: "notice_shown", source: "first_message", messageId });
      return true;
    },
    async recordOptOut(tenantId, contactId, source, messageId) {
      calls.push("recordOptOut");
      maybeFail("recordOptOut");
      const c = contacts.get(contactId);
      if (!c || c.tenantId !== tenantId || c.optedOut) return false;
      c.optedOut = true;
      consentLogs.push({ tenantId, contactId, event: "opted_out", source, messageId });
      return true;
    },
    async markLeadLost(tenantId, leadId) {
      calls.push("markLeadLost");
      maybeFail("markLeadLost");
      const l = leads.get(leadId);
      if (!l || l.tenantId !== tenantId || !["new", "engaged", "qualified", "nurture"].includes(l.stage)) return false;
      l.stage = "lost";
      return true;
    },
    async saveLeadScore(tenantId, leadId, result) {
      calls.push("saveLeadScore");
      maybeFail("saveLeadScore");
      const l = leads.get(leadId);
      if (!l || l.tenantId !== tenantId || !["new", "engaged", "qualified", "nurture"].includes(l.stage)) return false;
      l.score = result.score;
      l.temperature = result.temperature;
      return true;
    },
    async getPreviousPlanCase(tenantId, conversationId, before) {
      calls.push("getPreviousPlanCase");
      maybeFail("getPreviousPlanCase");
      const earlier = [...messages.values()]
        .filter((m) => m.tenantId === tenantId && m.conversationId === conversationId && m.sender === "customer" && Date.parse(m.createdAt) < Date.parse(before))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, 20);
      for (const m of earlier) {
        const planCase = (m.meta?.agent as { planCase?: unknown } | undefined)?.planCase;
        if (typeof planCase === "string") return planCase;
      }
      return null;
    },
    async recordedMessageIds(tenantId, conversationId, ids) {
      calls.push("recordedMessageIds");
      maybeFail("recordedMessageIds");
      return [...messages.values()].filter((m) => m.tenantId === tenantId && m.conversationId === conversationId && ids.includes(m.id)).map((m) => m.id);
    },
    async claimedMessageIds(tenantId, ids) {
      calls.push("claimedMessageIds");
      maybeFail("claimedMessageIds");
      return state.claimsFrom(tenantId, ids);
    },
    async getPreviousCoverage(tenantId, conversationId, before) {
      calls.push("getPreviousCoverage");
      maybeFail("getPreviousCoverage");
      const earlier = [...messages.values()]
        .filter((m) => m.tenantId === tenantId && m.conversationId === conversationId && m.sender === "customer" && Date.parse(m.createdAt) < Date.parse(before))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, 20);
      for (const m of earlier) {
        const agent = m.meta?.agent as Record<string, unknown> | undefined;
        if (agent && Object.hasOwn(agent, "coverage")) return parseChatCoverage(agent.coverage);
      }
      return null;
    },
    async hasBookingChangeReminder(tenantId, leadId) {
      calls.push("hasBookingChangeReminder");
      maybeFail("hasBookingChangeReminder");
      return leads.get(leadId)?.tenantId === tenantId && bookingReminded.has(leadId);
    },
    async hasHotLeadAlert(tenantId, leadId) {
      calls.push("hasHotLeadAlert");
      maybeFail("hasHotLeadAlert");
      return leads.get(leadId)?.tenantId === tenantId && hotAlerted.has(leadId);
    },
    async getPreviousOffer(tenantId, conversationId, before) {
      calls.push("getPreviousOffer");
      maybeFail("getPreviousOffer");
      const earlier = [...messages.values()]
        .filter((m) => m.tenantId === tenantId && m.conversationId === conversationId && m.sender === "customer" && Date.parse(m.createdAt) < Date.parse(before))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, 20);
      for (const m of earlier) {
        const agent = m.meta?.agent as Record<string, unknown> | undefined;
        if (agent && Object.hasOwn(agent, "offer")) return parsePendingState(agent.offer);
      }
      return null;
    },
    async getTenantReplyInfo(tenantId): Promise<TenantReplyInfo | null> {
      calls.push("getTenantReplyInfo");
      maybeFail("getTenantReplyInfo");
      return seed.tenantInfo?.[tenantId] ?? (tenants.has(tenantId) ? { name: "Skyline Homes", agentSettings: {} } : null);
    },
    async getPreviousMisses(tenantId, conversationId, before) {
      calls.push("getPreviousMisses");
      maybeFail("getPreviousMisses");
      const earlier = [...messages.values()]
        .filter((m) => m.tenantId === tenantId && m.conversationId === conversationId && m.sender === "customer" && Date.parse(m.createdAt) < Date.parse(before))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, 20);
      for (const m of earlier) {
        const misses = (m.meta?.agent as { kbMisses?: unknown } | undefined)?.kbMisses;
        if (typeof misses === "number" && Number.isInteger(misses) && misses >= 0) return misses;
      }
      return 0;
    },
    async recordKbGap(tenantId, { question, questionNorm, contactId }) {
      calls.push("recordKbGap");
      maybeFail("recordKbGap");
      const key = `${tenantId}|${questionNorm}`;
      const existing = gaps.get(key);
      if (existing) {
        existing.askedCount++;
        existing.contactId = contactId;
        return { gapId: key, askedCount: existing.askedCount };
      }
      gaps.set(key, { tenantId, norm: questionNorm, question, contactId, askedCount: 1 });
      return { gapId: key, askedCount: 1 };
    },
    async openHandoff(tenantId, conversationId, trigger, priority) {
      calls.push("openHandoff");
      maybeFail("openHandoff");
      const open = handoffs.find((h) => h.tenantId === tenantId && h.conversationId === conversationId && !h.resolved);
      if (open) return { id: open.id, created: false };
      const handoff: FakeHandoff = { id: `20000000-0000-0000-0000-${String(++state.handoffCounter).padStart(12, "0")}`, tenantId, conversationId, trigger, priority, resolved: false };
      handoffs.push(handoff);
      return { id: handoff.id, created: true };
    },
    async setConversationMode(tenantId, conversationId, mode) {
      calls.push("setConversationMode");
      maybeFail("setConversationMode");
      const c = conversations.get(conversationId);
      if (!c || c.tenantId !== tenantId || c.mode !== "ai") return false;
      c.mode = mode;
      return true;
    },
    async recentUnanswered(tenantId, conversationId, since): Promise<PendingMessage[]> {
      calls.push("recentUnanswered");
      maybeFail("recentUnanswered");
      return [...messages.values()]
        .filter((m) => m.tenantId === tenantId && m.conversationId === conversationId && m.direction === "in" && m.sender === "customer" && Date.parse(m.createdAt) >= Date.parse(since))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)) // newest first
        .slice(0, 10)
        .reverse()
        .filter((m) => !isAnsweredAt(m.id, since))
        .map((m) => ({ id: m.id, kind: m.kind, ...HIDDEN }) as PendingMessage);
    },
  };

  return { store, tenants, messages, conversations, contacts, leads, answered, hotAlerted, bookingReminded, handoffs, gaps, consentLogs, calls, state };
}
