import type { Page } from "@playwright/test";
import { expect, SIGNED_OUT, test } from "../support/app";
import { DAY, newDay3Account, open, writesBy, type Day3Account } from "../support/day3";
import { refusal, stubApi } from "../support/day5";
import { mockRealtime } from "../support/realtime";

// The calendar's buttons (Day 5, Dev 3): Move, Cancel, Mark visited, Mark no-show. The routes are Dev 2's (on main, #115), but they need the
// booking engine's database, so they are stood in for with page.route: these tests prove what the screen sends, when it offers each button and what it says about the
// answer, not that the real routes exist. The mock database does not change when a stubbed route "succeeds", so after every action the screen is
// seen to read the booking again and show what the database holds, which is the point: it never claims a change the database has not made.
// The clock is fixed at Mon 12 Oct 2026, 1:30 pm in Asia/Kolkata, so Karthik's 10:00 booking has started and Wednesday's has not.

const NOW = new Date("2026-10-12T08:00:00Z");
const named = (...words: string[]) => new RegExp(`^${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")).join(",\\s+")}$`);
const booking = (page: Page, customer: string, time: string, status: string) => page.getByRole("button", { name: named(customer, time, status) });
const panel = (page: Page) => page.getByRole("complementary", { name: "Booking details" });
const toast = (page: Page, text: string) => page.getByRole("status").filter({ hasText: text });

const BOOKING_ID = /\/api\/bookings\/[0-9a-f-]{36}\/(reschedule|cancel|complete|no-show)$/;
const SLOTS = /\/api\/bookings\/[0-9a-f-]{36}\/slots(\?.*)?$/;
const idIn = (pathname: string) => pathname.split("/")[3];
const saved = (id: string, status: string) => ({
  id,
  tenantId: "t",
  leadId: "l",
  resourceId: null,
  serviceId: null,
  kind: "slot",
  start: "2026-10-12T04:30:00.000Z",
  end: "2026-10-12T05:30:00.000Z",
  status,
  holdExpiresAt: null,
  details: {},
});
const slot = (n: number, resourceId: string) => ({
  start: `2026-10-1${3 + n}T04:30:00.000Z`,
  end: `2026-10-1${3 + n}T05:30:00.000Z`,
  resourceId,
  resourceName: "Asha",
  serviceId: "s",
  label: `Day ${n}, 10:00 am`,
});

async function openDayAt(page: Page, account: Day3Account, query = `date=${DAY}`) {
  await page.clock.setFixedTime(NOW);
  await open(page, account, `/dashboard/calendar?${query}`, /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) \d+ \w+$|^Week of/);
}
async function selectKarthik(page: Page) {
  await booking(page, "Karthik R", "10:00 am – 11:00 am", "Confirmed").click();
  await expect(panel(page)).toBeVisible();
}

test.describe("Calendar actions", () => {
  test.use({ storageState: SIGNED_OUT });

  test("a started confirmed booking offers all four actions; a held one only Cancel", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true });
    await openDayAt(page, account);
    await selectKarthik(page);
    for (const name of ["Mark visited", "Mark no-show", "Move to another time", "Cancel booking"]) {
      await expect(panel(page).getByRole("button", { name })).toBeEnabled();
    }
    await page.keyboard.press("Escape");
    await booking(page, "Priya S", "11:30 am – 12:00 pm", "Held").click();
    await expect(panel(page).getByRole("button", { name: "Cancel booking" })).toBeEnabled();
    await expect(panel(page).getByRole("button", { name: /Mark|Move/ })).toHaveCount(0);
  });

  test("a booking that has not started cannot be marked visited or no-show, and says why", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true });
    await openDayAt(page, account, "date=2026-10-14");
    await booking(page, "Karthik R", "3:00 pm – 4:00 pm", "Confirmed").click();
    await expect(panel(page).getByRole("button", { name: "Mark visited" })).toBeDisabled();
    await expect(panel(page).getByRole("button", { name: "Mark no-show" })).toBeDisabled();
    await expect(panel(page)).toContainText("become available once the booking has started");
    await expect(panel(page).getByRole("button", { name: "Move to another time" })).toBeEnabled();
  });

  test("a completed booking offers nothing", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true });
    await openDayAt(page, account, "date=2026-10-13");
    await booking(page, "Lakshmi V", "10:00 am – 11:00 am", "Completed").click();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByRole("region", { name: "Change this booking" })).toHaveCount(0);
  });

  test("Mark visited posts to complete, then reads the booking again and shows what the database holds", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true });
    const calls = await stubApi(page, BOOKING_ID, (_n, call) => ({ status: 200, body: saved(idIn(call.url.pathname), "completed") }));
    await openDayAt(page, account);
    await selectKarthik(page);
    await panel(page).getByRole("button", { name: "Mark visited" }).click();
    await expect(toast(page, "Marked as visited")).toBeVisible();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url.pathname).toMatch(/^\/api\/bookings\/[0-9a-f-]{36}\/complete$/);
    expect(calls[0].body).toBeNull();
    expect(calls[0].tenant).toBe(account.tenantId);
    expect(calls[0].authorization).toMatch(/^Bearer /);
    // The stub did not change the database, so the screen, which read it again, still shows Confirmed. It never claims "Completed".
    await expect(booking(page, "Karthik R", "10:00 am – 11:00 am", "Confirmed")).toBeVisible();
    expect(await writesBy(request, account.email)).toEqual([]);
  });

  test("Cancel asks first, says the customer is not told, and sends the reason", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true });
    const calls = await stubApi(page, BOOKING_ID, (_n, call) => ({ status: 200, body: saved(idIn(call.url.pathname), "cancelled") }));
    await openDayAt(page, account);
    await selectKarthik(page);
    await panel(page).getByRole("button", { name: "Cancel booking" }).click();
    await expect(panel(page)).toContainText("The customer isn't told automatically");
    await panel(page).getByRole("button", { name: "Keep it" }).click();
    expect(calls).toHaveLength(0);

    await panel(page).getByRole("button", { name: "Cancel booking" }).click();
    await panel(page).getByLabel("Reason (optional)").fill("Customer called to cancel");
    await panel(page).getByRole("button", { name: "Cancel booking" }).click();
    await expect(toast(page, "Booking cancelled")).toBeVisible();
    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toMatch(/\/cancel$/);
    expect(calls[0].body).toEqual({ reason: "Customer called to cancel" });
  });

  test("Mark no-show asks first and warns about the rebooking offer", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true });
    const calls = await stubApi(page, BOOKING_ID, (_n, call) => ({ status: 200, body: saved(idIn(call.url.pathname), "no_show") }));
    await openDayAt(page, account);
    await selectKarthik(page);
    await panel(page).getByRole("button", { name: "Mark no-show" }).click();
    await expect(panel(page)).toContainText("customer is offered a new time");
    expect(calls).toHaveLength(0);
    await panel(page).getByRole("group", { name: "Mark this booking as a no-show?" }).getByRole("button", { name: "Mark no-show" }).click();
    await expect(toast(page, "Marked as a no-show")).toBeVisible();
    expect(calls[0].url.pathname).toMatch(/\/no-show$/);
  });

  test("Move: lists the offered times, sends the one picked, and a taken time brings fresh times and says why", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true });
    const asha = account.ids.asha;
    const slots = await stubApi(page, SLOTS, (n) => ({ status: 200, body: { slots: n === 1 ? [slot(0, asha), slot(1, asha)] : [slot(2, asha)] } }));
    const moves = await stubApi(page, BOOKING_ID, (n, call) =>
      n === 1 ? refusal(409, "slot_taken", "That time was just taken. Pick another.") : { status: 200, body: saved(idIn(call.url.pathname), "confirmed") },
    );
    await openDayAt(page, account);
    await selectKarthik(page);
    await panel(page).getByRole("button", { name: "Move to another time" }).click();
    await expect(panel(page).getByRole("radio")).toHaveCount(2);
    await expect(panel(page).getByRole("button", { name: "Move booking" })).toBeDisabled();
    await expect(panel(page)).toContainText("The customer isn't told automatically");

    await panel(page).getByRole("radio").first().click();
    await panel(page).getByRole("button", { name: "Move booking" }).click();
    await expect(panel(page).getByRole("alert")).toContainText("That time was just taken");
    // Fresh times were read, and the message stays.
    await expect(panel(page).getByRole("radio")).toHaveCount(1);
    expect(slots.length).toBeGreaterThanOrEqual(2);
    expect(moves[0].body).toEqual({ start: slot(0, asha).start, end: slot(0, asha).end, resourceId: asha });
    expect(moves[0].url.pathname).toMatch(/\/reschedule$/);

    await panel(page).getByRole("radio").first().click();
    await panel(page).getByRole("button", { name: "Move booking" }).click();
    await expect(toast(page, "Moved to Day 2, 10:00 am")).toBeVisible();
    expect(moves).toHaveLength(2);
  });

  test("a change arriving by Realtime does not reload the offered times or clear the one picked", async ({ page, request }) => {
    const rt = await mockRealtime(page);
    const account = await newDay3Account(request, { seed: true });
    const asha = account.ids.asha;
    const slots = await stubApi(page, SLOTS, () => ({ status: 200, body: { slots: [slot(0, asha), slot(1, asha)] } }));
    await openDayAt(page, account);
    await selectKarthik(page);
    await panel(page).getByRole("button", { name: "Move to another time" }).click();
    await expect(panel(page).getByRole("radio")).toHaveCount(2);
    await expect.poll(() => rt.joins.length).toBeGreaterThan(0);
    await page.waitForTimeout(900); // the join reads the bookings once to catch up; let that land first

    await panel(page).getByRole("radio").first().click();
    await expect(panel(page).getByRole("radio").first()).toBeChecked();
    const looked = slots.length;
    rt.push("bookings", "UPDATE", { id: "cccccccc-0000-0000-0000-0000000000aa", tenant_id: account.tenantId, status: "confirmed" });
    await page.waitForTimeout(1500); // longer than the screen's wait before it reads again
    // The screen read its bookings again, but the free times were not looked up again and the choice is still made.
    expect(slots.length).toBe(looked);
    await expect(panel(page).getByRole("radio")).toHaveCount(2);
    await expect(panel(page).getByRole("radio").first()).toBeChecked();
    await expect(panel(page).getByRole("button", { name: "Move booking" })).toBeEnabled();
  });

  test("a refused action shows the reason, changes nothing and can be tried again", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true });
    await stubApi(page, BOOKING_ID, (n, call) =>
      n === 1 ? refusal(403, "forbidden", "Staff can change only the bookings in their own calendar.") : { status: 200, body: saved(idIn(call.url.pathname), "completed") },
    );
    await openDayAt(page, account);
    await selectKarthik(page);
    await panel(page).getByRole("button", { name: "Mark visited" }).click();
    await expect(panel(page).getByRole("alert")).toContainText("Staff can change only the bookings in their own calendar.");
    await expect(panel(page).getByRole("button", { name: "Mark visited" })).toBeEnabled();
    await panel(page).getByRole("button", { name: "Mark visited" }).click();
    await expect(toast(page, "Marked as visited")).toBeVisible();
  });

  test("staff are not offered buttons on a booking that is not on their own calendar", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true, role: "staff" });
    const calls = await stubApi(page, BOOKING_ID, () => ({ status: 200, body: saved("x", "completed") }));
    await openDayAt(page, account);
    await selectKarthik(page);
    await expect(panel(page).getByTestId("booking-actions-staff-note")).toContainText("Staff can change only the bookings in their own calendar.");
    await expect(panel(page).getByRole("button", { name: /Mark|Move|Cancel/ })).toHaveCount(0);
    expect(calls).toHaveLength(0);
  });
});
