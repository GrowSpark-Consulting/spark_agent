import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReminderBooking } from "../booking/reminders";
import type { SendOutcome } from "../notify/send";
import { handlePostVisit, RATING_WAIT, type PostVisitDeps } from "./post-visit";

const TENANT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const BOOKING = "9b2f0a4e-1c3d-4e5f-8a6b-7c8d9e0f1a2b";
const CONVERSATION = "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f601";
const STAFF = "16fd2706-8baf-433b-82eb-8c7fada847da";
const event = { data: { tenantId: TENANT, bookingId: BOOKING } };

const booking = (over: Partial<ReminderBooking> = {}): ReminderBooking => ({
  bookingId: BOOKING,
  status: "confirmed",
  start: "2026-10-10T11:30:00.000Z",
  end: "2026-10-10T12:30:00.000Z",
  leadId: "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f",
  staffUserId: STAFF,
  what: "site visit",
  business: "Skyline Homes",
  timeZone: "Asia/Kolkata",
  conversationId: CONVERSATION,
  ...over,
});
const sent: SendOutcome = { status: "sent", messageId: "m", providerMsgId: "wamid", creditsCharged: 1, usedTemplate: false };

let journal: string[];
let loads: (ReminderBooking | null)[];
let rated: unknown;
const send = vi.fn<PostVisitDeps["send"]>();
const alert = vi.fn<PostVisitDeps["alert"]>();
const step = {
  run: async <T>(id: string, fn: () => Promise<T>) => (journal.push(id), fn()),
  sleepUntil: async (id: string, until: string) => {
    journal.push(`${id}@${until}`);
  },
  waitForEvent: async (id: string, options: { event: string; timeout: string; match: string }) => {
    journal.push(`${id}:${options.event}/${options.timeout}/${options.match}`);
    return rated;
  },
};
function deps(over: Partial<PostVisitDeps> = {}): PostVisitDeps {
  return {
    load: async () => (loads.length > 1 ? loads.shift()! : loads[0]),
    feedbackDelay: async () => 120,
    send,
    reviewLink: async () => "https://g.page/r/skyline/review",
    outcomeRecipients: async () => [STAFF],
    owners: async () => ["owner-1"],
    alert,
    ...over,
  };
}

beforeEach(() => {
  journal = [];
  loads = [booking()];
  rated = { name: "booking.rated", data: { tenantId: TENANT, bookingId: BOOKING, rating: 5 } };
  send.mockReset().mockResolvedValue(sent);
  alert.mockReset().mockResolvedValue({ ...sent, creditsCharged: 0 });
});

describe("handlePostVisit", () => {
  it("asks for a rating 2 h after the end, prompts staff for the outcome, and sends the review link for a 5", async () => {
    await expect(handlePostVisit({ event, step }, deps())).resolves.toEqual({
      feedback: { status: "sent" },
      outcomeAlerts: [{ userId: STAFF, status: "sent" }],
      rating: 5,
      review: { status: "sent" },
    });
    expect(journal).toEqual([
      "plan",
      "wait-visit@2026-10-10T14:30:00.000Z",
      "visit",
      "feedback",
      "outcome-recipients",
      `outcome-${STAFF}`,
      `rating:booking.rated/${RATING_WAIT}/data.bookingId`,
      "review",
    ]);
    expect(send).toHaveBeenNthCalledWith(1, TENANT, "feedback_request", expect.objectContaining({
      conversationId: CONVERSATION,
      interactive: expect.objectContaining({ type: "list", button: "Rate it" }),
      templateParams: ["site visit", "Skyline Homes"],
      idempotencyKey: `feedback_request:${BOOKING}`,
    }));
    expect(alert).toHaveBeenCalledWith(TENANT, STAFF, { kind: "visit_outcome", conversationId: CONVERSATION, what: "site visit" }, `visit_outcome:${BOOKING}:${STAFF}`);
    expect(send).toHaveBeenNthCalledWith(2, TENANT, "review_request", {
      conversationId: CONVERSATION,
      text: "Thank you! Would you leave Skyline Homes a quick review? It really helps: https://g.page/r/skyline/review",
      templateParams: ["Skyline Homes", "https://g.page/r/skyline/review"],
      idempotencyKey: `review_request:${BOOKING}`,
    });
  });

  // Exit test 1 (Day 7; inngest/replay-coverage.test.ts): notify.send keeps one message per key (notify/send.test.ts).
  it("replay: the same event twice sends and alerts under the same keys, so nobody hears twice", async () => {
    const keys = () => [...send.mock.calls.map((x) => x[2].idempotencyKey), ...alert.mock.calls.map((x) => x[3])];
    await handlePostVisit({ event, step }, deps());
    const first = keys();
    send.mockClear();
    alert.mockClear();
    await handlePostVisit({ event, step }, deps());
    expect(keys()).toEqual(first);
    expect(first).toEqual([`feedback_request:${BOOKING}`, `review_request:${BOOKING}`, `visit_outcome:${BOOKING}:${STAFF}`]);

    // A low rating's alerts to the owners, too.
    rated = { name: "booking.rated", data: { tenantId: TENANT, bookingId: BOOKING, rating: 2 } };
    alert.mockClear();
    await handlePostVisit({ event, step }, deps());
    const low = alert.mock.calls.map((x) => x[3]);
    alert.mockClear();
    await handlePostVisit({ event, step }, deps());
    expect(alert.mock.calls.map((x) => x[3])).toEqual(low);
    expect(low).toContain(`low_rating:${BOOKING}:owner-1`);
  });

  it("alerts the owners about a low rating instead of asking for a review", async () => {
    rated = { data: { tenantId: TENANT, bookingId: BOOKING, rating: 2 } };
    await expect(handlePostVisit({ event, step }, deps())).resolves.toMatchObject({ rating: 2, lowRatingAlerts: [{ userId: "owner-1", status: "sent" }] });
    expect(alert).toHaveBeenCalledWith(TENANT, "owner-1", { kind: "low_rating", conversationId: CONVERSATION, what: "site visit", rating: 2 }, `low_rating:${BOOKING}:owner-1`);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("stops after the question when no rating comes in time, and skips the review without a link", async () => {
    rated = null;
    await expect(handlePostVisit({ event, step }, deps())).resolves.toMatchObject({ rating: null });
    rated = { data: { rating: 4 } };
    await expect(handlePostVisit({ event, step }, deps({ reviewLink: async () => null }))).resolves.toMatchObject({ review: { status: "skipped", reason: "no_review_link" } });
  });

  it("uses the business's delay (a test can set minutes)", async () => {
    await handlePostVisit({ event, step }, deps({ feedbackDelay: async () => 1 }));
    expect(journal[1]).toBe("wait-visit@2026-10-10T12:31:00.000Z");
  });

  it("follows up a booking marked completed, but not one cancelled, moved or missed", async () => {
    loads = [booking(), booking({ status: "completed" })];
    await expect(handlePostVisit({ event, step }, deps())).resolves.toMatchObject({ feedback: { status: "sent" } });
    for (const after of [booking({ status: "cancelled" }), booking({ status: "no_show" }), booking({ end: "2026-10-11T12:30:00.000Z" }), null]) {
      loads = [booking(), after];
      send.mockClear();
      await expect(handlePostVisit({ event, step }, deps())).resolves.toEqual({ skipped: "booking_changed" });
      expect(send).not.toHaveBeenCalled();
    }
  });

  it("does nothing for a booking that is not confirmed when it is planned", async () => {
    loads = [booking({ status: "held" })];
    await expect(handlePostVisit({ event, step }, deps())).resolves.toEqual({ skipped: "not_confirmed" });
  });

  it("still prompts staff when the customer can't be asked, and waits for no rating then", async () => {
    send.mockResolvedValue({ status: "skipped", reason: "opted_out" });
    await expect(handlePostVisit({ event, step }, deps())).resolves.toEqual({
      feedback: { status: "skipped", reason: "opted_out" },
      outcomeAlerts: [{ userId: STAFF, status: "sent" }],
    });
    expect(journal.some((j) => j.startsWith("rating:"))).toBe(false);
  });

  it("retries a retryable failure, but never one WhatsApp may have delivered", async () => {
    send.mockResolvedValueOnce({ status: "failed", error: { code: "rate_limited", message: "", retryable: true, outcomeUnknown: false } });
    await expect(handlePostVisit({ event, step }, deps())).rejects.toThrow("will retry");
    send.mockReset().mockResolvedValue({ status: "failed", error: { code: "upstream_failed", message: "", retryable: true, outcomeUnknown: true } });
    await expect(handlePostVisit({ event, step }, deps())).resolves.toMatchObject({ feedback: { status: "failed", code: "upstream_failed" } });
  });
});
