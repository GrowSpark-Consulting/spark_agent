import { appAlert, expect, expectNoHorizontalOverflow, SIGNED_OUT, signIn, test } from "../support/app";
import { DAY, newDay3Account, open, writesBy } from "../support/day3";
import { stubApi } from "../support/day5";

// The screens every role works in. Most role tests check what a role is refused; these check what a staff member can do, because the Inbox,
// Leads and Calendar are the staff member's daily screens and nothing else pinned that they stay open to them. The refusals for each role
// are in each screen's own spec and are listed in docs/dashboard-roles-and-routes.md. Mocked: the mock database and a stood-in mode route, so
// this proves what the screen offers and sends for a staff member, not that the real route or RLS lets them (backend authorization-routes.test.ts
// proves the first against the real route table; RLS needs staging).

test.use({ storageState: SIGNED_OUT });

test.describe("Staff work the shared screens", () => {
  test("a staff member sees the leads board and a lead's detail, and the screens write nothing", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true, role: "staff" });
    await open(page, account, "/dashboard/leads", "Leads");
    await expect(page.getByTestId("leads-board").getByRole("region", { name: /^Qualified · \d+$/ })).toContainText("Karthik R");
    await expect(page.getByTestId("leads-board").getByRole("region", { name: /^New · \d+$/ })).toContainText("Priya S");
    await expectNoHorizontalOverflow(page);

    await page.getByTestId("leads-board").getByRole("link", { name: /Karthik R/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: /Karthik R/ })).toBeVisible();
    expect(await writesBy(request, account.email)).toEqual([]);
  });

  test("a staff member sees the calendar's bookings for the day", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true, role: "staff" });
    await open(page, account, `/dashboard/calendar?date=${DAY}`, "Monday 12 Oct");
    await expect(page.getByRole("button", { name: /Karthik R/ }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Priya S/ }).first()).toBeVisible();
    await expect(appAlert(page)).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    expect(await writesBy(request, account.email)).toEqual([]);
  });

  test("a staff member can open a chat and take it over, with their own token and business", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true, inbox: true, role: "staff" });
    const calls = await stubApi(page, /\/api\/conversations\/[^/]+\/mode$/, () => ({ status: 200, body: { mode: "human", changed: true } }));
    await signIn(page, account.email, "/dashboard/inbox");
    await expect(page).toHaveURL(/\/dashboard\/inbox/);
    await page.getByTestId("inbox").getByRole("button", { name: /Meena K/ }).click();
    const who = page.getByRole("group", { name: "Who replies" });
    await expect(who.getByRole("button", { name: "AI" })).toHaveAttribute("aria-pressed", "true");
    await expect(who.getByRole("button", { name: "Human" })).toBeEnabled();
    await who.getByRole("button", { name: "Human" }).click();
    await expect(who.getByRole("button", { name: "Human" })).toHaveAttribute("aria-pressed", "true");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].tenant).toBe(account.tenantId);
    expect(calls[0].authorization).toMatch(/^Bearer /);
    expect(calls[0].body).toEqual({ mode: "human" });
    await expectNoHorizontalOverflow(page);
  });
});
