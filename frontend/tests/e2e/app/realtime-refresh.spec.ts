import type { Page } from "@playwright/test";
import { expect, SIGNED_OUT, test } from "../support/app";
import { DAY, newDay3Account, open, type Day3Account } from "../support/day3";
import { mockRealtime } from "../support/realtime";

// What the Leads board and the Calendar do with Realtime now that `leads` and `bookings` are published (0026_booking_actions;
// lib/realtime/published-tables.ts). The socket is a stand-in that speaks the Phoenix protocol (support/realtime.ts), so this shows
// the screen's behaviour: which tables it subscribes to, that a pushed change makes it read again once, that a change naming another
// business is ignored, and what it says when the join is refused. It does NOT show that a real Realtime server delivers these
// changes, applies RLS to them, or that the migration was applied to the hosted database: that needs staging (matrix, RT-8).

const OTHER_BUSINESS = "10000000-0000-0000-0000-0000000000ff";
const CALENDAR_HEADING = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) \d+ \w+$|^Week of/;

/** Counts the GETs of one table; the count only grows. */
function reads(page: Page, table: string) {
  let n = 0;
  page.on("request", (r) => {
    if (r.method() === "GET" && new URL(r.url()).pathname === `/rest/v1/${table}`) n += 1;
  });
  return () => n;
}

const settle = (page: Page) => page.waitForTimeout(900); // longer than the screen's wait for company before it reads

function expectSubscribed(joins: Awaited<ReturnType<typeof mockRealtime>>["joins"], table: string, account: Day3Account) {
  const tables = joins.flatMap((j) => j.changes).filter((c) => c.table === table);
  expect(tables.length, `a subscription to ${table}`).toBeGreaterThan(0);
  expect(tables.every((c) => c.filter === `tenant_id=eq.${account.tenantId}`), "only this business's changes are asked for").toBe(true);
}

test.describe("Leads board · Realtime", () => {
  test.use({ storageState: SIGNED_OUT });

  test("subscribes for this business's leads, says it is live, and reads once more for a burst of changes", async ({ page, request }) => {
    const rt = await mockRealtime(page);
    const account = await newDay3Account(request, { seed: true });
    const count = reads(page, "leads");
    await open(page, account, "/dashboard/leads", "Leads");
    await expect(page.getByTestId("leads-board").getByRole("link", { name: /Karthik R/ })).toBeVisible();
    await expect(page.getByText("Updating live.")).toBeVisible();
    await expect.poll(() => rt.joins.length).toBeGreaterThan(0);
    expectSubscribed(rt.joins, "leads", account);

    await settle(page); // the first join reads once to catch up; count from after it
    const before = count();
    for (let i = 0; i < 3; i++) rt.push("leads", "UPDATE", { id: `bbbbbbbb-0000-0000-0000-00000000000${i}`, tenant_id: account.tenantId, score: 50 + i });
    await expect.poll(count).toBe(before + 1);
    await settle(page);
    expect(count(), "a burst of changes is one read").toBe(before + 1);
    await expect(page.getByTestId("leads-board").getByRole("link", { name: /Karthik R/ })).toBeVisible();
  });

  test("a change that names another business is ignored", async ({ page, request }) => {
    const rt = await mockRealtime(page);
    const account = await newDay3Account(request, { seed: true });
    const count = reads(page, "leads");
    await open(page, account, "/dashboard/leads", "Leads");
    await expect.poll(() => rt.joins.length).toBeGreaterThan(0);
    await settle(page); // the first join reads once to catch up; count from after it
    const before = count();
    rt.push("leads", "UPDATE", { id: "bbbbbbbb-0000-0000-0000-0000000000aa", tenant_id: OTHER_BUSINESS, score: 99 });
    await settle(page);
    expect(count()).toBe(before);
  });

  test("when the join is refused it says it is not live and Refresh still works", async ({ page, request }) => {
    await mockRealtime(page, { fail: true });
    const account = await newDay3Account(request, { seed: true });
    const count = reads(page, "leads");
    await open(page, account, "/dashboard/leads", "Leads");
    await expect(page.getByText("Not updating live. Use Refresh.")).toBeVisible();
    await settle(page); // the first join reads once to catch up; count from after it
    const before = count();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect.poll(count).toBeGreaterThan(before);
    await expect(page.getByTestId("leads-board").getByRole("link", { name: /Karthik R/ })).toBeVisible();
  });
});

test.describe("Calendar · Realtime", () => {
  test.use({ storageState: SIGNED_OUT });

  test("subscribes for this business's bookings and reads the shown day again once for a burst of changes", async ({ page, request }) => {
    const rt = await mockRealtime(page);
    const account = await newDay3Account(request, { seed: true });
    const count = reads(page, "bookings");
    await open(page, account, `/dashboard/calendar?date=${DAY}`, CALENDAR_HEADING);
    await expect(page.getByRole("button", { name: /Karthik R/ })).toBeVisible();
    await expect(page.getByText("Updating live.")).toBeVisible();
    await expect.poll(() => rt.joins.length).toBeGreaterThan(0);
    expectSubscribed(rt.joins, "bookings", account);

    await settle(page); // the first join reads once to catch up; count from after it
    const before = count();
    for (let i = 0; i < 3; i++) rt.push("bookings", "UPDATE", { id: `cccccccc-0000-0000-0000-00000000000${i}`, tenant_id: account.tenantId, status: "cancelled" });
    await expect.poll(count).toBe(before + 1);
    await settle(page);
    expect(count(), "a burst of changes is one read").toBe(before + 1);
    await expect(page.getByRole("button", { name: /Karthik R/ })).toHaveCount(1);

    rt.push("bookings", "UPDATE", { id: "cccccccc-0000-0000-0000-0000000000aa", tenant_id: OTHER_BUSINESS, status: "cancelled" });
    await settle(page);
    expect(count(), "another business's change is ignored").toBe(before + 1);
  });

  test("when the join is refused it says it is not live", async ({ page, request }) => {
    await mockRealtime(page, { fail: true });
    const account = await newDay3Account(request, { seed: true });
    await open(page, account, `/dashboard/calendar?date=${DAY}`, CALENDAR_HEADING);
    await expect(page.getByText("Not updating live. Use Refresh.")).toBeVisible();
  });
});
