import { expect, expectNoHorizontalOverflow, SIGNED_OUT, test } from "../support/app";
import { refusal, stubApi } from "../support/day5";

// /connect/:token, the assisted connection page. Public, so these tests do not sign in. GET /api/connect-links/:token and the Embedded Signup
// exchange are in docs/whatsapp-connection-contract.md but NOT registered on the API (backend/src/server/routes.ts), so every answer is stood
// in for with page.route. This proves how the page reads each answer; it does not prove the routes, the Meta popup or a live connection. The
// popup itself cannot run here (no Meta app configured in the test build, and its window messages must come from facebook.com), so the success
// path is covered by unit tests of the pure parts only and is NOT claimed verified end to end.

test.use({ storageState: SIGNED_OUT });

const TOKEN = "Zx9_k-Q2mP4rT7vB1nL6cD8fH3jW5yA0sE2uI4oG6hM";
const LINK = /\/api\/connect-links\/[A-Za-z0-9_-]+$/;
const ready = { tenantName: "Sunrise Homes", expiresAt: "2099-01-01T10:00:00.000Z" };

test("a link that has the shape of a token shows who it is for, and the button waits for an answer about the WhatsApp Business app", async ({ page }) => {
  const calls = await stubApi(page, LINK, () => ({ status: 200, body: ready }));
  await page.goto(`/connect/${TOKEN}`);
  await expect(page.getByRole("heading", { level: 1, name: "Connect Sunrise Homes to WhatsApp" })).toBeVisible();
  expect(calls).toHaveLength(1);
  expect(calls[0].method).toBe("GET");
  expect(calls[0].url.pathname).toBe(`/api/connect-links/${TOKEN}`);
  // Public: no business header, and no bearer token even though this browser has none to send.
  expect(calls[0].tenant).toBeNull();
  expect(calls[0].authorization).toBeNull();

  const go = page.getByRole("button", { name: "Continue with Facebook" });
  await expect(go).toBeDisabled();
  await page.getByRole("radio", { name: /Yes, keep the app working/ }).check();
  await expect(go).toBeEnabled();
  await expect(page.getByTestId("setup-call")).toContainText("Reply to the person who sent you this link");
  await expectNoHorizontalOverflow(page);
});

test("the Facebook step is not run when Meta isn't configured here: it says so, claims nothing is connected, and offers the setup call", async ({ page }) => {
  await stubApi(page, LINK, () => ({ status: 200, body: ready }));
  await page.goto(`/connect/${TOKEN}`);
  await page.getByRole("radio", { name: /No, it’s a new number/ }).check();
  await page.getByRole("button", { name: "Continue with Facebook" }).click();
  const failed = page.getByTestId("connect-failed");
  await expect(failed).toContainText("isn't switched on yet");
  await expect(failed).toContainText("Nothing was changed");
  await expect(page.getByTestId("connect-done")).toHaveCount(0);
  await expect(page.getByTestId("setup-call")).toBeVisible();
});

test("an unknown, expired or used link (404) is invalid, with no way to continue", async ({ page }) => {
  await stubApi(page, LINK, () => refusal(404, "not_found", "That link was not found."));
  await page.goto(`/connect/${TOKEN}`);
  await expect(page.getByTestId("connect-invalid")).toContainText("This link isn't valid or has expired.");
  await expect(page.getByRole("button", { name: "Continue with Facebook" })).toHaveCount(0);
});

test("something that isn't shaped like a token is invalid without asking the server", async ({ page }) => {
  const calls = await stubApi(page, LINK, () => ({ status: 200, body: ready }));
  await page.goto("/connect/not-a-token");
  await expect(page.getByTestId("connect-invalid")).toBeVisible();
  expect(calls).toHaveLength(0);
});

test("Embedded Signup switched off on the server (501) is said plainly and points to the setup call", async ({ page }) => {
  await stubApi(page, LINK, () => refusal(501, "not_available", "Not available."));
  await page.goto(`/connect/${TOKEN}`);
  await expect(page.getByTestId("connect-problem")).toContainText("Connecting with Facebook isn't switched on yet.");
  await expect(page.getByTestId("setup-call")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Facebook" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
});

test("a failed read offers Try again and then shows the link", async ({ page }) => {
  await stubApi(page, LINK, (n) => (n === 1 ? refusal(500, "internal", "Something went wrong. Try again in a moment.") : { status: 200, body: ready }));
  await page.goto(`/connect/${TOKEN}`);
  await expect(page.getByTestId("connect-problem")).toContainText("We couldn’t check this link");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { level: 1, name: /Sunrise Homes/ })).toBeVisible();
});

test("rate limiting is its own message", async ({ page }) => {
  await stubApi(page, LINK, () => refusal(429, "rate_limited", "Too many requests."));
  await page.goto(`/connect/${TOKEN}`);
  await expect(page.getByTestId("connect-problem")).toContainText("Too many tries");
});

test("an answer that isn't { tenantName, expiresAt } is refused, not drawn", async ({ page }) => {
  await stubApi(page, LINK, () => ({ status: 200, body: { tenantName: "", expiresAt: "soon" } }));
  await page.goto(`/connect/${TOKEN}`);
  await expect(page.getByTestId("connect-problem")).toContainText("We couldn’t check this link");
  // The problem panel's title is the page's one h1; what must not appear is the link's own heading, which names the business.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("We couldn’t check this link");
});

test("the token stays out of the page's text, title and later requests", async ({ page }) => {
  await stubApi(page, LINK, () => ({ status: 200, body: ready }));
  const requested: string[] = [];
  page.on("request", (r) => requested.push(r.url()));
  await page.goto(`/connect/${TOKEN}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await page.locator("body").innerText()).not.toContain(TOKEN);
  expect(await page.title()).not.toContain(TOKEN);
  // Only the link read itself carries it.
  expect(requested.filter((u) => u.includes(TOKEN) && !/\/api\/connect-links\//.test(u) && !u.endsWith(`/connect/${TOKEN}`))).toEqual([]);
});
