import type { Page } from "@playwright/test";
import { expect, expectNoHorizontalOverflow, test } from "../support/app";
import { refusal, stubApi } from "../support/day5";

// /dashboard/admin/plans: the plans and features are read as the signed-in member under row-level security (0001: global catalogues any member reads)
// and saved through PATCH /api/admin/plans/:key and /api/admin/features/:key, which need a platform admin. The reads are stood in for the way the
// Billing spec does it and the PATCHes with page.route. These tests prove what the screen reads, what it sends (only the changed fields), how it
// words each answer, and that nothing is shown as saved before the server answered. They do not prove the platform-admin check, the SQL functions
// or the real row-level security.

const PLAN_PATCH = /\/api\/admin\/plans\/[^/]+$/;
const FEATURE_PATCH = /\/api\/admin\/features\/[^/]+$/;

const PLAN_ROWS = [
  { key: "trial", name: "Trial", price_inr: 0, monthly_credits: 300, seats: 1, whatsapp_numbers: 1, feature_keys: ["ai_auto_reply"] },
  { key: "growth", name: "Growth", price_inr: 2499, monthly_credits: 1500, seats: 5, whatsapp_numbers: 2, feature_keys: ["ai_auto_reply", "booking"] },
];
const FEATURE_ROWS = [
  { key: "ai_auto_reply", name: "AI auto-reply", description: "Answers customers on its own.", default_on: true },
  { key: "booking", name: "Booking in chat", description: "Offers slots and books them.", default_on: false },
  { key: "reminder_24h", name: "24-hour reminder", description: "Reminds customers a day before.", default_on: true },
];
const serverPlan = (over: Record<string, unknown> = {}) => ({ key: "growth", name: "Growth", priceInr: 2499, monthlyCredits: 1500, seats: 5, whatsappNumbers: 2, featureKeys: ["ai_auto_reply", "booking"], ...over });

/** Answers a PostgREST read of `table` as the signed-in member; `failFirst` makes the first read fail. Returns the queries made. */
async function stubTable(page: Page, table: string, rows: unknown[], failFirst = false) {
  const queries: URLSearchParams[] = [];
  await page.route((url) => url.pathname === `/rest/v1/${table}`, (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fallback();
    queries.push(new URL(req.url()).searchParams);
    const fail = failFirst && queries.length === 1;
    return route.fulfill({
      status: fail ? 500 : 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": req.headers()["origin"] ?? "*" },
      body: JSON.stringify(fail ? { message: "boom", details: "internal detail" } : rows),
    });
  });
  return queries;
}

const planCard = (page: Page, key: string) => page.getByTestId("plan-editor").and(page.locator(`[data-plan="${key}"]`));
const featureCard = (page: Page, key: string) => page.getByTestId("feature-editor").and(page.locator(`[data-feature="${key}"]`));

test.describe("Admin: plans and features", () => {
  test("reads both catalogues as the member and shows them, sending nothing", async ({ page }) => {
    const writes: string[] = [];
    page.on("request", (r) => {
      if (["POST", "PUT", "PATCH", "DELETE"].includes(r.method()) && /\/api\/admin\//.test(r.url())) writes.push(`${r.method()} ${r.url()}`);
    });
    const plans = await stubTable(page, "plans", PLAN_ROWS);
    const features = await stubTable(page, "features", FEATURE_ROWS);
    await page.goto("/dashboard/admin/plans");
    await expect(page.getByRole("heading", { level: 1, name: "Plans and features" })).toBeVisible();
    await expect(page.getByTestId("plan-editor")).toHaveCount(2);
    const growth = planCard(page, "growth");
    await expect(growth.getByLabel("Name")).toHaveValue("Growth");
    await expect(growth.getByLabel("Price per month (₹, before GST)")).toHaveValue("2499");
    await expect(growth.getByLabel("Credits per month")).toHaveValue("1500");
    await expect(growth.getByLabel("Team seats")).toHaveValue("5");
    await expect(growth.getByLabel("WhatsApp numbers")).toHaveValue("2");
    await expect(growth.getByRole("checkbox", { name: /AI auto-reply/ })).toBeChecked();
    await expect(growth.getByRole("checkbox", { name: /Booking in chat/ })).toBeChecked();
    await expect(growth.getByRole("checkbox", { name: /24-hour reminder/ })).not.toBeChecked();
    await expect(page.getByTestId("feature-editor")).toHaveCount(3);
    await expect(featureCard(page, "booking").getByLabel("On by default")).not.toBeChecked();
    // Save is off until something changes, and nothing was sent by opening the page.
    await expect(growth.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(plans.length).toBeGreaterThan(0);
    expect(plans[0].get("select")).toContain("feature_keys");
    expect(features.length).toBeGreaterThan(0);
    expect(writes).toEqual([]);
    await expectNoHorizontalOverflow(page);
  });

  test("a plan change sends only the fields that changed, shows Saved after the answer, and then shows the server's row", async ({ page }) => {
    await stubTable(page, "plans", PLAN_ROWS);
    await stubTable(page, "features", FEATURE_ROWS);
    // The server's answer differs from what was typed (a trimmed name), to show the form follows the server, not the draft.
    const calls = await stubApi(page, PLAN_PATCH, () => ({ status: 200, body: serverPlan({ name: "Growth Plus", seats: 8 }) }));
    await page.goto("/dashboard/admin/plans");
    const growth = planCard(page, "growth");
    await growth.getByLabel("Name").fill("  Growth Plus  ");
    await growth.getByLabel("Team seats").fill("8");
    await growth.getByRole("button", { name: "Save changes" }).click();
    await expect(growth.getByTestId("plan-outcome")).toContainText("Saved. Growth Plus is now ₹2,499 with 1,500 credits a month.");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url.pathname).toBe("/api/admin/plans/growth");
    expect(calls[0].body).toEqual({ name: "Growth Plus", seats: 8 });
    expect(calls[0].tenant).toBeNull();
    expect(calls[0].authorization).toMatch(/^Bearer /);
    await expect(growth.getByLabel("Name")).toHaveValue("Growth Plus");
    await expect(growth.getByLabel("Team seats")).toHaveValue("8");
    await expect(growth.getByRole("button", { name: "Save changes" })).toBeDisabled();
    // The other plan was not touched.
    await expect(planCard(page, "trial").getByLabel("Name")).toHaveValue("Trial");
  });

  test("ticking and unticking features sends the whole set, in one request", async ({ page }) => {
    await stubTable(page, "plans", PLAN_ROWS);
    await stubTable(page, "features", FEATURE_ROWS);
    const calls = await stubApi(page, PLAN_PATCH, () => ({ status: 200, body: serverPlan({ featureKeys: ["ai_auto_reply", "reminder_24h"] }) }));
    await page.goto("/dashboard/admin/plans");
    const growth = planCard(page, "growth");
    await growth.getByRole("checkbox", { name: /Booking in chat/ }).uncheck();
    await growth.getByRole("checkbox", { name: /24-hour reminder/ }).check();
    await growth.getByRole("button", { name: "Save changes" }).click();
    await expect(growth.getByTestId("plan-outcome")).toContainText("Saved.");
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ featureKeys: ["ai_auto_reply", "reminder_24h"] });
    await expect(growth.getByRole("checkbox", { name: /24-hour reminder/ })).toBeChecked();
    await expect(growth.getByRole("checkbox", { name: /Booking in chat/ })).not.toBeChecked();
  });

  test("wrong numbers are named beside their fields and nothing is sent", async ({ page }) => {
    await stubTable(page, "plans", PLAN_ROWS);
    await stubTable(page, "features", FEATURE_ROWS);
    const calls = await stubApi(page, PLAN_PATCH, () => ({ status: 200, body: serverPlan() }));
    await page.goto("/dashboard/admin/plans");
    const growth = planCard(page, "growth");
    await growth.getByLabel("Name").fill("   ");
    await growth.getByLabel("Price per month (₹, before GST)").fill("free");
    await growth.getByLabel("Credits per month").fill("0");
    await growth.getByRole("button", { name: "Save changes" }).click();
    await expect(growth.getByRole("alert").filter({ hasText: "Name: 1 to 60 characters." })).toBeVisible();
    await expect(growth.getByRole("alert").filter({ hasText: "Price: enter a whole number." })).toBeVisible();
    await expect(growth.getByRole("alert").filter({ hasText: "Monthly credits: at least 1." })).toBeVisible();
    expect(calls).toEqual([]);
    // What was typed is kept for correcting.
    await expect(growth.getByLabel("Price per month (₹, before GST)")).toHaveValue("free");
  });

  test("a price the server refuses (businesses subscribed) shows its words, keeps the draft and never says Saved", async ({ page }) => {
    await stubTable(page, "plans", PLAN_ROWS);
    await stubTable(page, "features", FEATURE_ROWS);
    await stubApi(page, PLAN_PATCH, () =>
      refusal(409, "conflict", "Businesses are subscribed at this price: their auto-debits were approved for it, so the price can't change while they are."),
    );
    await page.goto("/dashboard/admin/plans");
    const growth = planCard(page, "growth");
    await growth.getByLabel("Price per month (₹, before GST)").fill("2999");
    await growth.getByRole("button", { name: "Save changes" }).click();
    await expect(growth.getByTestId("plan-outcome")).toContainText("Businesses are subscribed at this price");
    await expect(growth.getByTestId("plan-outcome")).toContainText("Nothing was changed.");
    await expect(growth.getByTestId("plan-outcome")).not.toContainText("Saved");
    await expect(growth.getByLabel("Price per month (₹, before GST)")).toHaveValue("2999");
    // The retry is possible.
    await expect(growth.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  test("someone who is not a platform admin is told so, and nothing is shown as saved", async ({ page }) => {
    await stubTable(page, "plans", PLAN_ROWS);
    await stubTable(page, "features", FEATURE_ROWS);
    await stubApi(page, PLAN_PATCH, () => refusal(403, "forbidden", "Platform admins only."));
    await stubApi(page, FEATURE_PATCH, () => refusal(403, "forbidden", "Platform admins only."));
    await page.goto("/dashboard/admin/plans");
    const growth = planCard(page, "growth");
    await growth.getByLabel("Team seats").fill("9");
    await growth.getByRole("button", { name: "Save changes" }).click();
    await expect(growth.getByTestId("plan-outcome")).toContainText("Only the Spark Agent team can change this.");
    await expect(growth.getByTestId("plan-outcome")).toContainText("Nothing was changed.");
    const booking = featureCard(page, "booking");
    await booking.getByLabel("On by default").check();
    await booking.getByRole("button", { name: "Save changes" }).click();
    await expect(booking.getByTestId("feature-outcome")).toContainText("Only the Spark Agent team can change this.");
    await expect(page.locator("body")).not.toContainText(/Saved\./);
  });

  test("a server failure says it cannot confirm the save and keeps the draft; a second try can succeed", async ({ page }) => {
    await stubTable(page, "plans", PLAN_ROWS);
    await stubTable(page, "features", FEATURE_ROWS);
    await stubApi(page, PLAN_PATCH, (n) => (n === 1 ? refusal(500, "internal", "Something went wrong.") : { status: 200, body: serverPlan({ monthlyCredits: 2000 }) }));
    await page.goto("/dashboard/admin/plans");
    const growth = planCard(page, "growth");
    await growth.getByLabel("Credits per month").fill("2000");
    await growth.getByRole("button", { name: "Save changes" }).click();
    await expect(growth.getByTestId("plan-outcome")).toContainText("can't confirm whether it was saved");
    await expect(growth.getByLabel("Credits per month")).toHaveValue("2000");
    await growth.getByRole("button", { name: "Save changes" }).click();
    await expect(growth.getByTestId("plan-outcome")).toContainText("Saved.");
  });

  test("one press is one request: the form is off while a save is in flight", async ({ page }) => {
    await stubTable(page, "plans", PLAN_ROWS);
    await stubTable(page, "features", FEATURE_ROWS);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const calls = await stubApi(page, PLAN_PATCH, async () => {
      await held;
      return { status: 200, body: serverPlan({ seats: 6 }) };
    });
    await page.goto("/dashboard/admin/plans");
    const growth = planCard(page, "growth");
    await growth.getByLabel("Team seats").fill("6");
    await growth.getByRole("button", { name: "Save changes" }).click();
    await expect(growth.getByRole("button", { name: "Saving…" })).toBeDisabled();
    await expect(growth.getByLabel("Team seats")).toBeDisabled();
    expect(calls).toHaveLength(1);
    release();
    await expect(growth.getByTestId("plan-outcome")).toContainText("Saved.");
    expect(calls).toHaveLength(1);
  });

  test("two saves that overlap and finish out of order do not undo each other", async ({ page }) => {
    await stubTable(page, "plans", PLAN_ROWS);
    await stubTable(page, "features", FEATURE_ROWS);
    let releaseTrial: () => void = () => {};
    let releaseGrowth: () => void = () => {};
    const heldTrial = new Promise<void>((resolve) => (releaseTrial = resolve));
    const heldGrowth = new Promise<void>((resolve) => (releaseGrowth = resolve));
    const calls = await stubApi(page, PLAN_PATCH, async (_n, call) => {
      if (call.url.pathname.endsWith("/trial")) {
        await heldTrial;
        return { status: 200, body: serverPlan({ key: "trial", name: "Trial", priceInr: 0, monthlyCredits: 300, seats: 3, whatsappNumbers: 1, featureKeys: ["ai_auto_reply"] }) };
      }
      await heldGrowth;
      return { status: 200, body: serverPlan({ seats: 8 }) };
    });
    await page.goto("/dashboard/admin/plans");
    const trial = planCard(page, "trial");
    const growth = planCard(page, "growth");
    // Both are pressed before either answers; the Growth answer arrives first, the Trial answer last.
    await trial.getByLabel("Team seats").fill("3");
    await trial.getByRole("button", { name: "Save changes" }).click();
    await growth.getByLabel("Team seats").fill("8");
    await growth.getByRole("button", { name: "Save changes" }).click();
    await expect.poll(() => calls.length).toBe(2);
    releaseGrowth();
    await expect(growth.getByTestId("plan-outcome")).toContainText("Saved.");
    releaseTrial();
    await expect(trial.getByTestId("plan-outcome")).toContainText("Saved.");
    // Each card still agrees with what its own save returned: nothing is left to save on either, and Growth was not put back to 5 seats.
    await expect(growth.getByLabel("Team seats")).toHaveValue("8");
    await expect(growth.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await expect(trial.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  test("a feature change sends only what changed", async ({ page }) => {
    await stubTable(page, "plans", PLAN_ROWS);
    await stubTable(page, "features", FEATURE_ROWS);
    const calls = await stubApi(page, FEATURE_PATCH, () => ({ status: 200, body: { key: "booking", name: "Booking in chat", description: "Offers slots and books them.", defaultOn: true } }));
    await page.goto("/dashboard/admin/plans");
    const booking = featureCard(page, "booking");
    await expect(booking.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await booking.getByLabel("On by default").check();
    await booking.getByRole("button", { name: "Save changes" }).click();
    await expect(booking.getByTestId("feature-outcome")).toContainText("Saved. Booking in chat is on by default.");
    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toBe("/api/admin/features/booking");
    expect(calls[0].body).toEqual({ defaultOn: true });
  });

  test("a description over 300 characters is stopped before anything is sent", async ({ page }) => {
    await stubTable(page, "plans", PLAN_ROWS);
    await stubTable(page, "features", FEATURE_ROWS);
    const calls = await stubApi(page, FEATURE_PATCH, () => ({ status: 200, body: {} }));
    await page.goto("/dashboard/admin/plans");
    const booking = featureCard(page, "booking");
    await booking.getByLabel("Description").fill("x".repeat(301));
    await booking.getByRole("button", { name: "Save changes" }).click();
    await expect(booking.getByRole("alert").filter({ hasText: "Description: 1 to 300 characters." })).toBeVisible();
    expect(calls).toEqual([]);
  });

  test("shows a failed read with Try again and none of the server's detail, and the other list still loads", async ({ page, consoleErrors }) => {
    await stubTable(page, "plans", PLAN_ROWS, true);
    await stubTable(page, "features", FEATURE_ROWS);
    await page.goto("/dashboard/admin/plans");
    const error = page.getByTestId("plans-error");
    await expect(error).toContainText("Couldn't load the plans.");
    await expect(page.locator("body")).not.toContainText(/internal detail|boom/);
    // The browser logs the refused read itself; that one line is expected and nothing else is.
    await expect.poll(() => consoleErrors.length).toBe(1);
    expect(consoleErrors[0]).toMatch(/Failed to load resource: .*500/);
    consoleErrors.length = 0;
    // The features still loaded: one list failing does not blank the other.
    await expect(page.getByTestId("feature-editor")).toHaveCount(3);
    await error.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("plan-editor")).toHaveCount(2);
    await expect(page.getByTestId("plans-error")).toHaveCount(0);
  });

  test("with no plans or features it says so", async ({ page }) => {
    await stubTable(page, "plans", []);
    await stubTable(page, "features", []);
    await page.goto("/dashboard/admin/plans");
    await expect(page.getByTestId("plans-empty")).toContainText("No plans are set up yet.");
    await expect(page.getByTestId("features-empty")).toContainText("No features are set up yet.");
    await expect(page.getByTestId("plan-editor")).toHaveCount(0);
  });

  test("when the feature list cannot be read, a plan's features cannot be changed and the other fields still can", async ({ page, consoleErrors }) => {
    await stubTable(page, "plans", PLAN_ROWS);
    await stubTable(page, "features", FEATURE_ROWS, true);
    const calls = await stubApi(page, PLAN_PATCH, () => ({ status: 200, body: serverPlan({ seats: 7 }) }));
    await page.goto("/dashboard/admin/plans");
    const growth = planCard(page, "growth");
    await expect(growth.getByTestId("plan-features")).toContainText("The feature list couldn't be loaded");
    // The browser logs the refused read itself; that one line is expected and nothing else is.
    await expect.poll(() => consoleErrors.length).toBe(1);
    expect(consoleErrors[0]).toMatch(/Failed to load resource: .*500/);
    consoleErrors.length = 0;
    await expect(growth.getByRole("checkbox")).toHaveCount(0);
    await growth.getByLabel("Team seats").fill("7");
    await growth.getByRole("button", { name: "Save changes" }).click();
    await expect(growth.getByTestId("plan-outcome")).toContainText("Saved.");
    // The features were not part of the change, so none were sent.
    expect(calls[0].body).toEqual({ seats: 7 });
  });
});
