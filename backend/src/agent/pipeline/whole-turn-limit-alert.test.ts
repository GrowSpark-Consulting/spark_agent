import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codeSummary, type CardFacts } from "../leadcard/card";
import { writeCardWords } from "../leadcard/summarise";
import type { LlmClient } from "../llm/anthropic";
import { AI_LIMITS, aiLimitFor, CONTACT_AI_REPLIES_PER_HOUR, limitNotice, limitNoticeKey, tellOwnersAboutLimit, TENANT_AI_REPLIES_PER_HOUR, withSpendGuard, type AiLimit } from "../../lib/ai-limits";
import { sendAccountNotice, type NoticeDeps } from "../../notify/account-notices";
import { SAFE_FALLBACK_EN } from "./fixed-texts";
import { CONV, createWorld, DEFAULT_MEMBERS, TENANT, type World, type WorldOptions } from "../../test-support/whole-turn-world";

// Day 7 exit test 4, second half: "hitting the per-contact rate limit or a tenant's daily LLM cap stops further AI calls AND TELLS THE OWNER". whole-turn-limit.test.ts proves the stop; this file
// proves the telling, and the real numbers, on the whole turn: the customer's message goes through the real webhook handler and the emulator of inngest/process-message.ts, whose
// "limit-notice" step now runs the REAL tellOwnersAboutLimit and the REAL sendAccountNotice (a fake team and a fake send behind them; the send keeps one alert per key like notify.send).
// Part B drives the limit by the REAL aiLimitFor on a fake `ai_limits` that counts the world's own replies, and the cap by the REAL withSpendGuard around the model.
// NOT PROVED: the real `ai_limits` function (supabase/tests/ai_limits.test.sql), the real list of who is alerted (notify/staff-alerts.ts), the real notify.send (a fake that follows its
// idempotency rule), WhatsApp delivery of the alert (a template outside the 24 hours is notify's).

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const TEXT = { text: "What is the price of a 2BHK?" };
const OWNER = DEFAULT_MEMBERS[0].userId;
const ADMIN = DEFAULT_MEMBERS[1].userId;
/** 15:30 on 14 Oct in India. */
const NOW = new Date("2026-10-14T10:00:00.000Z");
const hoursLater = (h: number) => new Date(NOW.getTime() + h * 3_600_000);
/** 00:30 on 15 Oct in India: the next day there, though only nine hours on. */
const NEXT_DAY = new Date("2026-10-14T19:00:00.000Z");
const APP_URL = "http://localhost:3000";

const keyFor = (limit: AiLimit, at: Date, userId: string, conversationId: string | null = CONV) => `${limitNoticeKey(limit, TENANT, conversationId, at)}:${userId}`;

// ---------------------------------------------------------------------------------------------------------------------
// A. The owner alert

describe.each(AI_LIMITS)("with the limit %s reached: the owners are told", (limit) => {
  const options = (rest: WorldOptions = {}): WorldOptions => ({ aiLimit: limit, now: () => NOW, ...rest });

  it("the owner and the admin with an alert number are told once each, and not the staff member, nor an owner with no alert number; the customer hears nothing", async () => {
    const w = await createWorld(options());
    await w.post("wamid.A1", TEXT);
    await w.drain();
    const r = w.report();
    expect(r.ownerAlerts.map((a) => a.userId).sort()).toEqual([OWNER, ADMIN].sort());
    expect(r.ownerAlerts.map((a) => a.key).sort()).toEqual([keyFor(limit, NOW, OWNER), keyFor(limit, NOW, ADMIN)].sort());
    expect(r.ownerAlerts.every((a) => a.text === limitNotice(limit, APP_URL, CONV).text)).toBe(true);
    expect(r.replies).toHaveLength(0);
    expect(r.notices).toHaveLength(0);
    expect(w.model.calls).toEqual({ extraction: 0, reply: 0 });
  });

  it("says what stopped and what happens next, with a link to the inbox (to the chat for one customer)", async () => {
    const w = await createWorld(options());
    await w.post("wamid.A1", TEXT);
    await w.drain();
    const [alert] = w.report().ownerAlerts;
    expect(alert.text).toContain(`${APP_URL}/dashboard/inbox`);
    expect(alert.text.includes(`?chat=${CONV}`)).toBe(limit === "contact_rate_limit");
    expect(alert.text).toMatch(/paused|stopped/);
    expect(alert.text).toMatch(/waiting in your inbox/);
  });

  it("holds none of the customer's words, number or name, and no secret", async () => {
    const w = await createWorld(options({ phone: "919812345621", profileName: "Priya Ramesh" }));
    await w.post("wamid.A1", { text: "My number is 9812345621, CANARY-WORDS-7QX" });
    await w.drain();
    const sent = JSON.stringify(w.report().ownerAlerts);
    expect(sent.length).toBeGreaterThan(50);
    for (const leak of ["9812345621", "98123", "Priya", "Ramesh", "CANARY", "2BHK", "synthetic-"]) expect(sent).not.toContain(leak);
  });

  it("a second message in the same hour (twenty minutes on) is stopped too and tells nobody again; a replayed event or webhook tells nobody again", async () => {
    let now = NOW;
    const w = await createWorld(options({ dedupeEvents: false, now: () => now }));
    await w.post("wamid.A1", TEXT, 0);
    await w.post("wamid.A1", TEXT, 0);
    await w.drain();
    now = new Date(NOW.getTime() + 20 * 60_000);
    await w.post("wamid.A2", { text: "Hello? Is anyone there?" }, 30);
    await w.drain();
    await w.post("wamid.A1", TEXT, 0);
    await w.drain();
    const r = w.report();
    expect(r.inbound).toHaveLength(2);
    expect(r.answered).toHaveLength(0);
    expect(r.ownerAlerts).toHaveLength(2);
  });

  it("the same alert is not sent twice when the step is retried after it already told them", async () => {
    const w = await createWorld(options());
    await w.post("wamid.A1", TEXT);
    const [report] = await w.drain({ inject: [{ stepId: "limit-notice", when: "after" }] });
    expect(report).toMatchObject({ status: "completed", attempts: { "limit-notice": 2 } });
    expect(w.report().ownerAlerts).toHaveLength(2);
  });

  it(limit === "ai_spend_cap" ? "the cap is told again only on the next day in India, not an hour later" : "told again in a later hour, not twice in one", async () => {
    let now = NOW;
    const w = await createWorld(options({ now: () => now }));
    await w.post("wamid.A1", TEXT, 0);
    await w.drain();
    now = hoursLater(1);
    await w.post("wamid.A2", { text: "Anyone?" }, 30);
    await w.drain();
    expect(w.report().ownerAlerts).toHaveLength(limit === "ai_spend_cap" ? 2 : 4);
    now = NEXT_DAY;
    await w.post("wamid.A3", { text: "Please reply" }, 60);
    await w.drain();
    expect(w.report().ownerAlerts).toHaveLength(limit === "ai_spend_cap" ? 4 : 6);
    expect(w.report().replies).toHaveLength(0);
  });

  it.each<[string, WorldOptions]>([
    ["every alert send is refused", { alertSends: ["failed", "failed"] }],
    ["every alert send throws (with a message packed with private words)", { alertSends: ["throws", "throws"], poison: " POISON +919812345621" }],
    ["every alert is skipped (alerts switched off, a closed window)", { alertSends: ["skipped", "skipped"] }],
    ["the lookup of who to tell fails", { alertRecipientsFail: true, poison: " POISON +919812345621" }],
    ["there is nobody with an alert number to tell", { members: DEFAULT_MEMBERS.map((m) => ({ ...m, alertNumber: false })) }],
    ["the business has no team at all", { members: [] }],
  ])("when %s: the turn still ends stopped, with no reply, no AI call and no customer message, and the alert step is not retried", async (_what, extra) => {
    const w = await createWorld(options(extra));
    await w.post("wamid.A1", TEXT);
    const [report] = await w.drain();
    expect(report).toMatchObject({ status: "completed", returned: { status: "gated_off", reason: limit }, attempts: { "limit-notice": 1 } });
    const r = w.report();
    expect(r.replies).toHaveLength(0);
    expect(r.notices).toHaveLength(0);
    expect(r.sendCalls).toBe(0);
    expect(r.creditsNet).toBe(0);
    expect(w.model.calls).toEqual({ extraction: 0, reply: 0 });
    expect(r.ownerAlerts).toHaveLength(0);
    expect(JSON.stringify(report)).not.toContain("POISON");
  });

  it("a refused alert for one person does not stop the other's: the admin is still told", async () => {
    const w = await createWorld(options({ alertSends: ["failed"] }));
    await w.post("wamid.A1", TEXT);
    await w.drain();
    expect(w.report().ownerAlerts.map((a) => a.userId)).toEqual([ADMIN]);
  });

  it("STOP while limited: the contact is opted out with ONE confirmation, and the owners are not told (nothing was stopped by the limit)", async () => {
    const w = await createWorld(options({ dedupeEvents: false }));
    await w.post("wamid.S1", { text: "STOP" });
    await w.drain();
    const r = w.report();
    expect(r.notices).toHaveLength(1);
    expect(r.ownerAlerts).toHaveLength(0);
    expect(w.fake.contacts.get("b0000000-0000-4000-8000-0000000000b1")?.optedOut).toBe(true);
  });
});

describe("no limit, or a limit that is not the reason: nobody is told", () => {
  it("under every limit: answered, and no alert", async () => {
    const w = await createWorld({ aiLimit: null, now: () => NOW });
    await w.post("wamid.N1", TEXT);
    await w.drain();
    expect(w.report().replies).toHaveLength(1);
    expect(w.report().ownerAlerts).toHaveLength(0);
  });

  it.each<[string, WorldOptions]>([
    ["a chat a person has", { mode: "human" }],
    ["the assistant switched off", { featureEnabled: false }],
    ["an opted-out contact", { optedOut: true }],
  ])("%s, even with a limit reached: its own reason, no alert", async (_what, extra) => {
    const w = await createWorld({ aiLimit: "ai_spend_cap", now: () => NOW, ...extra });
    await w.post("wamid.N1", TEXT);
    await w.drain();
    expect(w.report().ownerAlerts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// B. The real numbers: the real aiLimitFor on a fake ai_limits, the real spend guard around the model

interface Books {
  spendUsd: number;
  capUsd: number;
  /** Replies already counted this hour for the business, on top of the world's own. */
  otherTenantReplies: number;
}

/** A fake ai_limits (0044): the chat's and the business's AI replies in the hour are the ones the world sent (plus the books' extra), the spend is the books'. */
function limitsDb(world: () => World, books: Books, asked: { tenantId: unknown; conversationId: unknown }[] = []): SupabaseClient {
  return {
    rpc: async (name: string, args: { p_tenant_id: string; p_conversation_id: string | null }) => {
      expect(name).toBe("ai_limits");
      asked.push({ tenantId: args.p_tenant_id, conversationId: args.p_conversation_id });
      const own = world().report().replies.length;
      return { data: [{ spend_today_usd: books.spendUsd, cap_usd: books.capUsd, contact_replies_hour: own, tenant_replies_hour: own + books.otherTenantReplies }], error: null };
    },
  } as unknown as SupabaseClient;
}

async function worldWithRealLimits(books: Books, rest: WorldOptions = {}, asked: { tenantId: unknown; conversationId: unknown }[] = []) {
  // eslint-disable-next-line prefer-const -- read by the limit lookup before createWorld returns
  let world!: World;
  const db = limitsDb(() => world, books, asked);
  world = await createWorld({ aiLimitFrom: (tenantId, conversationId) => aiLimitFor(tenantId, conversationId, db), now: () => NOW, ...rest });
  return world;
}

const say = (i: number) => ({ text: `Message number ${i}: what about a ${(i % 3) + 2}BHK?` });

describe("the per-chat rate limit, with the real numbers", () => {
  it(`${CONTACT_AI_REPLIES_PER_HOUR} AI replies in an hour are answered; the next message is stopped (no model call, no reply, no charge) and the owners are told once, however many more come`, async () => {
    const asked: { tenantId: unknown; conversationId: unknown }[] = [];
    const w = await worldWithRealLimits({ spendUsd: 0, capUsd: 100, otherTenantReplies: 0 }, { balance: 100 }, asked);
    for (let i = 1; i <= CONTACT_AI_REPLIES_PER_HOUR; i++) {
      await w.post(`wamid.R${i}`, say(i), i);
      await w.drain();
    }
    expect(w.report().replies).toHaveLength(CONTACT_AI_REPLIES_PER_HOUR);
    expect(w.report().ownerAlerts).toHaveLength(0);
    const callsBefore = { ...w.model.calls };
    const creditsBefore = w.report().creditsNet;

    for (const i of [CONTACT_AI_REPLIES_PER_HOUR + 1, CONTACT_AI_REPLIES_PER_HOUR + 2, CONTACT_AI_REPLIES_PER_HOUR + 3]) {
      await w.post(`wamid.R${i}`, say(i), i);
      const [report] = await w.drain();
      expect(report.returned).toMatchObject({ status: "gated_off", reason: "contact_rate_limit" });
    }
    const r = w.report();
    expect(r.replies).toHaveLength(CONTACT_AI_REPLIES_PER_HOUR);
    expect(w.model.calls).toEqual(callsBefore);
    expect(r.creditsNet).toBe(creditsBefore);
    expect(r.answered).toHaveLength(CONTACT_AI_REPLIES_PER_HOUR);
    expect(r.inbound).toHaveLength(CONTACT_AI_REPLIES_PER_HOUR + 3);
    expect(r.ownerAlerts.map((a) => a.userId).sort()).toEqual([OWNER, ADMIN].sort());
    expect(r.ownerAlerts[0].key).toContain("ai_limit:chat:");
    // the limit is asked for this business and this chat, once per turn
    expect(asked.every((a) => a.tenantId === TENANT && a.conversationId === CONV)).toBe(true);
    expect(asked).toHaveLength(CONTACT_AI_REPLIES_PER_HOUR + 3);
  }, 30_000);

  it("the hour passes (the chat's count falls): the assistant answers again, and a later stop tells the owners again in its own hour", async () => {
    const books: Books = { spendUsd: 0, capUsd: 100, otherTenantReplies: 0 };
    let now = NOW;
    // eslint-disable-next-line prefer-const -- read by the limit lookup before createWorld returns
    let world!: World;
    let counted: number | null = null;
    const db = {
      rpc: async () => {
        const own = counted ?? world.report().replies.length;
        return { data: [{ spend_today_usd: books.spendUsd, cap_usd: books.capUsd, contact_replies_hour: own, tenant_replies_hour: own }], error: null };
      },
    } as unknown as SupabaseClient;
    world = await createWorld({ aiLimitFrom: (t, c) => aiLimitFor(t, c, db), now: () => now });
    counted = CONTACT_AI_REPLIES_PER_HOUR;
    await world.post("wamid.H1", TEXT, 1);
    await world.drain();
    expect(world.report().replies).toHaveLength(0);
    expect(world.report().ownerAlerts).toHaveLength(2);

    now = hoursLater(1);
    counted = 3;
    await world.post("wamid.H2", say(2), 30);
    await world.drain();
    expect(world.report().replies).toHaveLength(1);

    counted = CONTACT_AI_REPLIES_PER_HOUR;
    await world.post("wamid.H3", say(3), 60);
    await world.drain();
    expect(world.report().replies).toHaveLength(1);
    expect(world.report().ownerAlerts).toHaveLength(4);
  });
});

describe("the per-business rate limit, with the real numbers", () => {
  it(`at ${TENANT_AI_REPLIES_PER_HOUR - 1} replies in the hour one more is answered; at ${TENANT_AI_REPLIES_PER_HOUR} the next is stopped, and the owners are told with the business's key, once`, async () => {
    const w = await worldWithRealLimits({ spendUsd: 0, capUsd: 100, otherTenantReplies: TENANT_AI_REPLIES_PER_HOUR - 1 });
    await w.post("wamid.P1", TEXT, 1);
    await w.drain();
    expect(w.report().replies).toHaveLength(1);
    await w.post("wamid.P2", say(2), 30);
    const [stopped] = await w.drain();
    expect(stopped.returned).toMatchObject({ status: "gated_off", reason: "tenant_rate_limit" });
    await w.post("wamid.P3", say(3), 60);
    await w.drain();
    const r = w.report();
    expect(r.replies).toHaveLength(1);
    expect(w.model.calls).toEqual({ extraction: 1, reply: 1 });
    expect(r.ownerAlerts).toHaveLength(2);
    expect(r.ownerAlerts[0].key).toContain("ai_limit:pace:");
  });

  it("the business's pace is the stronger limit: with both reached, it is the one the owners hear about", async () => {
    const w = await worldWithRealLimits({ spendUsd: 0, capUsd: 100, otherTenantReplies: TENANT_AI_REPLIES_PER_HOUR });
    await w.post("wamid.P1", TEXT, 1);
    const [report] = await w.drain();
    expect(report.returned).toMatchObject({ reason: "tenant_rate_limit" });
    expect(w.report().ownerAlerts[0].key).toContain("ai_limit:pace:");
  });
});

describe("the daily AI cap, with the real spend guard around the model", () => {
  /** Each scripted model call costs USD 0.02, so a turn costs 0.04. */
  const COST = 0.02;
  const guarded = (books: Books) => (client: LlmClient) =>
    withSpendGuard(client, {
      overCap: async () => books.spendUsd >= books.capUsd,
      record: async (_tenantId, costUsd) => void (books.spendUsd += costUsd ?? 0),
    });

  it("a turn that ends exactly at the cap finishes; the next message is stopped before any model call; the owners are told once that day; the next day in India it is answered again", async () => {
    const books: Books = { spendUsd: 0, capUsd: 0.04, otherTenantReplies: 0 };
    let now = NOW;
    // eslint-disable-next-line prefer-const -- read by the limit lookup before createWorld returns
    let world!: World;
    const db = limitsDb(() => world, books);
    world = await createWorld({ aiLimitFrom: (t, c) => aiLimitFor(t, c, db), wrapLlm: guarded(books), modelCostUsd: COST, now: () => now });

    await world.post("wamid.D1", TEXT, 1);
    await world.drain();
    expect(world.report().replies).toHaveLength(1);
    expect(books.spendUsd).toBeCloseTo(0.04, 5);
    expect(world.report().ownerAlerts).toHaveLength(0);

    const calls = { ...world.model.calls };
    for (const i of [2, 3]) {
      await world.post(`wamid.D${i}`, say(i), i * 20);
      const [report] = await world.drain();
      expect(report.returned).toMatchObject({ status: "gated_off", reason: "ai_spend_cap" });
    }
    let r = world.report();
    expect(world.model.calls).toEqual(calls);
    expect(books.spendUsd).toBeCloseTo(0.04, 5);
    expect(r.replies).toHaveLength(1);
    expect(r.creditsNet).toBe(1);
    expect(r.ownerAlerts.map((a) => a.userId).sort()).toEqual([OWNER, ADMIN].sort());
    expect(r.ownerAlerts[0].key).toBe(keyFor("ai_spend_cap", NOW, r.ownerAlerts[0].userId, null));

    // the same day, later: still stopped, still told once
    now = hoursLater(5);
    await world.post("wamid.D4", say(4), 100);
    await world.drain();
    expect(world.report().ownerAlerts).toHaveLength(2);

    // the next day in India: the books start again, the assistant answers, and a new stop would tell them again
    now = NEXT_DAY;
    books.spendUsd = 0;
    await world.post("wamid.D5", say(5), 110);
    await world.drain();
    r = world.report();
    expect(r.replies).toHaveLength(2);
    expect(r.creditsNet).toBe(2);
  });

  it("the cap is reached while a turn is running (after the gate, before the reply call): the customer gets exactly one message, the reply model is never called, nothing is retried; the next message is stopped and the owners are told", async () => {
    const books: Books = { spendUsd: 0, capUsd: COST, otherTenantReplies: 0 };
    // eslint-disable-next-line prefer-const -- read by the limit lookup before createWorld returns
    let world!: World;
    const db = limitsDb(() => world, books);
    world = await createWorld({ aiLimitFrom: (t, c) => aiLimitFor(t, c, db), wrapLlm: guarded(books), modelCostUsd: COST, now: () => NOW });

    await world.post("wamid.M1", TEXT, 1);
    const [report] = await world.drain();
    expect(report.status).toBe("completed");
    expect(world.model.calls).toEqual({ extraction: 1, reply: 0 });
    const r = world.report();
    // what the customer got: one message in all, the fixed safe line (as for any model failure), one credit, never two
    expect(r.replies.map((d) => d.text)).toEqual([SAFE_FALLBACK_EN]);
    expect(r.notices).toHaveLength(0);
    expect(r.sendCalls).toBe(1);
    expect(r.creditsNet).toBe(1);
    expect(Object.entries(report.attempts).filter(([, n]) => n > 1)).toEqual([]);
    // the owners are told at the next message that the limit stops, not at the moment the cap is reached
    expect(r.ownerAlerts).toHaveLength(0);

    await world.post("wamid.M2", say(2), 40);
    const [stopped] = await world.drain();
    expect(stopped.returned).toMatchObject({ status: "gated_off", reason: "ai_spend_cap" });
    expect(world.model.calls).toEqual({ extraction: 1, reply: 0 });
    expect(world.report().ownerAlerts).toHaveLength(2);
    expect(world.report().replies).toHaveLength(1);
    expect(world.report().notices).toHaveLength(0);
  });

  it("a business over its cap gets no model call from anything else that uses the model (the lead card is written in plain words, and nothing throws)", async () => {
    const books: Books = { spendUsd: 1, capUsd: 1, otherTenantReplies: 0 };
    const complete = vi.fn();
    const client = withSpendGuard({ complete } as unknown as LlmClient, { overCap: async () => books.spendUsd >= books.capUsd, record: async () => undefined });
    const facts: CardFacts = {
      contact: { name: "Priya", phone: "+919812345621", language: "en" },
      fields: [{ label: "Budget", value: "60L" }],
      score: 75,
      temperature: "hot",
      booking: null,
      trigger: "negotiation",
      priority: "high",
      sentiment: "neutral",
      source: "WhatsApp",
      owner: null,
    };
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    const card = await writeCardWords({ tenantId: TENANT, conversationId: CONV, llm: client, facts, history: [{ sender: "customer", text: "CANARY-WORDS-7QX, 70 lakh ku mudiyuma?" }] });
    expect(complete).not.toHaveBeenCalled();
    expect(card).toMatchObject({ ...codeSummary(facts), suggestedReply: null, discount: null, aiWritten: false });
    expect(logged.join("\n")).toContain("over_budget");
    expect(logged.join("\n")).not.toMatch(/CANARY|lakh|Priya|98123/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// C. KNOWN LIMIT: how many alerts a flood of chats makes

describe("how many alerts a flood of chats makes: the chat limit alerts the owners once per business per hour", () => {
  /** The real tellOwnersAboutLimit and sendAccountNotice with a send that keeps one alert per key, as notify.send does. */
  function alerting() {
    const seen = new Map<string, number>();
    const perPerson = new Map<string, number>();
    const deps: NoticeDeps = {
      recipients: async () => [OWNER, ADMIN],
      send: async (_t, _k, payload) => {
        const key = payload.idempotencyKey ?? "";
        if (!seen.has(key)) {
          seen.set(key, 1);
          perPerson.set(payload.staffUserId ?? "", (perPerson.get(payload.staffUserId ?? "") ?? 0) + 1);
        }
        return { status: "sent", messageId: "m", providerMsgId: "p", creditsCharged: 0, usedTemplate: false } as never;
      },
    };
    const tell = (limit: AiLimit, conversationId: string | null, at: Date) =>
      tellOwnersAboutLimit(TENANT, limit, conversationId, { appUrl: APP_URL, now: () => at, notify: (tenantId, message, keyBase) => sendAccountNotice(tenantId, message, keyBase, { roles: ["owner", "admin"], deps }) });
    return { tell, perPerson };
  }
  const chat = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  it("50 chats that each reach the limit in one hour make one alert for each owner and admin, like the business-wide limits", async () => {
    const { tell, perPerson } = alerting();
    for (let n = 1; n <= 50; n++) await tell("contact_rate_limit", chat(n), NOW);
    expect(perPerson.get(OWNER)).toBe(1);
    expect(perPerson.get(ADMIN)).toBe(1);

    const business = alerting();
    for (let n = 1; n <= 50; n++) {
      await business.tell("tenant_rate_limit", chat(n), NOW);
      await business.tell("ai_spend_cap", chat(n), NOW);
    }
    expect(business.perPerson.get(OWNER)).toBe(2);
  });

  it("KNOWN LIMIT: a chat that stays flooded alerts again every hour, 24 a day for each owner and admin", async () => {
    const { tell, perPerson } = alerting();
    for (let h = 0; h < 24; h++) await tell("contact_rate_limit", CONV, hoursLater(h));
    expect(perPerson.get(OWNER)).toBe(24);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// D. Drift guard: the mirror in the world is the function

describe("the world mirrors the function that tells the owners", () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8").replace(/\s+/g, " ");
  const code = read("../../inngest/process-message.ts");
  const world = read("../../test-support/whole-turn-world.ts");

  it("the function tells owners and admins only, through sendAccountNotice, in a step of its own, after the stop check and only when the contact did not opt out", () => {
    expect(code).toContain('sendAccountNotice(tenantId, message, keyBase, { roles: ["owner", "admin"] })');
    expect(code).toContain('step.run("limit-notice", () => tellOwnersAboutLimit(ids.data.tenantId, limit, ids.data.conversationId, limitNoticeDeps()))');
    const stop = code.indexOf('if (stop.status === "opted_out") console.log(`[pipeline] opted out while gated off');
    const notice = code.indexOf("else if (isAiLimit(turn.reason))");
    expect(stop).toBeGreaterThan(0);
    expect(notice).toBeGreaterThan(stop);
  });

  it("the world does the same: the same roles, the same step, the same condition", () => {
    expect(world).toContain('{ roles: ["owner", "admin"], deps: noticeDeps }');
    expect(world).toContain('stop.status !== "opted_out" && isAiLimit(turn.reason)');
    expect(world).toContain('step.run("limit-notice", () => tellOwnersAboutLimit(ids.data.tenantId, limit, ids.data.conversationId, limitNoticeDeps()))');
  });
});
