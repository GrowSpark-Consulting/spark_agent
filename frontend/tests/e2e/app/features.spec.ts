import type { Page } from "@playwright/test";
import { expect, expectNoHorizontalOverflow, mainNav, SIGNED_OUT, signIn, test } from "../support/app";
import { newDay3Account } from "../support/day3";
import { refusal, stubApi } from "../support/day5";

// /dashboard/features (Day 5, Dev 3). GET /api/features and PATCH /api/features/:key are Dev 2's (origin/feat/features-api, not on main), so
// every answer here is stood in for with page.route: these tests prove what the screen sends, how it reads each answer and what it refuses
// to send, not that the real routes exist. Server-side plan enforcement is Dev 2's (set_tenant_feature) and is not tested here.

type Row = Record<string, unknown>;
const row = (over: Row): Row => ({
  description: "Does a thing for you.",
  state: "on",
  enabled: true,
  requiredPlan: null,
  disabledReason: null,
  creditsPerMonth: null,
  creditNote: "No extra credits",
  settings: {},
  control: "switch",
  ...over,
});

const reminder = row({ key: "reminder_24h", name: "24-hour reminder", creditsPerMonth: 12, creditNote: null, control: "timing", settings: { offset_minutes: 1440 } });
const nudges = row({ key: "followup_nudges", name: "Follow-up nudges", state: "locked", enabled: false, requiredPlan: "growth", creditsPerMonth: 0, creditNote: null });
const agenda = row({ key: "daily_agenda", name: "Daily agenda", state: "off", enabled: false });
const needsService = row({ key: "booking", name: "Booking", state: "disabled", enabled: false, disabledReason: "Add a service first.", creditNote: "Part of replies" });
const list = (rows: Row[] = [reminder, nudges, agenda, needsService]) => ({
  plan: { key: "starter", name: "Starter", monthlyCredits: 1500 },
  estimatedCreditsPerMonth: 12,
  groups: [
    { name: "Reminders", features: rows.slice(0, 1) },
    { name: "Follow-up and feedback", features: rows.slice(1, 2) },
    { name: "Team alerts", features: rows.slice(2, 3) },
    { name: "Booking", features: rows.slice(3) },
  ].filter((g) => g.features.length > 0),
});

const FEATURES = /\/api\/features$/;
const FEATURE = /\/api\/features\/[a-z0-9_]+$/;
const sw = (page: Page, name: string) => page.getByRole("switch", { name, exact: true });
const rowOf = (page: Page, key: string) => page.locator(`[data-feature="${key}"]`);
const toast = (page: Page, text: string) => page.getByRole("status").filter({ hasText: text });

test.describe("Features", () => {
  test("shows each feature from the server's list: switches, credits, locked and unavailable rows", async ({ page }) => {
    await stubApi(page, FEATURES, () => ({ status: 200, body: list() }));
    await page.goto("/dashboard/features");
    await expect(page.getByRole("heading", { level: 1, name: "Features" })).toBeVisible();
    await expect(mainNav(page).getByRole("link", { name: "Features", exact: true })).toHaveAttribute("aria-current", "page");

    await expect(page.getByTestId("credits-estimate")).toHaveText("About 12 of 1,500 credits a month with what's on");
    await expect(page.getByRole("region", { name: "Your plan" })).toContainText("Starter");

    await expect(sw(page, "24-hour reminder")).toBeChecked();
    await expect(rowOf(page, "reminder_24h")).toContainText("12 credits in the last 30 days");
    await expect(sw(page, "Daily agenda")).not.toBeChecked();
    await expect(rowOf(page, "daily_agenda")).toContainText("No extra credits");

    // Locked: no switch at all, only Upgrade, naming the plan.
    await expect(sw(page, "Follow-up nudges")).toHaveCount(0);
    await expect(rowOf(page, "followup_nudges").getByRole("button", { name: "Upgrade to Growth" })).toBeVisible();
    await expect(rowOf(page, "followup_nudges")).toContainText("Needs the Growth plan.");

    // In the plan but cannot work yet: shown off and disabled, with the reason.
    await expect(sw(page, "Booking")).toBeDisabled();
    await expect(rowOf(page, "booking")).toContainText("Add a service first.");
    await expectNoHorizontalOverflow(page);
  });

  test("a switch calls PATCH for that feature and shows the row the server answers with", async ({ page }) => {
    await stubApi(page, FEATURES, () => ({ status: 200, body: list() }));
    const patches = await stubApi(page, FEATURE, () => ({ status: 200, body: { ...reminder, state: "off", enabled: false } }));
    await page.goto("/dashboard/features");
    await sw(page, "24-hour reminder").click();
    await expect(toast(page, "24-hour reminder is off")).toBeVisible();
    await expect(sw(page, "24-hour reminder")).not.toBeChecked();
    expect(patches).toHaveLength(1);
    expect(patches[0].method).toBe("PATCH");
    expect(patches[0].url.pathname).toBe("/api/features/reminder_24h");
    expect(patches[0].body).toEqual({ enabled: false });
    expect(patches[0].tenant).toMatch(/^[0-9a-f-]{36}$/);
    expect(patches[0].authorization).toMatch(/^Bearer /);
    // The estimate follows: this feature is off now, so its credits no longer count.
    await expect(page.getByTestId("credits-estimate")).toHaveText("About 0 of 1,500 credits a month with what's on");
  });

  test("does not move the switch until the server answers, and leaves it where it was when the change fails", async ({ page }) => {
    await stubApi(page, FEATURES, () => ({ status: 200, body: list() }));
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    await stubApi(page, FEATURE, async () => {
      await gate;
      return refusal(500, "internal", "Something went wrong. Try again in a moment.");
    });
    await page.goto("/dashboard/features");
    await sw(page, "24-hour reminder").click();
    await expect(rowOf(page, "reminder_24h")).toContainText("Saving…");
    await expect(sw(page, "24-hour reminder")).toBeDisabled();
    await expect(sw(page, "24-hour reminder")).toBeChecked();
    release();
    await expect(rowOf(page, "reminder_24h").getByRole("alert")).toContainText("Something went wrong");
    await expect(sw(page, "24-hour reminder")).toBeChecked();
    await expect(sw(page, "24-hour reminder")).toBeEnabled();
  });

  test("a plan_required answer opens Upgrade and the switch stays off", async ({ page }) => {
    await stubApi(page, FEATURES, () => ({ status: 200, body: list() }));
    await stubApi(page, FEATURE, () => refusal(403, "plan_required", "Daily agenda needs the Growth plan. Upgrade to switch it on."));
    await page.goto("/dashboard/features");
    await sw(page, "Daily agenda").click();
    await expect(page.getByRole("dialog")).toContainText("Daily agenda isn't in your plan");
    await expect(page.getByRole("dialog")).toContainText("Changing plans from the dashboard isn't switched on yet");
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
    await expect(sw(page, "Daily agenda")).not.toBeChecked();
  });

  test("Upgrade on a locked row only explains: no change is sent", async ({ page }) => {
    await stubApi(page, FEATURES, () => ({ status: 200, body: list() }));
    const patches = await stubApi(page, FEATURE, () => ({ status: 200, body: nudges }));
    await page.goto("/dashboard/features");
    await rowOf(page, "followup_nudges").getByRole("button", { name: "Upgrade to Growth" }).click();
    await expect(page.getByRole("dialog")).toContainText("Follow-up nudges is on the Growth plan");
    await expect(page.getByRole("dialog")).toContainText("You're on Starter");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(patches).toHaveLength(0);
  });

  test("the reminder's timing is saved as offset_minutes", async ({ page }) => {
    await stubApi(page, FEATURES, () => ({ status: 200, body: list() }));
    const patches = await stubApi(page, FEATURE, () => ({ status: 200, body: { ...reminder, settings: { offset_minutes: 720 } } }));
    await page.goto("/dashboard/features");
    const timing = page.getByLabel("When to send: 24-hour reminder");
    await expect(timing).toHaveValue("1440");
    await timing.selectOption("720");
    await expect(toast(page, "12 hours before")).toBeVisible();
    expect(patches[0].body).toEqual({ settings: { offset_minutes: 720 } });
    await expect(timing).toHaveValue("720");
  });

  test.describe("staff", () => {
    test.use({ storageState: SIGNED_OUT });

    test("see the list and cannot change it", async ({ page, request }) => {
      const account = await newDay3Account(request, { role: "staff" });
      await stubApi(page, FEATURES, () => ({ status: 200, body: list() }));
      const patches = await stubApi(page, FEATURE, () => ({ status: 200, body: reminder }));
      await signIn(page, account.email, "/dashboard/features");
      await expect(page.getByRole("heading", { level: 1, name: "Features" })).toBeVisible();
      await expect(page.getByText("Only an owner or admin can change them.")).toBeVisible();
      await expect(sw(page, "24-hour reminder")).toBeDisabled();
      await expect(page.getByLabel("When to send: 24-hour reminder")).toBeDisabled();
      expect(patches).toHaveLength(0);
    });
  });

  test("says so, without an error, when the server has no feature routes yet", async ({ page }) => {
    await stubApi(page, FEATURES, () => refusal(404, "not_found", "Not found."));
    await page.goto("/dashboard/features");
    await expect(page.getByText("Feature settings aren't available yet")).toBeVisible();
    await expect(page.getByRole("switch")).toHaveCount(0);
  });

  test("a failed load shows the error and retries", async ({ page }) => {
    await stubApi(page, FEATURES, (n) => (n === 1 ? refusal(500, "internal", "Something went wrong. Try again in a moment.") : { status: 200, body: list() }));
    await page.goto("/dashboard/features");
    await expect(page.locator('[role="alert"].app-state')).toContainText("Couldn't load your features");
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(sw(page, "24-hour reminder")).toBeVisible();
  });

  test("an answer that isn't the contract's shape is refused, not drawn", async ({ page }) => {
    await stubApi(page, FEATURES, () => ({ status: 200, body: { plan: { key: "starter" }, groups: "none" } }));
    await page.goto("/dashboard/features");
    await expect(page.locator('[role="alert"].app-state')).toContainText("Couldn't load your features");
    await expect(page.getByRole("switch")).toHaveCount(0);
  });
});
