import type { Page } from "@playwright/test";
import { expect, MOCK_SUPABASE_URL, SIGNED_OUT, signIn, signUp, test, uniqueEmail } from "../support/app";

// Onboarding's Business step creates the account's trial business through createTrialTenant (the
// mock implements create_trial_tenant like migration 0006). Signing up alone creates nothing.

type Business = {
  memberships: { tenantId: string; name: string; vertical: string; status: string; planKey: string; role: string; credits: number | null; routeCode: string | null }[];
  trialCalls: number;
};
async function business(page: Page, email: string): Promise<Business> {
  const res = await page.request.get(`${MOCK_SUPABASE_URL}/__mock/business?email=${encodeURIComponent(email)}`);
  return res.json();
}

const next = (page: Page, label: string | RegExp) => page.getByRole("button", { name: label });
const trade = (page: Page, name: string) => page.getByRole("radio", { name: new RegExp(`^${name}`) });

/** Opens the wizard with a frozen clock (its import animation runs on timers) and passes the phone step. */
async function toBusinessStep(page: Page) {
  await page.clock.install({ time: new Date("2026-10-24T09:00:00+05:30") });
  await page.goto("/onboarding");
  await next(page, "Send code on WhatsApp").click();
  await page.getByPlaceholder("––––––").fill("123456");
  await next(page, "Verify and continue").click();
  await expect(page.getByRole("heading", { name: "Tell us about your business" })).toBeVisible();
}

async function newAccount(page: Page) {
  const email = uniqueEmail();
  await signUp(page, email);
  await expect(page).toHaveURL(/\/onboarding$/);
  return email;
}

// The trades the Business step offers come from vertical_packs (active rows only). These accounts see
// their own pack catalogue instead of the table's launch packs, or a read that fails.
type PackRow = { key: string; version: number; active: boolean; definition: Record<string, unknown> };
const pack = (key: string, label: string | null, { version = 1, active = true } = {}): PackRow => ({
  key, version, active, definition: label === null ? { key, version } : { key, version, label },
});
async function catalogueAccount(page: Page, catalogue: { packs?: PackRow[]; packsError?: boolean }) {
  const { email } = (await (await page.request.post(`${MOCK_SUPABASE_URL}/__mock/onboarding-account`, { data: catalogue })).json()) as { email: string };
  await signIn(page, email);
  await expect(page).toHaveURL(/\/onboarding$/);
  return email;
}

/** The built-in trades that have no pack: never offered. */
const INACTIVE = ["Hotel", "Restaurant", "Plumber", "Electrician"];
async function expectHidden(page: Page, names: string[]) {
  for (const name of names) {
    await expect(page.getByRole("radio", { name: new RegExp(name) })).toHaveCount(0);
    await expect(page.getByText(name, { exact: true })).toHaveCount(0);
  }
}

test.describe("trial signup from onboarding", () => {
  test.use({ storageState: SIGNED_OUT });

  test("signing up creates no business; the Business step creates exactly one trial", async ({ page }) => {
    const email = await newAccount(page);
    expect(await business(page, email)).toEqual({ memberships: [], trialCalls: 0 });

    await toBusinessStep(page);
    await page.getByLabel("Business name").fill("  Sunrise Homes ");
    await trade(page, "Real estate").click();
    await next(page, "Continue").click();
    await expect(page.getByRole("heading", { name: "Teach your assistant" })).toBeVisible();

    const first = await business(page, email);
    expect(first.trialCalls).toBe(1);
    expect(first.memberships).toEqual([
      {
        tenantId: expect.any(String),
        name: "Sunrise Homes",
        vertical: "real-estate",
        status: "trial",
        planKey: "trial",
        role: "owner",
        credits: 300,
        routeCode: expect.stringMatching(/^TRIAL-[2-9A-HJKMNP-Z]{4}$/),
      },
    ]);
    const { routeCode } = first.memberships[0];

    // Back and Continue again: the account has a business now, so nothing new is created.
    await next(page, "Back").click();
    await next(page, "Continue").click();
    await expect(page.getByRole("heading", { name: "Teach your assistant" })).toBeVisible();
    await next(page, "Back").click();
    await expect(page.getByText("Your account already belongs to a business, so no new one was created.")).toBeVisible();
    expect(await business(page, email)).toEqual(first);

    // The rest of the wizard shows the real trial instead of the prototype's sample code and credits.
    await next(page, "Continue").click();
    await next(page, "Continue").click();
    await expect(page.getByText(`Your code is ${routeCode}.`)).toBeVisible();
    // The link uses the configured demo number (the e2e build's fictional one) and this business's own code, nothing hardcoded.
    await expect(page.getByRole("link", { name: "Open WhatsApp test chat" })).toHaveAttribute("href", `https://wa.me/15555550100?text=${routeCode}`);
    await expect(page.locator('a[href*="919000000000"]')).toHaveCount(0);
    await next(page, "I’ve tried it").click();
    await next(page, "Do this later").click();
    await next(page, "Go live").click();
    await expect(page.getByText(`Test number · code ${routeCode}`)).toBeVisible();
    await expect(page.getByText("7 days · 300 credits")).toBeVisible();
    await expect(page.getByText("150 credits")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "You’re set up." })).toBeVisible();

    // Into the dashboard as the new business's owner, with the real Day 1 screens.
    await page.getByRole("link", { name: "Go to my dashboard" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole("heading", { level: 1, name: "Sunrise Homes" })).toBeVisible();
    await expect(page.getByTestId("no-business")).toHaveCount(0);

    await page.goto("/dashboard/whatsapp");
    await expect(page.getByRole("heading", { level: 1, name: "WhatsApp connection" })).toBeVisible();
    await expect(page.getByText("No WhatsApp number connected")).toBeVisible();
    await expect(page.getByTestId("no-business")).toHaveCount(0);

    await page.goto("/dashboard/messages/test");
    await expect(page.getByRole("heading", { level: 1, name: "Send a test message" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send test message" })).toBeVisible();
    await expect(page.getByTestId("no-business")).toHaveCount(0);

    await page.goto("/dashboard/templates/new");
    await expect(page.getByRole("heading", { level: 1, name: "Create a message template" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Submit for review" })).toBeVisible();
    await expect(page.getByTestId("no-business")).toHaveCount(0);

    // Back in the wizard later, the Business step still creates nothing.
    await toBusinessStep(page);
    await page.getByLabel("Business name").fill("Another Business");
    await trade(page, "Beauty parlour").click();
    await next(page, "Continue").click();
    await expect(page.getByRole("heading", { name: "Teach your assistant" })).toBeVisible();
    expect(await business(page, email)).toEqual(first);

    // Onboarded now: signing in again, or opening /signup, goes straight to the dashboard.
    await page.goto("/dashboard");
    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await signIn(page, email);
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole("heading", { level: 1, name: "Sunrise Homes" })).toBeVisible();
    await page.goto("/signup");
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test("offers only trades with an active pack, named by the pack, and still sends the trade key", async ({ page }) => {
    const email = await newAccount(page);
    await toBusinessStep(page);
    // The launch packs in vertical_packs: real-estate, interiors and salon ("Beauty parlour").
    await expect(page.getByRole("radio")).toHaveText([/^Real estate/, /^Interior design/, /^Beauty parlour/]);
    await expectHidden(page, ["Salon", ...INACTIVE]);
    await expect(trade(page, "Real estate")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByText("Trials for this trade aren’t open yet.")).toHaveCount(0);

    await page.getByLabel("Business name").fill("Glow Studio");
    await trade(page, "Beauty parlour").click();
    await expect(trade(page, "Beauty parlour")).toContainText("Books: appointments");
    const sent = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/api/onboarding/trial"));
    await next(page, "Continue").click();
    expect((await sent).postDataJSON()).toEqual({ name: "Glow Studio", industry: "salon" });
    await expect(page.getByRole("heading", { name: "Teach your assistant" })).toBeVisible();
    const { memberships } = await business(page, email);
    expect(memberships).toMatchObject([{ name: "Glow Studio", vertical: "salon", role: "owner" }]);
  });

  test("a pack with no label shows the trade's own name, and a repeated pack key shows one card", async ({ page }) => {
    await catalogueAccount(page, {
      packs: [pack("real-estate", "Real estate"), pack("real-estate", "Real estate", { version: 2 }), pack("salon", null)],
    });
    await toBusinessStep(page);
    await expect(page.getByRole("radio")).toHaveText([/^Real estate/, /^Salon/]);
    await expectHidden(page, ["Beauty parlour", "Interior design", ...INACTIVE]);
  });

  test("starts on the first offered trade when the default one has no active pack", async ({ page }) => {
    const email = await catalogueAccount(page, {
      packs: [pack("real-estate", "Real estate", { active: false }), pack("interiors", "Interior design"), pack("salon", "Beauty parlour")],
    });
    await toBusinessStep(page);
    await expect(page.getByRole("radio")).toHaveText([/^Interior design/, /^Beauty parlour/]);
    await expectHidden(page, ["Real estate", ...INACTIVE]);
    await expect(trade(page, "Interior design")).toHaveAttribute("aria-checked", "true");
    await expect(page.getByLabel("Business name")).toHaveAttribute("placeholder", "Nest Interiors");

    await page.getByLabel("Business name").fill("Nest Homes");
    const sent = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/api/onboarding/trial"));
    await next(page, "Continue").click();
    expect((await sent).postDataJSON()).toEqual({ name: "Nest Homes", industry: "int" });
    await expect(page.getByRole("heading", { name: "Teach your assistant" })).toBeVisible();
    expect((await business(page, email)).memberships).toMatchObject([{ name: "Nest Homes", vertical: "interiors", role: "owner" }]);
  });

  test("with no active pack, no trade is offered and Continue stays off", async ({ page }) => {
    const email = await catalogueAccount(page, { packs: [pack("real-estate", "Real estate", { active: false })] });
    await toBusinessStep(page);
    await page.getByLabel("Business name").fill("Sunrise Homes");
    await expect(page.getByText("Trials aren’t open for any trade yet.")).toBeVisible();
    await expect(page.getByRole("radio")).toHaveCount(0);
    await expectHidden(page, ["Real estate", ...INACTIVE]);
    await expect(next(page, "Continue")).toBeDisabled();
    expect(await business(page, email)).toEqual({ memberships: [], trialCalls: 0 });
  });

  test("when the packs can't be read, no trade is offered and Continue stays off", async ({ page }) => {
    const email = await catalogueAccount(page, { packsError: true });
    await toBusinessStep(page);
    await page.getByLabel("Business name").fill("Sunrise Homes");
    await expect(page.getByText("We couldn’t load the trades that are open. Reload the page to try again.")).toBeVisible();
    // No fallback to the six built-in trades.
    await expect(page.getByRole("radio")).toHaveCount(0);
    await expectHidden(page, ["Real estate", "Interior design", "Salon", "Beauty parlour", ...INACTIVE]);
    await expect(next(page, "Continue")).toBeDisabled();
    expect(await business(page, email)).toEqual({ memberships: [], trialCalls: 0 });
  });

  for (const member of ["owner@test.local", "staff@test.local"]) {
    test(`an existing member (${member}) gets no new trial`, async ({ page }) => {
      const before = await business(page, member);
      await signIn(page, member);
      await expect(page).toHaveURL(/\/dashboard$/);
      await toBusinessStep(page);
      await page.getByLabel("Business name").fill("Side Business");
      await trade(page, "Beauty parlour").click();
      await next(page, "Continue").click();
      await expect(page.getByRole("heading", { name: "Teach your assistant" })).toBeVisible();
      await next(page, "Back").click();
      await expect(page.getByText("Your account already belongs to a business, so no new one was created.")).toBeVisible();
      expect(await business(page, member)).toEqual(before);
      expect(before.trialCalls).toBe(0);
    });
  }
});
