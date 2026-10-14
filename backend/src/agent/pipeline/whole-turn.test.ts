import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorld, type Injection, type World, type WorldOptions } from "../../test-support/whole-turn-world";

// WHAT IS AND IS NOT PROVED. Proved: what OUR code (webhook handler, gate, STOP check, understanding, plan, reply, handover, failure handler) does with
// each outcome notify.send can return, under replay and retry. NOT proved, because they are fakes or left out: notify.send itself (the fake is more
// forgiving in the ways listed at the top of test-support/whole-turn-world.ts), "balance never negative" (the fake refuses a spend below 1 itself; what
// is shown is that credits spent minus refunded is 0 or 1), the real database and its SQL idempotency, real Inngest timing (debounce, concurrency),
// the 25-second hard stop, mid-run arrival of another message, booking and the "act" steps, the "external-notice" step, the area reminder, and the
// real read receipt. The mirror below stands in for inngest/process-message.ts.
//
// Day 7, PR A: the whole turn, with failures injected. One customer message goes in through the REAL inbound webhook handler, becomes an event, and runs
// through the pipeline in the order of inngest/process-message.ts on an emulator that behaves like Inngest (test-support/whole-turn-world.ts). The language
// model is scripted, the database is the in-memory pipeline store, and notify.send is a FAKE (FakeNotify): this proves what OUR code does with the
// outcomes notify.send can give, not how Dev 2's notify.send behaves.
//
// The invariant, per TURN (a batch of messages answered together):
//   1. The customer receives AT MOST ONE AI reply per turn, and exactly one unless the case below says why not (silence is pinned, never assumed).
//   2. At most one outbound reply row is recorded.
//   3. Credits spent minus credits refunded is 1 when a reply was recorded as sent and 0 otherwise, never above 1 and never negative (an unknown outcome
//      refunds, by contracts decision 16: the customer may then have a message that was not charged).
//   4. Every inbound message of the turn ends answered, or is deliberately left for staff.
//   5. Two separate turns give one reply each.

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const TEXT = { text: "What is the price of a 2BHK?" };

async function oneMessage(options: WorldOptions = {}, run: { inject?: Injection[] } = {}): Promise<{ w: World; reports: Awaited<ReturnType<World["drain"]>> }> {
  const w = await createWorld(options);
  expect((await w.post("wamid.A1", TEXT)).status).toBe(200);
  return { w, reports: await w.drain(run) };
}

// Day 7 (Dev 2, lib/ai-limits.ts): exit test 4, "hitting the per-contact rate limit or a tenant's daily LLM cap stops further AI calls". The owners'
// notice is the "limit-notice" step, left out of the mirror (it has its own tests).
describe("a chat over a rate limit or the daily AI spend cap", () => {
  it.each(["contact_rate_limit", "tenant_rate_limit", "ai_spend_cap"] as const)("%s: no model call, no reply, no credit; the message waits for staff", async (aiLimit) => {
    const { w, reports } = await oneMessage({ aiLimit });
    expect(reports[0]).toMatchObject({ status: "completed", returned: { status: "gated_off", reason: aiLimit } });
    expect(w.model.calls).toEqual({ extraction: 0, reply: 0 });
    const r = w.report();
    expect(r.replies).toHaveLength(0);
    expect(r.creditsNet).toBe(0);
    expect(r.answered).toEqual([]);
  });

  it("still honours STOP", async () => {
    const w = await createWorld({ aiLimit: "ai_spend_cap" });
    expect((await w.post("wamid.S1", { text: "STOP" })).status).toBe(200);
    await w.drain();
    expect(w.report().notices).toHaveLength(1);
    expect(w.fake.contacts.values().next().value?.optedOut).toBe(true);
  });
});

describe("a clean turn, through the real webhook and the emulator", () => {
  it("one message in, one reply out, one row, one credit, the message answered", async () => {
    const { w, reports } = await oneMessage();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ status: "completed", returned: { status: "understood", reply: "sent" } });
    const r = w.report();
    expect(r.replies).toHaveLength(1);
    expect(r.replies[0].text).toContain("₹78 lakh");
    expect(r.replyRows).toBe(1);
    expect(r.creditsNet).toBe(1);
    expect(r.answered).toEqual(r.inbound);
    expect(w.model.calls).toEqual({ extraction: 1, reply: 1 });
  });

  it("ran exactly these steps, each once (a step added or removed in the pipeline shows up here)", async () => {
    const { reports } = await oneMessage();
    expect(reports[0].steps).toEqual(["started", "resolve", "batch", "lead", "gate", "stop-check", "mark-read", "extract", "save-fields", "qualify", "retrieve", "plan", "reply"]);
    for (const attempts of Object.values(reports[0].attempts)) expect(attempts).toBe(1);
  });
});

describe("the mirror of inngest/process-message.ts (drift guard)", () => {
  // The emulator cannot call the real function body (it needs Inngest and the real database), so test-support/whole-turn-world.ts repeats its
  // order of work. If the real function changes, this fails until the mirror is updated.
  const source = readFileSync(fileURLToPath(new URL("../../inngest/process-message.ts", import.meta.url)), "utf8");
  const code = source.replace(/\/\/.*$/gm, "");
  const calls = ['steps.run("started"', "runTurn(", "stopCheckAfterGate(", "stopCheck(", "understandTurn(", "markReadStep(", "replyTurn("];

  it("calls the same pieces, in the same order", () => {
    const positions = calls.map((c) => code.indexOf(c));
    expect(positions.every((p) => p >= 0), `every call is still there: ${calls.filter((_, i) => positions[i] < 0).join(", ")}`).toBe(true);
    // stopCheckAfterGate sits in the gated-off branch, before the plain stopCheck of a ready turn
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("has no other step of its own than 'started', 'external-notice' and 'limit-notice' (a new step would be missing from the mirror)", () => {
    const own = [...code.matchAll(/\b(?:steps|step)\.run(?:<[^>]*>)?\(\s*"([a-z-]+)"/g)].map((m) => m[1]);
    expect(own.sort()).toEqual(["external-notice", "limit-notice", "started"]);
  });

  it("still retries a failing step 3 times and runs the failure handler", () => {
    expect(code).toMatch(/retries:\s*3\b/);
    expect(code).toMatch(/onFailure:/);
    expect(code).toMatch(/answerRunThatGaveUp\(/);
  });

  it("still runs the understanding and the read receipt together, and the gated-off branch for a chat a person has, the feature off or a limit", () => {
    const flat = code.replace(/\s+/g, " ");
    expect(flat).toContain("Promise.all([understandTurn(");
    expect(flat.indexOf("markReadStep(")).toBeGreaterThan(flat.indexOf("Promise.all([understandTurn("));
    expect(flat).toContain('turn.status === "gated_off" && (turn.reason === "not_ai_mode" || turn.reason === "feature_off" || isAiLimit(turn.reason))');
    expect(flat).toContain('turn.status !== "ready"');
    expect(flat).toContain('stop.status === "opted_out"');
  });

  it("still asks the rate limits and the daily AI spend cap in the gate, before any model call, and tells the owners (Day 7: the world's `aiLimit` mirrors it; whole-turn-limit.test.ts)", () => {
    const flat = code.replace(/\s+/g, " ");
    expect(flat).toContain("aiLimit: (tenantId, conversationId) => aiLimitFor(tenantId, conversationId)");
    expect(flat).toContain("tellOwnersAboutLimit(");
    expect(flat).toContain('steps.run("started"');
    const world = readFileSync(fileURLToPath(new URL("../../test-support/whole-turn-world.ts", import.meta.url)), "utf8").replace(/\s+/g, " ");
    expect(world).toContain("aiLimit: async (tenantId, conversationId) => (options.aiLimitFrom ? options.aiLimitFrom(tenantId, conversationId) : (options.aiLimit ?? null))");
    const gate = readFileSync(fileURLToPath(new URL("./process-message.ts", import.meta.url)), "utf8").replace(/\s+/g, " ");
    // the limit is only asked when the assistant would answer: not for an opted-out contact, a chat a person has, or the feature off
    expect(gate).toContain("needsFeature && featureEnabled && deps.aiLimit");
  });

  it("still runs one conversation at a time", () => {
    expect(code).toMatch(/concurrency:\s*\{\s*key:\s*"event\.data\.conversationId",\s*limit:\s*1\s*\}/);
  });
});
