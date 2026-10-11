import type { Page } from "@playwright/test";
import { appAlert, expect, SIGNED_OUT, signIn, test } from "../support/app";
import { DAY, newDay3Account, open, type Day3Account } from "../support/day3";

// Loading states on the screens a person waits on (the Inbox's is in inbox.spec.ts, beside its Realtime stub), and the Calendar's Refresh (mocked E2E: mock-supabase.mjs under RLS,
// single requests held or broken with page.route). It shows each screen says it is loading, then shows its data, and that
// a refresh never clears or replaces what is on screen with an error. It does NOT show real Supabase latency or that
// bookings arrive live: `bookings` is not in the supabase_realtime publication yet, so the calendar says it isn't live.

/** Holds GETs of one table until `release()`; the rest of the traffic goes straight through. */
async function hold(page: Page, table: string, matches: (url: URL) => boolean = () => true) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = 0;
  await page.route(new RegExp(`/rest/v1/${table}(\\?|$)`), async (route) => {
    if (route.request().method() !== "GET" || !matches(new URL(route.request().url()))) return route.fallback();
    held += 1;
    await gate;
    return route.fallback();
  });
  return { release, held: () => held };
}

const loading = (page: Page, title: string) => page.getByRole("status").filter({ hasText: title });

async function openDay(page: Page, account: Day3Account, query = `date=${DAY}`) {
  await open(page, account, `/dashboard/calendar?${query}`, /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) \d+ \w+$|^Week of/);
}

test.describe("Loading states", () => {
  test.use({ storageState: SIGNED_OUT });

  test("Calendar: says it is loading bookings, shows no empty or error message meanwhile, then the day", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true });
    const bookings = await hold(page, "bookings");
    await openDay(page, account);
    await expect(loading(page, "Loading bookings")).toBeVisible();
    await expect(appAlert(page)).toHaveCount(0);
    await expect(page.getByText(/no bookings/i)).toHaveCount(0);
    expect(bookings.held()).toBeGreaterThan(0);
    bookings.release();
    await expect(page.getByRole("button", { name: /Karthik R/ })).toBeVisible();
    await expect(loading(page, "Loading bookings")).toHaveCount(0);
  });

  test("Lead detail: says it is loading the lead, then the lead and its timeline", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true });
    const leads = await hold(page, "leads");
    await signIn(page, account.email, `/dashboard/leads/${account.ids.karthik}`);
    await expect(loading(page, "Loading this lead")).toBeVisible();
    await expect(page.getByRole("link", { name: "← All leads" })).toBeVisible(); // the way out is there while waiting
    leads.release();
    await expect(page.getByRole("heading", { level: 1, name: "Karthik R" })).toBeVisible();
    await expect(loading(page, "Loading this lead")).toHaveCount(0);
  });

  test("Lead detail: the timeline and bookings load on their own and say so", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true });
    const conversations = await hold(page, "conversations");
    await signIn(page, account.email, `/dashboard/leads/${account.ids.karthik}`);
    await expect(page.getByRole("heading", { level: 1, name: "Karthik R" })).toBeVisible(); // the lead itself is already there
    await expect(loading(page, "Loading the timeline")).toBeVisible();
    conversations.release();
    await expect(loading(page, "Loading the timeline")).toHaveCount(0);
  });

  test("Booking setup: staff and hours say they are loading, then show", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true });
    const resources = await hold(page, "resources");
    await signIn(page, account.email, "/dashboard/settings/booking");
    await expect(loading(page, "Loading staff and resources")).toBeVisible();
    resources.release();
    await expect(page.getByText("Asha", { exact: true }).first()).toBeVisible();
    await expect(loading(page, "Loading staff and resources")).toHaveCount(0);
  });
});

test.describe("Calendar · Refresh", () => {
  test.use({ storageState: SIGNED_OUT });

  test("says the calendar isn't updating live, and reads the shown day again without clearing it", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true });
    await openDay(page, account);
    const karthik = page.getByRole("button", { name: /Karthik R/ });
    await expect(karthik).toBeVisible();
    await expect(page.getByText("Not updating live. Use Refresh.")).toBeVisible();

    let reads = 0;
    page.on("request", (r) => {
      if (r.method() === "GET" && new URL(r.url()).pathname === "/rest/v1/bookings") reads += 1;
    });
    const next = await hold(page, "bookings");
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByRole("button", { name: "Refreshing…" })).toBeDisabled();
    await expect(karthik).toBeVisible(); // still on screen while it reads
    await expect(loading(page, "Loading bookings")).toHaveCount(0);
    next.release();
    await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    expect(reads).toBe(1);
    await expect(karthik).toBeVisible();
    // Each booking appears once: the answer replaced what was held.
    await expect(page.getByRole("button", { name: /Karthik R/ })).toHaveCount(1);
  });

  test("a refresh that fails leaves the day as it was and says so", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true });
    await openDay(page, account);
    await expect(page.getByRole("button", { name: /Karthik R/ })).toBeVisible();
    await page.route(/\/rest\/v1\/bookings(\?|$)/, (route) =>
      route.request().method() === "GET" ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{ id: "not-a-booking" }]) }) : route.fallback(),
    );
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByText("Couldn’t refresh. You’re seeing the last read.")).toBeVisible();
    await expect(page.getByRole("button", { name: /Karthik R/ })).toBeVisible();
    await expect(appAlert(page)).toHaveCount(0);
  });

  test("moving to another day while a refresh is running shows the new day, never the old answer", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true });
    await openDay(page, account);
    await expect(page.getByRole("button", { name: /Karthik R/ })).toBeVisible();
    const next = await hold(page, "bookings");
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.getByRole("button", { name: "Next day" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tuesday 13 Oct");
    next.release();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tuesday 13 Oct");
    // Monday's booking is not on Tuesday's screen.
    await expect(page.getByRole("button", { name: /Karthik R, 10:00 am/ })).toHaveCount(0);
  });
});
