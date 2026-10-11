import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnNumberHandoff } from "../leads/own-number-outcome";
import type { SendOutcome } from "../notify/send";
import { handleOwnNumberOutcome, type OwnNumberOutcomeDeps } from "./own-number-outcome";

const TENANT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const HANDOFF = "4a2b1b4c-5d6e-4f70-8a91-b2c3d4e5f602";
const CONVERSATION = "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f601";
const STAFF = "16fd2706-8baf-433b-82eb-8c7fada847da";
const event = { data: { tenantId: TENANT, handoffId: HANDOFF } };
const QUESTION = "How did your WhatsApp chat with Asha go? Update the lead.";
const LINK = `https://app.test/dashboard/inbox?conversation=${CONVERSATION}`;
const sent: SendOutcome = { status: "sent", messageId: "m", providerMsgId: "wamid", creditsCharged: 0, usedTemplate: false };

let handoff: OwnNumberHandoff | null;
const journal: string[] = [];
const send = vi.fn<OwnNumberOutcomeDeps["send"]>();
const step = {
  run: async <T>(id: string, fn: () => Promise<T>) => (journal.push(id), fn()),
  sleep: async (id: string, duration: string) => {
    journal.push(`${id}:${duration}`);
  },
};
const deps = (): OwnNumberOutcomeDeps => ({
  delay: async () => 240,
  handoff: async () => handoff,
  content: async () => ({ headline: QUESTION, link: LINK }),
  send,
});

beforeEach(() => {
  journal.length = 0;
  handoff = { conversationId: CONVERSATION, staffUserId: STAFF, outcome: null };
  send.mockReset().mockResolvedValue(sent);
});

describe("handleOwnNumberOutcome", () => {
  it("asks the staff member after 4 hours, with Booked / Follow-up / Lost buttons and the link as the fallback", async () => {
    await expect(handleOwnNumberOutcome({ event, step }, deps())).resolves.toEqual({ minutes: 240, ask: { status: "sent" } });
    expect(journal).toEqual(["delay", "wait-outcome:240m", "ask"]);
    expect(send).toHaveBeenCalledWith(TENANT, "staff_alert", {
      staffUserId: STAFF,
      interactive: expect.objectContaining({ type: "buttons", body: QUESTION, buttons: expect.arrayContaining([{ id: `outcome:${HANDOFF}:booked`, title: "Booked" }]) }),
      text: `${QUESTION}\n${LINK}`,
      templateParams: [QUESTION, LINK],
      idempotencyKey: `own_number_outcome:${HANDOFF}`,
    });
  });

  it("does not ask about a handoff that has an answer, has no staff member, or is gone", async () => {
    for (const [now, reason] of [
      [{ conversationId: CONVERSATION, staffUserId: STAFF, outcome: "booked" }, "already_answered"],
      [{ conversationId: CONVERSATION, staffUserId: null, outcome: null }, "no_staff_member"],
      [null, "handoff_not_found"],
    ] as const) {
      handoff = now;
      await expect(handleOwnNumberOutcome({ event, step }, deps())).resolves.toMatchObject({ ask: { status: "skipped", reason } });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("retries a retryable failure, but never one WhatsApp may have delivered", async () => {
    send.mockResolvedValueOnce({ status: "failed", error: { code: "rate_limited", message: "", retryable: true, outcomeUnknown: false } });
    await expect(handleOwnNumberOutcome({ event, step }, deps())).rejects.toThrow("will retry");
    send.mockResolvedValueOnce({ status: "failed", error: { code: "upstream_failed", message: "", retryable: true, outcomeUnknown: true } });
    await expect(handleOwnNumberOutcome({ event, step }, deps())).resolves.toMatchObject({ ask: { status: "failed", code: "upstream_failed" } });
  });
});
