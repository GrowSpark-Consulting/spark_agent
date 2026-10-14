import { NonRetriableError } from "inngest";
import { describe, expect, it, vi } from "vitest";
import { fakePipelineStore, HIDDEN, type FakeLead, type FakeMessage } from "../../test-support/fake-pipeline-store";
import { BATCH_WINDOW_MS, runTurn, type StepRunner, type TurnDeps } from "./process-message";

// The pipeline's first stages: who wrote, their open lead, whether the AI answers, and which messages it
// answers together. `step.run` is a runner that remembers each step's result by id, like Inngest does, so a run
// that is repeated after a step does not repeat what finished.

const A = "e0000000-0000-0000-0000-00000000000a";
const B = "e0000000-0000-0000-0000-00000000000b";
const CONV = "c0000000-0000-0000-0000-00000000000c";
const CONV_B = "c0000000-0000-0000-0000-00000000000d";
const CONTACT = "b0000000-0000-0000-0000-0000000000b1";
const CONTACT_B = "b0000000-0000-0000-0000-0000000000b2";
const M1 = "a0000000-0000-0000-0000-0000000000a1";
const M2 = "a0000000-0000-0000-0000-0000000000a2";
const M3 = "a0000000-0000-0000-0000-0000000000a3";
const MB = "a0000000-0000-0000-0000-0000000000b1";
const T0 = Date.parse("2026-10-08T10:00:00.000Z");
const at = (secondsFromT0: number) => new Date(T0 + secondsFromT0 * 1000).toISOString();

function runner() {
  const memo = new Map<string, unknown>();
  const ran: string[] = [];
  const step: StepRunner = {
    async run(id, fn) {
      if (memo.has(id)) return memo.get(id) as never;
      ran.push(id);
      const value = await fn();
      memo.set(id, value);
      return value;
    },
  };
  return { step, ran, memo };
}

const message = (over: Partial<FakeMessage> = {}): FakeMessage => ({
  id: M1,
  tenantId: A,
  conversationId: CONV,
  direction: "in",
  sender: "customer",
  kind: "text",
  createdAt: at(0),
  ...over,
});

function world(over: { messages?: FakeMessage[]; mode?: "ai" | "human" | "external"; optedOut?: boolean; answered?: string[]; answeredAt?: Record<string, string>; leads?: FakeLead[] } = {}) {
  const fake = fakePipelineStore({
    tenants: [
      { id: A, vertical: "pack-a", verticalVersion: 1 },
      { id: B, vertical: "pack-b", verticalVersion: 1 },
    ],
    conversations: [
      { id: CONV, tenantId: A, contactId: CONTACT, mode: over.mode ?? "ai" },
      { id: CONV_B, tenantId: B, contactId: CONTACT_B, mode: "ai" },
    ],
    contacts: [
      { id: CONTACT, tenantId: A, language: "ta-en", optedOut: over.optedOut ?? false },
      { id: CONTACT_B, tenantId: B, language: null, optedOut: false },
    ],
    messages: over.messages ?? [message(), message({ id: MB, tenantId: B, conversationId: CONV_B })],
    leads: over.leads,
    answered: over.answered,
    answeredAt: over.answeredAt,
  });
  const isEnabled = vi.fn<TurnDeps["isEnabled"]>(async () => true);
  const deps: TurnDeps = { store: fake.store, isEnabled };
  return { ...fake, isEnabled, deps };
}
const event = { tenantId: A, conversationId: CONV, messageId: M1 };

describe("a message the AI should answer", () => {
  it("comes out ready, with the ids and facts the next steps need and nothing else", async () => {
    const w = world();
    const { step, ran } = runner();
    const result = await runTurn(step, event, w.deps);
    expect(result).toEqual({
      status: "ready",
      turn: {
        tenantId: A,
        conversationId: CONV,
        contactId: CONTACT,
        leadId: expect.any(String),
        leadCreated: true,
        messageIds: [M1],
        language: "ta-en",
        vertical: "pack-a",
        verticalVersion: 1,
      },
    });
    expect(ran).toEqual(["resolve", "batch", "lead", "gate"]);
    expect(w.leads.size).toBe(1);
    expect([...w.leads.values()][0]).toMatchObject({ tenantId: A, contactId: CONTACT });
  });

  it("asks isEnabled for ai_auto_reply for this business", async () => {
    const w = world();
    await runTurn(runner().step, event, w.deps);
    expect(w.isEnabled).toHaveBeenCalledWith(A, "ai_auto_reply");
  });
});

describe("messages that arrive together", () => {
  it("are answered together: the customer's unanswered messages from just before this one are in the batch, oldest first", async () => {
    const w = world({ messages: [message({ id: M1, createdAt: at(-4) }), message({ id: M2, createdAt: at(-2) }), message({ id: M3, createdAt: at(0) })] });
    const result = await runTurn(runner().step, { ...event, messageId: M3 }, w.deps);
    expect(result).toMatchObject({ status: "ready", turn: { messageIds: [M1, M2, M3] } });
  });

  it("leave out what was said long before, what has been answered, and what the business or the AI said", async () => {
    const old = "a0000000-0000-0000-0000-0000000000a9";
    const reply = "a0000000-0000-0000-0000-0000000000a8";
    const w = world({
      messages: [
        message({ id: old, createdAt: at(-(BATCH_WINDOW_MS / 1000) - 5) }),
        message({ id: M1, createdAt: at(-6) }),
        message({ id: reply, sender: "ai", direction: "out", createdAt: at(-3) }),
        message({ id: M2, createdAt: at(-2) }),
        message({ id: M3, createdAt: at(0) }),
      ],
      answered: [M1],
    });
    const result = await runTurn(runner().step, { ...event, messageId: M3 }, w.deps);
    expect(result).toMatchObject({ status: "ready", turn: { messageIds: [M2, M3] } });
  });

  it("window is as long as a debounce can run, so a burst the debounce held for 15 seconds is still all answered", () => {
    expect(BATCH_WINDOW_MS).toBe(15_000);
  });

  it("the message that started the run is in the batch even when the newest ten do not include it", async () => {
    const w = world();
    w.store.recentUnanswered = async () => []; // it was not among the newest ten
    const result = await runTurn(runner().step, event, w.deps);
    expect(result).toMatchObject({ status: "ready", turn: { messageIds: [M1] } });
  });

  it("a burst of more than ten is answered from its newest ten", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `a0000000-0000-0000-0000-0000000001${String(i).padStart(2, "0")}`);
    const w = world({ messages: ids.map((id, i) => message({ id, createdAt: at(-12 + i) })) });
    const result = await runTurn(runner().step, { ...event, messageId: ids[11] }, w.deps);
    expect(result).toMatchObject({ status: "ready", turn: { messageIds: ids.slice(2) } });
  });
});

describe("a photo or voice note in the burst", () => {
  it("does not take the text sent just before it with it: the text is answered, the photo waits for staff", async () => {
    const w = world({ messages: [message({ id: M1, kind: "text", createdAt: at(-2) }), message({ id: M2, kind: "image", createdAt: at(0) })] });
    // the debounce kept the LAST event, the photo's
    const result = await runTurn(runner().step, { ...event, messageId: M2 }, w.deps);
    expect(result).toMatchObject({ status: "ready", turn: { messageIds: [M1] } });
  });

  it("answers the texts around it", async () => {
    const w = world({ messages: [message({ id: M1, createdAt: at(-4) }), message({ id: M2, kind: "audio", createdAt: at(-2) }), message({ id: M3, createdAt: at(0) })] });
    // the voice note is answered with the rest: one reply covers the burst
    expect(await runTurn(runner().step, { ...event, messageId: M3 }, w.deps)).toMatchObject({ turn: { messageIds: [M1, M2, M3] } });
  });

  it("is gated off, the lead still made, when nothing in the burst can be read", async () => {
    for (const kind of ["image", "document", "location", "unsupported"]) {
      const w = world({ messages: [message({ kind })] });
      expect(await runTurn(runner().step, event, w.deps)).toEqual({ status: "gated_off", reason: "unsupported_kind", leadId: expect.any(String) });
      expect(w.leads.size).toBe(1);
    }
  });

  it("a voice note on its own is answered: the burst is ready, with the voice note in it", async () => {
    const w = world({ messages: [message({ id: M1, kind: "audio", createdAt: at(0) })] });
    expect(await runTurn(runner().step, { ...event, messageId: M1 }, w.deps)).toMatchObject({ status: "ready", turn: { messageIds: [M1] } });
  });

  it("lets a tapped list or button reply through", async () => {
    const w = world({ messages: [message({ kind: "interactive" })] });
    expect((await runTurn(runner().step, event, w.deps)).status).toBe("ready");
  });
});

describe("an old or repeated event", () => {
  it("does not hide newer messages: if the event's own message was answered, the unanswered ones after it are still handled", async () => {
    const w = world({ messages: [message({ id: M1, createdAt: at(-10) }), message({ id: M2, createdAt: at(-5) }), message({ id: M3, createdAt: at(-3) })], answered: [M1] });
    // the debounce kept a repeated event for the message that was already answered
    const result = await runTurn(runner().step, { ...event, messageId: M1 }, w.deps);
    expect(result).toMatchObject({ status: "ready", turn: { messageIds: [M2, M3] } });
  });

  it("does nothing when everything in the window has been answered", async () => {
    const w = world({ messages: [message({ id: M1, createdAt: at(-3) }), message({ id: M2, createdAt: at(0) })], answered: [M1, M2] });
    expect(await runTurn(runner().step, { ...event, messageId: M2 }, w.deps)).toEqual({ status: "skipped", reason: "already_answered" });
    expect(w.leads.size).toBe(0);
  });

  it("finds an answered row even when Meta's clock runs a long way ahead of ours", async () => {
    // the message is stamped 5 hours ahead; our audit row, written when we replied, is 5 hours earlier than that
    const w = world({ messages: [message({ id: M1, createdAt: at(5 * 3600) })], answered: [M1], answeredAt: { [M1]: at(0) } });
    expect(await runTurn(runner().step, event, w.deps)).toEqual({ status: "skipped", reason: "already_answered" });
  });

  it("does not hide a message behind an answered row that is more than a day older: that is a different message's row, not an answer", async () => {
    const w = world({ messages: [message({ id: M1, createdAt: at(3 * 86_400) })], answered: [M1], answeredAt: { [M1]: at(0) } });
    expect((await runTurn(runner().step, event, w.deps)).status).toBe("ready");
  });
});

describe("running it again", () => {
  it("does not repeat a step that finished when the run is resumed", async () => {
    const w = world();
    const r = runner();
    await runTurn(r.step, event, w.deps);
    const callsAfterFirst = w.calls.length;
    await runTurn(r.step, event, w.deps);
    expect(w.calls.length).toBe(callsAfterFirst);
    expect(w.leads.size).toBe(1);
  });

  it("a new run for the same message (the event sent again) finds the lead the first run made, and makes no second one", async () => {
    const w = world();
    const first = await runTurn(runner().step, event, w.deps);
    const second = await runTurn(runner().step, event, w.deps);
    expect(w.leads.size).toBe(1);
    expect(first.status === "ready" && second.status === "ready" && first.turn.leadId === second.turn.leadId).toBe(true);
    expect(second.status === "ready" && second.turn.leadCreated).toBe(false);
  });

  it("resumes after a step failed, without redoing the steps before it", async () => {
    const w = world();
    const r = runner();
    w.state.failNext.add("findOrCreateOpenLead");
    await expect(runTurn(r.step, event, w.deps)).rejects.toThrow(/simulated/);
    expect(r.ran).toEqual(["resolve", "batch", "lead"]);
    const result = await runTurn(r.step, event, w.deps); // the same memory: resolve and batch are not run again
    expect(result.status).toBe("ready");
    expect(w.calls.filter((c) => c === "getTenant")).toHaveLength(1);
    expect(w.leads.size).toBe(1);
  });
});

describe("what it skips (no lead is made, nothing changes)", () => {
  const skipped = async (w: ReturnType<typeof world>, e = event) => {
    const result = await runTurn(runner().step, e, w.deps);
    expect(w.leads.size).toBe(0);
    expect(w.isEnabled).not.toHaveBeenCalled();
    return result;
  };

  it("a message that does not exist", async () => {
    expect(await skipped(world(), { ...event, messageId: "a0000000-0000-0000-0000-0000000000ff" })).toEqual({ status: "skipped", reason: "message_not_found" });
  });

  it("another business's message, named with this business's id: the event cannot reach into another tenant", async () => {
    const w = world();
    expect(await skipped(w, { tenantId: A, conversationId: CONV_B, messageId: MB })).toEqual({ status: "skipped", reason: "message_not_found" });
    expect(await skipped(w, { tenantId: B, conversationId: CONV, messageId: M1 })).toEqual({ status: "skipped", reason: "message_not_found" });
  });

  it("a message named with the wrong conversation", async () => {
    expect(await skipped(world(), { ...event, conversationId: CONV_B })).toEqual({ status: "skipped", reason: "message_not_found" });
  });

  it.each([
    ["an outgoing message", { direction: "out" as const, sender: "ai" as const }],
    ["a message from staff", { direction: "in" as const, sender: "staff" as const }],
    ["a system note", { direction: "in" as const, sender: "system" as const }],
  ])("%s: only a customer's message starts a turn", async (_name, over) => {
    expect(await skipped(world({ messages: [message(over)] }))).toEqual({ status: "skipped", reason: "not_customer_message" });
  });

  it("a message that has already been answered, however many times the event arrives", async () => {
    const w = world({ answered: [M1] });
    expect(await skipped(w)).toEqual({ status: "skipped", reason: "already_answered" });
    expect(await skipped(w)).toEqual({ status: "skipped", reason: "already_answered" });
  });

  it("a conversation, contact or business that is missing, without throwing", async () => {
    const noConversation = world();
    noConversation.conversations.delete(CONV);
    expect(await skipped(noConversation)).toEqual({ status: "skipped", reason: "conversation_not_found" });
    const noContact = world();
    noContact.contacts.delete(CONTACT);
    expect(await skipped(noContact)).toEqual({ status: "skipped", reason: "contact_not_found" });
    const noTenant = world();
    noTenant.tenants.delete(A);
    expect(await skipped(noTenant)).toEqual({ status: "skipped", reason: "tenant_not_found" });
  });

  it("an event that is not valid, without touching the store", async () => {
    const w = world();
    for (const bad of [{ tenantId: "x", conversationId: CONV, messageId: M1 }, { tenantId: A, conversationId: CONV }, null, "text"]) {
      const error = await runTurn(runner().step, bad, w.deps).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(NonRetriableError);
    }
    expect(w.calls).toEqual([]);
  });
});

describe("the gate", () => {
  it("turns away a chat a person has: the message stays in the inbox, the lead is made, nothing else runs, and isEnabled is not even asked", async () => {
    for (const mode of ["human", "external"] as const) {
      const w = world({ mode });
      const r = runner();
      const result = await runTurn(r.step, event, w.deps);
      expect(result).toEqual({ status: "gated_off", reason: "not_ai_mode", leadId: expect.any(String) });
      expect(w.leads.size).toBe(1);
      expect(r.ran).toEqual(["resolve", "batch", "lead", "gate"]);
      expect(w.isEnabled).not.toHaveBeenCalled();
    }
  });

  it("turns away a customer who opted out, without even asking whether the feature is on", async () => {
    const w = world({ optedOut: true });
    expect(await runTurn(runner().step, event, w.deps)).toMatchObject({ status: "gated_off", reason: "opted_out" });
    expect(w.isEnabled).not.toHaveBeenCalled();
  });

  it("turns away a business that has ai_auto_reply off", async () => {
    const w = world();
    w.isEnabled.mockResolvedValue(false);
    expect(await runTurn(runner().step, event, w.deps)).toMatchObject({ status: "gated_off", reason: "feature_off" });
    expect(w.leads.size).toBe(1);
  });

  it("turns away a chat that reached a rate limit or the spend cap, before any model is called, and still makes the lead", async () => {
    const w = world();
    const aiLimit = vi.fn<NonNullable<TurnDeps["aiLimit"]>>(async () => "contact_rate_limit");
    const r = runner();
    expect(await runTurn(r.step, event, { ...w.deps, aiLimit })).toEqual({ status: "gated_off", reason: "contact_rate_limit", leadId: expect.any(String) });
    expect(aiLimit).toHaveBeenCalledWith(A, CONV);
    expect(r.ran).toEqual(["resolve", "batch", "lead", "gate"]);
    expect(w.leads.size).toBe(1);
  });

  it("asks about the limits only when the AI would otherwise answer, and lets the chat through under them", async () => {
    const aiLimit = vi.fn<NonNullable<TurnDeps["aiLimit"]>>(async () => null);
    const off = world();
    off.isEnabled.mockResolvedValue(false);
    await runTurn(runner().step, event, { ...off.deps, aiLimit });
    await runTurn(runner().step, event, { ...world({ mode: "human" }).deps, aiLimit });
    expect(aiLimit).not.toHaveBeenCalled();
    expect(await runTurn(runner().step, event, { ...world().deps, aiLimit })).toMatchObject({ status: "ready" });
  });

  it("does not hide a failure to read the limits: the step fails and is retried", async () => {
    const aiLimit = vi.fn<NonNullable<TurnDeps["aiLimit"]>>(async () => {
      throw new Error("ai_limits failed: db down");
    });
    await expect(runTurn(runner().step, event, { ...world().deps, aiLimit })).rejects.toThrow(/db down/);
  });

  it("does not hide a failure to find out whether the feature is on: the step fails and is retried", async () => {
    const w = world();
    w.isEnabled.mockRejectedValue(new Error("db down"));
    await expect(runTurn(runner().step, event, w.deps)).rejects.toThrow(/db down/);
  });
});

describe("one open lead per contact", () => {
  const lead = (id: string, stage: string, createdAt: number) => ({ id, tenantId: A, contactId: CONTACT, stage, createdAt });

  it.each(["new", "engaged", "qualified", "booked", "visited", "nurture", "human"])("reuses a lead at stage %s", async (stage) => {
    const w = world({ leads: [lead("10000000-0000-0000-0000-00000000000f", stage, 1)] });
    const result = await runTurn(runner().step, event, w.deps);
    expect(result).toMatchObject({ status: "ready", turn: { leadId: "10000000-0000-0000-0000-00000000000f", leadCreated: false } });
    expect(w.leads.size).toBe(1);
  });

  it.each(["won", "lost"])("starts a new lead when the only one is %s", async (stage) => {
    const w = world({ leads: [lead("10000000-0000-0000-0000-00000000000f", stage, 1)] });
    const result = await runTurn(runner().step, event, w.deps);
    expect(result).toMatchObject({ status: "ready", turn: { leadCreated: true } });
    expect(w.leads.size).toBe(2);
  });

  it("uses the oldest when there are several open ones", async () => {
    const w = world({ leads: [lead("10000000-0000-0000-0000-0000000000f2", "engaged", 20), lead("10000000-0000-0000-0000-0000000000f1", "new", 10)] });
    expect(await runTurn(runner().step, event, w.deps)).toMatchObject({ turn: { leadId: "10000000-0000-0000-0000-0000000000f1" } });
  });

  it("never uses another business's lead for the same contact id", async () => {
    const w = world({ leads: [{ id: "10000000-0000-0000-0000-0000000000f9", tenantId: B, contactId: CONTACT, stage: "new", createdAt: 1 }] });
    const result = await runTurn(runner().step, event, w.deps);
    expect(result).toMatchObject({ turn: { leadCreated: true } });
    expect([...w.leads.values()].filter((l) => l.tenantId === A)).toHaveLength(1);
  });
});

describe("what the steps remember", () => {
  it("is ids, flags and small facts only: the store's rows carry a message text, a phone number and names, and none of them is kept (Inngest keeps every step's result)", async () => {
    const w = world();
    const r = runner();
    await runTurn(r.step, event, w.deps);
    const remembered = JSON.stringify([...r.memo.values()]);
    expect(Object.values(HIDDEN).concat("Hidden Business Name").filter((secret) => remembered.includes(secret))).toEqual([]);
    expect(remembered).not.toMatch(/"(phone|body|text|name|media)":/i);
    expect(remembered).toContain(CONTACT);
  });

  it("also for the batch of a burst and for a gated-off turn", async () => {
    const w = world({ mode: "human", messages: [message({ id: M1, createdAt: at(-2) }), message({ id: M2, createdAt: at(0) })] });
    const r = runner();
    await runTurn(r.step, { ...event, messageId: M2 }, w.deps);
    const remembered = JSON.stringify([...r.memo.values()]);
    expect(Object.values(HIDDEN).filter((secret) => remembered.includes(secret))).toEqual([]);
  });
});
