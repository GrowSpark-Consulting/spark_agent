import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_LIMITS } from "../../lib/ai-limits";
import { createWorld, type Injection, type WorldOptions } from "../../test-support/whole-turn-world";

// Day 7 exit test 4, on the whole turn: "hitting the per-contact rate limit or a tenant's daily LLM cap stops further AI calls". inngest/process-message.ts now asks
// `aiLimit` (lib/ai-limits.ts aiLimitFor) in the gate, before any model call; the world of test-support/whole-turn-world.ts has the same hook (`aiLimit`). What is proved here, through
// the real webhook handler and the emulator: with a limit reached the model is never called, no AI reply goes out, no credit is spent, the message waits for staff (it is not
// answered), STOP is still honoured (one confirmation), nothing changes under a replayed event or webhook or an injected step failure, and when the limit clears the next
// message is answered once. NOT proved: the "limit-notice" step that tells the owners (it needs the database; lib/ai-limits.test.ts and the process-message tests have it), the real
// `ai_limits` function, and the model client's own spend guard.

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const TEXT = { text: "What is the price of a 2BHK?" };
const CONTACT = "b0000000-0000-4000-8000-0000000000b1";

const expectUntouched = (w: Awaited<ReturnType<typeof createWorld>>) => {
  const r = w.report();
  expect(r.replies).toHaveLength(0);
  expect(r.replyRows).toBe(0);
  expect(r.creditsNet).toBe(0);
  expect(r.sendCalls).toBe(0);
  expect(r.handoffs).toBe(0);
  expect(w.model.calls).toEqual({ extraction: 0, reply: 0 });
};

describe.each(AI_LIMITS)("with the limit %s reached", (limit) => {
  it("the model is never asked, nothing is sent, nothing is charged, and the message waits for staff", async () => {
    const w = await createWorld({ aiLimit: limit });
    await w.post("wamid.L1", TEXT);
    const reports = await w.drain();
    expect(reports[0]).toMatchObject({ status: "completed", returned: { status: "gated_off", reason: limit } });
    expectUntouched(w);
    expect(w.report().answered).toHaveLength(0);
    expect(w.report().inbound).toHaveLength(1);
    expect(w.report().notices).toHaveLength(0);
  });

  it("the steps are only the ones before the gate, and the stop check: no read receipt, no understanding, no reply", async () => {
    const w = await createWorld({ aiLimit: limit });
    await w.post("wamid.L1", TEXT);
    const [report] = await w.drain();
    expect(report.steps).toEqual(["started", "resolve", "batch", "lead", "gate", "stop-check-gated"]);
  });

  it("a replayed event and a replayed webhook change nothing", async () => {
    const w = await createWorld({ aiLimit: limit, dedupeEvents: false });
    await w.post("wamid.L1", TEXT);
    await w.post("wamid.L1", TEXT);
    await w.drain();
    await w.post("wamid.L1", TEXT);
    await w.drain();
    expectUntouched(w);
    expect(w.report().inbound).toHaveLength(1);
  });

  it("STOP is still honoured: the contact is opted out and gets ONE confirmation, however often it comes, and no AI reply", async () => {
    const w = await createWorld({ aiLimit: limit, dedupeEvents: false });
    await w.post("wamid.S1", { text: "STOP" });
    await w.post("wamid.S1", { text: "STOP" });
    await w.drain();
    await w.post("wamid.S1", { text: "STOP" });
    await w.drain();
    const r = w.report();
    expect(r.replies).toHaveLength(0);
    expect(r.notices).toHaveLength(1);
    expect(w.fake.contacts.get(CONTACT)?.optedOut).toBe(true);
    expect(w.model.calls).toEqual({ extraction: 0, reply: 0 });
  });

  it("a step that fails once, before or after it runs, at every step of the limited turn: still no reply, no charge, no model call", async () => {
    const stepIds = ["started", "resolve", "batch", "lead", "gate", "stop-check-gated"];
    for (const stepId of stepIds) {
      for (const when of ["before", "after"] as const) {
        const w = await createWorld({ aiLimit: limit });
        await w.post("wamid.F1", TEXT);
        const inject: Injection[] = [{ stepId, when }];
        await w.drain({ inject });
        expectUntouched(w);
      }
    }
  });
});

describe("the limit is only asked when the assistant would answer, and only then decides", () => {
  /** Options whose `aiLimit` counts how often the world's gate asks for it (the world reads `options.aiLimit` only when the limit lookup is made). */
  function counting(limit: WorldOptions["aiLimit"], rest: WorldOptions = {}): { options: WorldOptions; asked: () => number } {
    let reads = 0;
    const options: WorldOptions = { ...rest };
    Object.defineProperty(options, "aiLimit", { get: () => (reads++, limit), enumerable: true });
    return { options, asked: () => reads };
  }

  it("a chat a person has: the limit is not the reason (not_ai_mode), and the limit is never looked up", async () => {
    const { options, asked } = counting("contact_rate_limit", { mode: "human" });
    const w = await createWorld(options);
    await w.post("wamid.H1", TEXT);
    const [report] = await w.drain();
    expect(report.returned).toMatchObject({ status: "gated_off", reason: "not_ai_mode" });
    expect(asked()).toBe(0);
    expectUntouched(w);
  });

  it("the assistant switched off: the reason is feature_off, whatever the limit, and the limit is never looked up", async () => {
    const { options, asked } = counting("ai_spend_cap", { featureEnabled: false });
    const w = await createWorld(options);
    await w.post("wamid.H1", TEXT);
    const [report] = await w.drain();
    expect(report.returned).toMatchObject({ status: "gated_off", reason: "feature_off" });
    expect(asked()).toBe(0);
    expectUntouched(w);
  });

  it("an opted-out contact: opted_out, not the limit, and the limit is never looked up", async () => {
    const { options, asked } = counting("contact_rate_limit", { optedOut: true });
    const w = await createWorld(options);
    await w.post("wamid.H1", TEXT);
    const [report] = await w.drain();
    expect(report.returned).toMatchObject({ status: "gated_off", reason: "opted_out" });
    expect(asked()).toBe(0);
    expectUntouched(w);
  });

  it("a chat the assistant would answer: the limit is looked up (once for the turn)", async () => {
    const { options, asked } = counting(null);
    const w = await createWorld(options);
    await w.post("wamid.H1", TEXT);
    await w.drain();
    expect(asked()).toBe(1);
    expect(w.report().replies).toHaveLength(1);
  });
});

describe("when the limit clears", () => {
  it("the next message is answered once (one reply, one credit), and the earlier one, left for staff, is not answered behind the customer's back", async () => {
    const options: WorldOptions = { aiLimit: "contact_rate_limit" };
    const w = await createWorld(options);
    await w.post("wamid.C1", TEXT, 0);
    await w.drain();
    expectUntouched(w);

    options.aiLimit = null;
    await w.post("wamid.C2", { text: "And what about a 3BHK?" }, 60);
    await w.drain();
    const r = w.report();
    expect(r.replies).toHaveLength(1);
    expect(r.replyRows).toBe(1);
    expect(r.creditsNet).toBe(1);
    expect(w.model.calls).toEqual({ extraction: 1, reply: 1 });
  });

  it("a limit that comes back after a reply stops the next message again, and the credits stay at one", async () => {
    const options: WorldOptions = { aiLimit: null };
    const w = await createWorld(options);
    await w.post("wamid.C1", TEXT, 0);
    await w.drain();
    expect(w.report().replies).toHaveLength(1);

    options.aiLimit = "tenant_rate_limit";
    await w.post("wamid.C2", { text: "Is parking free?" }, 60);
    await w.drain();
    const r = w.report();
    expect(r.replies).toHaveLength(1);
    expect(r.creditsNet).toBe(1);
    expect(w.model.calls).toEqual({ extraction: 1, reply: 1 });
  });
});
