import type { Page } from "@playwright/test";
import { expect, expectNoHorizontalOverflow, mainNav, SIGNED_OUT, test } from "../support/app";
import { stubApi } from "../support/day5";
import { mockKbApi } from "../support/kb-api";

// The real dashboard's main navigation as one journey, signed in through the project's storage state
// (owner@test.local, Test Realty). auth.spec.ts checks the business name on each screen; this checks
// that the navigation offers exactly the sections that exist, that each one opens at its own address
// with no redirect, and that Back and Forward keep you in the dashboard.

const SECTIONS = [
  { link: "Home", path: "/dashboard", heading: "Test Realty" },
  { link: "Inbox", path: "/dashboard/inbox", heading: "Inbox" },
  { link: "Leads", path: "/dashboard/leads", heading: "Leads" },
  // The calendar's heading is the day it shows (today, in the business's time zone).
  { link: "Calendar", path: "/dashboard/calendar", heading: /^(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day \d{1,2} [A-Z][a-z]{2}$/ },
  { link: "Features", path: "/dashboard/features", heading: "Features" },
  { link: "Billing", path: "/dashboard/billing", heading: "Billing and credits" },
  { link: "Knowledge base", path: "/dashboard/knowledge", heading: "Knowledge base" },
  { link: "Booking setup", path: "/dashboard/settings/booking", heading: "Booking setup" },
  { link: "Team", path: "/dashboard/team", heading: "Team" },
  { link: "Send test message", path: "/dashboard/messages/test", heading: "Send a test message" },
  { link: "Create template", path: "/dashboard/templates/new", heading: "Create a message template" },
  { link: "WhatsApp", path: "/dashboard/whatsapp", heading: "WhatsApp connection" },
] as const;

const exactPath = (path: string) => new RegExp(`^[^?#]*//[^/]+${path.replace(/\//g, "\\/")}$`);

/**
 * The inbox opens a Supabase Realtime socket; mock-supabase has none, so hold it open and silent. The
 * Knowledge base calls the knowledge-base API, which isn't built yet: support/kb-api.ts stands in.
 */
async function holdRealtime(page: Page) {
  await page.routeWebSocket(/\/realtime\/v1\/websocket/, () => {});
  // Billing reads GET /api/billing/balance and, under RLS, plans and credit_ledger; the journey only needs the screen to open.
  await stubApi(page, /\/api\/billing\/balance$/, () => ({
    status: 200,
    body: { status: "active", plan: { key: "growth", name: "Growth", monthlyCredits: 1500 }, credits: { plan: 1, topup: 0, total: 1 }, creditsGranted: 10, renewsAt: null, trialEndsAt: null, aiPaused: false, aiPausedReason: null, lowCredits: false, aiAutoReply: true },
  }));
}

test.describe("dashboard navigation", () => {
  test("offers exactly the dashboard's sections, and each opens at its own address", async ({ page, request }) => {
    await holdRealtime(page);
    await mockKbApi(page, request);
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { level: 1, name: "Test Realty" })).toBeVisible();

    const links = mainNav(page).getByRole("link");
    await expect(links).toHaveText([...SECTIONS.map((s) => s.link), /^Dashboard preview/]);

    for (const section of [...SECTIONS.slice(1), SECTIONS[0]]) {
      const link = mainNav(page).getByRole("link", { name: section.link, exact: true });
      await expect(link).toHaveAttribute("href", section.path);
      await link.click();
      await expect(page).toHaveURL(exactPath(section.path));
      await expect(page.getByRole("heading", { level: 1, name: section.heading, exact: true })).toBeVisible();
      await expect(link).toHaveAttribute("aria-current", "page");
      await expect(mainNav(page).locator('[aria-current="page"]')).toHaveCount(1);
      await expectNoHorizontalOverflow(page);
    }
  });

  test("Back and Forward move between sections without leaving the dashboard", async ({ page, request }) => {
    await holdRealtime(page);
    await mockKbApi(page, request);
    await page.goto("/dashboard/whatsapp");
    await expect(page.getByRole("heading", { level: 1, name: "WhatsApp connection" })).toBeVisible();
    await mainNav(page).getByRole("link", { name: "Knowledge base", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Knowledge base" })).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(exactPath("/dashboard/whatsapp"));
    await expect(page.getByRole("heading", { level: 1, name: "WhatsApp connection" })).toBeVisible();
    await page.goForward();
    await expect(page).toHaveURL(exactPath("/dashboard/knowledge"));
    await expect(page.getByRole("heading", { level: 1, name: "Knowledge base" })).toBeVisible();
    await expect(mainNav(page).getByRole("link", { name: "Knowledge base", exact: true })).toHaveAttribute("aria-current", "page");
  });
});

test.describe("dashboard navigation, signed out", () => {
  test.use({ storageState: SIGNED_OUT });

  // auth.spec.ts covers the other sections; these pages came later.
  for (const path of ["/dashboard/inbox", "/dashboard/knowledge", "/dashboard/leads", "/dashboard/calendar", "/dashboard/settings/booking"]) {
    test(`${path} sends a signed-out visitor to sign-in`, async ({ page }) => {
      await page.goto(path);
      // The dashboard layout does the redirect and can't read the URL, so every page asks for /dashboard.
      await expect(page).toHaveURL(/\/login\?next=%2Fdashboard$/);
      await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
      await expect(mainNav(page)).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
    });
  }
});
