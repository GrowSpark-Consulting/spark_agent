import type { Page } from "@playwright/test";
import { appAlert, expect, SIGNED_OUT, signIn, test } from "../support/app";
import { newDay3Account } from "../support/day3";

// Refresh on the lead detail (mocked E2E: mock-supabase.mjs under RLS, with page.route changing or breaking single
// answers). It shows the screen reads the lead and its timeline again without clearing what is on screen, shows a change made
// since it was opened, and that a failed refresh leaves the page as it was and says so. It does NOT show that leads or bookings
// arrive live from a real Realtime server: both are published (0026) and the page subscribes, but here the socket is a stand-in
// (support/realtime.ts, answered for every test by support/app.ts).

const refreshButton = (page: Page) => page.getByRole("button", { name: "Refresh", exact: true });
const currentStage = (page: Page) => page.getByRole("list", { name: "Stage" }).locator('[aria-current="step"]');

async function openKarthik(page: Page, leadId: string, email: string) {
  await signIn(page, email, `/dashboard/leads/${leadId}`);
  await expect(page.getByRole("heading", { level: 1, name: "Karthik R" })).toBeVisible();
  await expect(currentStage(page)).toHaveText("Qualified");
}

test.describe("Lead detail · Refresh", () => {
  test.use({ storageState: SIGNED_OUT });

  test("says it is updating live, and Refresh still reads the lead and its bookings again without clearing the page", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true });
    await openKarthik(page, account.ids.karthik, account.email);
    await expect(page.getByText("Updating live.")).toBeVisible();
    await page.waitForTimeout(900); // the join reads once to catch up; count only what Refresh does

    const reads: string[] = [];
    page.on("request", (r) => {
      const path = new URL(r.url()).pathname;
      if (r.method() === "GET" && (path === "/rest/v1/leads" || path === "/rest/v1/bookings")) reads.push(path);
    });
    await refreshButton(page).click();
    await expect(refreshButton(page)).toBeEnabled();
    expect(reads).toContain("/rest/v1/leads");
    expect(reads).toContain("/rest/v1/bookings");
    // Still the same page, with nothing replaced by a loading or an error state meanwhile.
    await expect(page.getByRole("heading", { level: 1, name: "Karthik R" })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Loading this lead" })).toHaveCount(0);
    await expect(appAlert(page)).toHaveCount(0);
  });

  test("shows a change made since the page was opened", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true });
    await openKarthik(page, account.ids.karthik, account.email);

    // The next read of the lead says it has moved on to Won (the stored row is untouched; only this answer is changed).
    await page.route(/\/rest\/v1\/leads(\?|$)/, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const response = await route.fetch();
      const rows = (await response.json()) as { stage: string }[];
      return route.fulfill({ response, json: rows.map((row) => ({ ...row, stage: "won" })) });
    });
    await refreshButton(page).click();
    await expect(currentStage(page)).toHaveText("Won");
    await expect(page.getByText("Couldn’t refresh. You’re seeing the last read.")).toHaveCount(0);
  });

  test("a refresh that fails leaves the page as it was and says so", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true });
    await openKarthik(page, account.ids.karthik, account.email);
    // The lead reads fine but its bookings don't: nothing is replaced, not even the part that did read.
    await page.route(/\/rest\/v1\/bookings(\?|$)/, (route) =>
      route.request().method() === "GET" ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: "not-a-booking" }]) }) : route.fallback(),
    );
    await page.route(/\/rest\/v1\/leads(\?|$)/, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const response = await route.fetch();
      const rows = (await response.json()) as { stage: string }[];
      return route.fulfill({ response, json: rows.map((row) => ({ ...row, stage: "won" })) });
    });
    await refreshButton(page).click();
    await expect(page.getByText("Couldn’t refresh. You’re seeing the last read.")).toBeVisible();
    await expect(currentStage(page)).toHaveText("Qualified");
    await expect(page.getByRole("heading", { level: 1, name: "Karthik R" })).toBeVisible();
    await expect(appAlert(page)).toHaveCount(0);
  });
});
