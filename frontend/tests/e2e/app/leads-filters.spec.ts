import type { Page } from "@playwright/test";
import { expect, SIGNED_OUT, test } from "../support/app";
import { newDay3Account, open } from "../support/day3";

// The Leads board's filters and counts are worked out by the database over the whole business (mocked E2E: mock-supabase.mjs
// under RLS, which answers PostgREST's filters, `Prefer: count=exact` and HEAD like the real thing). `mixedLeads: 450` gives a
// known spread: lead i has temperature [hot, warm, cold, disqualified, none][i % 5] and stage [new … human][i % 9], so every
// count can be worked out from 450 alone: 90 in each temperature, 50 in each stage, 350 open (not won or lost), 360 scored.
// What this shows is the screen's behaviour. It does NOT show that a real PostgREST answers these filters and counts the same
// way, or how long six counts take on a large business: only a read against a real Supabase can.

const board = (page: Page) => page.getByTestId("leads-board");
const cards = (page: Page) => board(page).getByRole("link");
const temperature = (page: Page) => page.getByRole("group", { name: "Temperature" });
const chip = (page: Page, name: RegExp | string) => temperature(page).getByRole("button", { name });
const loadMore = (page: Page) => page.getByRole("button", { name: /Load more leads|Loading more leads…/ });

/** Every request the page makes to the leads table, in order, with its method and query. */
function leadsRequests(page: Page) {
  const seen: { method: string; url: URL }[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (url.pathname === "/rest/v1/leads") seen.push({ method: r.method(), url });
  });
  return {
    all: seen,
    heads: () => seen.filter((r) => r.method === "HEAD"),
    pages: () => seen.filter((r) => r.method === "GET"),
  };
}

const leadNumbers = async (page: Page) => (await cards(page).allInnerTexts()).map((t) => Number(/Mixed lead (\d+)/.exec(t)?.[1]));

test.describe("Leads board · filters and counts from the database", () => {
  test.use({ storageState: SIGNED_OUT });

  test("the chips and the heading count the whole business, although only 200 leads are loaded", async ({ page, request }) => {
    const account = await newDay3Account(request, { mixedLeads: 450 });
    await open(page, account, "/dashboard/leads", "Leads");
    await expect(cards(page)).toHaveCount(200);
    for (const name of ["All · 450", "Hot · 90", "Warm · 90", "Cold · 90", "Disqualified · 90", "Not scored · 90"]) {
      await expect(chip(page, name)).toBeVisible();
    }
    await expect(page.getByText("350 open · 90 hot")).toBeVisible();
  });

  test("a temperature filter is read from the database: only matching leads come back, and Load more stays inside the filter", async ({ page, request }) => {
    const account = await newDay3Account(request, { mixedLeads: 450 });
    const reads = leadsRequests(page);
    await open(page, account, "/dashboard/leads", "Leads");
    await expect(cards(page)).toHaveCount(200);
    await chip(page, /^Hot/).click();
    await expect(cards(page)).toHaveCount(90);
    const numbers = await leadNumbers(page);
    expect(numbers.every((n) => (n - 1) % 5 === 0), "only hot leads").toBe(true);
    // The request itself carried the filter: the board did not read everything and hide most of it.
    const hot = reads.pages().filter((r) => r.url.searchParams.get("temperature") === "eq.hot");
    expect(hot).toHaveLength(1);
    // 90 fit on one page: nothing is cut short, so there is no notice and no Load more.
    await expect(page.getByText(/Showing \d+ of/)).toHaveCount(0);
    await expect(loadMore(page)).toHaveCount(0);
    // The chips still count the whole business, not the filter.
    await expect(chip(page, "All · 450")).toBeVisible();
  });

  test("a minimum score is applied by the database after a short pause, and leaves out unscored leads", async ({ page, request }) => {
    const account = await newDay3Account(request, { mixedLeads: 450 });
    const reads = leadsRequests(page);
    await open(page, account, "/dashboard/leads", "Leads");
    await expect(cards(page)).toHaveCount(200);
    const before = reads.pages().length;
    await page.getByLabel("Score at least").fill("70");
    await expect(cards(page)).toHaveCount(90); // hot only: score 90
    // One read for the finished number, not one per key.
    expect(reads.pages().length - before).toBe(1);
    expect(reads.pages().at(-1)!.url.searchParams.get("score")).toBe("gte.70");
    await page.getByLabel("Score at least").fill("50");
    await expect(cards(page)).toHaveCount(180); // hot and warm
    await chip(page, /^Hot/).click();
    await expect(cards(page)).toHaveCount(90);
    await page.getByLabel("Score at least").fill("95");
    await expect(page.getByText("No leads match these filters")).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).first().click();
    await expect(cards(page)).toHaveCount(200);
  });

  test("a filter with more than a page of matches says how many, and Load more reads exactly those", async ({ page, request }) => {
    const account = await newDay3Account(request, { mixedLeads: 450 });
    await open(page, account, "/dashboard/leads", "Leads");
    await page.getByLabel("Score at least").fill("0"); // every scored lead: 360
    await expect(page.getByText("Showing 200 of 360 matching leads, most recently updated first.")).toBeVisible();
    await expect(cards(page)).toHaveCount(200);
    await loadMore(page).click();
    await expect(cards(page)).toHaveCount(360);
    await expect(loadMore(page)).toHaveCount(0);
    const numbers = await leadNumbers(page);
    expect(new Set(numbers).size).toBe(360);
    expect(numbers.every((n) => (n - 1) % 5 !== 4), "no unscored lead").toBe(true);
  });

  test("an answer for a filter that was replaced meanwhile never lands on the new one", async ({ page, request }) => {
    const account = await newDay3Account(request, { mixedLeads: 450 });
    await open(page, account, "/dashboard/leads", "Leads");
    await expect(cards(page)).toHaveCount(200);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(/\/rest\/v1\/leads\?/, async (route) => {
      if (route.request().method() === "GET" && new URL(route.request().url()).searchParams.get("temperature") === "eq.hot") await gate;
      return route.fallback();
    });
    await chip(page, /^Hot/).click(); // its read is held
    await chip(page, /^Warm/).click(); // replaced before the first answers
    await expect(cards(page)).toHaveCount(90);
    release();
    // The late hot answer is dropped: still only warm leads (lead i = 1 mod 5).
    await expect.poll(async () => (await leadNumbers(page)).every((n) => (n - 1) % 5 === 1)).toBe(true);
    expect(await cards(page).count()).toBe(90);
  });

  test("Refresh with a filter on replaces the list, so a lead that stopped matching goes, and counts again", async ({ page, request }) => {
    const account = await newDay3Account(request, { mixedLeads: 450 });
    const reads = leadsRequests(page);
    await open(page, account, "/dashboard/leads", "Leads");
    await chip(page, /^Hot/).click();
    await expect(cards(page)).toHaveCount(90);
    // The next read of hot leads no longer holds the newest one: it stopped matching.
    await page.route(/\/rest\/v1\/leads\?/, async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== "GET" || url.searchParams.get("temperature") !== "eq.hot") return route.fallback();
      const response = await route.fetch();
      const rows = (await response.json()) as unknown[];
      return route.fulfill({ response, json: rows.slice(1) });
    });
    const headsBefore = reads.heads().length;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(cards(page)).toHaveCount(89);
    await expect.poll(() => reads.heads().length - headsBefore).toBe(6); // the numbers are read again with it
  });

  test("asks for six counts for the business, and nine more per-stage counts only when the list is cut short", async ({ page, request }) => {
    const big = await newDay3Account(request, { mixedLeads: 450 });
    const reads = leadsRequests(page);
    await open(page, big, "/dashboard/leads", "Leads");
    await expect(cards(page)).toHaveCount(200);
    // The board subscribes to Realtime and, once the join succeeds, reads once more to catch up: that repeats the counts. Let it land,
    // then check what the counts are, whether they ran once (15) or twice (30).
    await expect(page.getByText("Updating live.")).toBeVisible();
    await page.waitForTimeout(900);
    const bigHeads = reads.heads();
    expect([15, 30]).toContain(bigHeads.length);
    const bigLoads = bigHeads.length / 15;
    const perStage = (rs: typeof bigHeads) => rs.filter((r) => r.url.searchParams.get("stage")?.startsWith("eq.")).length;
    expect(perStage(bigHeads), "nine per-stage counts for each time the list is read").toBe(9 * bigLoads);
    expect(reads.heads().every((r) => r.url.searchParams.get("tenant_id") === `eq.${big.tenantId}`), "every count names the business").toBe(true);
    // Each stage has 50 leads; the column says how many of them are on screen.
    await expect(board(page).locator('[data-stage="won"]')).toHaveAttribute("aria-label", /^Won · \d+ of 50$/);
    await expect(board(page).locator('[data-stage="new"]')).toHaveAttribute("aria-label", /^New · \d+ of 50$/);

    const small = await newDay3Account(request, { seed: true });
    const smallReads = leadsRequests(page);
    await open(page, small, "/dashboard/leads", "Leads");
    await expect(board(page)).toBeVisible();
    await expect(page.getByText("Updating live.")).toBeVisible();
    await page.waitForTimeout(900);
    const smallHeads = smallReads.heads();
    expect([6, 12]).toContain(smallHeads.length); // six counts, repeated if the catch-up read ran
    expect(smallHeads.filter((r) => r.url.searchParams.get("stage")?.startsWith("eq.")), "nothing is cut short, so no per-stage counts").toHaveLength(0);
    // Nothing is cut short, so what is loaded is every lead and its own count is exact.
    await expect(board(page).locator('[data-stage="new"]')).toHaveAttribute("aria-label", "New · 1");
  });

  test("when the database gives no count, the numbers are left out and the list still works", async ({ page, request }) => {
    const account = await newDay3Account(request, { mixedLeads: 450, noLeadCount: true });
    await open(page, account, "/dashboard/leads", "Leads");
    await expect(cards(page)).toHaveCount(200);
    await expect(page.getByText("Couldn’t count all your leads, so the totals are left out.")).toBeVisible();
    await expect(chip(page, "Hot")).toBeVisible(); // a chip with no number, never a guessed one
    await expect(page.getByText("Every WhatsApp enquiry, by stage.")).toBeVisible();
    await expect(page.getByText("Showing the 200 most recently updated leads. Load more to see older ones.")).toBeVisible();
    await expect(board(page).locator('[data-stage="new"]')).toHaveAttribute("aria-label", /^New · \d+\+$/);
    await loadMore(page).click();
    await expect(cards(page)).toHaveCount(400);
  });

  test("counts only the business's own leads, whatever else exists", async ({ page, request }) => {
    await newDay3Account(request, { mixedLeads: 450 });
    const mine = await newDay3Account(request, { seed: true });
    await open(page, mine, "/dashboard/leads", "Leads");
    await expect(chip(page, "All · 5")).toBeVisible();
    await expect(chip(page, "Hot · 2")).toBeVisible();
    await expect(page.getByText("4 open · 2 hot")).toBeVisible();
  });
});
