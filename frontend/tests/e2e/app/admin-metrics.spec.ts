import { expect, expectNoHorizontalOverflow, test } from "../support/app";
import { refusal, stubApi } from "../support/day5";

// /dashboard/admin/metrics: GET /api/admin/metrics is Dev 2's (0051) and needs a platform admin, so it is stood in for with page.route.
// These tests prove what the screen sends, how it words each answer and that a refusal for a non-admin shows no data. They do not prove the
// platform-admin check, the admin_metrics SQL function or the numbers it returns.

const METRICS = /\/api\/admin\/metrics$/;

const window = (over: Record<string, unknown> = {}) => ({
  days: 7,
  creditsSpent: 1200,
  aiCostUsd: 4.5,
  aiCostInr: 405,
  aiCalls: 310,
  costPerCreditInr: 0.338,
  trialsStarted: 8,
  trialsPaid: 2,
  trialToPaidPct: 25,
  ...over,
});
const answer = (windows: unknown[]) => ({ windows, targetCostPerCreditInr: 0.35, usdInr: 90, asOf: "2026-10-15T06:00:00.000Z" });

test.describe("Admin: metrics", () => {
  test("shows both windows with the server's numbers, one read and no business header", async ({ page }) => {
    const reads = await stubApi(page, METRICS, () => ({
      status: 200,
      body: answer([window(), window({ days: 30, creditsSpent: 5000, aiCostUsd: 20, aiCostInr: 1800, aiCalls: 1500, costPerCreditInr: 0.36, trialsStarted: 30, trialsPaid: 9, trialToPaidPct: 30 })]),
    }));
    await page.goto("/dashboard/admin/metrics");
    await expect(page.getByRole("heading", { level: 1, name: "Metrics" })).toBeVisible();
    const week = page.getByTestId("metrics-window-7");
    await expect(week.getByRole("heading", { name: "Last 7 days" })).toBeVisible();
    await expect(week.getByTestId("cost-per-credit")).toContainText("₹0.338");
    await expect(week.getByTestId("target-comparison")).toContainText("Within the ₹0.350 target");
    await expect(week.getByTestId("trial-to-paid")).toContainText("25.0%");
    await expect(week.getByTestId("trial-to-paid")).toContainText("2 of 8 trials paid");
    await expect(week.getByTestId("credits-spent")).toContainText("1,200");
    await expect(week.getByTestId("ai-cost")).toContainText("₹405.00");
    await expect(week.getByTestId("ai-cost")).toContainText("$4.50 over 310 calls");
    const month = page.getByTestId("metrics-window-30");
    await expect(month.getByRole("heading", { name: "Last 30 days" })).toBeVisible();
    await expect(month.getByTestId("target-comparison")).toContainText("Above the ₹0.350 target by ₹0.010");
    await expect(month.getByTestId("credits-spent")).toContainText("5,000");
    await expect(page.getByTestId("metrics-notes")).toContainText("₹90 to the dollar");
    await expect(page.getByTestId("metrics-as-of")).toContainText("2026");
    expect(reads).toHaveLength(1);
    expect(reads[0].method).toBe("GET");
    expect(reads[0].tenant).toBeNull();
    expect(reads[0].authorization).toMatch(/^Bearer /);
    await expectNoHorizontalOverflow(page);
  });

  test("a period with no credits spent or no trials shows a dash and says why, and compares nothing", async ({ page }) => {
    await stubApi(page, METRICS, () => ({
      status: 200,
      body: answer([window({ creditsSpent: 0, aiCostUsd: 0, aiCostInr: 0, aiCalls: 0, costPerCreditInr: null, trialsStarted: 0, trialsPaid: 0, trialToPaidPct: null })]),
    }));
    await page.goto("/dashboard/admin/metrics");
    const week = page.getByTestId("metrics-window-7");
    await expect(week.getByTestId("cost-per-credit")).toContainText("No credits were spent in this period.");
    await expect(week.getByTestId("cost-per-credit").getByTestId("stat-value")).toHaveText("—");
    await expect(week.getByTestId("target-comparison")).toHaveCount(0);
    await expect(week.getByTestId("trial-to-paid")).toContainText("No trials started in this period.");
    await expect(week.getByTestId("trial-to-paid").getByTestId("stat-value")).toHaveText("—");
    await expectNoHorizontalOverflow(page);
  });

  test("an answer with no windows says there are no figures", async ({ page }) => {
    await stubApi(page, METRICS, () => ({ status: 200, body: answer([]) }));
    await page.goto("/dashboard/admin/metrics");
    await expect(page.getByTestId("metrics-empty")).toBeVisible();
    await expect(page.getByTestId("metrics-window-7")).toHaveCount(0);
  });

  test("while the numbers are on their way the screen says it is loading, and shows no figures", async ({ page }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    await stubApi(page, METRICS, async () => (await gate, { status: 200, body: answer([window()]) }));
    await page.goto("/dashboard/admin/metrics");
    await expect(page.getByTestId("metrics-loading")).toBeVisible();
    await expect(page.getByTestId("metrics-window-7")).toHaveCount(0);
    release();
    await expect(page.getByTestId("metrics-window-7")).toBeVisible();
    await expect(page.getByTestId("metrics-loading")).toHaveCount(0);
  });

  test("a refusal for someone who is not on the platform-admin list shows no data and no retry", async ({ page }) => {
    const reads = await stubApi(page, METRICS, () => refusal(403, "forbidden", "Not a platform admin"));
    await page.goto("/dashboard/admin/metrics");
    await expect(page.getByTestId("admin-error")).toContainText("Only the Spark Agent team can see this.");
    await expect(page.getByTestId("admin-error")).toHaveAttribute("data-code", "forbidden");
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await expect(page.getByTestId("metrics-window-7")).toHaveCount(0);
    expect(reads).toHaveLength(1);
  });

  test("a server error says so and Try again reads again", async ({ page }) => {
    const reads = await stubApi(page, METRICS, (n) => (n === 1 ? refusal(500, "internal", "boom") : { status: 200, body: answer([window()]) }));
    await page.goto("/dashboard/admin/metrics");
    await expect(page.getByTestId("admin-error")).toBeVisible();
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("metrics-window-7")).toBeVisible();
    await expect(page.getByTestId("admin-error")).toHaveCount(0);
    expect(reads).toHaveLength(2);
  });

  test("an answer that is not the contract's shape is refused, not shown", async ({ page }) => {
    await stubApi(page, METRICS, () => ({ status: 200, body: { windows: [{ days: 7 }] } }));
    await page.goto("/dashboard/admin/metrics");
    await expect(page.getByTestId("admin-error")).toBeVisible();
    await expect(page.getByTestId("metrics-window-7")).toHaveCount(0);
  });

  test("the figures are reachable by keyboard: the retry button can take focus", async ({ page }) => {
    await stubApi(page, METRICS, () => refusal(500, "internal", "boom"));
    await page.goto("/dashboard/admin/metrics");
    const retry = page.getByRole("button", { name: "Try again" });
    await expect(retry).toBeVisible();
    await retry.focus();
    await expect(retry).toBeFocused();
  });
});
