import { expect, expectNoHorizontalOverflow, test } from "../support/app";
import { refusal, stubApi } from "../support/day5";

// /dashboard/admin/whatsapp (Day 5, Dev 3): the admin's manual connection form. POST /api/admin/whatsapp/manual is Dev 1's and needs a
// platform admin and Meta, so it is stood in for with page.route: these tests prove what the form sends, that the secrets are not kept and
// that the page claims only what the answer says. They do not prove the six checks, the platform-admin check or anything about Meta.

const ADMIN = /\/api\/admin\/whatsapp\/manual$/;
const TENANT = "10000000-0000-0000-0000-000000000004";
const TOKEN = "EAAB-secret-token-0123456789";
const SECRET = "app-secret-abcdef0123456789";

const check = (key: string, status: string, message: string) => ({ key, status, message, checked_at: "2026-10-12T10:00:00Z" });
const six = (over: Record<string, [string, string]> = {}) =>
  [
    ["token_permissions", "pass", "The token has both WhatsApp permissions."],
    ["number_registered", "pass", "The number is in the account and on the Cloud API."],
    ["webhook_subscribed", "pass", "A webhook signed with your app's secret arrived."],
    ["display_name_approved", "pass", "The display name is approved."],
    ["payment_method", "pass", "A payment method is on the account."],
    ["test_message_delivered", "pass", "The test message was delivered."],
  ].map(([key, status, message]) => check(key, over[key]?.[0] ?? status, over[key]?.[1] ?? message));
const connection = (status: string, checks: unknown[], overall: string) => ({
  id: "30000000-0000-0000-0000-0000000000a1",
  tenant_id: TENANT,
  method: "manual_byo",
  waba_id: "102938475610",
  phone_number_id: "109876543210987",
  display_phone: "+91 98400 12345",
  verified_name: "Bright Interiors",
  coexistence: false,
  status,
  last_check: { ran_at: "2026-10-12T10:00:00Z", overall, checks },
  quality_rating: null,
  messaging_limit: null,
  created_at: "2026-10-12T10:00:00Z",
});

async function fill(page: import("@playwright/test").Page) {
  await page.getByLabel("Business ID", { exact: true }).fill(TENANT);
  await page.getByLabel("WhatsApp Business Account ID").fill("102938475610");
  await page.getByLabel("Phone number ID").fill("109876543210987");
  await page.getByLabel("System-user access token").fill(TOKEN);
  await page.getByLabel("App secret").fill(SECRET);
}
const submit = (page: import("@playwright/test").Page) => page.getByRole("button", { name: /^Connect number$/ });

test.describe("Admin: connect a number", () => {
  test("posts the contract's body once, then clears the secrets from the form", async ({ page }) => {
    const calls = await stubApi(page, ADMIN, () => ({ status: 201, body: connection("active", six(), "pass") }));
    await page.goto("/dashboard/admin/whatsapp");
    await expect(page.getByRole("heading", { level: 1, name: "Connect a number" })).toBeVisible();
    await expect(page.getByLabel("System-user access token")).toHaveAttribute("type", "password");
    await expect(page.getByLabel("App secret")).toHaveAttribute("type", "password");
    await fill(page);
    await submit(page).click();

    await expect(page.getByTestId("admin-connect-result")).toHaveAttribute("data-status", "active");
    await expect(page.getByTestId("admin-connect-result")).toContainText("Connected.");
    await expect(page.getByTestId("admin-connect-result")).toContainText("All 6 checks passed.");
    await expect(page.getByTestId("connection-check")).toHaveCount(6);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].tenant).toBeNull();
    expect(calls[0].authorization).toMatch(/^Bearer /);
    expect(calls[0].body).toEqual({ tenantId: TENANT, wabaId: "102938475610", phoneNumberId: "109876543210987", token: TOKEN, tokenType: "system_user", appSecret: SECRET });

    // Nothing left to read: not in the inputs, not in the page, not in browser storage.
    await expect(page.getByLabel("System-user access token")).toHaveValue("");
    await expect(page.getByLabel("App secret")).toHaveValue("");
    await expect(page.locator("body")).not.toContainText(TOKEN);
    await expect(page.locator("body")).not.toContainText(SECRET);
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(stored).not.toContain(TOKEN);
    expect(stored).not.toContain(SECRET);
    await expectNoHorizontalOverflow(page);
  });

  test("a wrong token is shown as not connected, with the reason from the checks", async ({ page }) => {
    await stubApi(page, ADMIN, () => ({
      status: 201,
      body: connection(
        "failed",
        six({ token_permissions: ["fail", "Meta did not accept this token. Check it and connect again."], number_registered: ["skipped", "Not checked: the token failed."] }),
        "fail",
      ),
    }));
    await page.goto("/dashboard/admin/whatsapp");
    await fill(page);
    await submit(page).click();
    const result = page.getByTestId("admin-connect-result");
    await expect(result).toHaveAttribute("data-status", "failed");
    await expect(result).toContainText("a check failed, so it is not active");
    await expect(result).not.toContainText("Connected.");
    await expect(result).toContainText("Meta did not accept this token.");
    await expect(result).toContainText("At least one check failed");
  });

  test("active but webhook not confirmed is not called plainly connected", async ({ page }) => {
    await stubApi(page, ADMIN, () => ({ status: 201, body: connection("active", six({ webhook_subscribed: ["not_verified", "Waiting for a webhook from your app."] }), "warn") }));
    await page.goto("/dashboard/admin/whatsapp");
    await fill(page);
    await submit(page).click();
    await expect(page.getByTestId("admin-connect-result")).toContainText("Connected. The webhook isn't confirmed yet.");
  });

  test("a refusal says nothing was connected, keeps the business details and drops the secrets", async ({ page }) => {
    await stubApi(page, ADMIN, () => refusal(403, "forbidden", "Only the Spark Agent team can do this."));
    await page.goto("/dashboard/admin/whatsapp");
    await fill(page);
    await submit(page).click();
    await expect(page.getByTestId("admin-connect-rejected")).toContainText("Nothing was connected. Only the Spark Agent team can do this.");
    await expect(page.getByLabel("Business ID", { exact: true })).toHaveValue(TENANT);
    await expect(page.getByLabel("System-user access token")).toHaveValue("");
    await expect(page.getByLabel("App secret")).toHaveValue("");
  });

  test("shows the server's per-field messages", async ({ page }) => {
    await stubApi(page, ADMIN, () => ({
      status: 422,
      body: { error: { code: "validation_failed", message: "Check the fields and try again.", fields: { wabaId: "That account ID isn't valid." } } },
    }));
    await page.goto("/dashboard/admin/whatsapp");
    await fill(page);
    await submit(page).click();
    await expect(page.getByText("That account ID isn't valid.")).toBeVisible();
  });

  test("an existing number is a conflict the admin can read", async ({ page }) => {
    await stubApi(page, ADMIN, () => refusal(409, "conflict", "That phone number is already connected."));
    await page.goto("/dashboard/admin/whatsapp");
    await fill(page);
    await submit(page).click();
    await expect(page.getByTestId("admin-connect-rejected")).toContainText("already connected");
  });

  test("checks the form before sending anything", async ({ page }) => {
    const calls = await stubApi(page, ADMIN, () => ({ status: 201, body: connection("active", six(), "pass") }));
    await page.goto("/dashboard/admin/whatsapp");
    await submit(page).click();
    await expect(page.getByText("Enter the business's ID.")).toBeVisible();
    await expect(page.getByText("Enter the system-user access token.")).toBeVisible();
    await page.getByLabel("Business ID", { exact: true }).fill("not-an-id");
    await submit(page).click();
    await expect(page.getByText(/isn't a business ID/)).toBeVisible();
    expect(calls).toHaveLength(0);
  });

  test("while it runs the button is off, so one click sends one request", async ({ page }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const calls = await stubApi(page, ADMIN, async () => {
      await gate;
      return { status: 201, body: connection("active", six(), "pass") };
    });
    await page.goto("/dashboard/admin/whatsapp");
    await fill(page);
    await submit(page).click();
    await expect(page.getByRole("button", { name: "Connecting and checking…" })).toBeDisabled();
    await expect(page.getByRole("status").filter({ hasText: "Running the six connection checks" })).toBeVisible();
    release();
    await expect(page.getByTestId("admin-connect-result")).toBeVisible();
    expect(calls).toHaveLength(1);
  });
});
