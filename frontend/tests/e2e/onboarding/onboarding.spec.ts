import type { Page } from "@playwright/test";
// `test` fails on any console or page error, except the browser's own line for an API answer that
// isn't 2xx: the owner's Business step gets 409 has_business from POST /api/onboarding/trial.
import { PASSWORD, SIGNED_OUT, expect, signUp, test, uniqueEmail } from "../support/app";

/** The wizard's footer button that moves to the next step (label changes per step). */
const next = (page: Page, label: string | RegExp) => page.getByRole("button", { name: label });
/** Trade, coexistence and manual-mode pickers are radio-like buttons. */
const option = (page: Page, text: string) => page.locator("button").filter({ hasText: text }).first();

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "page is wider than the viewport").toBeLessThanOrEqual(0);
}

/** Runs the prototype's timers (import animation, connection checks) with a frozen clock. */
async function advance(page: Page, ms: number, times: number) {
  for (let i = 0; i < times; i++) {
    await page.clock.runFor(ms);
    await page.waitForTimeout(30);
  }
}

async function openOnboarding(page: Page) {
  await page.clock.install({ time: new Date("2026-10-24T09:00:00+05:30") });
  await page.goto("/onboarding");
  await expect(page.getByRole("heading", { name: "Start your free trial" })).toBeVisible();
}

/** Walks the wizard to the given step heading, picking a trade on the Business step. */
async function walkTo(page: Page, stop: "WhatsApp" | "Team" | "Live", trade = "Real estate", { codeSent = false } = {}) {
  if (!codeSent) await next(page, "Send code on WhatsApp").click();
  await page.getByPlaceholder("––––––").fill("123456");
  await next(page, "Verify and continue").click();
  await page.getByLabel("Business name").fill("Sunrise Homes");
  await option(page, trade).click();
  await next(page, "Continue").click();
  await next(page, "Import").click();
  await advance(page, 600, 6);
  await next(page, "Looks good").click();
  await next(page, "I’ve tried it").click();
  if (stop === "WhatsApp") return;
  await next(page, "Do this later").click();
  if (stop === "Team") return;
  await next(page, "Go live").click();
}

/** The server's answer to GET / with redirects not followed: the one place `/` sends anyone. */
async function rootRedirect(page: Page) {
  const res = await page.request.get("/", { maxRedirects: 0 });
  return { status: res.status(), location: res.headers()["location"] };
}

test("/ always goes to /login and stops there, even with a session (signed in)", async ({ page }) => {
  // Signed in through the project's storage state as owner@test.local, a member of Test Realty.
  expect(await rootRedirect(page)).toEqual({ status: 307, location: "/login" });
  const documents: string[] = [];
  page.on("request", (r) => {
    if (r.isNavigationRequest()) documents.push(new URL(r.url()).pathname);
  });
  await page.goto("/");
  // The session alone decides nothing: the sign-in page renders. Submitting it does the routing.
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  expect(documents).toEqual(["/", "/login"]);
});

test("walks every step without overflow, and Back returns", async ({ page }) => {
  await openOnboarding(page);
  // The trial plan grants 300 credits (supabase/seed/plans.sql, 0006).
  await expect(page.getByText("7 days, 300 credits, no card.")).toBeVisible();
  await expect(page.getByText(/150 credits/)).toHaveCount(0);
  await expectNoHorizontalOverflow(page);

  await next(page, "Send code on WhatsApp").click();
  const verify = next(page, "Verify and continue");
  await expect(verify).toBeDisabled();
  await page.getByPlaceholder("––––––").fill("123456");
  await verify.click();

  await expect(page.getByRole("heading", { name: "Tell us about your business" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  // The name starts empty (the trade's sample is only a placeholder) and is required.
  const name = page.getByLabel("Business name");
  await expect(name).toHaveValue("");
  await expect(name).toHaveAttribute("placeholder", "Skyline Homes");
  await expect(next(page, "Continue")).toBeDisabled();
  await option(page, "Beauty parlour").click();
  await expect(name).toHaveValue("");
  await name.fill("   ");
  await expect(next(page, "Continue")).toBeDisabled();
  await name.fill("Glow Studio");
  await next(page, "Continue").click();

  await expect(page.getByRole("heading", { name: "Teach your assistant" })).toBeVisible();
  await expect(next(page, "Looks good")).toBeDisabled();
  await next(page, "Import").click();
  await advance(page, 600, 6);
  await expect(next(page, "Looks good")).toBeEnabled();
  await expectNoHorizontalOverflow(page);
  await next(page, "Looks good").click();

  await expect(page.getByRole("heading", { name: "Try your assistant now" })).toBeVisible();
  await next(page, "Back").click();
  await expect(page.getByRole("heading", { name: "Teach your assistant" })).toBeVisible();
  await next(page, "Looks good").click();
  await next(page, "I’ve tried it").click();

  await expect(page.getByRole("heading", { name: "Connect your WhatsApp number" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await next(page, "Do this later").click();

  await expect(page.getByRole("heading", { name: "Team, calendar and features" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await next(page, "Go live").click();

  await expect(page.getByRole("link", { name: "Go to my dashboard" })).toBeVisible();
  // No trial was created here (the account already has a business), so the summary is the default.
  await expect(page.getByText("7 days · 300 credits")).toBeVisible();
  await expect(page.getByText(/150 credits/)).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

/** The step says it is a preview before anything is clicked. */
async function expectPreviewNotice(page: Page) {
  const note = page.getByRole("note", { name: "Preview" });
  await expect(note).toContainText("Preview: connecting a number isn’t switched on yet.");
  await expect(note).toContainText("Nothing is sent to Meta and no number is connected.");
}

/** Whatever the preview showed, nothing claims a real connection, test send or Meta result. */
async function expectNoConnectionClaim(page: Page) {
  const body = page.locator("body");
  await expect(body).not.toContainText(/\+91 [\d ]+ is connected/);
  await expect(body).not.toContainText(/Test sent|Send a test message to my phone/);
  await expect(body).not.toContainText(/9 of 12|In review|Not added/);
}

test("Connect with Facebook: a labelled preview that ends without connecting anything", async ({ page }) => {
  await openOnboarding(page);
  await walkTo(page, "WhatsApp");
  await expectPreviewNotice(page);
  await next(page, "Continue with Facebook").click();
  const popup = page.getByRole("dialog");
  // The preview window doesn't pose as facebook.com.
  await expect(popup).toContainText("Preview · Meta’s WhatsApp setup window");
  await expect(popup).not.toContainText("facebook.com");
  for (const cta of ["Continue", "Next", "Next", "Verify", "Finish"]) {
    if (cta === "Verify") await expect(popup).toContainText("+91 98400 12345 · code sent");
    await popup.getByRole("button", { name: cta, exact: true }).click();
  }
  await expect(popup).toHaveCount(0);
  await advance(page, 700, 8);
  await expect(next(page, /^Continue$/)).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Preview finished" })).toContainText(
    "Preview finished: +91 98400 12345 isn’t connected yet",
  );
  await expectNoConnectionClaim(page);
  await expectNoHorizontalOverflow(page);

  // The Live step never shows the number as live after a preview.
  await next(page, /^Continue$/).click();
  await next(page, "Go live").click();
  await expect(page.getByText("Your number +91 98400 12345")).toBeVisible();
  await expect(page.getByText("Not connected yet")).toBeVisible();
});

// The webhook details and the connect route are emulated with page.route: the e2e API has no Meta, and the
// live Meta handshake is verified separately (docs/whatsapp-connection-contract.md). What is tested here is
// what the screen does with each answer of the real routes' envelopes.
const WEBHOOK_URL = "https://api.example.test/api/webhooks/whatsapp";
const VERIFY_TOKEN = "e2e-tenant-verify-token";
const CONNECTION = {
  id: "c0000000-0000-4000-8000-0000000000c1", tenant_id: "a0000000-0000-4000-8000-00000000000a", method: "manual_byo",
  waba_id: "100000000000001", phone_number_id: "200000000000001", display_phone: "+91 98765 43210", verified_name: "Skyline Homes",
  coexistence: false, status: "active", quality_rating: null, messaging_limit: null, created_at: "2026-10-24T09:00:00Z",
  last_check: {
    ran_at: "2026-10-24T09:00:00Z", overall: "warn",
    checks: [
      { key: "token_permissions", status: "pass", message: "Meta accepted the access token for this number.", checked_at: "2026-10-24T09:00:00Z" },
      { key: "webhook_subscribed", status: "not_verified", message: "Waiting for Meta.", checked_at: "2026-10-24T09:00:00Z" },
    ],
  },
};
const apiError = (status: number, code: string, message: string, fields?: Record<string, string>) => ({
  status, contentType: "application/json", body: JSON.stringify({ error: { code, message, ...(fields && { fields }) } }),
});
const ok = (status: number, body: unknown) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

async function openOwnApp(page: Page, config: Parameters<Page["route"]>[1]) {
  await page.route(/\/api\/whatsapp\/webhook-config/, config);
  await openOnboarding(page);
  await walkTo(page, "WhatsApp");
  await option(page, "Manual connection").click();
  await page.getByRole("tab", { name: "Use my own Meta app" }).click();
}

async function fillOwnApp(page: Page) {
  await page.getByLabel("WhatsApp Business Account ID").fill("100000000000001");
  await page.getByLabel("Phone number ID").fill("200000000000001");
  await page.getByLabel("Access token").fill("EAAB-e2e-synthetic-token");
  await page.getByLabel("App secret").fill("e2e-synthetic-app-secret");
}

test("own Meta app: shows the real webhook URL and this business's verify token, with copy buttons", async ({ page }) => {
  await openOwnApp(page, (route) => route.fulfill(ok(200, { webhookUrl: WEBHOOK_URL, verifyToken: VERIFY_TOKEN, partnerBusinessId: null })));
  await expect(page.getByText(WEBHOOK_URL, { exact: true })).toBeVisible();
  await expect(page.getByText(VERIFY_TOKEN, { exact: true })).toBeVisible();
  await expect(page.getByText("Not available yet. Our team shares it when connecting opens.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy" })).toHaveCount(2);
  // The own-app path is real, so it carries no "preview" notice; the token fields are masked.
  await expect(page.getByRole("note", { name: "Preview" })).toHaveCount(0);
  await expect(page.locator("input[type=password]")).toHaveCount(2);
  await expectNoHorizontalOverflow(page);
});

test("own Meta app: says so, and offers no form, when the API's address isn't configured", async ({ page }) => {
  await openOwnApp(page, (route) => route.fulfill(apiError(501, "not_available", "The webhook address isn’t configured yet. Our team will set it up.")));
  await expect(page.getByRole("alert").filter({ hasText: "isn’t configured yet" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect number" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy" })).toHaveCount(0);
});

test("own Meta app: a backend failure can be retried", async ({ page }) => {
  let calls = 0;
  await openOwnApp(page, (route) => {
    calls += 1;
    return calls === 1
      ? route.fulfill(apiError(502, "upstream_failed", "We couldn’t prepare your webhook details. Try again in a moment."))
      : route.fulfill(ok(200, { webhookUrl: WEBHOOK_URL, verifyToken: VERIFY_TOKEN, partnerBusinessId: null }));
  });
  await expect(page.getByRole("alert").filter({ hasText: "couldn’t prepare" })).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText(VERIFY_TOKEN, { exact: true })).toBeVisible();
});

test("own Meta app: a rejected field is shown, a successful connect shows what the API returned, and the secrets are cleared", async ({ page }) => {
  let posted: Record<string, unknown> | null = null;
  let attempt = 0;
  await page.route(/\/api\/whatsapp\/manual/, (route) => {
    attempt += 1;
    posted = route.request().postDataJSON();
    return attempt === 1
      ? route.fulfill(apiError(422, "validation_failed", "Some details need fixing.", { wabaId: "Enter the WhatsApp Business Account ID: digits only." }))
      : route.fulfill(ok(201, CONNECTION));
  });
  await openOwnApp(page, (route) => route.fulfill(ok(200, { webhookUrl: WEBHOOK_URL, verifyToken: VERIFY_TOKEN, partnerBusinessId: null })));
  await fillOwnApp(page);
  await page.getByRole("button", { name: "Connect number" }).click();
  await expect(page.getByText("Enter the WhatsApp Business Account ID: digits only.")).toBeVisible();
  // Nothing claims a connection that the API did not confirm.
  await expect(page.locator("body")).not.toContainText(/^Connected/m);

  await page.getByRole("button", { name: "Connect number" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Connected" })).toContainText("+91 98765 43210");
  await expect(page.getByText("Meta accepted the access token for this number.")).toBeVisible();
  await expect(page.getByText("Waiting for Meta.")).toBeVisible();
  expect(posted).toMatchObject({ wabaId: "100000000000001", phoneNumberId: "200000000000001", tokenType: "system_user" });
  expect(posted).not.toHaveProperty("tenantId");
  // The form is gone and the secrets are nowhere on the page.
  await expect(page.getByRole("button", { name: "Connect number" })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("EAAB-e2e-synthetic-token");
  await expectNoHorizontalOverflow(page);
});

test("own Meta app: a connection Meta rejected is shown as failed, never as connected", async ({ page }) => {
  await page.route(/\/api\/whatsapp\/manual/, (route) =>
    route.fulfill(ok(201, { ...CONNECTION, status: "failed", last_check: { checks: [{ key: "token_permissions", status: "fail", message: "Meta did not accept the access token or the Phone number ID.", checked_at: "x" }] } })),
  );
  await openOwnApp(page, (route) => route.fulfill(ok(200, { webhookUrl: WEBHOOK_URL, verifyToken: VERIFY_TOKEN, partnerBusinessId: null })));
  await fillOwnApp(page);
  await page.getByRole("button", { name: "Connect number" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Meta didn’t accept these details" })).toBeVisible();
  await expect(page.getByText("Meta did not accept the access token or the Phone number ID.")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Connected" })).toHaveCount(0);
  // The form stays so the customer can fix and retry.
  await expect(page.getByRole("button", { name: "Connect number" })).toBeVisible();
});

test("own Meta app: a backend error on connect is shown and nothing is claimed", async ({ page }) => {
  await page.route(/\/api\/whatsapp\/manual/, (route) => route.fulfill(apiError(502, "upstream_failed", "We couldn’t reach Meta to check these details. Try again in a moment.")));
  await openOwnApp(page, (route) => route.fulfill(ok(200, { webhookUrl: WEBHOOK_URL, verifyToken: VERIFY_TOKEN, partnerBusinessId: null })));
  await fillOwnApp(page);
  await page.getByRole("button", { name: "Connect number" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "couldn’t reach Meta" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect number" })).toBeEnabled();
});

// The signed-in owner belongs to one business (Test Realty in support/mock-supabase.mjs). Both WhatsApp calls must name
// it in X-Pakka-Tenant, next to the user's own token. The header is the browser's request, not authorization: the
// real API checks the membership, which this mocked run cannot prove (no real database, no live Meta).
const OWNER_TENANT = "10000000-0000-0000-0000-000000000001";

test("own Meta app: webhook details and connect both name the signed-in owner's business and send the user's token", async ({ page }) => {
  const seen: { path: string; tenant: string | undefined; authorization: string | undefined }[] = [];
  const note = (route: import("@playwright/test").Route) => {
    const headers = route.request().headers();
    seen.push({ path: new URL(route.request().url()).pathname, tenant: headers["x-pakka-tenant"], authorization: headers["authorization"] });
  };
  await page.route(/\/api\/whatsapp\/manual/, (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback();
    note(route);
    return route.fulfill(ok(201, CONNECTION));
  });
  await openOwnApp(page, (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback();
    note(route);
    return route.fulfill(ok(200, { webhookUrl: WEBHOOK_URL, verifyToken: VERIFY_TOKEN, partnerBusinessId: null }));
  });
  await expect(page.getByText(VERIFY_TOKEN, { exact: true })).toBeVisible();
  await fillOwnApp(page);
  await page.getByRole("button", { name: "Connect number" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Connected" })).toBeVisible();
  expect(seen.map((r) => r.path)).toEqual(["/api/whatsapp/webhook-config", "/api/whatsapp/manual"]);
  for (const request of seen) {
    expect(request.tenant, request.path).toBe(OWNER_TENANT);
    expect(request.authorization, request.path).toMatch(/^Bearer \S+$/);
  }
});

test("partner access shows Spark Agent's portfolio ID when the API has it, and stays a labelled preview", async ({ page }) => {
  await page.route(/\/api\/whatsapp\/webhook-config/, (route) => route.fulfill(ok(200, { webhookUrl: WEBHOOK_URL, verifyToken: VERIFY_TOKEN, partnerBusinessId: "123456789012345" })));
  await openOnboarding(page);
  await walkTo(page, "WhatsApp");
  await option(page, "Manual connection").click();
  await expect(page.getByText("123456789012345", { exact: true })).toBeVisible();
  await expectPreviewNotice(page);
});

test("manual partner access fails without IDs, then waits for “hi”", async ({ page }) => {
  await openOnboarding(page);
  await walkTo(page, "WhatsApp");
  await option(page, "Manual connection").click();
  await next(page, "Check connection").click();
  await advance(page, 700, 3);
  await expect(next(page, "Fix details")).toBeVisible();
  await next(page, "Fix details").click();
  await page.getByPlaceholder("234567890123456").fill("234567890123456");
  await page.getByPlaceholder("109876543210987").fill("109876543210987");
  await next(page, "Check connection").click();
  await advance(page, 700, 8);
  await next(page, "Prototype: “hi” received").click();
  await expect(next(page, /^Continue$/)).toBeVisible();
  await expect(page.getByText("Preview finished: +91 98400 12345 isn’t connected yet")).toBeVisible();
  await expectNoConnectionClaim(page);
});

test.describe("onboarding → dashboard", () => {
  // Signed in through the project's storage state: /dashboard is the signed-in home.
  test("completing onboarding is a full page load to /dashboard", async ({ page }) => {
    await openOnboarding(page);
    await walkTo(page, "Live");
    // A marker on window survives a client-side render but not a new document.
    await page.evaluate(() => ((window as unknown as { __onboardingDoc: boolean }).__onboardingDoc = true));
    await page.getByRole("link", { name: "Go to my dashboard" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole("heading", { level: 1, name: "Test Realty" })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __onboardingDoc?: boolean }).__onboardingDoc)).toBeUndefined();
    // The dashboard document has neither the onboarding wizard nor its font class on <html>.
    await expect(page.getByRole("heading", { name: "Start your free trial" })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.className)).toBe("");
    await expectNoHorizontalOverflow(page);
  });

});

test.describe("onboarding needs an account", () => {
  test.use({ storageState: SIGNED_OUT });

  test("signed out, / shows sign-in and /onboarding still asks for an account", async ({ page }) => {
    expect(await rootRedirect(page)).toEqual({ status: 307, location: "/login" });
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

    await page.goto("/onboarding");
    await expect(page).toHaveURL(/\/signup\?next=%2Fonboarding$/);
    await expect(page.getByRole("heading", { name: "Sign up" })).toBeVisible();

    // From /, an existing member signs in on the real login page and sign-in sends them on.
    await page.goto("/");
    await page.getByLabel("Email").fill("owner@test.local");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole("heading", { level: 1, name: "Test Realty" })).toBeVisible();
  });

  test("an account with no business yet also starts at /login from /", async ({ page }) => {
    await signUp(page, uniqueEmail());
    await expect(page).toHaveURL(/\/onboarding$/);
    // `/` never decides by membership: it answers /login for this account too.
    expect(await rootRedirect(page)).toEqual({ status: 307, location: "/login" });
  });

  test("a new account walks the existing wizard, with the same dummy WhatsApp code and no email code", async ({ page }) => {
    await signUp(page, uniqueEmail());
    await expect(page).toHaveURL(/\/onboarding$/);

    // Reload with the frozen clock the wizard's timers need; the session cookie carries over.
    await openOnboarding(page);
    await expect(page.getByLabel("Your WhatsApp number")).toBeVisible();
    await expect(page.getByLabel(/email/i)).toHaveCount(0);
    await next(page, "Send code on WhatsApp").click();
    await expect(page.getByText(/6-digit code sent to \+91/)).toBeVisible();
    await expect(page.getByText(/sent to .*@/)).toHaveCount(0);

    await walkTo(page, "Live", "Beauty parlour", { codeSent: true });
    await expect(page.getByRole("link", { name: "Go to my dashboard" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
