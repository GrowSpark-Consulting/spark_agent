import type { Page } from "@playwright/test";
import { expect, expectNoHorizontalOverflow, mainNav, MOCK_SUPABASE_URL, SIGNED_OUT, signIn, test } from "../support/app";
import { refusal, stubApi } from "../support/day5";

// /dashboard/billing (Day 6, Dev 3). GET /api/billing/balance (Dev 2, #140) is stood in for with page.route using the full AccountStatus shape;
// the plans catalogue and credit_ledger reads are stood in for the same way (their real RLS is the database's, not tested here). The PayU
// routes (checkout, top-up, setup fee, change plan, payment status; docs/contracts.md) are stood in for too, and PayU's hosted page is a
// page.route that records the form the browser posts to it. So these tests prove what the screen sends, what it does with each documented
// answer and when it re-reads the plan: not that the real routes agree, and not that a real PayU payment works (no PayU test merchant here).

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

    // An owner on a paid plan can change plan, top up and pay the setup fee; no invoice list exists, and the screen says so.
    await expect(page.getByTestId("plan-action-pro")).toHaveText("Upgrade to Pro");
    await expect(page.getByTestId("plan-action-starter")).toHaveText("Switch to Starter at renewal");
    await expect(page.getByTestId("plan-action-growth")).toHaveText("Keep this plan");
    await expect(page.getByTestId("topup-card")).toContainText("1,000 credits");
    await expect(page.getByTestId("topup-card")).toContainText("₹1,199");
    await expect(page.getByTestId("setup-fee-card")).toContainText("₹4,999");
    await expect(page.getByText("No invoice list yet")).toBeVisible();
    await expect(page.getByText(/razorpay|not on the API|isn't switched on yet/i)).toHaveCount(0);
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

// Paying (owner) --------------------------------------------------------------------------------------------------

const CHECKOUT = /\/api\/billing\/checkout$/;
const TOPUP = /\/api\/billing\/topup$/;
const SETUP_FEE = /\/api\/billing\/setup-fee$/;
const CHANGE_PLAN = /\/api\/billing\/change-plan$/;
const PAYMENT_ROUTE = /\/api\/billing\/payments\/[^/]+$/;
const PAYU_URL = "https://test.payu.in/_payment";
const PAYMENT = "20000000-0000-4000-8000-000000000002";
const FIELDS = { key: "e2e-merchant", txnid: "subscribe_e2e1", amount: "2948.82", productinfo: "Spark Agent Growth plan (yearly)", hash: "e2e-signed-hash", surl: "http://127.0.0.1:4100/api/billing/payu/return" };
const PAYU_CHECKOUT = { paymentId: PAYMENT, payu: { url: PAYU_URL, fields: FIELDS } };
const NEEDS_PHONE = { status: 422, body: { error: { code: "validation_failed", message: "Enter a phone number for the payment.", fields: { phone: "Enter the number with country code, like +919840012345" } } } };
const TRIAL = { status: "trial", plan: { key: "trial", name: "Free trial", monthlyCredits: 100 }, renewsAt: null, trialEndsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() };

/** PayU's hosted page: records each form the browser posts to it (method, fields, and whether our bearer token went along). */
async function stubPayu(page: Page) {
  const posts: { method: string; fields: Record<string, string>; authorization: string | null }[] = [];
  await page.route(PAYU_URL, (route) => {
    const req = route.request();
    posts.push({ method: req.method(), fields: Object.fromEntries(new URLSearchParams(req.postData() ?? "")), authorization: req.headers()["authorization"] ?? null });
    return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>PayU</title><p>PayU test checkout</p>" });
  });
  return posts;
}

async function openBilling(page: Page, over: Record<string, unknown> = {}, path = "/dashboard/billing") {
  const balance = await stubApi(page, BALANCE, () => ({ status: 200, body: status(over) }));
  await stubTable(page, "plans", () => PLAN_ROWS);
  await stubTable(page, "credit_ledger", () => []);
  await page.goto(path);
  await expect(page.getByTestId("plan-card")).toBeVisible();
  return balance;
}

test.describe("Billing · paying", () => {
  test("a trial owner chooses a plan and cycle: the API starts the payment and the browser POSTs PayU's fields to PayU", async ({ page }) => {
    const calls = await stubApi(page, CHECKOUT, () => ({ status: 200, body: PAYU_CHECKOUT }));
    const posts = await stubPayu(page);
    await openBilling(page, TRIAL);

    await page.getByLabel("Yearly (10 months for 12)").check();
    await expect(page.getByTestId("plan-list").locator('[data-plan="growth"]')).toContainText("₹24,990");
    await expect(page.getByTestId("plan-action-growth")).toHaveText("Choose Growth");
    await page.getByTestId("plan-action-growth").click();

    await expect.poll(() => posts.length).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ planKey: "growth", cycle: "yearly" });
    expect(calls[0].tenant).not.toBeNull();
    expect(calls[0].authorization).toMatch(/^Bearer /);
    // A real form post to PayU's address, carrying exactly the fields the API gave, and not our bearer token.
    expect(posts[0]).toEqual({ method: "POST", fields: FIELDS, authorization: null });
    await expect(page).toHaveURL(PAYU_URL);
  });

  test("a second click while the request runs does nothing, and every payment button is off meanwhile", async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls = await stubApi(page, CHECKOUT, async () => {
      await gate;
      return { status: 200, body: PAYU_CHECKOUT };
    });
    const posts = await stubPayu(page);
    await openBilling(page, TRIAL);

    // Two clicks in the same tick, before React can re-render: only the lock stops the second.
    await page.getByTestId("plan-action-growth").evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    await expect(page.getByTestId("plan-action-growth")).toHaveText("Opening PayU…");
    for (const id of ["plan-action-starter", "plan-action-pro", "setup-fee-action"]) await expect(page.getByTestId(id)).toBeDisabled();
    await page.getByTestId("plan-action-growth").click({ force: true });
    release();
    await expect.poll(() => posts.length).toBe(1);
    expect(calls).toHaveLength(1);
  });

  test("top-up and the setup fee send no body, then post to PayU", async ({ page }) => {
    const topup = await stubApi(page, TOPUP, () => ({ status: 200, body: PAYU_CHECKOUT }));
    const fee = await stubApi(page, SETUP_FEE, () => ({ status: 200, body: PAYU_CHECKOUT }));
    const posts = await stubPayu(page);
    await openBilling(page);
    await page.getByTestId("topup-action").click();
    await expect.poll(() => posts.length).toBe(1);
    expect(topup).toHaveLength(1);
    expect(topup[0].body).toBeNull();
    expect(fee).toHaveLength(0);

    await page.goBack();
    await expect(page.getByTestId("plan-card")).toBeVisible();
    await page.getByTestId("setup-fee-action").click();
    await expect.poll(() => posts.length).toBe(2);
    expect(fee).toHaveLength(1);
    expect(fee[0].body).toBeNull();
    expect(posts[1]).toEqual({ method: "POST", fields: FIELDS, authorization: null });
  });

  test("a top-up is offered only on a paid plan", async ({ page }) => {
    await openBilling(page, TRIAL);
    await expect(page.getByTestId("topup-action")).toHaveCount(0);
    await expect(page.getByTestId("topup-card")).toContainText("paid plan");
  });

  test("when the API needs a phone, the screen asks, checks it, and sends it with the retry", async ({ page }) => {
    const calls = await stubApi(page, TOPUP, (n, call) => (n === 1 && !(call.body as { phone?: string } | null)?.phone ? NEEDS_PHONE : { status: 200, body: PAYU_CHECKOUT }));
    const posts = await stubPayu(page);
    await openBilling(page);

    await page.getByTestId("topup-action").click();
    const prompt = page.getByTestId("phone-prompt");
    await expect(prompt).toContainText("Enter the number with country code");
    expect(posts).toHaveLength(0);

    // A number that isn't E.164 is refused here, before any request.
    await prompt.getByLabel("Phone number for the payment").fill("98400 12345");
    await prompt.getByRole("button", { name: "Continue to PayU" }).click();
    await expect(prompt).toContainText("Enter the number with country code");
    expect(calls).toHaveLength(1);

    await prompt.getByLabel("Phone number for the payment").fill("+919840012345");
    await prompt.getByRole("button", { name: "Continue to PayU" }).click();
    await expect.poll(() => posts.length).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toEqual({ phone: "+919840012345" });
  });

  test("cancelling the phone prompt starts nothing", async ({ page }) => {
    await stubApi(page, CHECKOUT, () => NEEDS_PHONE);
    const posts = await stubPayu(page);
    await openBilling(page, TRIAL);
    await page.getByTestId("plan-action-starter").click();
    await expect(page.getByTestId("phone-prompt")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("phone-prompt")).toHaveCount(0);
    await expect(page.getByTestId("plan-action-starter")).toBeEnabled();
    expect(posts).toHaveLength(0);
  });

  test("an upgrade opens PayU with the change-plan body (no cycle, no price)", async ({ page }) => {
    const calls = await stubApi(page, CHANGE_PLAN, () => ({ status: 200, body: { action: "upgrade", ...PAYU_CHECKOUT } }));
    const posts = await stubPayu(page);
    await openBilling(page);
    await page.getByTestId("plan-action-pro").click();
    await expect.poll(() => posts.length).toBe(1);
    expect(calls[0].body).toEqual({ planKey: "pro" });
    expect(posts[0].fields).toEqual(FIELDS);
  });

  for (const [action, button, answer, text] of [
    ["scheduled", "plan-action-starter", { action: "scheduled", planKey: "starter", effectiveAt: "2026-11-01T00:00:00.000Z" }, "Your plan changes to Starter on 1 Nov 2026"],
    ["kept", "plan-action-growth", { action: "kept" }, "scheduled is cancelled"],
    ["unchanged", "plan-action-growth", { action: "unchanged" }, "already on that plan"],
  ] as const) {
    test(`change plan: ${action} is shown as done and never opens PayU or re-reads the plan`, async ({ page }) => {
      await stubApi(page, CHANGE_PLAN, () => ({ status: 200, body: answer }));
      const posts = await stubPayu(page);
      const balance = await openBilling(page);
      await page.getByTestId(button).click();
      await expect(page.getByTestId("billing-action-done")).toContainText(text);
      await expect(page.getByTestId(button)).toBeEnabled();
      expect(posts).toHaveLength(0);
      expect(page.url()).toContain("/dashboard/billing");
      expect(balance).toHaveLength(1);
    });
  }

  for (const [name, answer, shown] of [
    ["the owner-only refusal", refusal(403, "forbidden", "Only the business owner can choose a plan."), "Only the business owner can choose a plan."],
    ["a business that already has a plan", refusal(409, "conflict", "Your business already has a plan. Change it from Billing instead."), "already has a plan"],
    ["payments not switched on", refusal(501, "not_available", "Payments aren't switched on yet. Try again later."), "Payments aren't switched on yet"],
    ["a server error", refusal(500, "internal", "Something went wrong. Try again in a moment."), "Something went wrong"],
    ["an answer that is not PayU's form details", { status: 200, body: { paymentId: PAYMENT, payu: { url: PAYU_URL, fields: { hash: 5 } } } }, "nothing was charged"],
    ["a checkout address that is not https", { status: 200, body: { paymentId: PAYMENT, payu: { url: "http://test.payu.in/_payment", fields: FIELDS } } }, "nothing was charged"],
  ] as const) {
    test(`checkout: ${name} is said plainly, nothing is posted, and the button works again`, async ({ page }) => {
      const calls = await stubApi(page, CHECKOUT, () => answer);
      const posts = await stubPayu(page);
      await openBilling(page, TRIAL);
      await page.getByTestId("plan-action-pro").click();
      await expect(page.getByTestId("billing-action-error")).toContainText(shown);
      await expect(page.getByTestId("plan-action-pro")).toBeEnabled();
      expect(posts).toHaveLength(0);
      expect(page.url()).toContain("/dashboard/billing");
      // Nothing secret is drawn from the answer.
      await expect(page.locator("body")).not.toContainText("e2e-signed-hash");
      await page.getByTestId("plan-action-pro").click();
      await expect.poll(() => calls.length).toBe(2);
    });
  }

  test("a network failure is said as such and nothing is posted", async ({ page }) => {
    await page.route(CHECKOUT, (route) => (route.request().method() === "OPTIONS" ? route.fallback() : route.abort("failed")));
    const posts = await stubPayu(page);
    await openBilling(page, TRIAL);
    await page.getByTestId("plan-action-pro").click();
    await expect(page.getByTestId("billing-action-error")).toContainText("offline");
    await expect(page.getByTestId("plan-action-pro")).toBeEnabled();
    expect(posts).toHaveLength(0);
  });

  test("a payment on a narrow screen fits without sideways scrolling", async ({ page }) => {
    await stubApi(page, CHECKOUT, () => NEEDS_PHONE);
    await openBilling(page, TRIAL);
    await page.getByTestId("plan-action-pro").click();
    await expect(page.getByTestId("phone-prompt")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});

// Back from PayU -------------------------------------------------------------------------------------------------

test.describe("Billing · back from PayU", () => {
  const URL_FOR = (id: string) => `/dashboard/billing?payment=${id}`;
  const payment = (st: string, over: Record<string, unknown> = {}) => ({ id: PAYMENT, kind: "subscribe", status: st, amountInr: 2948.82, failureReason: null, createdAt: "2026-10-13T10:00:00.000Z", ...over });
  const banner = (page: Page) => page.getByTestId("payment-return");
  /**
   * Moves the page's clock 5 seconds at a time (the poll's pace) until the banner stops saying "checking". The installed clock also runs
   * in real time, so the one-minute window ends after somewhat fewer than 13 reads, depending on the machine; the exact pace is pinned in
   * payment-poll.test.ts on a fake clock, and these tests assert a sane range and the state.
   */
  async function runPollingToTheEnd(page: Page) {
    for (let i = 0; i < 40; i += 1) {
      if ((await banner(page).getAttribute("data-state")) !== "checking") return;
      await page.clock.runFor(5_000);
      await page.waitForTimeout(100);
    }
  }

  test("the address alone proves nothing: it reads 'checking' until the API says success, then re-reads the plan once", async ({ page }) => {
    await page.clock.install();
    const calls = await stubApi(page, PAYMENT_ROUTE, (n) => ({ status: 200, body: payment(n === 1 ? "created" : n === 2 ? "pending" : "success") }));
    const balance = await stubApi(page, BALANCE, () => ({ status: 200, body: status() }));
    await stubTable(page, "plans", () => PLAN_ROWS);
    await stubTable(page, "credit_ledger", () => []);
    await page.goto(URL_FOR(PAYMENT));

    await expect(banner(page)).toHaveAttribute("data-state", "checking");
    await expect(banner(page)).not.toContainText("Payment confirmed");
    await expect.poll(() => calls.length).toBeGreaterThan(0);
    expect(calls[0].url.pathname).toBe(`/api/billing/payments/${PAYMENT}`);
    expect(calls[0].tenant).not.toBeNull();
    await page.clock.runFor(5_000);
    await expect.poll(() => calls.length).toBe(2);
    await expect(banner(page)).toHaveAttribute("data-state", "checking");
    expect(balance).toHaveLength(1);

    await page.clock.runFor(5_000);
    await expect(banner(page)).toHaveAttribute("data-state", "success");
    await expect(banner(page)).toContainText("Payment confirmed");
    await expect(banner(page)).toContainText("Your plan is active");
    await expect(banner(page)).toContainText("₹2,948.82");
    // Re-read only now that the API has confirmed it, and no more polling after that.
    await expect.poll(() => balance.length).toBe(2);
    await page.clock.runFor(30_000);
    expect(calls).toHaveLength(3);
    expect(balance).toHaveLength(2);
  });

  test("a failed payment says so with PayU's reason, changes nothing, and still re-reads the plan", async ({ page }) => {
    const calls = await stubApi(page, PAYMENT_ROUTE, () => ({ status: 200, body: payment("failed", { kind: "topup", failureReason: "Insufficient funds" }) }));
    const balance = await openBilling(page, {}, URL_FOR(PAYMENT));
    await expect(banner(page)).toHaveAttribute("data-state", "failed");
    await expect(banner(page)).toContainText("didn't go through");
    await expect(banner(page)).toContainText("Insufficient funds");
    await expect(banner(page)).toContainText("weren't changed");
    await expect.poll(() => balance.length).toBe(2);
    expect(calls).toHaveLength(1);
  });

  test("a payment still pending after about a minute is 'still processing', never success, with no plan re-read", async ({ page }) => {
    await page.clock.install();
    const calls = await stubApi(page, PAYMENT_ROUTE, () => ({ status: 200, body: payment("pending") }));
    const balance = await stubApi(page, BALANCE, () => ({ status: 200, body: status() }));
    await stubTable(page, "plans", () => PLAN_ROWS);
    await stubTable(page, "credit_ledger", () => []);
    await page.goto(URL_FOR(PAYMENT));
    await runPollingToTheEnd(page);
    expect(calls.length).toBeGreaterThanOrEqual(8);
    expect(calls.length).toBeLessThanOrEqual(13);
    await expect(banner(page)).toHaveAttribute("data-state", "processing");
    await expect(banner(page)).toContainText("Still processing");
    await expect(banner(page)).not.toContainText("Payment confirmed");
    const reads = calls.length;
    await page.clock.runFor(60_000);
    expect(calls).toHaveLength(reads);
    expect(balance).toHaveLength(1);
  });

  test("Check again after 'still processing' asks again and shows what the API then says", async ({ page }) => {
    await page.clock.install();
    let confirmed = false;
    const calls = await stubApi(page, PAYMENT_ROUTE, () => ({ status: 200, body: payment(confirmed ? "success" : "pending") }));
    const balance = await stubApi(page, BALANCE, () => ({ status: 200, body: status() }));
    await stubTable(page, "plans", () => PLAN_ROWS);
    await stubTable(page, "credit_ledger", () => []);
    await page.goto(URL_FOR(PAYMENT));
    await runPollingToTheEnd(page);
    expect(calls.length).toBeGreaterThanOrEqual(8);
    expect(calls.length).toBeLessThanOrEqual(13);
    await expect(banner(page)).toHaveAttribute("data-state", "processing");
    confirmed = true;
    await banner(page).getByRole("button", { name: "Check again" }).click();
    await expect(banner(page)).toHaveAttribute("data-state", "success");
    await expect.poll(() => balance.length).toBe(2);
  });

  test("an id that is not a payment id ('unknown') makes no request and changes nothing", async ({ page }) => {
    const calls = await stubApi(page, PAYMENT_ROUTE, () => ({ status: 200, body: payment("success") }));
    const balance = await openBilling(page, {}, URL_FOR("unknown"));
    await expect(banner(page)).toHaveAttribute("data-state", "invalid");
    await expect(banner(page)).toContainText("couldn't find that payment");
    expect(calls).toHaveLength(0);
    expect(balance).toHaveLength(1);
  });

  test("a payment id the API does not know for this business is 'not found', not success", async ({ page }) => {
    const calls = await stubApi(page, PAYMENT_ROUTE, () => refusal(404, "not_found", "That payment was not found."));
    const balance = await openBilling(page, {}, URL_FOR(PAYMENT));
    await expect(banner(page)).toHaveAttribute("data-state", "invalid");
    expect(calls).toHaveLength(1);
    expect(balance).toHaveLength(1);
  });

  test("an answer that is not a payment is an error, with no plan re-read", async ({ page }) => {
    await stubApi(page, PAYMENT_ROUTE, () => ({ status: 200, body: { id: PAYMENT, status: "paid" } }));
    const balance = await openBilling(page, {}, URL_FOR(PAYMENT));
    await expect(banner(page)).toHaveAttribute("data-state", "error");
    await expect(banner(page)).toContainText("couldn't confirm the payment");
    expect(balance).toHaveLength(1);
  });

  test("repeated network failures end in an error with Check again, not in a made-up result", async ({ page }) => {
    await page.clock.install();
    let reads = 0;
    await page.route(PAYMENT_ROUTE, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback();
      reads += 1;
      return route.abort("failed");
    });
    const balance = await stubApi(page, BALANCE, () => ({ status: 200, body: status() }));
    await stubTable(page, "plans", () => PLAN_ROWS);
    await stubTable(page, "credit_ledger", () => []);
    await page.goto(URL_FOR(PAYMENT));
    for (let i = 1; i <= 3; i += 1) {
      await expect.poll(() => reads).toBe(i);
      if (i < 3) await page.clock.runFor(5_000);
    }
    await expect(banner(page)).toHaveAttribute("data-state", "error");
    await expect(banner(page)).toContainText("offline");
    await expect(banner(page).getByRole("button", { name: "Check again" })).toBeVisible();
    expect(balance).toHaveLength(1);
  });

  test("Dismiss removes ?payment= from the address", async ({ page }) => {
    await stubApi(page, PAYMENT_ROUTE, () => ({ status: 200, body: payment("success") }));
    await openBilling(page, {}, URL_FOR(PAYMENT));
    await expect(banner(page)).toHaveAttribute("data-state", "success");
    await banner(page).getByRole("button", { name: "Dismiss" }).click();
    await expect(banner(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/dashboard\/billing$/);
  });

  test("opening the same return link again after it settled shows the same confirmed result", async ({ page }) => {
    const calls = await stubApi(page, PAYMENT_ROUTE, () => ({ status: 200, body: payment("success") }));
    await openBilling(page, {}, URL_FOR(PAYMENT));
    await expect(banner(page)).toHaveAttribute("data-state", "success");
    await page.reload();
    await expect(banner(page)).toHaveAttribute("data-state", "success");
    expect(calls).toHaveLength(2);
  });
});

// Cancel plan and Keep my plan (POST /api/billing/cancel and /resume, owner only) --------------------------------------------------

const CANCEL = /\/api\/billing\/cancel$/;
const RESUME = /\/api\/billing\/resume$/;
const ENDS = "2026-11-01T00:00:00.000Z";

/** Opens Billing for an owner; the first balance read is `first`, every later one is `later`. */
async function openCancelable(page: Page, first: Record<string, unknown>, later: Record<string, unknown> = first) {
  const balance = await stubApi(page, BALANCE, (n) => ({ status: 200, body: status(n === 1 ? first : later) }));
  await stubTable(page, "plans", () => PLAN_ROWS);
  await stubTable(page, "credit_ledger", () => []);
  await page.goto("/dashboard/billing");
  await expect(page.getByTestId("plan-card")).toBeVisible();
  return balance;
}
const dialog = (page: Page) => page.getByRole("dialog");

test.describe("Billing · cancel and keep", () => {
  test("Cancel plan asks first, names the end date, and Keep my plan sends nothing", async ({ page }) => {
    const calls = await stubApi(page, CANCEL, () => ({ status: 200, body: { status: "scheduled", endsAt: ENDS } }));
    await openCancelable(page, {});
    await page.getByRole("button", { name: "Cancel plan" }).click();
    await expect(dialog(page)).toContainText("ends on 1 Nov 2026");
    await expect(dialog(page)).toContainText("you can change your mind before that day");
    await expectNoHorizontalOverflow(page);
    await dialog(page).getByRole("button", { name: "Keep my plan" }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(calls).toHaveLength(0);
  });

  test("confirming cancels with no body, re-reads the plan, and shows it as ending and not renewing", async ({ page }) => {
    const calls = await stubApi(page, CANCEL, () => ({ status: 200, body: { status: "scheduled", endsAt: ENDS } }));
    const balance = await openCancelable(page, {}, { renewsAt: null, endsAt: ENDS });
    await page.getByRole("button", { name: "Cancel plan" }).click();
    await dialog(page).getByRole("button", { name: "Cancel plan" }).click();
    await expect(page.getByTestId("plan-ending-done")).toContainText("stays active until 1 Nov 2026 and won't renew");
    await expect(dialog(page)).toHaveCount(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toBeNull();
    expect(calls[0].tenant).not.toBeNull();
    // The card shows what the server now says, not what the button assumed.
    await expect(page.getByTestId("plan-ends")).toContainText("Your plan is cancelled.");
    await expect(page.getByTestId("ends-at")).toHaveText("1 Nov 2026");
    await expect(page.getByTestId("renews-at")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Cancel plan" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Keep my plan" })).toBeVisible();
    expect(balance).toHaveLength(2);
  });

  test("a past-due plan that ends now says the assistant is paused (what the API answered)", async ({ page }) => {
    await stubApi(page, CANCEL, () => ({ status: 200, body: { status: "ended" } }));
    await openCancelable(page, {}, { status: "paused", aiPaused: true, aiPausedReason: "paused", renewsAt: null });
    await page.getByRole("button", { name: "Cancel plan" }).click();
    await dialog(page).getByRole("button", { name: "Cancel plan" }).click();
    await expect(page.getByTestId("plan-ending-done")).toContainText("Your plan has ended and your assistant is paused");
    await expect(page.getByTestId("plan-card")).toHaveAttribute("data-status", "paused");
    await expect(page.getByRole("button", { name: "Cancel plan" })).toHaveCount(0);
  });

  for (const [name, answer, shown] of [
    ["the owner-only refusal", refusal(403, "forbidden", "Only the business owner can cancel the plan."), "Only the business owner can cancel the plan."],
    ["no plan to cancel", refusal(409, "conflict", "There is no plan to cancel."), "There is no plan to cancel."],
    ["a server error", refusal(500, "internal", "Something went wrong. Try again in a moment."), "Something went wrong"],
    ["an answer that is not a cancel result", { status: 200, body: { status: "refunded" } }, "answered something we didn't expect"],
  ] as const) {
    test(`cancel: ${name} keeps the dialog open with the reason and claims nothing`, async ({ page }) => {
      await stubApi(page, CANCEL, () => answer);
      const balance = await openCancelable(page, {});
      await page.getByRole("button", { name: "Cancel plan" }).click();
      await dialog(page).getByRole("button", { name: "Cancel plan" }).click();
      await expect(dialog(page)).toContainText(shown);
      await expect(page.getByTestId("plan-ending-done")).toHaveCount(0);
      await expect(page.getByTestId("plan-ends")).toHaveCount(0);
      expect(balance).toHaveLength(1);
    });
  }

  test("one press of Cancel plan is one request", async ({ page }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const calls = await stubApi(page, CANCEL, async () => {
      await gate;
      return { status: 200, body: { status: "scheduled", endsAt: ENDS } };
    });
    await openCancelable(page, {}, { renewsAt: null, endsAt: ENDS });
    await page.getByRole("button", { name: "Cancel plan" }).click();
    await dialog(page).getByRole("button", { name: "Cancel plan" }).click();
    await expect(dialog(page).getByRole("button", { name: "Cancelling…" })).toBeDisabled();
    release();
    await expect(page.getByTestId("plan-ending-done")).toBeVisible();
    expect(calls).toHaveLength(1);
  });

  test("Keep my plan resumes with no body, says when it renews, and re-reads the plan", async ({ page }) => {
    const calls = await stubApi(page, RESUME, () => ({ status: 200, body: { renewsAt: ENDS } }));
    const balance = await openCancelable(page, { renewsAt: null, endsAt: ENDS }, { renewsAt: ENDS, endsAt: null });
    await expect(page.getByTestId("plan-ends")).toContainText("stays active until 1 Nov 2026");
    await page.getByRole("button", { name: "Keep my plan" }).click();
    await expect(page.getByTestId("plan-ending-done")).toContainText("Your plan will renew on 1 Nov 2026");
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toBeNull();
    await expect(page.getByTestId("plan-ends")).toHaveCount(0);
    await expect(page.getByTestId("renews-at")).toHaveText("1 Nov 2026");
    await expect(page.getByRole("button", { name: "Cancel plan" })).toBeVisible();
    expect(balance).toHaveLength(2);
  });

  test("a refused resume says why and leaves the plan shown as ending", async ({ page }) => {
    await stubApi(page, RESUME, () => refusal(409, "conflict", "There is no cancelled plan to keep."));
    const balance = await openCancelable(page, { renewsAt: null, endsAt: ENDS });
    await page.getByRole("button", { name: "Keep my plan" }).click();
    await expect(page.getByTestId("plan-ending-error")).toContainText("There is no cancelled plan to keep.");
    await expect(page.getByTestId("plan-ends")).toBeVisible();
    await expect(page.getByTestId("plan-ending-done")).toHaveCount(0);
    expect(balance).toHaveLength(1);
  });

  test("a trial has nothing to cancel", async ({ page }) => {
    await openCancelable(page, TRIAL);
    await expect(page.getByTestId("plan-ending")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Cancel plan" })).toHaveCount(0);
  });
});

// Who can pay ----------------------------------------------------------------------------------------------------

test.describe("Billing · admin", () => {
  test.use({ storageState: SIGNED_OUT });

  test("an admin sees the plans but no payment buttons, and is told only the owner pays", async ({ page, request }) => {
    const account = (await (await request.post(`${MOCK_SUPABASE_URL}/__mock/team-account`, { data: { role: "admin" } })).json()) as { email: string };
    const calls = await stubApi(page, CHECKOUT, () => ({ status: 200, body: PAYU_CHECKOUT }));
    await stubApi(page, BALANCE, () => ({ status: 200, body: status() }));
    await stubTable(page, "plans", () => PLAN_ROWS);
    await stubTable(page, "credit_ledger", () => []);
    await signIn(page, account.email, "/dashboard/billing");
    await expect(page.getByTestId("plan-list")).toBeVisible();
    await expect(page.getByTestId("owner-only-note")).toContainText("Only the business owner can pay or change the plan");
    await expect(page.locator('[data-testid^="plan-action-"]')).toHaveCount(0);
    await expect(page.getByTestId("topup-card")).toHaveCount(0);
    await expect(page.getByTestId("setup-fee-card")).toHaveCount(0);
    await expect(page.getByTestId("cycle-choice")).toHaveCount(0);
    await expect(page.getByTestId("plan-ending")).toHaveCount(0);
    expect(calls).toHaveLength(0);
  });
});
