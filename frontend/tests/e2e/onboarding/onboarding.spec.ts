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
async function walkTo(page: Page, stop: "Try" | "WhatsApp" | "Team" | "Live", trade = "Real estate", { codeSent = false } = {}) {
  if (!codeSent) await next(page, "Send code on WhatsApp").click();
  await page.getByPlaceholder("––––––").fill("123456");
  await next(page, "Verify and continue").click();
  await page.getByLabel("Business name").fill("Sunrise Homes");
  await option(page, trade).click();
  await next(page, "Continue").click();
  await next(page, "Continue").click();
  if (stop === "Try") return;
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
  // No website import exists: the step says so, shows nothing "found", and never blocks Continue.
  await expect(page.getByTestId("import-unavailable")).toContainText("isn’t available yet");
  await expect(page.getByText(/found/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Import" })).toHaveCount(0);
  await expect(next(page, "Continue")).toBeEnabled();
  await expectNoHorizontalOverflow(page);
  await next(page, "Continue").click();

  await expect(page.getByRole("heading", { name: "Try your assistant now" })).toBeVisible();
  // This account already has a business: no trial exists, so there is no code, no test chat link and no trial note.
  await expect(page.getByTestId("no-trial-chat")).toContainText("already has a business");
  await expect(page.locator('a[href*="wa.me"]')).toHaveCount(0);
  await expect(page.getByText(/TRIAL-/)).toHaveCount(0);
  await expect(page.getByTestId("one-trial-note")).toHaveCount(0);
  await next(page, "Back").click();
  await expect(page.getByRole("heading", { name: "Teach your assistant" })).toBeVisible();
  await next(page, "Continue").click();
  await next(page, "I’ve tried it").click();

  await expect(page.getByRole("heading", { name: "Connect your WhatsApp number" })).toBeVisible();
  // NEXT_PUBLIC_SETUP_CALL_URL is not set in this build: the setup-call offer says to ask the team and links nowhere.
  await expect(page.getByTestId("setup-call")).toContainText("Ask the Spark Agent team");
  await expect(page.getByTestId("setup-call").getByRole("link")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await next(page, "Do this later").click();

  await expect(page.getByRole("heading", { name: "Team, calendar and features" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await next(page, "Go live").click();

  await expect(page.getByRole("link", { name: "Go to my dashboard" })).toBeVisible();
  // No trial was created here (the account already has a business): no trial code, credits or days are shown, and nothing says the
  // assistant is live while no number is connected.
  await expect(page.getByText(/credits/)).toHaveCount(0);
  await expect(page.getByText(/Test number/)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "You’re set up." })).toBeVisible();
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

// Connect with Facebook runs Meta's real Embedded Signup (components/onboarding/facebook-connect.tsx). This e2e build has no Meta app
// (NEXT_PUBLIC_META_APP_ID and NEXT_PUBLIC_META_ES_CONFIG_ID are unset), so the popup cannot open here and these tests can only show the
// "not set up" state. What the step does with each Meta and API outcome (start, payload, cancel, not_available, refusals, network, duplicate
// clicks) is covered with SDK and API stubs in lib/whatsapp/owner-embedded-signup.test.ts. No real Meta connection is tested anywhere here.
test("Connect with Facebook without a Meta app configured: says so, loads nothing from Facebook, sends nothing, claims nothing", async ({ page }) => {
  const facebook: string[] = [];
  const signups: string[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (/facebook\.(com|net)$/.test(url.hostname)) facebook.push(r.url());
    if (url.pathname === "/api/onboarding/whatsapp/embedded-signup") signups.push(r.method());
  });
  await openOnboarding(page);
  await walkTo(page, "WhatsApp");
  // Facebook is the default method. It is no longer a scripted preview, so no "Preview" label: it says plainly that it isn't set up.
  await expect(option(page, "Connect with Facebook")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("note", { name: "Preview" })).toHaveCount(0);
  await expect(page.getByTestId("facebook-not-configured")).toContainText("Connecting with Facebook isn’t set up on this site yet.");
  await expect(page.getByTestId("facebook-not-configured")).toContainText("no number is connected");
  await expect(page.getByRole("button", { name: /Continue with Facebook|Try again with Facebook/ })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expectNoConnectionClaim(page);
  await expectNoHorizontalOverflow(page);
  expect(facebook).toEqual([]);
  expect(signups).toEqual([]);

  // Skipping keeps the honest footer, and the Live step never shows the number as connected.
  await next(page, "Do this later").click();
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

// The Team step's switches are the business's saved feature switches: GET /api/features and PATCH /api/features/:key (Dev 2). Both are
// stood in for with page.route and a small fake server, so these tests prove what the step reads, what it sends, when it moves a switch
// and that a refresh finds the same state: not that the real routes or the plan checks agree.
test.describe("the Team step saves the feature switches", () => {
  const FEATURES_ROUTE = /\/api\/features$/;
  const FEATURE_ROUTE = /\/api\/features\/[a-z0-9_]+$/;
  type Row = Record<string, unknown>;
  const row = (key: string, name: string, over: Row = {}): Row => ({
    key, name, description: "d", state: "on", enabled: true, requiredPlan: null, disabledReason: null,
    creditsPerMonth: null, creditNote: null, settings: {}, control: "switch", ...over,
  });
  const startingRows = (): Row[] => [
    row("ai_auto_reply", "AI replies"),
    row("lead_qualification", "Lead qualification"),
    row("booking", "Booking in chat"),
    row("reminder_24h", "Day-before reminder", { control: "timing" }),
    row("reminder_2h", "2-hour reminder"),
    row("staff_alerts", "Staff alerts", { state: "locked", enabled: false, requiredPlan: "growth" }),
    row("feedback_request", "Feedback request", { state: "off", enabled: false }),
  ];
  const listOf = (rows: Row[]) => ({
    plan: { key: "starter", name: "Starter", monthlyCredits: 1500 },
    estimatedCreditsPerMonth: 0,
    groups: [{ name: "All", features: rows }],
  });

  /** A fake server: GET returns the rows, PATCH changes one and answers it. `failPatch` makes the next PATCH fail. */
  async function fakeServer(page: Page, opts: { failGet?: number; patch?: (key: string, n: number) => { status: number; body: unknown } | null } = {}) {
    const rows = startingRows();
    const patches: { key: string; body: unknown }[] = [];
    let gets = 0;
    await page.route(FEATURES_ROUTE, async (route) => {
      const req = route.request();
      if (req.method() === "OPTIONS") return route.fallback();
      gets += 1;
      const headers = { "access-control-allow-origin": req.headers()["origin"] ?? "*" };
      if (gets <= (opts.failGet ?? 0)) return route.fulfill({ status: 500, contentType: "application/json", headers, body: JSON.stringify({ error: { code: "internal", message: "Something went wrong. Try again in a moment." } }) });
      return route.fulfill({ status: 200, contentType: "application/json", headers, body: JSON.stringify(listOf(rows)) });
    });
    await page.route(FEATURE_ROUTE, async (route) => {
      const req = route.request();
      if (req.method() === "OPTIONS") return route.fallback();
      const key = new URL(req.url()).pathname.split("/").pop() ?? "";
      const body = req.postDataJSON() as { enabled: boolean };
      patches.push({ key, body });
      const headers = { "access-control-allow-origin": req.headers()["origin"] ?? "*" };
      const forced = opts.patch?.(key, patches.length);
      if (forced) return route.fulfill({ status: forced.status, contentType: "application/json", headers, body: JSON.stringify(forced.body) });
      const target = rows.find((r) => r.key === key)!;
      target.enabled = body.enabled;
      target.state = body.enabled ? "on" : "off";
      return route.fulfill({ status: 200, contentType: "application/json", headers, body: JSON.stringify(target) });
    });
    return { rows, patches, gets: () => gets };
  }

  const sw = (page: Page, name: string) => page.getByRole("switch", { name, exact: true });

  test("shows the saved switches, not defaults, and keeps nothing for staff or the calendar", async ({ page }) => {
    await fakeServer(page);
    await openOnboarding(page);
    await walkTo(page, "Team");
    await expect(sw(page, "AI auto-reply")).toBeChecked();
    await expect(sw(page, "Feedback request")).not.toBeChecked();
    // The plan does not include staff alerts: shown off and disabled, with the plan that has it.
    await expect(sw(page, "Staff WhatsApp alerts")).toBeDisabled();
    await expect(sw(page, "Staff WhatsApp alerts")).not.toBeChecked();
    await expect(page.locator('[data-feature="staff_alerts"]')).toContainText("Needs the Growth plan.");
    // No sample staff, and no pretend calendar.
    await expect(page.getByTestId("team-note")).toContainText("nobody is added here");
    await expect(page.getByTestId("calendar-note")).toContainText("nothing is connected");
    await expect(page.getByText("Google Calendar connected")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Add staff|Connect Google Calendar/ })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });

  test("a switch moves only after the server saved it, and a refresh finds it saved", async ({ page }) => {
    const server = await fakeServer(page);
    await openOnboarding(page);
    await walkTo(page, "Team");
    await sw(page, "Lead qualification").click();
    await expect(sw(page, "Lead qualification")).not.toBeChecked();
    expect(server.patches).toEqual([{ key: "lead_qualification", body: { enabled: false } }]);
    await sw(page, "Feedback request").click();
    await expect(sw(page, "Feedback request")).toBeChecked();

    // A refresh drops everything the page remembered; the step reads the server again.
    await page.reload();
    await walkTo(page, "Team");
    await expect(sw(page, "Lead qualification")).not.toBeChecked();
    await expect(sw(page, "Feedback request")).toBeChecked();
    await expect(sw(page, "AI auto-reply")).toBeChecked();
  });

  test("Reminders is two feature rows and saves both", async ({ page }) => {
    const server = await fakeServer(page);
    await openOnboarding(page);
    await walkTo(page, "Team");
    await sw(page, "Reminders").click();
    await expect(sw(page, "Reminders")).not.toBeChecked();
    expect(server.patches.map((p) => p.key)).toEqual(["reminder_24h", "reminder_2h"]);
    expect(server.patches.every((p) => (p.body as { enabled: boolean }).enabled === false)).toBe(true);
  });

  test("a failed save leaves the switch as the server has it and says so", async ({ page }) => {
    await fakeServer(page, { patch: () => ({ status: 500, body: { error: { code: "internal", message: "Something went wrong. Try again in a moment." } } }) });
    await openOnboarding(page);
    await walkTo(page, "Team");
    await sw(page, "Booking in chat").click();
    await expect(page.getByTestId("feature-error")).toContainText("Booking in chat was not changed.");
    await expect(sw(page, "Booking in chat")).toBeChecked();
    await expect(sw(page, "Booking in chat")).toBeEnabled();
  });

  test("a plan refusal names the plan and changes nothing", async ({ page }) => {
    await fakeServer(page, { patch: () => ({ status: 403, body: { error: { code: "plan_required", message: "Feedback request needs the Growth plan. Upgrade to switch it on." } } }) });
    await openOnboarding(page);
    await walkTo(page, "Team");
    await sw(page, "Feedback request").click();
    await expect(page.getByTestId("feature-error")).toContainText("Nothing was changed.");
    await expect(sw(page, "Feedback request")).not.toBeChecked();
  });

  test("one press is one request: the switches are off while one is saving", async ({ page }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const server = await fakeServer(page);
    await page.unroute(FEATURE_ROUTE);
    const patches: string[] = [];
    await page.route(FEATURE_ROUTE, async (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback();
      patches.push(new URL(route.request().url()).pathname);
      await gate;
      const key = new URL(route.request().url()).pathname.split("/").pop() ?? "";
      const target = server.rows.find((r) => r.key === key)!;
      target.enabled = false;
      target.state = "off";
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": route.request().headers()["origin"] ?? "*" }, body: JSON.stringify(target) });
    });
    await openOnboarding(page);
    await walkTo(page, "Team");
    await sw(page, "AI auto-reply").click();
    await expect(sw(page, "Lead qualification")).toBeDisabled();
    await expect(page.getByText("Saving…")).toBeVisible();
    release();
    await expect(sw(page, "AI auto-reply")).not.toBeChecked();
    expect(patches).toHaveLength(1);
  });

  test("a failed read says so with Try again, and shows no switches until the server answers", async ({ page }) => {
    await fakeServer(page, { failGet: 1 });
    await openOnboarding(page);
    await walkTo(page, "Team");
    await expect(page.getByTestId("features-error")).toContainText("Couldn’t load your saved choices");
    await expect(page.getByRole("switch")).toHaveCount(0);
    await page.getByTestId("features-error").getByRole("button", { name: "Try again" }).click();
    await expect(sw(page, "AI auto-reply")).toBeChecked();
  });
});

// POST /api/onboarding/trial answers `phone_used` (409) for a WhatsApp number that already had a free trial (Dev 2, #176). It is stood in for
// here with page.route; the real route and its database check are not exercised.
test.describe("the trial route's phone check", () => {
  const TRIAL_ROUTE = /\/api\/onboarding\/trial$/;
  const USED = "This WhatsApp number has already had a free trial, so we can't start another. Contact us to start on a paid plan.";

  async function toBusinessStep(page: Page, phone?: string) {
    await openOnboarding(page);
    if (phone) await page.getByLabel("Your WhatsApp number").fill(phone);
    await next(page, "Send code on WhatsApp").click();
    await page.getByPlaceholder("––––––").fill("123456");
    await next(page, "Verify and continue").click();
    await page.getByLabel("Business name").fill("Sunrise Homes");
    await option(page, "Real estate").click();
  }

  test("a typed number is sent in E.164, and a refused one is shown with the API's words while the wizard stays on the Business step", async ({ page }) => {
    const bodies: unknown[] = [];
    await page.route(TRIAL_ROUTE, async (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback();
      bodies.push(route.request().postDataJSON());
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        headers: { "access-control-allow-origin": route.request().headers()["origin"] ?? "*" },
        body: JSON.stringify({ status: "phone_used", message: USED }),
      });
    });
    await toBusinessStep(page, "98765 43210");
    await next(page, "Continue").click();
    await expect(page.getByText(USED)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Tell us about your business" })).toBeVisible();
    expect(bodies).toEqual([{ name: "Sunrise Homes", industry: "re", phone: "+919876543210" }]);
    await expectNoHorizontalOverflow(page);

    // Typing the business name again clears the message, and nothing was treated as created.
    await page.getByLabel("Business name").fill("Sunrise Homes Chennai");
    await expect(page.getByText(USED)).toHaveCount(0);
    await expect(page.getByText("Test number · code")).toHaveCount(0);
  });

  test("the pre-filled sample number is never sent", async ({ page }) => {
    const bodies: unknown[] = [];
    await page.route(TRIAL_ROUTE, async (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback();
      bodies.push(route.request().postDataJSON());
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        headers: { "access-control-allow-origin": route.request().headers()["origin"] ?? "*" },
        body: JSON.stringify({ status: "has_business" }),
      });
    });
    await toBusinessStep(page);
    await next(page, "Continue").click();
    await expect(page.getByRole("heading", { name: "Teach your assistant" })).toBeVisible();
    expect(bodies).toEqual([{ name: "Sunrise Homes", industry: "re" }]);
  });
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

    await walkTo(page, "Try", "Beauty parlour", { codeSent: true });
    // A real trial was created: the link carries this business's own code and the configured (fictional, e2e) demo number.
    const code = (await page.getByText(/^Your code is/).locator("strong").textContent()) ?? "";
    expect(code).toMatch(/^TRIAL-[A-Z0-9]{4}$/);
    await expect(page.getByRole("link", { name: "Open WhatsApp test chat" })).toHaveAttribute("href", `https://wa.me/15555550100?text=${code}`);
    await expect(page.getByTestId("test-chat-unavailable")).toHaveCount(0);
    await expect(page.getByTestId("one-trial-note")).toContainText("one free trial for each WhatsApp number");
    await next(page, "I’ve tried it").click();
    await next(page, "Do this later").click();
    await next(page, "Go live").click();
    await expect(page.getByRole("link", { name: "Go to my dashboard" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
