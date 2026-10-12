import { expect, expectNoHorizontalOverflow, test } from "../support/app";
import { refusal, stubApi } from "../support/day5";

// Home v1 (Day 5, Dev 3): the credit meter in leads, this month's summary and the after-hours enquiries handled. GET /api/dashboard/summary and
// GET /api/billing/balance are PROPOSED routes of Dev 2's that do not exist yet, so each is stood in for with page.route. These tests prove how
// Home reads each answer and what it says when a route is missing or fails; they do not show the real routes exist.

const SUMMARY = /\/api\/dashboard\/summary$/;
const BALANCE = /\/api\/billing\/balance$/;
const summary = { month: "2026-10", stats: { enquiries: 50, qualified: 18, booked: 7, afterHours: 11, enquiriesChangePct: 18 }, overnightHandled: 9 };
const balance = (total: number, over: Record<string, unknown> = {}) => ({ credits: { plan: total, topup: 0, total }, creditsGranted: 1500, aiPaused: false, lowCredits: false, ...over });

test.describe("Home overview", () => {
  test("shows credits as leads at this month's pace, and the month's summary with after-hours handled", async ({ page }) => {
    await stubApi(page, SUMMARY, () => ({ status: 200, body: summary }));
    await stubApi(page, BALANCE, () => ({ status: 200, body: balance(1000) }));
    await page.goto("/dashboard");
    // 500 of 1,500 spent over 50 enquiries = 10 credits a lead; 1,000 left = about 100 leads.
    await expect(page.getByTestId("credit-leads")).toHaveText("About 100");
    await expect(page.getByTestId("credit-meter")).toContainText("more leads");
    await expect(page.getByTestId("credit-meter")).toContainText("1,000 credits left of 1,500 this cycle");
    await expect(page.getByTestId("credit-meter")).toContainText("about 10.0 credits a lead");

    const month = page.getByTestId("month-summary");
    await expect(month.locator('[data-stat="Enquiries"]')).toContainText("50");
    await expect(month.locator('[data-stat="Enquiries"]')).toContainText("+18% vs last month");
    await expect(month.locator('[data-stat="Qualified"]')).toContainText("18");
    await expect(month.locator('[data-stat="Booked"]')).toContainText("7");
    await expect(month.locator('[data-stat="After-hours enquiries handled"]')).toContainText("11");
    await expect(month.locator('[data-stat="After-hours enquiries handled"]')).toContainText("9 chats overnight");
    await expectNoHorizontalOverflow(page);
  });

  test("without a month of activity it shows credits, not an invented lead count", async ({ page }) => {
    await stubApi(page, SUMMARY, () => ({ status: 200, body: { ...summary, stats: { ...summary.stats, enquiries: 0, qualified: 0, booked: 0, afterHours: 0 } } }));
    await stubApi(page, BALANCE, () => ({ status: 200, body: balance(1500) }));
    await page.goto("/dashboard");
    await expect(page.getByTestId("credit-leads")).toHaveText("1,500");
    await expect(page.getByTestId("credit-meter")).toContainText("credits left");
    await expect(page.getByTestId("credit-meter")).not.toContainText("more leads");
    await expect(page.getByTestId("month-summary").locator('[data-stat="Booked"]')).toContainText("0");
  });

  test("out of credits says the assistant is paused", async ({ page }) => {
    await stubApi(page, SUMMARY, () => ({ status: 200, body: summary }));
    await stubApi(page, BALANCE, () => ({ status: 200, body: balance(0, { aiPaused: true, lowCredits: true }) }));
    await page.goto("/dashboard");
    await expect(page.getByTestId("credit-meter")).toContainText("Assistant paused: out of credits");
    await expect(page.getByTestId("credit-meter")).toContainText("New chats go to your inbox until you top up.");
  });

  test("a route the server does not have yet is said so, per card, with no figures", async ({ page }) => {
    await stubApi(page, SUMMARY, () => refusal(404, "not_found", "Not found."));
    await stubApi(page, BALANCE, () => ({ status: 200, body: balance(1000) }));
    await page.goto("/dashboard");
    await expect(page.getByText("This month's summary isn't available yet")).toBeVisible();
    await expect(page.getByTestId("month-summary")).toHaveCount(0);
    // The other card is unaffected; with no enquiries to go on it shows credits only.
    await expect(page.getByTestId("credit-leads")).toHaveText("1,000");
    await expect(page.locator('[role="alert"].app-state')).toHaveCount(0);
  });

  test("a failed card shows its own error and retries", async ({ page }) => {
    await stubApi(page, SUMMARY, () => ({ status: 200, body: summary }));
    await stubApi(page, BALANCE, (n) => (n === 1 ? refusal(500, "internal", "Something went wrong. Try again in a moment.") : { status: 200, body: balance(1000) }));
    await page.goto("/dashboard");
    await expect(page.locator('[role="alert"].app-state')).toContainText("Couldn't load your credits");
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("credit-leads")).toHaveText("About 100");
  });

  test("an answer that isn't the proposed shape is refused, not drawn", async ({ page }) => {
    await stubApi(page, SUMMARY, () => ({ status: 200, body: { stats: { enquiries: "lots" } } }));
    await stubApi(page, BALANCE, () => ({ status: 200, body: balance(1000) }));
    await page.goto("/dashboard");
    await expect(page.locator('[role="alert"].app-state')).toContainText("Couldn't load this month's summary");
    await expect(page.getByTestId("month-summary")).toHaveCount(0);
  });
});
