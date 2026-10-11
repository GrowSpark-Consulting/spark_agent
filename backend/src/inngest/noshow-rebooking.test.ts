import { beforeEach, describe, expect, it, vi } from "vitest";
import { noShowMessage } from "../booking/no-show";
import type { ReminderBooking } from "../booking/reminders";
import { Interactive } from "../notify/interactive";
import type { SendOutcome } from "../notify/send";
import { handleNoShowRebooking, type NoShowRebookingDeps } from "./noshow-rebooking";

const TENANT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const BOOKING = "9b2f0a4e-1c3d-4e5f-8a6b-7c8d9e0f1a2b";
const CONVERSATION = "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f601";
const event = { data: { tenantId: TENANT, bookingId: BOOKING, change: "no_show" } };

const booking = (over: Partial<ReminderBooking> = {}): ReminderBooking => ({
  bookingId: BOOKING,
  status: "no_show",
  start: "2026-10-10T11:30:00.000Z",
  end: "2026-10-10T12:30:00.000Z",
  leadId: "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f",
  staffUserId: null,
  what: "site visit",
  business: "Skyline Homes",
  timeZone: "Asia/Kolkata",
  conversationId: CONVERSATION,
  ...over,
});
const sent: SendOutcome = { status: "sent", messageId: "m", providerMsgId: "wamid", creditsCharged: 1, usedTemplate: false };

let current: ReminderBooking | null;
const send = vi.fn<NoShowRebookingDeps["send"]>();
const step = { run: async <T>(_id: string, fn: () => Promise<T>) => fn() };
const deps = (): NoShowRebookingDeps => ({ load: async () => current, send });

beforeEach(() => {
  current = booking();
  send.mockReset().mockResolvedValue(sent);
});

describe("noShowMessage", () => {
  it("offers a new time with the reminders' reschedule button, and gives the template's variables", () => {
    const message = noShowMessage(booking());
    expect(message.interactive).toEqual({
      type: "buttons",
      body: "Sorry we missed you for your site visit with Skyline Homes. Would you like to pick a new time?",
      buttons: [{ id: `booking:${BOOKING}:reschedule`, title: "Pick a new time" }],
    });
    expect(Interactive.safeParse(message.interactive).success).toBe(true);
    expect(message.templateParams).toEqual(["site visit", "Skyline Homes"]);
  });
});

describe("handleNoShowRebooking", () => {
  it("offers a new time once per booking", async () => {
    await expect(handleNoShowRebooking({ event, step }, deps())).resolves.toEqual({ offer: { status: "sent" } });
    expect(send).toHaveBeenCalledWith(TENANT, "noshow_rebooking", {
      conversationId: CONVERSATION,
      ...noShowMessage(booking()),
      idempotencyKey: `noshow_rebooking:${BOOKING}`,
    });
  });

  it("sends nothing when the no-show was corrected, the booking is gone, or there is no chat", async () => {
    for (const [now, reason] of [
      [booking({ status: "completed" }), "not_a_no_show"],
      [null, "not_a_no_show"],
      [booking({ conversationId: null }), "no_conversation"],
    ] as const) {
      current = now;
      await expect(handleNoShowRebooking({ event, step }, deps())).resolves.toEqual({ offer: { status: "skipped", reason } });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("retries a retryable failure, but never one WhatsApp may have delivered", async () => {
    send.mockResolvedValueOnce({ status: "failed", error: { code: "rate_limited", message: "", retryable: true, outcomeUnknown: false } });
    await expect(handleNoShowRebooking({ event, step }, deps())).rejects.toThrow("will retry");
    send.mockResolvedValueOnce({ status: "failed", error: { code: "upstream_failed", message: "", retryable: true, outcomeUnknown: true } });
    await expect(handleNoShowRebooking({ event, step }, deps())).resolves.toEqual({ offer: { status: "failed", code: "upstream_failed" } });
  });
});
