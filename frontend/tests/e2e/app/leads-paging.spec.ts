import type { Page, Route } from "@playwright/test";
import { appAlert, expect, SIGNED_OUT, test } from "../support/app";
import { newDay3Account, open } from "../support/day3";

// The Leads board beyond one page, its loading state and its Refresh button (mocked E2E: mock-supabase.mjs under RLS,
// with page.route holding or breaking single requests). What this shows is the screen's behaviour. It does NOT show that
// a real PostgREST accepts the paging filter on a real timestamptz, or that a real Realtime server delivers lead changes. `leads`
// is in the supabase_realtime publication (0026), so the board subscribes; the tests answer the socket with a stand-in
// (support/realtime.ts), and realtime-refresh.spec.ts covers what a pushed change does.

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

/** Follows the page's GETs of the leads table (register before the page opens), to tell when they have gone quiet. */
const leadsActivity = (page: Page) => {
  const isLeadsGet = (r: { url(): string; method(): string }) => r.method() === "GET" && new URL(r.url()).pathname === "/rest/v1/leads";
  const inFlight = new Set<unknown>();
  let lastActivity = Date.now();
  page.on("request", (r) => {
    if (!isLeadsGet(r)) return;
    inFlight.add(r);
    lastActivity = Date.now();
  });
  const done = (r: { url(): string; method(): string }) => {
    if (!isLeadsGet(r)) return;
    inFlight.delete(r);
    lastActivity = Date.now();
  };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  return { inFlight: () => inFlight.size, lastActivity: () => lastActivity };
};

// The board reads its first page once more 400 ms after it joins Realtime (lib/realtime/table-changes.ts), and Refresh stays disabled
// while that read runs. A test that hold()s every leads read before that read has landed holds the catch-up too, then waits for a
// Refresh button that cannot enable until the test itself releases the hold. This waits until the board is live and its reads have been
// quiet for longer than that wait. A quiet window, not a request match: the catch-up read is not guaranteed.
const CATCH_UP_QUIET_MS = 700;
async function settleCatchUp(page: Page, reads: ReturnType<typeof leadsActivity>) {
  await expect(page.getByText("Updating live."), "the board never joined Realtime, so its catch-up read cannot be waited for").toBeVisible();
  const liveSeenAt = Date.now();
  await expect
    .poll(() => reads.inFlight() === 0 && Date.now() - Math.max(liveSeenAt, reads.lastActivity()) >= CATCH_UP_QUIET_MS, {
      message: `the leads reads did not go quiet for ${CATCH_UP_QUIET_MS} ms after the board joined Realtime`,
      timeout: 15_000,
      intervals: [50, 100, 250],
    })
    .toBe(true);
}

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
    await expect(page.getByText("Showing 200 of 450 leads, most recently updated first.")).toBeVisible();
    // The counts are the database's, for the whole business, not a minimum over the 200 loaded.
    await expect(page.getByRole("group", { name: "Temperature" }).getByRole("button", { name: "All · 450" })).toBeVisible();

    // The board subscribes to Realtime and reads its first page once more when the join succeeds (to catch what it missed). Let that
    // read land before paging, so the reads below are in a known order.
    await expect(page.getByText("Updating live.")).toBeVisible();
    await page.waitForTimeout(900);
    await expect(cards(page)).toHaveCount(200);

    await loadMore(page).click();
    await expect(cards(page)).toHaveCount(400);
    await loadMore(page).click();
    await expect(cards(page)).toHaveCount(450);
    await expect(loadMore(page)).toHaveCount(0);
    await expect(page.getByText(/Showing \d+ of \d+ leads/)).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Temperature" }).getByRole("button", { name: "All · 450" })).toBeVisible();

    // Never "everything at once": initial read(s) ask without a cursor, and the two later pages ask for what is older, by cursor.
    const pageReads = reads.filter((u) => u.searchParams.get("limit") === "200");
    const keysets = pageReads.map(isKeyset);
    expect(keysets.slice(-2)).toEqual([true, true]);
    expect(keysets.slice(0, -2).length).toBeGreaterThanOrEqual(1);
    expect(keysets.slice(0, -2).every((k) => k === false)).toBe(true);
    // Nobody appears twice and nobody is missing.
    const names = await cards(page).allInnerTexts();
    expect(new Set(names).size).toBe(450);
  });

  test("a filter is applied by the database: the counts cover every lead, and a filter that matches nothing says so", async ({ page, request }) => {
    const account = await newDay3Account(request, { manyLeads: 450 });
    await open(page, account, "/dashboard/leads", "Leads");
    const temperature = page.getByRole("group", { name: "Temperature" });
    // All 450 leads are unscored; the count is exact although only 200 are loaded.
    await expect(temperature.getByRole("button", { name: "Not scored · 450" })).toBeVisible();
    await temperature.getByRole("button", { name: /^Not scored/ }).click();
    await expect(page.getByText("Showing 200 of 450 matching leads, most recently updated first.")).toBeVisible();
    await expect(cards(page)).toHaveCount(200);
    // A minimum score leaves out unscored leads, in the database: nothing matches, and that is the whole business, not a guess.
    await page.getByLabel("Score at least").fill("10");
    await expect(page.getByText("No leads match these filters")).toBeVisible();
    await expect(page.getByText(/Load more to look through older ones/)).toHaveCount(0);
    await page.getByRole("button", { name: "Clear filters" }).first().click();
    await expect(cards(page)).toHaveCount(200);
    await loadMore(page).click();
    await loadMore(page).click();
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

  test("says the board is updating live, and Refresh still reads again without clearing it", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true });
    const reads = leadsReads(page);
    const activity = leadsActivity(page);
    // The hold is armed by the Refresh click itself, in the page's capture phase, before the board's handler issues its read. A read
    // that started earlier (the Realtime catch-up) goes through unheld, and the click waits for it to finish; one that would start
    // later is dropped by the board, which is already refreshing. So the held read is always Refresh's own, never the catch-up's.
    let armed = false;
    await page.exposeFunction("__armRefreshHold", () => {
      armed = true;
    });
    await open(page, account, "/dashboard/leads", "Leads");
    await expect(board(page)).toBeVisible();
    await page.evaluate(() => {
      document.addEventListener(
        "click",
        (e) => {
          const button = (e.target as Element | null)?.closest("button");
          if (button?.textContent === "Refresh") void (window as unknown as { __armRefreshHold: () => Promise<void> }).__armRefreshHold();
        },
        { capture: true, once: false },
      );
    });
    await settleCatchUp(page, activity); // also waits for "Updating live."; keeps the baseline below free of the catch-up
    const before = reads.length;
    const next = await hold(page, () => armed);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect.poll(() => next.held(), { message: "Refresh's own read was not held" }).toBe(1);
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
