import { expect, expectNoHorizontalOverflow, test } from "../support/app";
import { refusal, stubApi } from "../support/day5";

// /dashboard/admin/whatsapp, "Make a connect link": POST /api/admin/whatsapp/connect-link is Dev 1's and needs a platform admin, so it is
// stood in for with page.route. These tests prove what the form sends, that nothing is requested on load or refresh, that the link is shown
// once and kept only in memory, and that a refusal is worded truthfully. They do not prove the platform-admin check or the real route.

const ROUTE = /\/api\/admin\/whatsapp\/connect-link$/;
const TENANT = "10000000-0000-0000-0000-000000000004";
const TOKEN = "k3J9xQ2mZpL0aB7cD4eF5gH6iJ8kL1nO2pQ3rS4tU5v";
const LINK = `http://localhost:3000/connect/${TOKEN}`;
const answer = () => ({ status: 201, body: { url: LINK, expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString() } });
const make = (page: import("@playwright/test").Page) => page.getByRole("button", { name: /^Make connect link$/ });

test.describe("Admin: make a connect link", () => {
  test("makes nothing on load, sends { tenantId } once, and shows the link once", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    const calls = await stubApi(page, ROUTE, answer);
    await page.goto("/dashboard/admin/whatsapp");
    await expect(page.getByRole("heading", { level: 2, name: "Make a connect link" })).toBeVisible();
    expect(calls).toHaveLength(0);

    await page.getByLabel("Business ID for the link").fill(TENANT);
    await make(page).click();

    const result = page.getByTestId("connect-link-result");
    await expect(result).toContainText("Link ready");
    await expect(page.getByTestId("connect-link-url")).toHaveValue(LINK);
    await expect(page.getByTestId("connect-link-expiry")).toContainText("It works once.");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].tenant).toBeNull();
    expect(calls[0].authorization).toMatch(/^Bearer /);
    expect(calls[0].body).toEqual({ tenantId: TENANT });

    // The link is not kept anywhere a refresh could read it.
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(stored).not.toContain(TOKEN);
    expect(page.url()).not.toContain(TOKEN);
    await expectNoHorizontalOverflow(page);

    // A refresh loses it and does not make another.
    await page.reload();
    await expect(page.getByTestId("connect-link-result")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(TOKEN);
    expect(calls).toHaveLength(1);
  });

  test("Copy link copies the link, or says the browser would not", async ({ page, context, browserName }) => {
    await stubApi(page, ROUTE, answer);
    await page.goto("/dashboard/admin/whatsapp");
    await page.getByLabel("Business ID for the link").fill(TENANT);
    await make(page).click();
    await page.getByRole("button", { name: "Copy link" }).click();
    // Where clipboard permission is granted the page says copied; otherwise it must say so plainly, never "Copied".
    const granted = await context.grantPermissions(["clipboard-read", "clipboard-write"]).then(() => true, () => false);
    if (granted && browserName === "chromium") {
      await page.getByRole("button", { name: /Copy link|Copied/ }).click();
      await expect(page.getByRole("status").filter({ hasText: "Copied to your clipboard." })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(LINK);
    } else {
      await expect(page.getByRole("status").filter({ hasText: /Copied to your clipboard|wouldn't copy/ })).toBeVisible();
    }
  });

  test("Done clears the link and the business, ready for the next one", async ({ page }) => {
    await stubApi(page, ROUTE, answer);
    await page.goto("/dashboard/admin/whatsapp");
    await page.getByLabel("Business ID for the link").fill(TENANT);
    await make(page).click();
    await expect(make(page)).toBeDisabled();
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByTestId("connect-link-result")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(TOKEN);
    await expect(make(page)).toBeEnabled();
  });

  test("checks the id before sending anything", async ({ page }) => {
    const calls = await stubApi(page, ROUTE, answer);
    await page.goto("/dashboard/admin/whatsapp");
    await make(page).click();
    await expect(page.getByText("Enter the business's ID.").first()).toBeVisible();
    await page.getByLabel("Business ID for the link").fill("not-an-id");
    await make(page).click();
    await expect(page.getByText(/isn't a business ID/).first()).toBeVisible();
    expect(calls).toHaveLength(0);
  });

  test("while it runs the button is off, so one click makes one link", async ({ page }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const calls = await stubApi(page, ROUTE, async () => {
      await gate;
      return answer();
    });
    await page.goto("/dashboard/admin/whatsapp");
    await page.getByLabel("Business ID for the link").fill(TENANT);
    await make(page).click();
    await expect(page.getByRole("button", { name: "Making the link…" })).toBeDisabled();
    release();
    await expect(page.getByTestId("connect-link-result")).toBeVisible();
    expect(calls).toHaveLength(1);
  });

  for (const [status, code, text] of [
    [403, "forbidden", "Only the Spark Agent team can make connect links."],
    [404, "not_found", "We couldn't find that business."],
    [501, "not_available", "Connect links aren't switched on yet"],
  ] as const) {
    test(`${status} ${code} says no link was made`, async ({ page }) => {
      await stubApi(page, ROUTE, () => refusal(status, code, "server words"));
      await page.goto("/dashboard/admin/whatsapp");
      await page.getByLabel("Business ID for the link").fill(TENANT);
      await make(page).click();
      await expect(page.getByTestId("connect-link-rejected")).toContainText("No link was made.");
      await expect(page.getByTestId("connect-link-rejected")).toContainText(text);
      await expect(page.getByTestId("connect-link-result")).toHaveCount(0);
      await expect(page.getByLabel("Business ID for the link")).toHaveValue(TENANT);
    });
  }
});
