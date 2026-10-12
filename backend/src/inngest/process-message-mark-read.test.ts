import { beforeEach, describe, expect, it, vi } from "vitest";

// Where the blue ticks sit in the pipeline: right after the gate lets the message through, before anything else is done with it, and never when
// the assistant stays out of the chat. What the step itself does is tested in channels/whatsapp/mark-read.test.ts.

const calls = vi.hoisted(() => [] as string[]);
const turn = { tenantId: "e0000000-0000-4000-8000-00000000000a", conversationId: "c0000000-0000-4000-8000-0000000000c1", messageIds: ["a0000000-0000-4000-8000-0000000000a1"], leadId: "l", contactId: "k", leadCreated: false, language: null, vertical: "real-estate", verticalVersion: 1 };
const runTurn = vi.hoisted(() => vi.fn());
const markReadStep = vi.hoisted(() => vi.fn(async () => ({ status: "marked" })));

vi.mock("../agent/pipeline/process-message", () => ({ runTurn }));
vi.mock("../channels/whatsapp/mark-read", () => ({
  markReadStep: (...args: unknown[]) => {
    calls.push("mark-read");
    return markReadStep(...(args as []));
  },
}));
vi.mock("../agent/pipeline/stop", () => ({
  stopCheck: async () => (calls.push("stop"), { status: "continue" }),
  stopCheckAfterGate: async () => (calls.push("stop-after-gate"), { status: "continue" }),
}));
vi.mock("../agent/pipeline/understand", () => ({ understandTurn: async () => (calls.push("understand"), { status: "fallback", reason: "model_unavailable" }) }));
vi.mock("../agent/pipeline/reply", () => ({ replyTurn: async () => (calls.push("reply"), { case: "fallback", reply: { status: "sent" }, handoff: null }) }));
vi.mock("../agent/pipeline/runtime", () => ({ replyDeps: () => ({}), understandDeps: () => ({}) }));
vi.mock("../agent/pipeline/store", () => ({ createPipelineStore: () => ({}) }));
vi.mock("../agent/handoff/external-notice", () => ({ tellCustomerTeamIsHandling: async () => (calls.push("external-notice"), { status: "told" }) }));
vi.mock("../agent/pipeline/give-up", () => ({ answerRunThatGaveUp: async () => "nothing_to_do" }));
vi.mock("../features/is-enabled", () => ({ isEnabled: async () => true }));

const { processMessage } = await import("./process-message");
const handler = (processMessage as unknown as { fn: (ctx: unknown) => Promise<unknown> }).fn;
const run = () => handler({ event: { data: { tenantId: turn.tenantId, conversationId: turn.conversationId, messageId: turn.messageIds[0] } }, step: { run: async (_id: string, fn: () => Promise<unknown>) => fn() } });

beforeEach(() => {
  calls.length = 0;
  markReadStep.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("process-message and the blue ticks", () => {
  it("marks the message read as soon as the gate is open, before STOP, understanding and the reply", async () => {
    runTurn.mockResolvedValue({ status: "ready", turn });
    await run();
    expect(calls).toEqual(["mark-read", "stop", "understand", "reply"]);
    expect(markReadStep).toHaveBeenCalledOnce();
    const [, passedTurn, startedAt] = markReadStep.mock.calls[0] as unknown as [unknown, typeof turn, number];
    expect(passedTurn).toMatchObject({ tenantId: turn.tenantId, conversationId: turn.conversationId, messageIds: turn.messageIds });
    expect(typeof startedAt).toBe("number");
  });

  it("does not mark anything when the assistant stays out of the chat (a person has it, the AI is off, an opt-out)", async () => {
    for (const reason of ["not_ai_mode", "feature_off", "opted_out"]) {
      calls.length = 0;
      runTurn.mockResolvedValue({ status: "gated_off", reason, leadId: "l" });
      await run();
      expect(calls).not.toContain("mark-read");
    }
  });

  it("does not mark anything for a message that is skipped (already answered, not found)", async () => {
    runTurn.mockResolvedValue({ status: "skipped", reason: "already_answered" });
    await run();
    expect(calls).not.toContain("mark-read");
  });
});
