import { expect, expectNoHorizontalOverflow, test } from "../support/app";
import { refusal, stubApi } from "../support/day5";

// Home v1 (Dev 3): why the assistant is (not) replying, the credit meter in leads, this month's summary, the hot leads waiting and today's
// bookings. GET /api/dashboard/summary and GET /api/billing/balance are Dev 2's routes (#140) and are stood in for with page.route here, using
// the full DashboardSummary and AccountStatus shapes from @pakka/types. These tests prove how Home reads each answer and what it says when a
// route is missing, fails or answers with another shape; they do not show the real routes agree.

const SUMMARY = /\/api\/dashboard\/summary$/;
const BALANCE = /\/api\/billing\/balance$/;
const CHAT = "40000000-0000-0000-0000-000000000001";
const summary = {
  month: "2026-10",
  stats: { enquiries: 50, qualified: 18, booked: 7, afterHours: 11, enquiriesChangePct: 18 },
  overnightHandled: 9,
  hotLeads: [
    { leadId: "50000000-0000-0000-0000-000000000001", conversationId: CHAT, name: "Priya S", need: "Teeth whitening", score: 88, temperature: "hot", reason: "Asked for a person", waitingSince: "2026-10-13T04:00:00.000Z", assignedTo: null },
    { leadId: "50000000-0000-0000-0000-000000000002", conversationId: null, name: "Karthik R", need: "Check-up", score: 75, temperature: "hot", reason: "Hot lead", waitingSince: null, assignedTo: null },
  ],
  todayBookings: [{ bookingId: "60000000-0000-0000-0000-000000000001", startAt: "2026-10-13T05:30:00.000Z", name: "Asha N", place: "Chair 1", staff: "Dr Rao", status: "confirmed" }],
};
const balance = (total: number, over: Record<string, unknown> = {}) => ({
  status: "active",
  plan: { key: "growth", name: "Growth", monthlyCredits: 1500 },
  credits: { plan: total, topup: 0, total },
  creditsGranted: 1500,
  renewsAt: "2026-11-01T00:00:00.000Z",
  trialEndsAt: null,
  aiPaused: false,
  aiPausedReason: null,
  lowCredits: false,
  aiAutoReply: true,
  ...over,
});

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
    await expect(page.getByTestId("renews-at")).toContainText("Renews 1 Nov 2026");
    await expect(page.getByTestId("assistant-status")).toHaveCount(0);

    const month = page.getByTestId("month-summary");
    await expect(month.locator('[data-stat="Enquiries"]')).toContainText("50");
    await expect(month.locator('[data-stat="Enquiries"]')).toContainText("+18% vs last month");
    await expect(month.locator('[data-stat="Qualified"]')).toContainText("18");
    await expect(month.locator('[data-stat="Booked"]')).toContainText("7");
    await expect(month.locator('[data-stat="After-hours enquiries handled"]')).toContainText("11");
    await expect(month.locator('[data-stat="After-hours enquiries handled"]')).toContainText("9 chats overnight");
    await expectNoHorizontalOverflow(page);
  });

  test("lists the hot leads waiting and today's bookings from the summary, linking each lead to its chat or its record", async ({ page }) => {
    await stubApi(page, SUMMARY, () => ({ status: 200, body: summary }));
    await stubApi(page, BALANCE, () => ({ status: 200, body: balance(1000) }));
    await page.goto("/dashboard");
    const hot = page.getByTestId("hot-leads");
    await expect(hot.getByRole("link")).toHaveCount(2);
    await expect(hot.getByRole("link", { name: /Priya S/ })).toHaveAttribute("href", `/dashboard/inbox?chat=${CHAT}`);
    await expect(hot.getByRole("link", { name: /Priya S/ })).toContainText("Asked for a person · waiting since");
    await expect(hot.getByRole("link", { name: /Karthik R/ })).toHaveAttribute("href", "/dashboard/leads/50000000-0000-0000-0000-000000000002");
    await expect(page.getByTestId("today-bookings")).toContainText("Asha N");
    await expect(page.getByTestId("today-bookings")).toContainText("Chair 1 · Dr Rao");
    await expect(page.getByTestId("today-bookings")).toContainText("Confirmed");
    await expectNoHorizontalOverflow(page);
  });

  test("empty lists say so instead of showing nothing", async ({ page }) => {
    await stubApi(page, SUMMARY, () => ({ status: 200, body: { ...summary, hotLeads: [], todayBookings: [] } }));
    await stubApi(page, BALANCE, () => ({ status: 200, body: balance(1000) }));
    await page.goto("/dashboard");
    await expect(page.getByText("No hot leads waiting")).toBeVisible();
    await expect(page.getByText("No bookings today")).toBeVisible();
    await expect(page.getByTestId("hot-leads")).toHaveCount(0);
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

  const PAUSED = [
    { reason: "no_credits", status: "active", title: "Assistant paused: out of credits", action: "Top up credits" },
    { reason: "trial_ended", status: "trial", title: "Assistant paused: your free trial has ended", action: "Choose a plan" },
    { reason: "whatsapp_not_connected", status: "active", title: "Assistant paused: no WhatsApp number is connected", action: "Connect WhatsApp", href: "/dashboard/whatsapp" },
    { reason: "paused", status: "paused", title: "Assistant paused: your account is paused", action: "See your plan" },
    { reason: "cancelled", status: "cancelled", title: "Assistant paused: your subscription is cancelled", action: "Choose a plan" },
  ] as const;
  for (const { reason, status, title, action, ...rest } of PAUSED) {
    const href = "href" in rest ? rest.href : "/dashboard/billing";
    test(`says why the assistant is paused for ${reason}, and where to go`, async ({ page }) => {
      await stubApi(page, SUMMARY, () => ({ status: 200, body: summary }));
      await stubApi(page, BALANCE, () => ({ status: 200, body: balance(reason === "no_credits" ? 0 : 400, { status, aiPaused: true, aiPausedReason: reason }) }));
      await page.goto("/dashboard");
      const banner = page.getByTestId("assistant-status");
      await expect(banner).toHaveAttribute("data-reason", reason);
      await expect(banner).toContainText(title);
      await expect(banner).toContainText("New chats go to your inbox");
      await expect(banner.getByRole("link", { name: action })).toHaveAttribute("href", href);
      await expect(page.getByTestId("credit-meter")).toHaveAttribute("data-paused", "true");
      await expectNoHorizontalOverflow(page);
    });
  }

  test("a running trial counts the days left and offers a plan", async ({ page }) => {
    const trialEndsAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
    await stubApi(page, SUMMARY, () => ({ status: 200, body: summary }));
    await stubApi(page, BALANCE, () => ({ status: 200, body: balance(400, { status: "trial", trialEndsAt, renewsAt: null }) }));
    await page.goto("/dashboard");
    await expect(page.getByTestId("assistant-status")).toContainText("5 days left in your free trial.");
    await expect(page.getByTestId("assistant-status").getByRole("link", { name: "Choose a plan" })).toHaveAttribute("href", "/dashboard/billing");
    await expect(page.getByTestId("renews-at")).toHaveCount(0);
  });

  test("a route the server does not have is said so, per card, with no figures", async ({ page }) => {
    await stubApi(page, SUMMARY, () => refusal(404, "not_found", "Not found."));
    await stubApi(page, BALANCE, () => ({ status: 200, body: balance(1000) }));
    await page.goto("/dashboard");
    await expect(page.getByText("This month's summary isn't available yet")).toBeVisible();
    await expect(page.getByTestId("month-summary")).toHaveCount(0);
    await expect(page.getByTestId("hot-leads")).toHaveCount(0);
    // The other card is unaffected; with no enquiries to go on it shows credits only.
    await expect(page.getByTestId("credit-leads")).toHaveText("1,000");
    await expect(page.locator('[role="alert"].app-state')).toHaveCount(0);
  });

  test("a failed card shows its own error and retries", async ({ page }) => {
    await stubApi(page, SUMMARY, () => ({ status: 200, body: summary }));
    await stubApi(page, BALANCE, (n) => (n === 1 ? refusal(500, "internal", "Something went wrong. Try again in a moment.") : { status: 200, body: balance(1000) }));
    await page.goto("/dashboard");
    await expect(page.locator('[role="alert"].app-state')).toContainText("Couldn't load your credits");
    await expect(page.getByTestId("assistant-status")).toHaveCount(0);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("credit-leads")).toHaveText("About 100");
  });

  test("an answer that isn't the contract's shape is refused, not drawn", async ({ page }) => {
    await stubApi(page, SUMMARY, () => ({ status: 200, body: { stats: { enquiries: "lots" } } }));
    await stubApi(page, BALANCE, () => ({ status: 200, body: balance(1000, { aiPausedReason: "mystery" }) }));
    await page.goto("/dashboard");
    await expect(page.locator('[role="alert"].app-state').filter({ hasText: "Couldn't load this month's summary" })).toBeVisible();
    await expect(page.locator('[role="alert"].app-state').filter({ hasText: "Couldn't load your credits" })).toBeVisible();
    await expect(page.getByTestId("month-summary")).toHaveCount(0);
    await expect(page.getByTestId("credit-meter")).toHaveCount(0);
  });
});
