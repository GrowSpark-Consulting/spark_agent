import { API_URL } from "../../../playwright.config";
import type { APIRequestContext, Page } from "@playwright/test";
import { appAlert, asUser, SIGNED_OUT, expect, expectNoHorizontalOverflow, MOCK_SUPABASE_URL, signIn, test } from "../support/app";

const card = (page: Page) => page.getByRole("list", { name: "WhatsApp numbers" }).getByRole("listitem");
const recheck = (page: Page) => page.getByRole("button", { name: /^(Recheck connection|Rechecking…)$/ });
const disconnect = (page: Page) => page.getByRole("button", { name: "Disconnect", exact: true });
const checks = (page: Page) => page.getByTestId("connection-check");

/** Only public, non-secret fields reach the page, whatever the status. */
async function expectNoSecrets(page: Page) {
  await expect(page.locator("body")).not.toContainText(/secret|EAA[A-Za-z0-9]/i);
}

// Each account in mock-supabase.mjs returns a different answer from whatsapp_connections_public.
test.describe("WhatsApp connection panel", () => {
  test.use({ storageState: SIGNED_OUT });

  test("while the public view doesn't exist yet", async ({ page }) => {
    await signIn(page, "owner@test.local", "/dashboard/whatsapp");
    await expect(page.getByText("WhatsApp connection details aren't available yet")).toBeVisible();
    await expect(appAlert(page)).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });

  test("connected", async ({ page }) => {
    await signIn(page, "connected@test.local", "/dashboard/whatsapp");
    await expect(card(page)).toContainText("Connected");
    await expect(card(page)).toContainText("+91 98400 12345");
    await expect(card(page)).toContainText("Shows as “Bright Interiors”");
    await expect(card(page)).toContainText("Your assistant replies to customers from this number.");
    await expect(card(page)).toContainText("GREEN");
    await expect(card(page)).toContainText("TIER_1K");
    await expect(card(page)).toContainText("1 Oct 2026");
    await expect(card(page)).toContainText("102938475610");
    await expect(card(page)).toContainText("109876543210987");
    await expectNoSecrets(page);
    await expect(page.locator("body")).not.toContainText(/token/i);
    await expectNoHorizontalOverflow(page);
  });

  test("an admin may recheck but not disconnect; staff see the status only", async ({ page }) => {
    await signIn(page, "wa-admin@test.local", "/dashboard/whatsapp");
    await expect(card(page)).toContainText("Connected");
    await expect(recheck(page)).toBeEnabled();
    await expect(disconnect(page)).toHaveCount(0);

    await page.context().clearCookies();
    await signIn(page, "wa-staff@test.local", "/dashboard/whatsapp");
    await expect(card(page)).toContainText("Connected");
    await expect(recheck(page)).toHaveCount(0);
    await expect(disconnect(page)).toHaveCount(0);
    // Staff are not told to press a button they don't have.
    await expect(card(page)).toContainText("No connection checks have run for this number yet.");
    await expect(card(page)).not.toContainText("Use Recheck connection");
    await expectNoSecrets(page);
  });

  test("a Spark Agent number offers no recheck or disconnect; the client's own number keeps both", async ({ page }) => {
    await signIn(page, "wa-platform@test.local", "/dashboard/whatsapp");
    await expect(card(page)).toHaveCount(2);
    const platform = card(page).filter({ hasText: "Spark Agent number" });
    const own = card(page).filter({ hasText: "Connected manually" });

    // Seeded without a check: no number or name yet, so the existing fallback shows.
    await expect(platform).toContainText("Connected");
    await expect(platform).toContainText("Number pending");
    await expect(platform).not.toContainText("Shows as");
    await expect(platform).toContainText("600000000000001");
    await expect(platform.getByRole("button")).toHaveCount(0);
    await expect(platform).not.toContainText("Use Recheck connection");

    // The owner's own number on the same business is unchanged.
    await expect(own).toContainText("+91 98400 12345");
    await expect(own.getByRole("button", { name: "Recheck connection" })).toBeEnabled();
    await expect(own.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
    await expect(recheck(page)).toHaveCount(1);
    await expect(disconnect(page)).toHaveCount(1);
    await expectNoSecrets(page);
    await expectNoHorizontalOverflow(page);
  });

  test("checking", async ({ page }) => {
    await signIn(page, "validating@test.local", "/dashboard/whatsapp");
    await expect(card(page)).toContainText("Checking");
    await expect(card(page)).toContainText("We're running the connection checks with Meta.");
    // A check is already running: nothing to recheck, but the owner can still disconnect.
    await expect(recheck(page)).toHaveCount(0);
    await expect(disconnect(page)).toBeVisible();
    await expectNoSecrets(page);
    await expectNoHorizontalOverflow(page);
  });

  test("disconnected", async ({ page }) => {
    await signIn(page, "disconnected@test.local", "/dashboard/whatsapp");
    await expect(page.getByRole("listitem")).toContainText("Disconnected");
    await expect(card(page)).toContainText("no longer sends or receives messages");
    await expect(recheck(page)).toHaveCount(0);
    await expect(disconnect(page)).toHaveCount(0);
    // Connecting again needs the connect flow, which isn't switched on: it says so.
    const connect = page.getByRole("button", { name: "Connect WhatsApp" });
    await expect(connect).toBeDisabled();
    await expect(connect).toHaveAccessibleDescription("Connecting from the dashboard isn't switched on yet.");
    await expectNoSecrets(page);
    await expectNoHorizontalOverflow(page);
    // Sending is refused on the server, not just hidden.
    const res = await page.request.post(`${API_URL}/api/messages/test`, { data: { to: "+919840012345", body: "hi" }, headers: await asUser(page) });
    expect(res.status()).toBe(409);
    expect((await res.json()).error.code).toBe("whatsapp_not_connected");
  });

  test("connecting", async ({ page }) => {
    await signIn(page, "pending@test.local", "/dashboard/whatsapp");
    await expect(page.getByRole("listitem")).toContainText("Connecting");
    await expect(card(page)).toContainText("Setup with Meta isn't finished yet.");
    await expectNoSecrets(page);
    const res = await page.request.post(`${API_URL}/api/messages/test`, { data: { to: "+919840012345", body: "hi" }, headers: await asUser(page) });
    expect((await res.json()).error.code).toBe("whatsapp_not_connected");
  });

  test("needs attention", async ({ page }) => {
    await signIn(page, "failed@test.local", "/dashboard/whatsapp");
    await expect(page.getByRole("listitem")).toContainText("Needs attention");
    await expect(card(page)).toContainText("A connection check failed, so messages aren't being sent.");
    await expect(recheck(page)).toBeEnabled();
    await expect(disconnect(page)).toBeVisible();
    await expectNoSecrets(page);
    await expectNoHorizontalOverflow(page);
  });

  test("no number connected", async ({ page }) => {
    await signIn(page, "staff@test.local", "/dashboard/whatsapp");
    await expect(page.getByText("No WhatsApp number connected")).toBeVisible();
    // A placeholder until the connect flow exists: switched off, and it says why.
    const connect = page.getByRole("button", { name: "Connect WhatsApp" });
    await expect(connect).toBeDisabled();
    await expect(connect).toHaveAccessibleDescription("Connecting from the dashboard isn't switched on yet.");
    await expectNoHorizontalOverflow(page);
  });

  test("load error", async ({ page }) => {
    await signIn(page, "viewerror@test.local", "/dashboard/whatsapp");
    const alert = appAlert(page);
    await expect(alert).toContainText("Couldn't load your WhatsApp connection");
    await expect(alert).not.toContainText(/boom|internal detail/);
    await expect(alert.getByRole("link", { name: "Try again" })).toHaveAttribute("href", "/dashboard/whatsapp");
  });

  test("loading", async ({ page }) => {
    await signIn(page, "slow@test.local");
    await expect(page.getByRole("heading", { level: 1, name: "Test Realty" })).toBeVisible();
    // The panel streams in after the page shell; don't wait for the full document.
    await page.goto("/dashboard/whatsapp", { waitUntil: "commit" });
    await expect(page.getByRole("status").filter({ hasText: "Checking your WhatsApp connection" })).toBeVisible();
    await expect(page.getByText("No WhatsApp number connected")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("status").filter({ hasText: "Checking your WhatsApp connection" })).toHaveCount(0);
  });

  test("home shows the same status", async ({ page }) => {
    await signIn(page, "connected@test.local");
    await expect(page.getByRole("heading", { level: 1, name: "Bright Interiors" })).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: "+91 98400 12345" })).toContainText("Connected");
    // The home card is a summary: no actions and no ids.
    await expect(recheck(page)).toHaveCount(0);
    await expect(disconnect(page)).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("109876543210987");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The six checks, Recheck and Disconnect (backend/src/channels/whatsapp/connect/{checks,recheck}.ts; docs/whatsapp-connection-contract.md).
// The API's recheck and disconnect need Meta and the service-role database, so the two POST routes are stood in for with page.route; the
// stand-in stores what the real ones would have (through the mock database) and answers in the contract's envelope. The page then reads
// the number back from whatsapp_connections_public, exactly as it does for a real answer.

const RAN = "2026-10-12T04:30:00.000Z";
const SAFE = {
  tokenPass: "Meta accepted the access token for this number.",
  numberPass: "The number belongs to this WhatsApp Business Account and is set up for the Cloud API.",
  webhookWaiting:
    "Your app is subscribed. This is confirmed when a webhook from your app arrives: send a message to this number from a phone, or use Test in Meta's webhook settings, then check again.",
  webhookPass: "Your app is subscribed, and a signed webhook from it has arrived.",
  namePass: "The display name is approved.",
  paymentPass: "A payment method is on this WhatsApp Business Account.",
  paymentWarn: "No payment method is on this WhatsApp Business Account. The number is connected, but template messages will not send until one is added in Meta's billing settings.",
  testWaiting: "Not checked yet.",
  testPass: "The test message reached the owner's number.",
  tokenFail: "Meta did not accept the access token or the Phone number ID. Check both, and that the token can manage this WhatsApp account.",
  later: "Not checked yet.",
};
type Status = "pass" | "warn" | "fail" | "not_verified" | "skipped";
const check = (key: string, status: Status, message: string) => ({ key, status, message, checked_at: RAN });
const lastCheck = (overall: "pass" | "warn" | "fail", checkList: ReturnType<typeof check>[]) => ({ ran_at: RAN, overall, checks: checkList });

/** All six pass. */
const ALL_PASS = lastCheck("pass", [
  check("token_permissions", "pass", SAFE.tokenPass),
  check("number_registered", "pass", SAFE.numberPass),
  check("webhook_subscribed", "pass", SAFE.webhookPass),
  check("display_name_approved", "pass", SAFE.namePass),
  check("payment_method", "pass", SAFE.paymentPass),
  check("test_message_delivered", "pass", SAFE.testPass),
]);
/** Connected, but no webhook from the business's own app has arrived, there is no payment method, and no test message went out. */
const WEBHOOK_WAITING = lastCheck("warn", [
  check("token_permissions", "pass", SAFE.tokenPass),
  check("number_registered", "pass", SAFE.numberPass),
  check("webhook_subscribed", "not_verified", SAFE.webhookWaiting),
  check("display_name_approved", "pass", SAFE.namePass),
  check("payment_method", "warn", SAFE.paymentWarn),
  check("test_message_delivered", "not_verified", SAFE.testWaiting),
]);
/** A wrong token: the first check fails and the ones that need it are skipped. */
const TOKEN_FAILED = lastCheck("fail", [
  check("token_permissions", "fail", SAFE.tokenFail),
  check("number_registered", "skipped", SAFE.later),
  check("webhook_subscribed", "skipped", SAFE.later),
  check("display_name_approved", "skipped", SAFE.later),
  check("payment_method", "skipped", SAFE.later),
  check("test_message_delivered", "skipped", SAFE.later),
]);

type WaAccount = { email: string; tenantId: string; connectionId: string };
async function newWhatsappAccount(
  request: APIRequestContext,
  options: { role?: "owner" | "admin" | "staff"; status?: string; method?: string; lastCheck?: unknown } = {},
): Promise<WaAccount> {
  const res = await request.post(`${MOCK_SUPABASE_URL}/__mock/whatsapp-account`, { data: options });
  expect(res.ok()).toBe(true);
  return (await res.json()) as WaAccount;
}

type Stored = { status?: string; last_check?: unknown };
type Reply = { status: number; body: unknown; stored?: Stored };
type Answer = Reply | "abort";
type Call = { action: "recheck" | "disconnect"; id: string; tenant: string | null; authorization: string | null; body: string };

/** Stands in for the two POST routes. `stored` is what the real route would have saved by the time it answers. */
async function mockConnectionApi(
  page: Page,
  request: APIRequestContext,
  account: WaAccount,
  answers: { recheck?: (n: number) => Answer | Promise<Answer>; disconnect?: (n: number) => Answer | Promise<Answer> },
) {
  const calls: Call[] = [];
  await page.route(/\/api\/whatsapp\/connections\/[^/]+\/(recheck|disconnect)$/, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fallback();
    const [, id, action] = new URL(req.url()).pathname.match(/connections\/([^/]+)\/(recheck|disconnect)$/)! as unknown as [string, string, "recheck" | "disconnect"];
    calls.push({ action, id, tenant: req.headers()["x-pakka-tenant"] ?? null, authorization: req.headers()["authorization"] ?? null, body: req.postData() ?? "" });
    const handler: (n: number) => Answer | Promise<Answer> = answers[action] ?? (() => refusal(404, "not_found", "We couldn't find that connection."));
    const answer = await handler(calls.filter((c) => c.action === action).length);
    if (answer === "abort") return route.abort("failed");
    if (answer.stored) await request.post(`${MOCK_SUPABASE_URL}/__mock/whatsapp-connection`, { data: { email: account.email, ...answer.stored } });
    return route.fulfill({ status: answer.status, contentType: "application/json", body: JSON.stringify(answer.body) });
  });
  return calls;
}
const connectionBody = (account: WaAccount, patch: Record<string, unknown>) => ({
  id: account.connectionId, tenant_id: account.tenantId, method: "manual_byo", waba_id: "102938475610", phone_number_id: "109876543210987",
  display_phone: "+91 98400 12345", verified_name: "Bright Interiors", coexistence: false, status: "active", last_check: {},
  quality_rating: "GREEN", messaging_limit: "TIER_1K", created_at: "2026-10-01T09:00:00Z", ...patch,
});
const refusal = (status: number, code: string, message: string): Reply => ({ status, body: { error: { code, message } } });

test.describe("WhatsApp connection checks", () => {
  test.use({ storageState: SIGNED_OUT });

  test("shows the six checks in order, each with its status in words and its own message", async ({ page, request }) => {
    const account = await newWhatsappAccount(request, { lastCheck: WEBHOOK_WAITING });
    await signIn(page, account.email, "/dashboard/whatsapp");
    await expect(checks(page)).toHaveCount(6);
    expect(await checks(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-check")))).toEqual([
      "token_permissions", "number_registered", "webhook_subscribed", "display_name_approved", "payment_method", "test_message_delivered",
    ]);
    expect(await checks(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-status")))).toEqual([
      "pass", "pass", "not_verified", "pass", "warn", "not_verified",
    ]);
    const group = page.getByRole("group", { name: "Connection checks" });
    await expect(group).toContainText("last run 12 Oct 2026");
    await expect(group).toContainText("No check failed, but some are still waiting or have a warning.");
    const webhook = checks(page).nth(2);
    await expect(webhook).toContainText("Webhook delivery");
    await expect(webhook).toContainText("Not confirmed yet");
    await expect(webhook).toContainText("This is confirmed when a webhook from your app arrives");
    await expect(checks(page).nth(0)).toContainText("Passed");
    await expect(checks(page).nth(4)).toContainText("Warning");
    await expect(checks(page).nth(4)).toContainText("template messages will not send until one is added");
    await expectNoHorizontalOverflow(page);
  });

  test("never calls a number plainly connected while no webhook has been confirmed", async ({ page, request }) => {
    const account = await newWhatsappAccount(request, { lastCheck: WEBHOOK_WAITING });
    await signIn(page, account.email, "/dashboard/whatsapp");
    await expect(card(page)).toContainText("Connected, webhook not confirmed");
    await expect(card(page)).toContainText("we haven't confirmed that customers' messages reach your assistant yet");
    await expect(card(page)).not.toContainText("Your assistant replies to customers from this number.");
    await expect(card(page)).not.toContainText(/webhook verified|fully connected|all checks passed/i);
    await expect(card(page).locator(".app-status").first()).toHaveClass(/app-status-warn/);

    // The home card is a summary and carries the same caveat.
    await page.goto("/dashboard");
    await expect(page.getByRole("listitem").filter({ hasText: "+91 98400 12345" })).toContainText("Connected, webhook not confirmed");
  });

  test("says plain Connected and all checks passed only when they all did", async ({ page, request }) => {
    const account = await newWhatsappAccount(request, { lastCheck: ALL_PASS });
    await signIn(page, account.email, "/dashboard/whatsapp");
    await expect(card(page).locator(".app-status").first()).toHaveText("Connected");
    await expect(card(page)).toContainText("Your assistant replies to customers from this number.");
    await expect(page.getByRole("group", { name: "Connection checks" })).toContainText("All 6 checks passed.");
    await expect(checks(page).filter({ hasText: "Passed" })).toHaveCount(6);
  });

  test("a failed check shows what failed and what was skipped", async ({ page, request }) => {
    const account = await newWhatsappAccount(request, { status: "failed", lastCheck: TOKEN_FAILED });
    await signIn(page, account.email, "/dashboard/whatsapp");
    await expect(card(page)).toContainText("Needs attention");
    await expect(page.getByRole("group", { name: "Connection checks" })).toContainText("At least one check failed, so messages aren't being sent.");
    await expect(checks(page).nth(0)).toContainText("Failed");
    await expect(checks(page).nth(0)).toContainText("Meta did not accept the access token");
    await expect(checks(page).filter({ hasText: "Skipped" })).toHaveCount(5);
    await expect(card(page)).not.toContainText("webhook not confirmed");
  });

  test("a number never checked says so, and only someone who can recheck is pointed to the button", async ({ page, request }) => {
    const account = await newWhatsappAccount(request, { lastCheck: {} });
    await signIn(page, account.email, "/dashboard/whatsapp");
    await expect(card(page)).toContainText("No connection checks have run for this number yet. Use Recheck connection to run them.");
    await expect(checks(page)).toHaveCount(0);
    // Nothing is claimed about its webhook either.
    await expect(card(page)).not.toContainText("webhook not confirmed");
    await expect(card(page)).toContainText("Your assistant replies to customers from this number.");
  });

  test("an older or malformed result is not drawn and not trusted", async ({ page, request }) => {
    const account = await newWhatsappAccount(request, { lastCheck: { token: { ok: true } } });
    await signIn(page, account.email, "/dashboard/whatsapp");
    await expect(card(page)).toContainText("The last check result isn’t in a form we can show. Use Recheck connection to run them.");
    await expect(checks(page)).toHaveCount(0);
    await expect(card(page)).not.toContainText("All 6 checks passed.");
    await expect(appAlert(page)).toHaveCount(0);
  });

  test("recheck asks the API as this member for this business, shows it working, and reads the new checks back", async ({ page, request }) => {
    const account = await newWhatsappAccount(request, { lastCheck: WEBHOOK_WAITING });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const calls = await mockConnectionApi(page, request, account, {
      recheck: async () => {
        await held;
        return { status: 200, body: connectionBody(account, { last_check: ALL_PASS }), stored: { status: "active", last_check: ALL_PASS } };
      },
    });
    await signIn(page, account.email, "/dashboard/whatsapp");
    await expect(card(page)).toContainText("Connected, webhook not confirmed");

    await recheck(page).dblclick();
    await expect(recheck(page)).toHaveText("Rechecking…");
    await expect(recheck(page)).toBeDisabled();
    await expect(disconnect(page)).toBeDisabled();
    await expect(page.getByRole("status").filter({ hasText: "Asking Meta." })).toBeVisible();
    release();

    // The page is re-read from the stored state: the card now proves what it says.
    await expect(card(page).locator(".app-status").first()).toHaveText("Connected");
    await expect(page.getByRole("group", { name: "Connection checks" })).toContainText("All 6 checks passed.");
    await expect(page.getByRole("status").filter({ hasText: "Rechecked. The checks below are up to date." })).toBeVisible();
    await expect(recheck(page)).toHaveText("Recheck connection");
    await expect(recheck(page)).toBeEnabled();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ action: "recheck", id: account.connectionId, tenant: account.tenantId, body: "" });
    expect(calls[0].authorization).toMatch(/^Bearer /);
  });

  test("a recheck that still finds a problem shows it, not a success", async ({ page, request }) => {
    const account = await newWhatsappAccount(request, { lastCheck: ALL_PASS });
    await mockConnectionApi(page, request, account, {
      recheck: () => ({ status: 200, body: connectionBody(account, { status: "failed", last_check: TOKEN_FAILED }), stored: { status: "failed", last_check: TOKEN_FAILED } }),
    });
    await signIn(page, account.email, "/dashboard/whatsapp");
    await recheck(page).click();
    await expect(card(page)).toContainText("Needs attention");
    await expect(checks(page).nth(0)).toContainText("Failed");
    await expect(page.getByRole("group", { name: "Connection checks" })).toContainText("At least one check failed");
    await expect(page.getByRole("group", { name: "Connection checks" })).not.toContainText("All 6 checks passed.");
  });

  test("a recheck Meta can't answer shows the API's message and leaves the number as it was", async ({ page, request }) => {
    const account = await newWhatsappAccount(request, { lastCheck: WEBHOOK_WAITING });
    const calls = await mockConnectionApi(page, request, account, {
      recheck: (n) => (n === 1 ? refusal(502, "upstream_failed", "We couldn't reach Meta to check this number. Try again in a moment.") : "abort"),
    });
    await signIn(page, account.email, "/dashboard/whatsapp");
    await recheck(page).click();
    await expect(appAlert(page)).toContainText("We couldn't reach Meta to check this number. Try again in a moment.");
    await expect(appAlert(page)).not.toContainText(/upstream_failed|502/);
    await expect(card(page)).toContainText("Connected, webhook not confirmed");
    await expect(page.getByRole("status").filter({ hasText: "Rechecked." })).toHaveCount(0);
    await expect(recheck(page)).toBeEnabled();

    // No answer at all: a safe message, and it can be tried again.
    await recheck(page).click();
    await expect(appAlert(page)).toBeVisible();
    await expect(appAlert(page)).not.toContainText(/Failed to fetch|TypeError|ERR_/);
    await expect(recheck(page)).toBeEnabled();
    expect(calls).toHaveLength(2);
  });

  test("a recheck refused because one is already running catches the screen up with the server", async ({ page, request }) => {
    const account = await newWhatsappAccount(request, { lastCheck: WEBHOOK_WAITING });
    await mockConnectionApi(page, request, account, {
      // Another session is checking this number: the API says so, and the number is `validating` now.
      recheck: () => ({ ...refusal(409, "conflict", "A check is already running for this number. Try again in a moment."), stored: { status: "validating" } }),
    });
    await signIn(page, account.email, "/dashboard/whatsapp");
    await recheck(page).click();
    await expect(card(page)).toContainText("We're running the connection checks with Meta.");
    // The screen re-read the number: there is nothing to recheck while a check runs.
    await expect(recheck(page)).toHaveCount(0);
    await expect(disconnect(page)).toBeVisible();
  });

  test("a recheck on a number that was disconnected elsewhere shows the server's state", async ({ page, request }) => {
    const account = await newWhatsappAccount(request, { lastCheck: ALL_PASS });
    await mockConnectionApi(page, request, account, {
      recheck: () => ({ ...refusal(409, "conflict", "This number is disconnected. Connect it again with the connection form."), stored: { status: "disconnected" } }),
    });
    await signIn(page, account.email, "/dashboard/whatsapp");
    await recheck(page).click();
    await expect(card(page)).toContainText("Disconnected");
    await expect(recheck(page)).toHaveCount(0);
    await expect(disconnect(page)).toHaveCount(0);
  });

  test("disconnect asks first, and Keep it connected sends nothing", async ({ page, request }) => {
    const account = await newWhatsappAccount(request, { lastCheck: ALL_PASS });
    const calls = await mockConnectionApi(page, request, account, {});
    await signIn(page, account.email, "/dashboard/whatsapp");
    await expect(card(page)).toContainText("Connected");

    await disconnect(page).click();
    const dialog = page.getByRole("dialog", { name: "Disconnect this WhatsApp number?" });
    await expect(dialog).toContainText("+91 98400 12345 will stop sending and receiving messages through Spark Agent");
    await expect(dialog.getByRole("button", { name: "Disconnect number" })).toBeEnabled();
    await expect(dialog.getByRole("button", { name: "Keep it connected" })).toBeFocused();
    // The dialog fits the screen at every width.
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await expectNoHorizontalOverflow(page);

    await dialog.getByRole("button", { name: "Keep it connected" }).click();
    await expect(dialog).toHaveCount(0);
    await disconnect(page).click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // Still connected, no claim that anything happened, no request sent.
    await expect(card(page)).toContainText("Connected");
    await expect(page.locator("body")).not.toContainText(/number disconnected|tokens deleted/i);
    expect(calls).toEqual([]);
  });

  test("confirming disconnect asks the API once, then the number reads Disconnected", async ({ page, request }) => {
    const account = await newWhatsappAccount(request, { lastCheck: ALL_PASS });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const calls = await mockConnectionApi(page, request, account, {
      disconnect: async () => {
        await held;
        return { status: 200, body: connectionBody(account, { status: "disconnected" }), stored: { status: "disconnected" } };
      },
    });
    await signIn(page, account.email, "/dashboard/whatsapp");
    await disconnect(page).click();
    const dialog = page.getByRole("dialog", { name: "Disconnect this WhatsApp number?" });
    const confirm = dialog.getByRole("button", { name: /^(Disconnect number|Disconnecting…)$/ });
    await confirm.dblclick();
    await expect(confirm).toHaveText("Disconnecting…");
    await expect(confirm).toBeDisabled();
    release();

    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("listitem").first()).toContainText("Disconnected");
    await expect(card(page)).toContainText("no longer sends or receives messages");
    await expect(recheck(page)).toHaveCount(0);
    await expect(disconnect(page)).toHaveCount(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ action: "disconnect", id: account.connectionId, tenant: account.tenantId, body: "" });
    expect(calls[0].authorization).toMatch(/^Bearer /);
  });

  test("a disconnect that fails keeps the dialog open with the reason, and the number connected", async ({ page, request }) => {
    const account = await newWhatsappAccount(request, { lastCheck: ALL_PASS });
    const calls = await mockConnectionApi(page, request, account, {
      disconnect: (n) => (n === 1 ? refusal(403, "forbidden", "Only an owner or admin can disconnect a WhatsApp number.") : "abort"),
    });
    await signIn(page, account.email, "/dashboard/whatsapp");
    await disconnect(page).click();
    const dialog = page.getByRole("dialog", { name: "Disconnect this WhatsApp number?" });
    await dialog.getByRole("button", { name: "Disconnect number" }).click();
    await expect(dialog.getByRole("alert")).toContainText("Only an owner or admin can disconnect a WhatsApp number.");
    await expect(dialog.getByRole("alert")).not.toContainText("forbidden");
    await expect(dialog.getByRole("button", { name: "Disconnect number" })).toBeEnabled();

    await dialog.getByRole("button", { name: "Disconnect number" }).click();
    await expect(dialog.getByRole("alert")).not.toContainText(/Failed to fetch|TypeError|ERR_/);
    expect(calls).toHaveLength(2);

    await dialog.getByRole("button", { name: "Keep it connected" }).click();
    await expect(card(page)).toContainText("Connected");
    await expect(page.locator("body")).not.toContainText(/number disconnected/i);
  });
});

// Template approval status (Day 5, Dev 3): whatsapp_templates read under RLS (0007), shown per number. Nothing here submits a template.
test.describe("WhatsApp connection panel · template approval", () => {
  test.use({ storageState: SIGNED_OUT });
  const templates = (page: Page) => page.getByTestId("template-status");

  test("shows each template's stored status and Meta's reason for a rejection", async ({ page, request }) => {
    const account = await newWhatsappAccount(request);
    const set = await request.post(`${MOCK_SUPABASE_URL}/__mock/whatsapp-templates`, {
      data: {
        email: account.email,
        templates: [
          { name: "reminder_24h_v1", language: "en", status: "approved" },
          { name: "reminder_24h_v1", language: "ta", status: "pending" },
          { name: "followup_v1", language: "en", category: "marketing", status: "rejected", rejection_reason: "Variables are not allowed at the start." },
        ],
      },
    });
    expect(set.ok()).toBe(true);
    await signIn(page, account.email, "/dashboard/whatsapp");
    await expect(templates(page)).toContainText("1 approved, 1 waiting for Meta, 1 rejected.");
    const rows = templates(page).getByTestId("template-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.filter({ hasText: "followup_v1" })).toHaveAttribute("data-status", "rejected");
    await expect(rows.filter({ hasText: "followup_v1" })).toContainText("Meta said: “Variables are not allowed at the start.”");
    await expect(rows.filter({ hasText: "Tamil" })).toContainText("Waiting for Meta");
    await expect(rows.filter({ hasText: "Tamil" })).toContainText("can't be sent until Meta approves it");
    await expectNoSecrets(page);
    await expectNoHorizontalOverflow(page);
  });

  test("says none have been submitted when there are none, and claims no approval", async ({ page, request }) => {
    const account = await newWhatsappAccount(request);
    await signIn(page, account.email, "/dashboard/whatsapp");
    await expect(templates(page)).toContainText("No templates have been submitted for this number yet.");
    await expect(templates(page)).not.toContainText("approved");
  });
});
