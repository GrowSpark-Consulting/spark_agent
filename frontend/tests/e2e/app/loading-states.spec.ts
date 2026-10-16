import type { Page } from "@playwright/test";
import { expect, expectNoHorizontalOverflow, SIGNED_OUT, test } from "../support/app";
import { stubApi } from "../support/day5";

// What each of the newer screens says while its data is still on its way: that it is loading, and nothing else (no empty message, no error, no
// half-drawn content). Each read is held with page.route until the test lets it go, then the screen must show its content and no loading text.
// Mocked: this proves what the screen draws while a read is open, not how long a real read takes. Screens whose loading state is already tested
// elsewhere (Knowledge, Inbox, Leads, Calendar, Booking setup, Agent settings, Privacy, Admin billing, connections and metrics, WhatsApp) are not repeated.

/** A read that is held until `open()`. */
function gate() {
  let open: () => void = () => {};
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

/** Holds the page's REST reads of one table (not the API) until the gate opens, then answers with `rows`. */
async function holdTable(page: Page, table: string, rows: unknown, g: ReturnType<typeof gate>) {
  await page.route((url) => url.pathname === `/rest/v1/${table}`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fallback();
    await g.wait;
    return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": req.headers()["origin"] ?? "*" }, body: JSON.stringify(rows) });
  });
}

/** Alerts inside the page's content: Next's route announcer is a role=alert outside it, and carries the page title after a client-side navigation. */
const alerts = (page: Page) => page.locator('main [role="alert"]');
const loadingText = (page: Page, text: string) => page.getByRole("status").filter({ hasText: text });
/**
 * No screen may show an empty, missing or error message while it is only loading. `staticEmpty` is the number of empty-state notes the page always
 * has (Billing's Invoices section says there is no invoice list, loaded or not).
 */
async function expectOnlyLoading(page: Page, staticEmpty = 0) {
  await expect(alerts(page)).toHaveCount(0);
  await expect(page.locator(".app-state-empty")).toHaveCount(staticEmpty);
  await expect(page.locator("body")).not.toContainText(/Couldn.t load|isn.t available yet|Try again/);
}

const balance = {
  status: "active",
  plan: { key: "growth", name: "Growth", monthlyCredits: 1500 },
  credits: { plan: 900, topup: 100, total: 1000 },
  creditsGranted: 1600,
  renewsAt: "2026-11-01T00:00:00.000Z",
  trialEndsAt: null,
  aiPaused: false,
  aiPausedReason: null,
  lowCredits: false,
  aiAutoReply: true,
};
const PLAN_ROWS = [
  { key: "starter", name: "Starter", price_inr: 999, monthly_credits: 600, seats: 2, whatsapp_numbers: 1 },
  { key: "growth", name: "Growth", price_inr: 2499, monthly_credits: 1500, seats: 5, whatsapp_numbers: 1 },
];

test.describe("Loading states: dashboard screens", () => {
  test("Billing: the plan, credits, plans and credit history each say they are loading, then show", async ({ page }) => {
    const g = gate();
    await stubApi(page, /\/api\/billing\/balance$/, async () => {
      await g.wait;
      return { status: 200, body: balance };
    });
    await holdTable(page, "plans", PLAN_ROWS, g);
    await holdTable(page, "credit_ledger", [], g);
    await page.goto("/dashboard/billing");
    await expect(page.getByRole("heading", { level: 1, name: "Billing and credits" })).toBeVisible();
    await expect(loadingText(page, "Loading your plan")).toBeVisible();
    await expect(loadingText(page, "Loading your credits")).toBeVisible();
    await expect(loadingText(page, "Loading plans")).toBeVisible();
    await expect(loadingText(page, "Loading credit history")).toBeVisible();
    await expectOnlyLoading(page, 1);
    await expectNoHorizontalOverflow(page);
    g.open();
    await expect(page.getByTestId("plan-list").locator("[data-plan]")).toHaveCount(2);
    await expect(page.getByRole("status").filter({ hasText: /^Loading/ })).toHaveCount(0);
  });

  test("Features: says it is loading, then shows the list", async ({ page }) => {
    const g = gate();
    await stubApi(page, /\/api\/features$/, async () => {
      await g.wait;
      return {
        status: 200,
        body: {
          plan: { key: "starter", name: "Starter", monthlyCredits: 1500 },
          estimatedCreditsPerMonth: 12,
          groups: [
            {
              name: "Reminders",
              features: [{ key: "reminder_24h", name: "24-hour reminder", description: "Reminds customers.", state: "on", enabled: true, requiredPlan: null, disabledReason: null, creditsPerMonth: 12, creditNote: null, settings: {}, control: "switch" }],
            },
          ],
        },
      };
    });
    await page.goto("/dashboard/features");
    await expect(loadingText(page, "Loading your features")).toBeVisible();
    await expect(page.getByRole("switch")).toHaveCount(0);
    await expectOnlyLoading(page);
    await expectNoHorizontalOverflow(page);
    g.open();
    await expect(page.getByRole("switch", { name: "24-hour reminder", exact: true })).toBeVisible();
    await expect(loadingText(page, "Loading your features")).toHaveCount(0);
  });

  test("Integrations: says it is loading, shows no form meanwhile, then the form", async ({ page }) => {
    const g = gate();
    await stubApi(page, /\/api\/integrations\/webhook$/, async () => {
      await g.wait;
      return { status: 200, body: { inPlan: true, sending: true, endpoint: null } };
    });
    await page.goto("/dashboard/settings/integrations");
    await expect(page.getByRole("heading", { level: 1, name: "Integrations" })).toBeVisible();
    await expect(loadingText(page, "Loading your webhook")).toBeVisible();
    await expect(page.getByLabel("Address that receives the events")).toHaveCount(0);
    await expectOnlyLoading(page);
    await expectNoHorizontalOverflow(page);
    g.open();
    await expect(page.getByLabel("Address that receives the events")).toBeVisible();
    await expect(loadingText(page, "Loading your webhook")).toHaveCount(0);
  });

  test("Team: says it is loading the team, not an empty team, then lists the members", async ({ page }) => {
    const g = gate();
    await stubApi(page, /\/api\/team$/, async () => {
      await g.wait;
      return {
        status: 200,
        body: {
          viewerRole: "owner",
          inviteRoles: ["admin", "staff"],
          seats: { used: 1, members: 1, pending: 0, limit: 5, planName: "Growth" },
          members: [{ userId: "00000000-0000-4000-8000-000000000001", role: "owner", name: "Meera Rao", email: "owner@test.local", you: true }],
          invites: [],
        },
      };
    });
    await page.goto("/dashboard/team");
    await expect(loadingText(page, "Loading your team")).toBeVisible();
    await expect(page.getByText("Meera Rao")).toHaveCount(0);
    // Only the members list is held. The page's other sections (your number, how you take over) read on their own and are not what is asserted.
    await expect(page.getByText("Couldn't load your team")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    g.open();
    await expect(page.getByText("Meera Rao")).toBeVisible();
    await expect(loadingText(page, "Loading your team")).toHaveCount(0);
  });

  test("Home: the credit card and the month's numbers each say they are loading, then show", async ({ page }) => {
    const g = gate();
    await stubApi(page, /\/api\/billing\/balance$/, async () => {
      await g.wait;
      return { status: 200, body: balance };
    });
    await stubApi(page, /\/api\/dashboard\/summary$/, async () => {
      await g.wait;
      return {
        status: 200,
        body: { month: "2026-10", stats: { enquiries: 50, qualified: 18, booked: 7, afterHours: 11, enquiriesChangePct: 18 }, overnightHandled: 9, hotLeads: [], todayBookings: [] },
      };
    });
    await page.goto("/dashboard");
    await expect(loadingText(page, "Loading your credits")).toBeVisible();
    await expect(loadingText(page, "Loading this month's numbers")).toBeVisible();
    await expect(page.getByTestId("credit-meter")).toHaveCount(0);
    await expect(page.getByTestId("month-summary")).toHaveCount(0);
    // The WhatsApp card is not what is held here: the e2e database has no connections view for this account, so that card always says so.
    await expectOnlyLoading(page, 1);
    await expectNoHorizontalOverflow(page);
    g.open();
    await expect(page.getByTestId("credit-meter")).toBeVisible();
    await expect(page.getByTestId("month-summary")).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: /^Loading/ })).toHaveCount(0);
  });
});

test.describe("Loading states: public pages", () => {
  test.use({ storageState: SIGNED_OUT });

  test("the connect link page says it is checking the link, offers nothing to press, then shows who it is for", async ({ page }) => {
    const g = gate();
    const token = "Zx9_k-Q2mP4rT7vB1nL6cD8fH3jW5yA0sE2uI4oG6hM";
    await stubApi(page, /\/api\/connect-links\/[A-Za-z0-9_-]+$/, async () => {
      await g.wait;
      return { status: 200, body: { tenantName: "Sunrise Homes", expiresAt: "2099-01-01T10:00:00.000Z" } };
    });
    await page.goto(`/connect/${token}`);
    await expect(loadingText(page, "Checking your link")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue with Facebook" })).toHaveCount(0);
    await expect(page.getByTestId("connect-invalid")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    g.open();
    await expect(page.getByRole("heading", { level: 1, name: "Connect Sunrise Homes to WhatsApp" })).toBeVisible();
    await expect(loadingText(page, "Checking your link")).toHaveCount(0);
  });

  test("the invitation page says it is checking the invitation, offers no sign-in meanwhile, then says who invited you", async ({ page }) => {
    const g = gate();
    const token = "Qx9_k-Q2mP4rT7vB1nL6cD8fH3jW5yA0sE2uI4oG6hM";
    await stubApi(page, /\/api\/team\/invites\/[A-Za-z0-9_-]{43}$/, async () => {
      await g.wait;
      return { status: 200, body: { status: "valid", businessName: "Sunrise Salon", role: "staff", expiresAt: "2099-01-01T10:00:00.000Z" } };
    });
    await page.goto(`/invite/${token}`);
    await expect(loadingText(page, "Checking your invitation")).toBeVisible();
    await expect(page.getByRole("link", { name: "Sign in to join" })).toHaveCount(0);
    await expect(page.getByTestId("invite-invalid")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    g.open();
    await expect(page.getByRole("heading", { level: 1, name: "Join Sunrise Salon" })).toBeVisible();
    await expect(loadingText(page, "Checking your invitation")).toHaveCount(0);
  });
});
