import type { Page, Route } from "@playwright/test";
import { appAlert, expect, SIGNED_OUT, test } from "../support/app";
import { newDay3Account, open } from "../support/day3";

// The Leads board beyond one page, its loading state and its Refresh button (mocked E2E: mock-supabase.mjs under RLS,
// with page.route holding or breaking single requests). What this shows is the screen's behaviour. It does NOT show that
// a real PostgREST accepts the paging filter on a real timestamptz, or that Realtime delivers lead changes: `leads` is not
// in the supabase_realtime publication yet, so the board says it is not live and Refresh is the way to update.

const board = (page: Page) => page.getByTestId("leads-board");
const loadMore = (page: Page) => page.getByRole("button", { name: /Load more leads|Loading more leads…/ });
const cards = (page: Page) => board(page).getByRole("link");
const leadsReads = (page: Page) => {
  const urls: URL[] = [];
  page.on("request", (r) => {
    if (r.method() === "GET" && new URL(r.url()).pathname === "/rest/v1/leads") urls.push(new URL(r.url()));
  });
  return urls;
};

/** Holds the matching GET of the leads table until `release()`; everything else goes straight through. */
async function hold(page: Page, matches: (url: URL) => boolean = () => true) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = 0;
  await page.route(/\/rest\/v1\/leads(\?|$)/, async (route) => {
    if (route.request().method() !== "GET" || !matches(new URL(route.request().url()))) return route.fallback();
    held += 1;
    await gate;
    return route.fallback();
  });
  return { release, held: () => held };
}

const badRows = (route: Route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: "not-a-lead" }]) });
const isKeyset = (url: URL) => url.searchParams.has("or");

test.describe("Leads board · loading", () => {
  test.use({ storageState: SIGNED_OUT });

  test("shows a loading state while the leads are read, then the board, without the page jumping", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true });
    const leads = await hold(page);
    await open(page, account, "/dashboard/leads", "Leads");
    await expect(page.getByRole("status").filter({ hasText: "Loading your leads" })).toBeVisible();
    await expect(board(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Refresh" })).toHaveCount(0); // nothing to refresh yet
    leads.release();
    await expect(board(page)).toBeVisible();
    await expect(page.getByText("Loading your leads")).toHaveCount(0);
  });
});

test.describe("Leads board · more than one page", () => {
  test.use({ storageState: SIGNED_OUT });

  test("reads 200 leads first, says so, and Load more reads the next pages until none are left", async ({ page, request }) => {
    const account = await newDay3Account(request, { manyLeads: 450 });
    const reads = leadsReads(page);
    await open(page, account, "/dashboard/leads", "Leads");
    await expect(cards(page)).toHaveCount(200);
    await expect(page.getByText(/Showing the 200 most recently updated leads/)).toBeVisible();
    // Counts over what is loaded are minimums while older leads remain.
    await expect(page.getByRole("group", { name: "Temperature" }).getByRole("button", { name: "All · 200+" })).toBeVisible();

    await loadMore(page).click();
    await expect(cards(page)).toHaveCount(400);
    await loadMore(page).click();
    await expect(cards(page)).toHaveCount(450);
    await expect(loadMore(page)).toHaveCount(0);
    await expect(page.getByText(/Showing the \d+ most recently updated leads/)).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Temperature" }).getByRole("button", { name: "All · 450" })).toBeVisible();

    // Three reads, never "everything at once": the first has no cursor, the others ask for what is older.
    const pageReads = reads.filter((u) => u.searchParams.get("limit") === "200");
    expect(pageReads.map(isKeyset)).toEqual([false, true, true]);
    // Nobody appears twice and nobody is missing.
    const names = await cards(page).allInnerTexts();
    expect(new Set(names).size).toBe(450);
  });

  test("the same filter applies to every page: leads loaded later are filtered and counted too", async ({ page, request }) => {
    const account = await newDay3Account(request, { manyLeads: 450 });
    await open(page, account, "/dashboard/leads", "Leads");
    const temperature = page.getByRole("group", { name: "Temperature" });
    await expect(temperature.getByRole("button", { name: "Not scored · 200+" })).toBeVisible();
    await temperature.getByRole("button", { name: /^Not scored/ }).click();
    await expect(cards(page)).toHaveCount(200);
    await page.getByLabel("Score at least").fill("10");
    await expect(page.getByText("No leads match these filters")).toBeVisible();
    // With older leads unread, it says so rather than claiming there are none.
    await expect(page.getByText("None of the leads loaded so far match")).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).first().click();
    await loadMore(page).click();
    await loadMore(page).click();
    await expect(temperature.getByRole("button", { name: "Not scored · 450" })).toBeVisible();
    await temperature.getByRole("button", { name: /^Not scored/ }).click();
    await expect(cards(page)).toHaveCount(450);
  });

  test("shows loading-more on the button, once, and keeps the leads already read", async ({ page, request }) => {
    const account = await newDay3Account(request, { manyLeads: 450 });
    await open(page, account, "/dashboard/leads", "Leads");
    await expect(cards(page)).toHaveCount(200);
    const next = await hold(page, isKeyset);
    await loadMore(page).click();
    await expect(page.getByRole("button", { name: "Loading more leads…" })).toBeDisabled();
    await expect(cards(page)).toHaveCount(200); // nothing cleared while it reads
    // Pressing it again while it reads does nothing: a disabled button takes no click, and only one request is held.
    await page.getByRole("button", { name: "Loading more leads…" }).click({ force: true });
    expect(next.held()).toBe(1);
    next.release();
    await expect(cards(page)).toHaveCount(400);
  });

  test("a page that fails says so, keeps the leads already read and can be tried again", async ({ page, request }) => {
    const account = await newDay3Account(request, { manyLeads: 450 });
    await open(page, account, "/dashboard/leads", "Leads");
    await expect(cards(page)).toHaveCount(200);
    let failures = 0;
    await page.route(/\/rest\/v1\/leads(\?|$)/, (route) => {
      if (route.request().method() === "GET" && isKeyset(new URL(route.request().url())) && failures === 0) {
        failures += 1;
        return badRows(route);
      }
      return route.fallback();
    });
    await loadMore(page).click();
    await expect(appAlert(page).or(page.getByRole("alert").filter({ hasText: "Couldn’t load more leads" }))).toBeVisible();
    await expect(cards(page)).toHaveCount(200);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(cards(page)).toHaveCount(400);
    await expect(page.getByRole("alert").filter({ hasText: "Couldn’t load more leads" })).toHaveCount(0);
  });
});

test.describe("Leads board · Refresh", () => {
  test.use({ storageState: SIGNED_OUT });

  test("says the board isn't updating live (leads aren't published to Realtime yet) and reads again without clearing it", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true });
    const reads = leadsReads(page);
    await open(page, account, "/dashboard/leads", "Leads");
    await expect(board(page)).toBeVisible();
    await expect(page.getByText("Not updating live. Use Refresh.")).toBeVisible();
    const before = reads.length;
    const next = await hold(page);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByRole("button", { name: "Refreshing…" })).toBeDisabled();
    await expect(board(page)).toBeVisible(); // still there while it reads
    await expect(page.getByText("Loading your leads")).toHaveCount(0);
    next.release();
    await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    expect(reads.length).toBeGreaterThan(before);
    await expect(board(page).getByRole("link", { name: /Karthik R/ })).toBeVisible();
  });

  test("a refresh that fails leaves the board as it was and says so", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true });
    await open(page, account, "/dashboard/leads", "Leads");
    await expect(board(page).getByRole("link", { name: /Karthik R/ })).toBeVisible();
    await page.route(/\/rest\/v1\/leads(\?|$)/, (route) => (route.request().method() === "GET" ? badRows(route) : route.fallback()));
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByText("Couldn’t refresh. You’re seeing the last read.")).toBeVisible();
    await expect(board(page).getByRole("link", { name: /Karthik R/ })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "Couldn't load your leads" })).toHaveCount(0);
  });
});
