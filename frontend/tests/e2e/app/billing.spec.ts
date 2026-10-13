import type { Page } from "@playwright/test";
import { expect, expectNoHorizontalOverflow, mainNav, MOCK_SUPABASE_URL, SIGNED_OUT, signIn, test } from "../support/app";
import { refusal, stubApi } from "../support/day5";

// /dashboard/billing (Day 6, Dev 3). GET /api/billing/balance (Dev 2, #140) is stood in for with page.route using the full AccountStatus shape;
// the plans catalogue and credit_ledger reads are stood in for the same way (their real RLS is the database's, not tested here). The checkout,
// top-up and change-plan routes, the Razorpay webhook and invoices do not exist on the API, so this screen has no button for any of them and
// these tests prove that: they show how each answer is drawn and that nothing claims a payment, not that payments work.

const BALANCE = /\/api\/billing\/balance$/;
const status = (over: Record<string, unknown> = {}) => ({
  status: "active",
  plan: { key: "growth", name: "Growth", monthlyCredits: 1500 },
  credits: { plan: 900, topup: 100, total: 1000 },
  creditsGranted: 1600,
  renewsAt: "2026-11-01T00:00:00.000Z",
  trialEndsAt: null,
  aiPaused: false,
  aiPausedReason: null,
  lowCredits: false,
  aiAutoReply: true,
  ...over,
});
const PLAN_ROWS = [
  { key: "trial", name: "Trial", price_inr: 0, monthly_credits: 100, seats: 1, whatsapp_numbers: 1 },
  { key: "starter", name: "Starter", price_inr: 999, monthly_credits: 600, seats: 2, whatsapp_numbers: 1 },
  { key: "growth", name: "Growth", price_inr: 2499, monthly_credits: 1500, seats: 5, whatsapp_numbers: 1 },
  { key: "pro", name: "Pro", price_inr: 4999, monthly_credits: 4000, seats: 10, whatsapp_numbers: 3 },
];
const ledger = (tenantId: string, n: number, over: Record<string, unknown> = {}) => ({
  id: n,
  tenant_id: tenantId,
  delta: -1,
  reason: "ai_reply",
  expires_at: null,
  created_at: `2026-10-${String(10 + (n % 9)).padStart(2, "0")}T10:00:00.000Z`,
  ...over,
});

/** Answers the page's REST reads of one table (not the API), optionally failing the first one. */
async function stubTable(page: Page, table: string, rows: (tenantId: string | null) => unknown, failFirst = false) {
  const queries: URLSearchParams[] = [];
  await page.route((url) => url.pathname === `/rest/v1/${table}`, (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fallback();
    const url = new URL(req.url());
    queries.push(url.searchParams);
    const fail = failFirst && queries.length === 1;
    return route.fulfill({
      status: fail ? 500 : 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": req.headers()["origin"] ?? "*" },
      body: JSON.stringify(fail ? { message: "boom" } : rows(url.searchParams.get("tenant_id")?.replace(/^eq\./, "") ?? null)),
    });
  });
  return queries;
}


test.describe("Billing", () => {
  test("owner: plan and status, credits, plans from the catalogue, credit history, and no way to pay", async ({ page }) => {
    await stubApi(page, BALANCE, () => ({ status: 200, body: status() }));
    await stubTable(page, "plans", () => PLAN_ROWS);
    const asked = await stubTable(page, "credit_ledger", (tenantId) => [
      ledger(tenantId ?? "", 3, { delta: 1000, reason: "topup", expires_at: "2027-01-01T00:00:00.000Z" }),
      ledger(tenantId ?? "", 2),
    ]);
    await page.goto("/dashboard/billing");
    await expect(page.getByRole("heading", { level: 1, name: "Billing and credits" })).toBeVisible();
    await expect(mainNav(page).getByRole("link", { name: "Billing", exact: true })).toHaveAttribute("aria-current", "page");

    const plan = page.getByTestId("plan-card");
    await expect(plan).toContainText("Growth");
    await expect(plan).toContainText("Active");
    await expect(plan).toContainText("1,500");
    await expect(page.getByTestId("renews-at")).toHaveText("1 Nov 2026");
    await expect(page.getByTestId("billing-paused")).toHaveCount(0);
    await expect(page.getByTestId("credit-total")).toHaveText("1,000");
    await expect(page.getByTestId("credit-card")).toContainText("900 from your plan and 100 from top-ups");

    // Plans: from the catalogue, cheapest first, trial left out, compared with the current plan by price.
    const plans = page.getByTestId("plan-list").locator("[data-plan]");
    await expect(plans).toHaveCount(3);
    await expect(plans.nth(0)).toHaveAttribute("data-relation", "downgrade");
    await expect(plans.nth(1)).toHaveAttribute("data-relation", "current");
    await expect(plans.nth(2)).toHaveAttribute("data-relation", "upgrade");
    await expect(plans.nth(2)).toContainText("₹4,999");
    await expect(plans.nth(2)).toContainText("10 team seats · 3 WhatsApp numbers");

    // History: this business only, newest first, words for the reasons.
    expect(asked[0].get("tenant_id")).toMatch(/^eq\./);
    await expect(page.getByTestId("credit-history").locator("li")).toHaveCount(2);
    await expect(page.getByTestId("credit-history").locator("li").first()).toContainText("Credit top-up");
    await expect(page.getByTestId("credit-history").locator("li").first()).toContainText("+1,000");
    await expect(page.getByTestId("credit-history").locator("li").first()).toContainText("expires 1 Jan 2027");
    await expect(page.getByTestId("credit-history").locator("li").nth(1)).toContainText("AI reply");

    // Paying isn't there, and the screen says so: no buy, upgrade, downgrade or top-up control, and invoices are not listed.
    await expect(page.getByTestId("payments-unavailable")).toContainText("isn't switched on yet");
    await expect(page.getByRole("button", { name: /buy|pay|upgrade|downgrade|top up|subscribe|checkout/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /buy|pay|top up|checkout/i })).toHaveCount(0);
    await expect(page.getByText("Invoices aren't available yet")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("a trial counts down and says to pick a plan; the paused reason is spelled out", async ({ page }) => {
    const trialEndsAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
    await stubApi(page, BALANCE, () => ({ status: 200, body: status({ status: "trial", plan: { key: "trial", name: "Free trial", monthlyCredits: 100 }, renewsAt: null, trialEndsAt }) }));
    await stubTable(page, "plans", () => PLAN_ROWS);
    await stubTable(page, "credit_ledger", () => []);
    await page.goto("/dashboard/billing");
    await expect(page.getByTestId("trial-ends")).toContainText("3 days left");
    await expect(page.getByTestId("trial-prompt")).toBeVisible();
    await expect(page.getByTestId("plan-list").locator('[data-relation="upgrade"]')).toHaveCount(3);
    await expect(page.getByText("No credit activity yet")).toBeVisible();
  });

  for (const [reason, title] of [
    ["no_credits", "Assistant paused: out of credits"],
    ["trial_ended", "Assistant paused: your free trial has ended"],
    ["whatsapp_not_connected", "Assistant paused: no WhatsApp number is connected"],
    ["paused", "Assistant paused: your account is paused"],
    ["cancelled", "Assistant paused: your subscription is cancelled"],
  ] as const) {
    test(`shows why the assistant is paused: ${reason}`, async ({ page }) => {
      await stubApi(page, BALANCE, () => ({ status: 200, body: status({ aiPaused: true, aiPausedReason: reason, lowCredits: true }) }));
      await stubTable(page, "plans", () => PLAN_ROWS);
      await stubTable(page, "credit_ledger", () => []);
      await page.goto("/dashboard/billing");
      await expect(page.getByTestId("billing-paused")).toHaveAttribute("data-reason", reason);
      await expect(page.getByTestId("billing-paused")).toContainText(title);
      await expect(page.getByTestId("credit-card")).toContainText("Running low");
    });
  }

  test("each part fails on its own with Try again, and a bad answer is refused", async ({ page }) => {
    await stubApi(page, BALANCE, (n) => (n === 1 ? refusal(500, "internal", "Something went wrong. Try again in a moment.") : { status: 200, body: status() }));
    await stubTable(page, "plans", () => PLAN_ROWS);
    await stubTable(page, "credit_ledger", () => [{ id: 1 }], false);
    await page.goto("/dashboard/billing");
    await expect(page.locator('[role="alert"].app-state').filter({ hasText: "Couldn't load your plan" })).toBeVisible();
    await expect(page.locator('[role="alert"].app-state').filter({ hasText: "Couldn't load your credits" })).toBeVisible();
    await expect(page.locator('[role="alert"].app-state').filter({ hasText: "Couldn't load credit history" })).toBeVisible();
    // The plans still drew.
    await expect(page.getByTestId("plan-list")).toBeVisible();
    await page.getByRole("button", { name: "Try again" }).first().click();
    await expect(page.getByTestId("plan-card")).toContainText("Growth");
  });

  test("a balance route the server doesn't have is said so, with no figures", async ({ page }) => {
    await stubApi(page, BALANCE, () => refusal(404, "not_found", "Not found."));
    await stubTable(page, "plans", () => PLAN_ROWS);
    await stubTable(page, "credit_ledger", () => []);
    await page.goto("/dashboard/billing");
    await expect(page.getByText("Your plan isn't available yet")).toBeVisible();
    await expect(page.getByTestId("credit-total")).toHaveCount(0);
    await expect(page.getByTestId("plan-list").locator('[data-relation="current"]')).toHaveCount(0);
  });

  test("shows the newest 50 and says older entries aren't listed", async ({ page }) => {
    await stubApi(page, BALANCE, () => ({ status: 200, body: status() }));
    await stubTable(page, "plans", () => PLAN_ROWS);
    await stubTable(page, "credit_ledger", (t) => Array.from({ length: 50 }, (_, i) => ledger(t ?? "", i + 1)));
    await page.goto("/dashboard/billing");
    await expect(page.getByTestId("credit-history").locator("li")).toHaveCount(50);
    await expect(page.getByTestId("history-truncated")).toBeVisible();
  });
});

test.describe("Billing · staff", () => {
  test.use({ storageState: SIGNED_OUT });

  test("staff are told billing is for owners and admins, and nothing is fetched", async ({ page, request }) => {
    const account = (await (await request.post(`${MOCK_SUPABASE_URL}/__mock/team-account`, { data: { role: "staff" } })).json()) as { email: string };
    const calls = await stubApi(page, BALANCE, () => ({ status: 200, body: status() }));
    const reads: string[] = [];
    page.on("request", (r) => {
      const path = new URL(r.url()).pathname;
      if (path === "/rest/v1/credit_ledger" || path === "/rest/v1/plans") reads.push(path);
    });
    await signIn(page, account.email, "/dashboard/billing");
    await expect(page.getByTestId("billing-no-access")).toBeVisible();
    await expect(page.getByTestId("plan-card")).toHaveCount(0);
    expect(calls).toHaveLength(0);
    expect(reads).toEqual([]);
  });
});
