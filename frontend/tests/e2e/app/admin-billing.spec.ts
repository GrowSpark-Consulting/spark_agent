import { expect, expectNoHorizontalOverflow, test } from "../support/app";
import { refusal, stubApi } from "../support/day5";

// /dashboard/admin/billing: the admin billing routes are Dev 2's (0041) and need a platform admin, so they are stood in for with page.route.
// These tests prove what the screen sends, how it words each answer, that a change is followed by a fresh read, and that a refusal for a
// non-admin shows no data. They do not prove the platform-admin check or the real routes.

const LIST = /\/api\/admin\/tenants$/;
const EXTEND = /\/api\/admin\/tenants\/[^/]+\/extend-trial$/;
const CREDITS = /\/api\/admin\/tenants\/[^/]+\/credits$/;
const REFUNDS = /\/api\/admin\/payments\/refunds$/;
const TENANT = "10000000-0000-0000-0000-000000000004";

const tenant = (over: Record<string, unknown> = {}) => ({
  id: TENANT,
  name: "Skyline Homes",
  vertical: "real_estate",
  status: "trial",
  planKey: "trial",
  trialEndsAt: "2026-10-20T00:00:00.000Z",
  createdAt: "2026-10-01T00:00:00.000Z",
  setupCallPaidAt: null,
  credits: 300,
  subscription: null,
  members: 1,
  activeNumbers: 0,
  ...over,
});
const refund = { paymentId: "p1", tenantId: TENANT, tenantName: "Skyline Homes", kind: "subscribe", amountInr: 5900, providerPaymentId: "403993715", method: "UPI", paidAt: "2026-10-12T00:00:00.000Z", flaggedAt: "2026-10-13T00:00:00.000Z" };

test.describe("Admin: billing", () => {
  test("lists businesses and refunds with nothing sent but two reads", async ({ page }) => {
    const reads = await stubApi(page, LIST, () => ({ status: 200, body: [tenant()] }));
    await stubApi(page, REFUNDS, () => ({ status: 200, body: [refund] }));
    await page.goto("/dashboard/admin/billing");
    await expect(page.getByTestId("tenant-row")).toContainText("Skyline Homes");
    await expect(page.getByTestId("tenant-credits")).toHaveText("300");
    await expect(page.getByTestId("refund-list")).toContainText("₹5,900");
    expect(reads).toHaveLength(1);
    expect(reads[0].method).toBe("GET");
    expect(reads[0].tenant).toBeNull();
    expect(reads[0].authorization).toMatch(/^Bearer /);
    await expectNoHorizontalOverflow(page);
  });

  test("a business that paid the setup fee shows the setup call as owed with its date; one that did not shows nothing", async ({ page }) => {
    await stubApi(page, LIST, () => ({
      status: 200,
      body: [tenant({ name: "Paid Homes", setupCallPaidAt: "2026-10-12T12:00:00.000Z" }), tenant({ id: "10000000-0000-0000-0000-000000000005", name: "Unpaid Homes", setupCallPaidAt: null })],
    }));
    await stubApi(page, REFUNDS, () => ({ status: 200, body: [] }));
    await page.goto("/dashboard/admin/billing");
    const paid = page.getByTestId("tenant-row").filter({ hasText: /^Paid Homes/ });
    const unpaid = page.getByTestId("tenant-row").filter({ hasText: /^Unpaid Homes/ });
    await expect(paid).toContainText("Setup call");
    await expect(paid).toContainText("Paid 12 Oct 2026: owed");
    await expect(unpaid).toBeVisible();
    await expect(unpaid).not.toContainText("Setup call");
    await expect(unpaid).not.toContainText("owed");
  });

  test("a non-admin is told so and sees no data", async ({ page }) => {
    await stubApi(page, LIST, () => refusal(403, "forbidden", "no"));
    await stubApi(page, REFUNDS, () => refusal(403, "forbidden", "no"));
    await page.goto("/dashboard/admin/billing");
    await expect(page.getByTestId("admin-error").first()).toContainText("Only the Spark Agent team");
    await expect(page.getByTestId("tenant-row")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  });

  test("a failed list offers Try again, and the retry reads again", async ({ page }) => {
    const reads = await stubApi(page, LIST, (n) => (n === 1 ? refusal(500, "internal", "boom") : { status: 200, body: [tenant()] }));
    await stubApi(page, REFUNDS, () => ({ status: 200, body: [] }));
    await page.goto("/dashboard/admin/billing");
    await expect(page.getByTestId("admin-error")).toBeVisible();
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("tenant-row")).toBeVisible();
    expect(reads).toHaveLength(2);
    await expect(page.getByTestId("no-refunds")).toBeVisible();
  });

  test("extending a trial checks the days, sends { days } once, and re-reads the list", async ({ page }) => {
    let trialEnds = "2026-10-20T00:00:00.000Z";
    const reads = await stubApi(page, LIST, () => ({ status: 200, body: [tenant({ trialEndsAt: trialEnds })] }));
    await stubApi(page, REFUNDS, () => ({ status: 200, body: [] }));
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const posts = await stubApi(page, EXTEND, async () => {
      await gate;
      trialEnds = "2026-10-27T00:00:00.000Z";
      return { status: 200, body: { trialEndsAt: trialEnds } };
    });
    await page.goto("/dashboard/admin/billing");
    const days = page.getByLabel(/Extend trial by/);
    const submit = page.getByRole("button", { name: "Extend trial" });
    await submit.click();
    await expect(page.getByText("Enter a whole number of days.")).toBeVisible();
    await days.fill("45");
    await submit.click();
    await expect(page.getByText("At most 30 days at a time")).toBeVisible();
    expect(posts).toHaveLength(0);

    await days.fill("7");
    await submit.click();
    await expect(page.getByRole("button", { name: "Extending…" })).toBeDisabled();
    release();
    await expect(page.getByTestId("extend-outcome")).toContainText("Trial now ends");
    await expect(page.getByTestId("tenant-trial-ends")).toContainText("27 Oct 2026");
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ days: 7 });
    expect(posts[0].url.pathname).toBe(`/api/admin/tenants/${TENANT}/extend-trial`);
    expect(reads).toHaveLength(2);
  });

  test("a refused extension says nothing changed and does not re-read", async ({ page }) => {
    const reads = await stubApi(page, LIST, () => ({ status: 200, body: [tenant()] }));
    await stubApi(page, REFUNDS, () => ({ status: 200, body: [] }));
    await stubApi(page, EXTEND, () => refusal(409, "conflict", "has a plan"));
    await page.goto("/dashboard/admin/billing");
    await page.getByLabel(/Extend trial by/).fill("3");
    await page.getByRole("button", { name: "Extend trial" }).click();
    await expect(page.getByTestId("extend-outcome")).toContainText("already has a plan");
    expect(reads).toHaveLength(1);
  });

  test("a business with a plan has no extend-trial form", async ({ page }) => {
    await stubApi(page, LIST, () => ({ status: 200, body: [tenant({ status: "active", planKey: "growth", subscription: { status: "active", cycle: "monthly", periodEnd: "2026-11-01T00:00:00.000Z" } })] }));
    await stubApi(page, REFUNDS, () => ({ status: 200, body: [] }));
    await page.goto("/dashboard/admin/billing");
    await expect(page.getByTestId("tenant-row")).toBeVisible();
    await expect(page.getByRole("button", { name: "Extend trial" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Grant credits" })).toBeVisible();
  });

  test("granting credits checks the amount, sends the grant with a request id, and shows the new balance from a fresh read", async ({ page }) => {
    let credits = 300;
    const reads = await stubApi(page, LIST, () => ({ status: 200, body: [tenant({ credits })] }));
    await stubApi(page, REFUNDS, () => ({ status: 200, body: [] }));
    const posts = await stubApi(page, CREDITS, () => {
      credits = 800;
      return { status: 200, body: { granted: true, credits } };
    });
    await page.goto("/dashboard/admin/billing");
    const grant = page.getByRole("button", { name: "Grant credits" });
    await grant.click();
    await expect(page.getByText("Enter a whole number of credits.")).toBeVisible();
    await page.getByLabel(/Credits to grant/).fill("100001");
    await grant.click();
    await expect(page.getByText("At most 100,000 at a time")).toBeVisible();
    expect(posts).toHaveLength(0);

    await page.getByLabel(/Credits to grant/).fill("500");
    await page.getByLabel(/Expire after/).fill("30");
    await page.getByLabel(/Note/).fill("Goodwill");
    await grant.click();
    await expect(page.getByTestId("grant-outcome")).toContainText("Granted 500 credits");
    await expect(page.getByTestId("tenant-credits")).toHaveText("800");
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ amount: 500, expiresInDays: 30, note: "Goodwill" });
    expect((posts[0].body as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(reads).toHaveLength(2);
  });

  test("a failed grant is retried with the same request id, so it cannot be made twice; a new grant gets a new id", async ({ page }) => {
    await stubApi(page, LIST, () => ({ status: 200, body: [tenant()] }));
    await stubApi(page, REFUNDS, () => ({ status: 200, body: [] }));
    const posts = await stubApi(page, CREDITS, (n) => (n === 1 ? refusal(502, "upstream_failed", "try later") : n === 2 ? { status: 200, body: { granted: false, credits: 800 } } : { status: 200, body: { granted: true, credits: 900 } }));
    await page.goto("/dashboard/admin/billing");
    const grant = page.getByRole("button", { name: "Grant credits" });
    await page.getByLabel(/Credits to grant/).fill("500");
    await grant.click();
    await expect(page.getByTestId("grant-outcome")).toContainText("not made twice");
    await grant.click();
    await expect(page.getByTestId("grant-outcome")).toContainText("already been made");
    await page.getByLabel(/Credits to grant/).fill("100");
    await grant.click();
    await expect(page.getByTestId("grant-outcome")).toContainText("Granted 100 credits");
    const ids = posts.map((p) => (p.body as { requestId: string }).requestId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });
});
