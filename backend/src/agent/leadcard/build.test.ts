import { describe, expect, it, vi } from "vitest";
import { fakeTables, type Row } from "../../test-support/fake-tables";
import type { LlmClient, LlmRequest, LlmResult } from "../llm/anthropic";
import { samplePack } from "../packs/test-packs";
import { buildLeadCard, type LeadCardDeps } from "./build";

// buildLeadCard (docs/contracts.md): one card for a chat, from the database, read only. Every read names the business, and a chat or lead of another
// business is never found, even with its id.

const A = "e0000000-0000-0000-0000-00000000000a";
const B = "e0000000-0000-0000-0000-00000000000b";
const CONV = "c0000000-0000-0000-0000-00000000000c";
const CONTACT = "b0000000-0000-0000-0000-0000000000b1";
const LEAD = "10000000-0000-0000-0000-0000000000f1";
const M1 = "a0000000-0000-0000-0000-0000000000a1";
const M2 = "a0000000-0000-0000-0000-0000000000a2";
const NOW = new Date("2026-10-10T04:30:00.000Z");
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

const pack = () =>
  samplePack({
    fields: [
      { key: "budget", label: "Budget", type: "range_inr", required: true },
      { key: "area", label: "Preferred area", type: "text", required: true },
      { key: "buyer", label: "Are you the buyer?", type: "boolean" },
    ],
    scoring: { rules: [], thresholds: { hot: 70, warm: 40 }, hardFails: [] },
  });

const words = { need: "Wants a flat in Velachery", summary: "Asked the price.\nAsked for 70 lakh.", nextStep: "Reply with a decision.", suggestedReply: "The team will check and come back.", discount: "Asked for 70 lakh" };
const llmResult = (text: string): LlmResult => ({ text, model: "m", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, latencyMs: 1, attempts: 1, requestId: null });

function world(over: { tables?: Record<string, Row[]>; answer?: string | Error } = {}) {
  const tables: Record<string, Row[]> = {
    conversations: [{ id: CONV, tenant_id: A, contact_id: CONTACT, mode: "ai", assigned_user_id: null }],
    contacts: [{ id: CONTACT, tenant_id: A, phone: "+919812345621", name: "Priya", language: "ta-en" }],
    tenants: [{ id: A, timezone: "Asia/Kolkata", vertical: "sample-pack", vertical_version: 1, pack_overrides: {} }],
    leads: [{ id: LEAD, tenant_id: A, contact_id: CONTACT, stage: "engaged", score: 75, temperature: "hot", fields: { budget: "60L", area: "Velachery", buyer: true }, owner_user_id: null, created_at: at(600) }],
    bookings: [],
    handoffs: [{ id: "h1", tenant_id: A, conversation_id: CONV, trigger: "negotiation", priority: "high", resolved_at: null }],
    messages: [
      { id: M1, tenant_id: A, conversation_id: CONV, sender: "customer", body: "2BHK Velachery price enna?", created_at: at(30), meta: { agent: { extraction: { sentiment: "neutral" } } } },
      { id: "m-ai", tenant_id: A, conversation_id: CONV, sender: "ai", body: "A 2BHK starts at ₹78 lakh.", created_at: at(29), meta: {} },
      { id: M2, tenant_id: A, conversation_id: CONV, sender: "customer", body: "70 lakh ku mudiyuma?", created_at: at(5), meta: { agent: { extraction: { sentiment: "negative" } } } },
    ],
    audit_logs: [],
    ...over.tables,
  };
  const { db, calls } = fakeTables(tables);
  const complete = vi.fn<(request: LlmRequest) => Promise<LlmResult>>(async () => {
    if (over.answer instanceof Error) throw over.answer;
    return llmResult(over.answer ?? JSON.stringify(words));
  });
  const llm: LlmClient = { complete };
  const saved: { messageId: string; agent: Record<string, unknown> }[] = [];
  const deps: LeadCardDeps = {
    db,
    llm,
    loadPackDefinition: async () => pack(),
    now: () => NOW,
    saveCache: async (_tenantId, _conversationId, messageId, agent) => {
      saved.push({ messageId, agent });
      const message = (tables.messages as Row[]).find((m) => m.id === messageId);
      if (message) message.meta = { ...(message.meta as object), agent: { ...((message.meta as { agent?: object }).agent ?? {}), ...agent } };
      return true;
    },
  };
  return { deps, calls, complete, saved, tables };
}

describe("a card for a chat", () => {
  it("has the customer, what they want, how promising, why staff are told, the words of the card, and nothing else to read", async () => {
    const w = world();
    const card = await buildLeadCard(A, CONV, w.deps);
    expect(card).toMatchObject({
      contact: { name: "Priya", phone: "+919812345621", language: "ta-en" },
      need: "Wants a flat in Velachery",
      languageNote: "Writes in Tanglish (Tamil in English letters)",
      source: "WhatsApp",
      answers: ["Budget: 60L", "Preferred area: Velachery", "Are you the buyer?: yes"],
      score: 75,
      temperature: "hot",
      isHot: true,
      booking: null,
      trigger: "Asked for a discount",
      priority: "high",
      sentiment: "negative", // from the customer's latest message
      summary: "Asked the price.\nAsked for 70 lakh.",
      nextStep: "Reply with a decision.",
      suggestedReply: "The team will check and come back.",
      discount: "Asked for 70 lakh",
      aiWritten: true,
    });
  });

  it("gives back null for a chat that does not exist, or a lead that was never made", async () => {
    expect(await buildLeadCard(A, "c0000000-0000-0000-0000-0000000000ff", world().deps)).toBeNull();
    expect(await buildLeadCard(A, CONV, world({ tables: { leads: [] } }).deps)).toBeNull();
  });
});

describe("every read names the business", () => {
  it("and a chat of another business is never found, even with its id", async () => {
    const w = world();
    expect(await buildLeadCard(B, CONV, w.deps)).toBeNull();
    for (const call of w.calls) {
      if (call.op !== "select") continue;
      const named = call.filters.some((f) => (f.column === "tenant_id" || (call.table === "tenants" && f.column === "id")) && f.op === "eq");
      expect(named, `${call.table} is read without naming the business`).toBe(true);
    }
  });

  it("the lead and the messages are the chat's own: other contacts' leads and other chats' messages are not read in", async () => {
    const w = world({
      tables: {
        leads: [
          { id: LEAD, tenant_id: A, contact_id: CONTACT, stage: "engaged", score: 75, temperature: "hot", fields: { area: "Velachery" }, owner_user_id: null, created_at: at(600) },
          { id: "10000000-0000-0000-0000-0000000000f2", tenant_id: A, contact_id: "b0000000-0000-0000-0000-0000000000b9", stage: "new", score: 5, temperature: "cold", fields: { area: "Chennai" }, owner_user_id: null, created_at: at(900) },
        ],
        messages: [
          { id: M1, tenant_id: A, conversation_id: CONV, sender: "customer", body: "mine", created_at: at(30), meta: {} },
          { id: "other", tenant_id: A, conversation_id: "c0000000-0000-0000-0000-0000000000dd", sender: "customer", body: "SOMEONE ELSE'S MESSAGE", created_at: at(2), meta: {} },
        ],
      },
    });
    const card = await buildLeadCard(A, CONV, w.deps);
    expect(card?.score).toBe(75);
    const prompt = w.complete.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain("mine");
    expect(prompt).not.toContain("SOMEONE ELSE");
  });
});

describe("the lead of a contact", () => {
  it("is the oldest open one, as the pipeline chooses it, else the newest closed one", async () => {
    const open = { id: LEAD, tenant_id: A, contact_id: CONTACT, stage: "engaged", score: 60, temperature: "warm", fields: {}, owner_user_id: null, created_at: at(300) };
    const won = { ...open, id: "10000000-0000-0000-0000-0000000000f3", stage: "won", score: 90, temperature: "hot", created_at: at(900) };
    expect((await buildLeadCard(A, CONV, world({ tables: { leads: [won, open] } }).deps))?.score).toBe(60);
    const lost = { ...open, id: "10000000-0000-0000-0000-0000000000f4", stage: "lost", score: 10, temperature: "cold", created_at: at(100) };
    expect((await buildLeadCard(A, CONV, world({ tables: { leads: [won, lost] } }).deps))?.score).toBe(10);
  });
});

describe("the booking", () => {
  const row = (over: Row = {}) => ({
    id: "bk1", tenant_id: A, lead_id: LEAD, status: "confirmed", start_at: "2026-10-11T09:30:00.000Z", end_at: "2026-10-11T10:30:00.000Z", hold_expires_at: null,
    services: { name: "Site visit" }, resources: { name: "Anand" }, ...over,
  });

  it("is the next one, as the customer reads it, in the business's own time zone, with who", async () => {
    const card = await buildLeadCard(A, CONV, world({ tables: { bookings: [row()] } }).deps);
    expect(card?.booking).toBe("Site visit, Sun 11 Oct, 3:00 pm · Anand");
  });

  it("says when it is only held", async () => {
    const card = await buildLeadCard(A, CONV, world({ tables: { bookings: [row({ status: "held", hold_expires_at: "2026-10-10T04:40:00.000Z" })] } }).deps);
    expect(card?.booking).toBe("Site visit, Sun 11 Oct, 3:00 pm · Anand (held, not yet confirmed)");
  });

  it("is none when the hold ran out, the booking is over or it was cancelled", async () => {
    const expired = row({ status: "held", hold_expires_at: "2026-10-10T04:00:00.000Z" });
    const over = row({ end_at: "2026-10-10T03:00:00.000Z", start_at: "2026-10-10T02:00:00.000Z" });
    const cancelled = row({ status: "cancelled" });
    expect((await buildLeadCard(A, CONV, world({ tables: { bookings: [expired, over, cancelled] } }).deps))?.booking).toBeNull();
  });
});

describe("why staff are being told", () => {
  it("is the chat's open handoff, with its priority", async () => {
    const card = await buildLeadCard(A, CONV, world({ tables: { handoffs: [{ id: "h", tenant_id: A, conversation_id: CONV, trigger: "complaint", priority: "high", resolved_at: null }] } }).deps);
    expect(card).toMatchObject({ trigger: "Unhappy with the service", priority: "high" });
  });

  it("is nothing when the handoffs are all closed", async () => {
    const card = await buildLeadCard(A, CONV, world({ tables: { handoffs: [{ id: "h", tenant_id: A, conversation_id: CONV, trigger: "complaint", priority: "high", resolved_at: at(10) }] } }).deps);
    expect(card).toMatchObject({ trigger: null, priority: null });
  });

  it("is a hot lead when staff were told it turned hot and there is no handoff", async () => {
    const card = await buildLeadCard(A, CONV, world({ tables: { handoffs: [], audit_logs: [{ id: 1, tenant_id: A, action: "lead.hot_alerted", entity_id: LEAD }] } }).deps);
    expect(card).toMatchObject({ trigger: "Hot lead: ready to move", isHot: true });
  });
});

describe("the words are written once per message", () => {
  it("the model is asked once, and the words are kept on the customer's latest message", async () => {
    const w = world();
    await buildLeadCard(A, CONV, w.deps);
    expect(w.complete).toHaveBeenCalledOnce();
    expect(w.saved).toHaveLength(1);
    expect(w.saved[0].messageId).toBe(M2);
    expect(w.saved[0].agent).toHaveProperty("cardWords");
  });

  it("a second look at the same chat uses what was kept, so opening the inbox costs no model call", async () => {
    const w = world();
    const first = await buildLeadCard(A, CONV, w.deps);
    const second = await buildLeadCard(A, CONV, w.deps);
    expect(w.complete).toHaveBeenCalledOnce();
    expect(second).toEqual(first);
  });

  it("a new customer message, or a different reason, writes them again", async () => {
    const w = world();
    await buildLeadCard(A, CONV, w.deps);
    (w.tables.messages as Row[]).push({ id: "a0000000-0000-0000-0000-0000000000a3", tenant_id: A, conversation_id: CONV, sender: "customer", body: "hello?", created_at: at(1), meta: {} });
    await buildLeadCard(A, CONV, w.deps);
    expect(w.complete).toHaveBeenCalledTimes(2);
    (w.tables.handoffs as Row[])[0].trigger = "complaint";
    await buildLeadCard(A, CONV, w.deps);
    expect(w.complete).toHaveBeenCalledTimes(3);
  });

  it("kept words that are not valid are ignored, and written again", async () => {
    const w = world({ tables: { messages: [{ id: M2, tenant_id: A, conversation_id: CONV, sender: "customer", body: "70 lakh ku mudiyuma?", created_at: at(5), meta: { agent: { cardWords: { key: `${M2}|negotiation`, words: { need: 5 } } } } }] } });
    const card = await buildLeadCard(A, CONV, w.deps);
    expect(w.complete).toHaveBeenCalledOnce();
    expect(card?.aiWritten).toBe(true);
  });

  it("plain words are not kept: a model that was down is tried again next time", async () => {
    const w = world({ answer: new Error("down") });
    const first = await buildLeadCard(A, CONV, w.deps);
    expect(first?.aiWritten).toBe(false);
    expect(w.saved).toEqual([]);
  });

  it("a failure to keep the words does not fail the card", async () => {
    const w = world();
    w.deps.saveCache = async () => {
      throw new Error("db down");
    };
    expect((await buildLeadCard(A, CONV, w.deps))?.aiWritten).toBe(true);
  });
});

describe("a business whose pack cannot be read", () => {
  it("still gets a card: the answers show with the labels they were saved under", async () => {
    const w = world();
    w.deps.loadPackDefinition = async () => null;
    const card = await buildLeadCard(A, CONV, w.deps);
    expect(card?.answers).toEqual(expect.arrayContaining(["budget: 60L", "area: Velachery"]));
  });
});

describe("what a card never contains", () => {
  it("a secret, a token or another business's data: it is built from named columns only", async () => {
    const w = world();
    const card = JSON.stringify(await buildLeadCard(A, CONV, w.deps));
    expect(card).not.toMatch(/token|secret|password|tenant_id/i);
  });
});
