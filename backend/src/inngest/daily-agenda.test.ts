import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgendaItem, AgendaTenant } from "../booking/daily-agenda";
import type { SendOutcome } from "../notify/send";
import { handleDailyAgenda, type DailyAgendaDeps } from "./daily-agenda";

const INDIA: AgendaTenant = { id: "7c9e6679-7425-40de-944b-e07fc1f90ae7", name: "Skyline Homes", timeZone: "Asia/Kolkata" };
const LONDON: AgendaTenant = { id: "2b5c6d7e-8f90-4a1b-8c2d-3e4f5a6b7c8d", name: "Thames Interiors", timeZone: "Europe/London" };
const AT_8_IN_INDIA = new Date("2026-10-10T02:30:00Z"); // 3:30 am in London
const items: AgendaItem[] = [{ time: "10:00 am", what: "Site visit", who: "Asha", staff: "Priya" }];
const sent: SendOutcome = { status: "sent", messageId: "m", providerMsgId: "wamid", creditsCharged: 0, usedTemplate: true };

const journal: string[] = [];
const step = { run: async <T>(id: string, fn: () => Promise<T>) => (journal.push(id), fn()) };
const send = vi.fn<DailyAgendaDeps["send"]>();
const enabled = vi.fn<DailyAgendaDeps["enabled"]>();
let bookings: AgendaItem[];
const deps = (): DailyAgendaDeps => ({
  tenants: async () => [INDIA, LONDON],
  enabled,
  bookings: async () => ({ date: "2026-10-10", items: bookings }),
  owners: async () => ["owner-1", "owner-2"],
  send,
  appUrl: () => "https://app.test",
  now: () => AT_8_IN_INDIA,
});

beforeEach(() => {
  journal.length = 0;
  bookings = items;
  send.mockReset().mockResolvedValue(sent);
  enabled.mockReset().mockResolvedValue(true);
});

describe("handleDailyAgenda", () => {
  it("sends today's agenda to each owner of a business where it is just past 8 am, once a day per owner", async () => {
    await expect(handleDailyAgenda({ step }, deps())).resolves.toEqual({
      due: 1,
      results: [
        {
          tenantId: INDIA.id,
          sent: [
            { userId: "owner-1", status: "sent" },
            { userId: "owner-2", status: "sent" },
          ],
        },
      ],
    });
    expect(journal).toEqual(["due", `agenda-${INDIA.id}`]);
    expect(send).toHaveBeenCalledWith(INDIA.id, "daily_agenda", expect.objectContaining({
      staffUserId: "owner-1",
      templateParams: ["1 booking", "10:00 am, Site visit with Asha (Priya)", "https://app.test/dashboard/calendar"],
      idempotencyKey: `daily_agenda:${INDIA.id}:owner-1:2026-10-10`,
    }));
    expect(enabled).toHaveBeenCalledWith(INDIA.id);
    expect(enabled).not.toHaveBeenCalledWith(LONDON.id);
  });

  it("sends nothing to a business without the feature or without bookings today", async () => {
    enabled.mockResolvedValue(false);
    await expect(handleDailyAgenda({ step }, deps())).resolves.toMatchObject({ results: [{ skipped: "feature_off" }] });
    enabled.mockResolvedValue(true);
    bookings = [];
    await expect(handleDailyAgenda({ step }, deps())).resolves.toMatchObject({ results: [{ skipped: "no_bookings" }] });
    expect(send).not.toHaveBeenCalled();
  });

  it("retries a retryable failure (the key stops repeats to owners who already got it)", async () => {
    send.mockResolvedValueOnce(sent).mockResolvedValueOnce({ status: "failed", error: { code: "rate_limited", message: "", retryable: true, outcomeUnknown: false } });
    await expect(handleDailyAgenda({ step }, deps())).rejects.toThrow("will retry");
  });
});
