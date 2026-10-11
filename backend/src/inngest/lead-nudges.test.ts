import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NudgeState } from "../leads/nudges";
import type { SendOutcome } from "../notify/send";
import { handleLeadNudges, type LeadNudgesDeps } from "./lead-nudges";

const TENANT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const CONVERSATION = "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f601";
const MESSAGE = "8e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b";
const LEAD = "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f";
const event = { data: { tenantId: TENANT, conversationId: CONVERSATION, messageId: MESSAGE } };

const state = (over: Partial<NudgeState> = {}): NudgeState => ({
  messageAt: "2026-10-09T10:00:00.000Z",
  answered: true,
  repliedSince: false,
  mode: "ai",
  lead: { id: LEAD, stage: "engaged" },
  customerName: "Asha",
  ...over,
});
const sent: SendOutcome = { status: "sent", messageId: "m", providerMsgId: "wamid", creditsCharged: 1, usedTemplate: false };

let journal: string[];
let states: (NudgeState | null)[];
const send = vi.fn<LeadNudgesDeps["send"]>();
const nurture = vi.fn<LeadNudgesDeps["nurture"]>();
const step = {
  run: async <T>(id: string, fn: () => Promise<T>) => (journal.push(id), fn()),
  sleepUntil: async (id: string, until: string) => {
    journal.push(`${id}@${until}`);
  },
};
const deps = (over: Partial<LeadNudgesDeps> = {}): LeadNudgesDeps => ({
  timing: async () => ({ offsetMinutes: [120, 1380], nurtureAfterMinutes: 2880 }),
  // Each read takes the next state, the last one repeating: lets a test change the chat between steps.
  state: async () => (states.length > 1 ? states.shift()! : states[0]),
  send,
  nurture,
  ...over,
});

beforeEach(() => {
  journal = [];
  states = [state()];
  send.mockReset().mockResolvedValue(sent);
  nurture.mockReset().mockResolvedValue(true);
});

describe("handleLeadNudges", () => {
  it("nudges a quiet lead at 2 h and 23 h after its message, then moves it to nurture at 48 h", async () => {
    await expect(handleLeadNudges({ event, step }, deps())).resolves.toEqual({
      nudges: [
        { n: 1, status: "sent" },
        { n: 2, status: "sent" },
      ],
      nurture: { moved: true },
    });
    expect(journal).toEqual([
      "plan",
      "wait-nudge-1@2026-10-09T12:00:00.000Z",
      "nudge-1",
      "wait-nudge-2@2026-10-10T09:00:00.000Z",
      "nudge-2",
      "wait-nurture@2026-10-11T10:00:00.000Z",
      "nurture",
    ]);
    expect(send).toHaveBeenNthCalledWith(1, TENANT, "followup_nudge", {
      conversationId: CONVERSATION,
      text: "Hi Asha, just checking in. Do you have any other questions? I'm happy to help.",
      templateParams: ["Asha"],
      idempotencyKey: `followup_nudge:${MESSAGE}:1`,
    });
    expect(send.mock.calls[1][2].idempotencyKey).toBe(`followup_nudge:${MESSAGE}:2`);
    expect(nurture).toHaveBeenCalledWith(TENANT, LEAD);
  });

  it("uses the business's timing (a test can set minutes)", async () => {
    await handleLeadNudges({ event, step }, deps({ timing: async () => ({ offsetMinutes: [2, 5], nurtureAfterMinutes: 10 }) }));
    expect(journal.filter((j) => j.startsWith("wait-"))).toEqual([
      "wait-nudge-1@2026-10-09T10:02:00.000Z",
      "wait-nudge-2@2026-10-09T10:05:00.000Z",
      "wait-nurture@2026-10-09T10:10:00.000Z",
    ]);
  });

  it("stops the moment the customer replies, a person takes the chat, or the lead is booked", async () => {
    for (const later of [state({ repliedSince: true }), state({ mode: "human" }), state({ lead: { id: LEAD, stage: "booked" } })]) {
      states = [state(), state(), later];
      send.mockClear();
      const result = await handleLeadNudges({ event, step }, deps());
      expect(result).toMatchObject({ nudges: [{ n: 1, status: "sent" }, { n: 2, status: "skipped" }] });
      expect(result).not.toHaveProperty("nurture");
      expect(send).toHaveBeenCalledTimes(1);
    }
  });

  it("does not nudge a message the assistant never answered, and stops when notify.send skips", async () => {
    states = [state({ answered: false })];
    await expect(handleLeadNudges({ event, step }, deps())).resolves.toEqual({ nudges: [{ n: 1, status: "skipped", reason: "not_answered" }] });
    states = [state()];
    send.mockResolvedValue({ status: "skipped", reason: "feature_off" });
    await expect(handleLeadNudges({ event, step }, deps())).resolves.toEqual({ nudges: [{ n: 1, status: "skipped", reason: "feature_off" }] });
  });

  it("does not move to nurture a lead that answered after the second nudge", async () => {
    states = [state(), state(), state(), state({ repliedSince: true })];
    await expect(handleLeadNudges({ event, step }, deps())).resolves.toMatchObject({ nurture: { moved: false, reason: "customer_replied" } });
    expect(nurture).not.toHaveBeenCalled();
  });

  it("skips a message that is not this business's, and refuses an event without ids", async () => {
    states = [null];
    await expect(handleLeadNudges({ event, step }, deps())).resolves.toEqual({ skipped: "message_not_found" });
    await expect(handleLeadNudges({ event: { data: { tenantId: TENANT } }, step }, deps())).rejects.toMatchObject({ name: "ZodError" });
  });

  it("retries a retryable failure, but never one WhatsApp may have delivered", async () => {
    send.mockResolvedValueOnce({ status: "failed", error: { code: "rate_limited", message: "", retryable: true, outcomeUnknown: false } });
    await expect(handleLeadNudges({ event, step }, deps())).rejects.toThrow("will retry");
    send.mockReset().mockResolvedValue({ status: "failed", error: { code: "upstream_failed", message: "", retryable: true, outcomeUnknown: true } });
    await expect(handleLeadNudges({ event, step }, deps())).resolves.toEqual({ nudges: [{ n: 1, status: "failed", code: "upstream_failed" }] });
  });
});
