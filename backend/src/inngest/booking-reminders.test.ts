import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReminderBooking } from "../booking/reminders";
import type { SendOutcome } from "../notify/send";
import { handleBookingConfirmed, type BookingRemindersDeps } from "./booking-reminders";

const TENANT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const BOOKING = "9b2f0a4e-1c3d-4e5f-8a6b-7c8d9e0f1a2b";
const CONVERSATION = "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f601";
const START = "2026-10-10T11:30:00.000Z";
const NOW = new Date("2026-10-09T08:00:00.000Z"); // 27.5 hours before the start
const event = { data: { tenantId: TENANT, bookingId: BOOKING } };

const booking = (over: Partial<ReminderBooking> = {}): ReminderBooking => ({
  bookingId: BOOKING,
  status: "confirmed",
  start: START,
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

let journal: string[];
let loads: (ReminderBooking | null)[];
const send = vi.fn<BookingRemindersDeps["send"]>();
const step = {
  run: async <T>(id: string, fn: () => Promise<T>) => (journal.push(id), fn()),
  sleepUntil: async (id: string, until: string) => {
    journal.push(`${id}@${until}`);
  },
};
function deps(over: Partial<BookingRemindersDeps> = {}): BookingRemindersDeps {
  return {
    // Each read takes the next state from `loads`, the last one repeating: lets a test change the booking between steps.
    load: async () => (loads.length > 1 ? loads.shift()! : loads[0]),
    offsets: async () => ({ reminder_24h: 1440, reminder_2h: 120 }),
    send,
    now: () => NOW,
    ...over,
  };
}

beforeEach(() => {
  journal = [];
  loads = [booking()];
  send.mockReset().mockResolvedValue(sent);
});

describe("handleBookingConfirmed", () => {
  it("waits until 24 h and 2 h before the start, then sends each reminder once, with buttons and a key", async () => {
    await expect(handleBookingConfirmed({ event, step }, deps())).resolves.toEqual({
      results: [
        { kind: "reminder_24h", status: "sent", creditsCharged: 1, usedTemplate: false },
        { kind: "reminder_2h", status: "sent", creditsCharged: 1, usedTemplate: false },
      ],
    });
    expect(journal).toEqual([
      "plan",
      "wait-reminder_24h@2026-10-09T11:30:00.000Z",
      "send-reminder_24h",
      "wait-reminder_2h@2026-10-10T09:30:00.000Z",
      "send-reminder_2h",
    ]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, TENANT, "reminder_24h", {
      conversationId: CONVERSATION,
      interactive: expect.objectContaining({ type: "buttons", body: "Reminder: your site visit with Skyline Homes is on Sat 10 Oct, 5:00 pm." }),
      templateParams: ["site visit", "Skyline Homes", "Sat 10 Oct, 5:00 pm"],
      // The template's Confirm, Reschedule and Cancel buttons carry the same ids as the interactive ones.
      templateButtons: [`booking:${BOOKING}:confirm`, `booking:${BOOKING}:reschedule`, `booking:${BOOKING}:cancel`],
      idempotencyKey: `reminder_24h:${BOOKING}:${START}`,
    });
    expect(send.mock.calls[1][2].idempotencyKey).toBe(`reminder_2h:${BOOKING}:${START}`);
  });

  // Exit test 1 (Day 7; inngest/replay-coverage.test.ts): notify.send keeps one message per key (notify/send.test.ts).
  it("replay: the same event twice sends under the same keys, so the customer gets each reminder once", async () => {
    await handleBookingConfirmed({ event, step }, deps());
    const first = send.mock.calls.map((c) => c[2].idempotencyKey);
    send.mockClear();
    await handleBookingConfirmed({ event, step }, deps());
    expect(send.mock.calls.map((c) => c[2].idempotencyKey)).toEqual(first);
    expect(first).toEqual([`reminder_24h:${BOOKING}:${START}`, `reminder_2h:${BOOKING}:${START}`]);
  });

  it("uses the business's offsets (a test can set minutes)", async () => {
    await handleBookingConfirmed({ event, step }, deps({ offsets: async () => ({ reminder_24h: 3, reminder_2h: 1 }) }));
    expect(journal.filter((j) => j.startsWith("wait-"))).toEqual(["wait-reminder_24h@2026-10-10T11:27:00.000Z", "wait-reminder_2h@2026-10-10T11:29:00.000Z"]);
  });

  it("leaves out a reminder whose time has already passed", async () => {
    const result = await handleBookingConfirmed({ event, step }, deps({ now: () => new Date("2026-10-10T08:00:00.000Z") })); // 3.5 h before
    expect(result).toEqual({ results: [{ kind: "reminder_2h", status: "sent", creditsCharged: 1, usedTemplate: false }] });
    expect(journal).toEqual(["plan", "wait-reminder_2h@2026-10-10T09:30:00.000Z", "send-reminder_2h"]);
  });

  it("does nothing for a booking that is gone or not confirmed", async () => {
    loads = [null];
    await expect(handleBookingConfirmed({ event, step }, deps())).resolves.toEqual({ skipped: "not_confirmed" });
    loads = [booking({ status: "held" })];
    await expect(handleBookingConfirmed({ event, step }, deps())).resolves.toEqual({ skipped: "not_confirmed" });
    expect(send).not.toHaveBeenCalled();
  });

  it("sends nothing after the booking is cancelled or moved, even if the cancel event is late", async () => {
    loads = [booking(), booking({ status: "cancelled" })];
    await expect(handleBookingConfirmed({ event, step }, deps())).resolves.toEqual({
      results: [
        { kind: "reminder_24h", status: "skipped", reason: "booking_changed" },
        { kind: "reminder_2h", status: "skipped", reason: "booking_changed" },
      ],
    });
    loads = [booking(), booking(), booking({ start: "2026-10-11T11:30:00.000Z" })];
    const moved = await handleBookingConfirmed({ event, step }, deps());
    expect(moved).toMatchObject({ results: [{ kind: "reminder_24h", status: "sent" }, { kind: "reminder_2h", status: "skipped", reason: "booking_changed" }] });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("skips a booking with no chat to send to", async () => {
    loads = [booking({ conversationId: null })];
    await expect(handleBookingConfirmed({ event, step }, deps())).resolves.toMatchObject({ results: [{ status: "skipped", reason: "no_conversation" }, { status: "skipped" }] });
    expect(send).not.toHaveBeenCalled();
  });

  it("passes on notify.send's skips (toggle off, opted out) without retrying", async () => {
    send.mockResolvedValue({ status: "skipped", reason: "feature_off" });
    await expect(handleBookingConfirmed({ event, step }, deps())).resolves.toMatchObject({ results: [{ status: "skipped", reason: "feature_off" }, { status: "skipped", reason: "feature_off" }] });
  });

  it("retries a retryable failure, but never one WhatsApp may have delivered", async () => {
    send.mockResolvedValueOnce({ status: "failed", error: { code: "rate_limited", message: "", retryable: true, outcomeUnknown: false } });
    await expect(handleBookingConfirmed({ event, step }, deps())).rejects.toThrow("will retry");
    send.mockReset().mockResolvedValue({ status: "failed", error: { code: "upstream_failed", message: "", retryable: true, outcomeUnknown: true } });
    await expect(handleBookingConfirmed({ event, step }, deps())).resolves.toMatchObject({ results: [{ status: "failed", code: "upstream_failed" }, { status: "failed" }] });
  });

  it("refuses an event without ids", async () => {
    await expect(handleBookingConfirmed({ event: { data: { tenantId: TENANT } }, step }, deps())).rejects.toMatchObject({ name: "ZodError" });
  });
});
