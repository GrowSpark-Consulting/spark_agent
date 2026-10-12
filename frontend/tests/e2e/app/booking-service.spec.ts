import { appAlert, expect, SIGNED_OUT, test } from "../support/app";
import { newDay3Account, open, storedDay3, type Day3Role } from "../support/day3";
import type { APIRequestContext, Page } from "@playwright/test";

// "Service the assistant books" on Booking setup (tenants.agent_settings.bookingServiceId; mocked E2E: mock-supabase.mjs under
// RLS). The seeded business has two active services (Consultation, Follow-up), so the assistant needs a choice. What this shows is
// that the page saves that one key, keeps every other setting, and says so when a save is refused. It does NOT show that the real
// assistant then books that service: that is the agent's reading of the setting (backend/src/agent/pipeline/reply.ts).

const section = (page: Page) => page.getByRole("region", { name: "Service the assistant books" });
const choice = (page: Page) => section(page).getByLabel("Service to book");
const save = (page: Page) => section(page).getByRole("button", { name: "Save" });

async function openSetup(page: Page, request: APIRequestContext, options: { role?: Day3Role; agentSettings?: Record<string, unknown> } = {}) {
  const account = await newDay3Account(request, { seed: true, ...options });
  await open(page, account, "/dashboard/settings/booking", "Booking setup");
  await expect(section(page)).toBeVisible();
  return account;
}

test.describe("Booking setup · service the assistant books", () => {
  test.use({ storageState: SIGNED_OUT });

  test("with two active services, asks for a choice and saves it without touching the other settings", async ({ page, request }) => {
    const settings = { persona: "Asha", tone: "formal", privacyNotice: true, handoffTriggers: [{ key: "hot_lead", enabled: false }] };
    const account = await openSetup(page, request, { agentSettings: settings });
    await expect(section(page).getByText("passes booking chats to your team instead of guessing")).toBeVisible();
    await expect(choice(page)).toHaveValue("");
    await expect(save(page)).toBeDisabled(); // nothing changed yet

    await choice(page).selectOption({ label: "Consultation · 60 min" });
    await save(page).click();
    await expect(page.getByText("Saved the service the assistant books")).toBeVisible();
    await expect(save(page)).toBeDisabled();

    const stored = (await storedDay3(request, account.tenantId)).tenant;
    expect(stored?.agent_settings).toEqual({ ...settings, bookingServiceId: account.ids.consult });
    await expect(appAlert(page)).toHaveCount(0);
  });

  test("shows the saved choice after a reload, and clearing it removes only that key", async ({ page, request }) => {
    const settings = { tone: "formal" };
    const account = await openSetup(page, request, { agentSettings: settings });
    await choice(page).selectOption({ label: "Consultation · 60 min" });
    await save(page).click();
    await expect(page.getByText("Saved the service the assistant books")).toBeVisible();

    await page.reload();
    await expect(choice(page)).toHaveValue(account.ids.consult);

    await choice(page).selectOption({ label: "No choice: a person takes booking chats" });
    await save(page).click();
    await expect(save(page)).toBeDisabled();
    expect((await storedDay3(request, account.tenantId)).tenant?.agent_settings).toEqual(settings);
  });

  test("a save the database refuses says so, keeps the choice on screen and changes nothing", async ({ page, request, consoleErrors }) => {
    const account = await openSetup(page, request, { agentSettings: { tone: "formal" } });
    await page.route(/\/rest\/v1\/tenants(\?|$)/, (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ code: "42501", details: null, hint: null, message: "permission denied for table tenants" }) })
        : route.fallback(),
    );
    await choice(page).selectOption({ label: "Follow-up · 30 min" });
    await save(page).click();
    await expect(section(page).getByRole("alert")).toContainText("Couldn't save the choice");
    // The database refused with 403, which the browser logs; that one line is expected.
    const refused = consoleErrors.findIndex((e) => /Failed to load resource: .*403/.test(e));
    expect(refused, "the browser's log of the refused save").toBeGreaterThanOrEqual(0);
    consoleErrors.splice(refused, 1);
    await expect(choice(page)).toHaveValue(/.+/); // still the choice they made
    await expect(save(page)).toBeEnabled(); // they can try again
    expect((await storedDay3(request, account.tenantId)).tenant?.agent_settings).toEqual({ tone: "formal" });
  });

  test("says when the service that was chosen is no longer active", async ({ page, request }) => {
    await openSetup(page, request, { agentSettings: { bookingServiceId: "99999999-9999-4999-8999-999999999999" } });
    await expect(section(page).getByRole("status")).toContainText("no longer active");
    await expect(choice(page)).toHaveValue("");
  });

  test("staff read it but can't change it", async ({ page, request }) => {
    await openSetup(page, request, { role: "staff" });
    await expect(section(page).getByText("No choice: a person takes booking chats.")).toBeVisible();
    await expect(choice(page)).toHaveCount(0);
    await expect(save(page)).toHaveCount(0);
  });
});
