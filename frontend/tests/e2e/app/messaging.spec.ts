import type { Page, Route } from "@playwright/test";
import { API_URL } from "../../../playwright.config";
import { appAlert, asUser, SIGNED_OUT, expect, expectNoHorizontalOverflow, signIn, test } from "../support/app";

// Signed in as owner@test.local (project storage state) unless a test says otherwise.

/** Holds the request until `release()` so the in-flight state can be checked. */
async function holdRoute(page: Page, url: string, response: { status: number; body: unknown }) {
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  await page.route(url, async (route: Route) => {
    await released;
    await route.fulfill({ status: response.status, contentType: "application/json", body: JSON.stringify(response.body) });
  });
  return release;
}

test.describe("send test message", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/dashboard/messages/test");
    await expect(page.getByRole("heading", { level: 1, name: "Send a test message" })).toBeVisible();
  });

  test("validates the number and message before sending", async ({ page }) => {
    await page.getByLabel("Message").fill("");
    await page.getByRole("button", { name: "Send test message" }).click();
    await expect(page.getByText("Enter the number with country code, like +919840012345")).toBeVisible();
    await expect(page.getByText("Write a message")).toBeVisible();
    await expect(page.getByLabel("Recipient's WhatsApp number")).toBeFocused();
    await page.getByLabel("Recipient's WhatsApp number").fill("98400 12345");
    await page.getByRole("button", { name: "Send test message" }).click();
    await expect(page.getByLabel("Recipient's WhatsApp number")).toHaveAttribute("aria-invalid", "true");
    await page.getByLabel("Recipient's WhatsApp number").fill("+919840012345");
    await page.getByRole("button", { name: "Send test message" }).click();
    await expect(page.getByLabel("Message")).toBeFocused();
    await expect(page.getByLabel("Message")).toHaveAttribute("aria-invalid", "true");
    await expectNoHorizontalOverflow(page);
  });

  test("tells the truth when no WhatsApp number is connected", async ({ page }) => {
    await expect(page.getByRole("note")).toContainText("No WhatsApp number is connected yet");
    await page.getByLabel("Recipient's WhatsApp number").fill("+919840012345");
    await page.getByRole("button", { name: "Send test message" }).click();
    const alert = appAlert(page);
    await expect(alert).toContainText("WhatsApp isn't connected");
    await expect(alert).toContainText("the message was not sent");
    await expect(page.getByRole("status").filter({ hasText: "Sent to" })).toHaveCount(0);
    await alert.getByRole("link", { name: "Check WhatsApp connection" }).click();
    await expect(page).toHaveURL(/\/dashboard\/whatsapp$/);
  });

  test("shows a loading state while sending, then the result", async ({ page }) => {
    const release = await holdRoute(page, "**/api/messages/test", {
      status: 200,
      body: { providerMsgId: "wamid.TEST123", status: "accepted" },
    });
    await page.getByLabel("Recipient's WhatsApp number").fill("+919840012345");
    await page.getByRole("button", { name: "Send test message" }).click();
    await expect(page.getByRole("button", { name: "Sending…" })).toBeDisabled();
    await expect(page.getByRole("status").filter({ hasText: "Sending your message" })).toBeVisible();
    release();
    const sent = page.getByRole("status").filter({ hasText: "Sent to +919840012345." });
    await expect(sent).toContainText("WhatsApp accepted the message (ID wamid.TEST123)");
  });

  test("reports server and network failures with a retry", async ({ page }) => {
    await page.route("**/api/messages/test", (route) =>
      route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: { code: "upstream_failed", message: "WhatsApp didn't answer. Try again." } }) }),
    );
    await page.getByLabel("Recipient's WhatsApp number").fill("+919840012345");
    await page.getByRole("button", { name: "Send test message" }).click();
    await expect(appAlert(page)).toContainText("WhatsApp didn't answer. Try again.");
    await page.unroute("**/api/messages/test");
    await page.route("**/api/messages/test", (route) => route.abort("internetdisconnected"));
    await appAlert(page).getByRole("button", { name: "Try again" }).click();
    await expect(appAlert(page)).toContainText("We couldn't reach Spark Agent");
  });
});

test.describe("send test message: errors agreed with Dev 2", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/dashboard/messages/test");
    await page.getByLabel("Recipient's WhatsApp number").fill("+919840012345");
  });

  test("a 200 whose body isn't an accepted message is not shown as sent", async ({ page }) => {
    await page.route("**/api/messages/test", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }));
    await page.getByRole("button", { name: "Send test message" }).click();
    const alert = appAlert(page);
    await expect(alert).toContainText("Couldn't confirm the message");
    await expect(alert).toContainText("Check the phone before sending it again.");
    await expect(alert.getByRole("button", { name: "Try again" })).toHaveCount(0); // it may have gone: no one-click resend
    await expect(page.getByText(/WhatsApp accepted the message \(ID /)).toHaveCount(0);
    await expect(page.getByText(/Sent to/)).toHaveCount(0);
  });

  test("outside the 24-hour window", async ({ page }) => {
    await page.route("**/api/messages/test", (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "outside_window", message: "This number hasn't messaged you in the last 24 hours." } }),
      }),
    );
    await page.getByRole("button", { name: "Send test message" }).click();
    const alert = appAlert(page);
    await expect(alert).toContainText("Outside the 24-hour window");
    await expect(alert).toContainText("This number hasn't messaged you in the last 24 hours.");
    await expect(alert.getByRole("button", { name: "Try again" })).toHaveCount(0);
  });

  test("rate limited", async ({ page }) => {
    await page.route("**/api/messages/test", (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "rate_limited", message: "Up to 10 test messages an hour. Try again later." } }),
      }),
    );
    await page.getByRole("button", { name: "Send test message" }).click();
    const alert = appAlert(page);
    await expect(alert).toContainText("Too many requests");
    await expect(alert).toContainText("Up to 10 test messages an hour. Try again later.");
    await expect(alert.getByRole("button", { name: "Try again" })).toHaveCount(0);
  });
});

test.describe("send test message as staff", () => {
  test.use({ storageState: SIGNED_OUT });

  test("is limited to owners and admins, on the server too", async ({ page }) => {
    await signIn(page, "staff@test.local", "/dashboard/messages/test");
    await expect(page.getByRole("note").filter({ hasText: "Only an owner or admin" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send test message" })).toBeDisabled();
    const res = await page.request.post(`${API_URL}/api/messages/test`, { data: { to: "+919840012345", body: "hi" }, headers: await asUser(page) });
    expect(res.status()).toBe(403);
    expect((await res.json()).error).toEqual({ code: "forbidden", message: "Only an owner or admin can send a test message." });
  });
});

test.describe("create template", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/dashboard/templates/new");
    await expect(page.getByRole("heading", { level: 1, name: "Create a message template" })).toBeVisible();
  });

  async function fillValid(page: Page) {
    await page.getByLabel("Template name").fill("booking_confirmed_v1");
    await page.getByLabel("Message").fill("Hi {{1}}, your visit is booked for {{2}}.");
    await page.getByLabel("Sample for {{1}}").fill("Karthik");
    await page.getByLabel("Sample for {{2}}").fill("Sat 24 Oct, 11 am");
  }

  test("shows the empty variables state and a live preview", async ({ page }) => {
    await expect(page.getByText("No variables yet")).toBeVisible();
    await fillValid(page);
    await expect(page.getByText("No variables yet")).toHaveCount(0);
    await expect(page.getByTestId("template-preview")).toContainText("Hi Karthik, your visit is booked for Sat 24 Oct, 11 am.");
    await page.getByText("Marketing", { exact: true }).click();
    await page.getByText("Tamil", { exact: true }).click();
    await expect(page.getByTestId("template-preview")).toContainText("Marketing · Tamil");
    await expectNoHorizontalOverflow(page);
  });

  test("validates name, variables and sample values", async ({ page }) => {
    await page.getByRole("button", { name: "Submit for review" }).click();
    await expect(page.getByText(/Use lowercase letters, numbers and underscores/)).toBeVisible();
    await expect(page.getByText("Write the message")).toBeVisible();
    await expect(page.getByLabel("Template name")).toBeFocused();

    await page.getByLabel("Template name").fill("booking_confirmed_v1");
    await page.getByLabel("Message").fill("Hi {{2}}");
    await page.getByRole("button", { name: "Submit for review" }).click();
    await expect(page.getByText("Number variables in order: {{1}}, {{2}}, …")).toBeVisible();
    await expect(page.getByLabel("Message")).toBeFocused();

    await page.getByLabel("Message").fill("Hi");
    await page.getByRole("button", { name: "+ Add variable" }).click();
    await expect(page.getByLabel("Message")).toHaveValue("Hi {{1}}");
    await page.getByRole("button", { name: "Submit for review" }).click();
    // Meta rejects a body that ends (or starts) with a variable.
    await expect(page.getByText("Start and end the message with words, not a variable")).toBeVisible();
    await expect(page.getByLabel("Message")).toBeFocused();
    await page.getByLabel("Message").fill("{{1}}, your visit is booked.");
    await page.getByRole("button", { name: "Submit for review" }).click();
    await expect(page.getByText("Start and end the message with words, not a variable")).toBeVisible();

    await page.getByLabel("Message").fill("Hi {{1}}, your visit is booked.");
    await page.getByRole("button", { name: "Submit for review" }).click();
    await expect(page.getByText("Add a sample value")).toBeVisible();
    const sample = page.getByLabel("Sample for {{1}}");
    await expect(sample).toBeFocused();
    await expect(sample).toHaveAttribute("aria-invalid", "true");
    await expect(sample).toHaveAccessibleDescription("Add a sample value");
  });

  test("never claims a submission the backend can't make", async ({ page }) => {
    await fillValid(page);
    await page.getByRole("button", { name: "Submit for review" }).click();
    const alert = appAlert(page);
    await expect(alert).toContainText("Not available yet");
    await expect(alert).toContainText("this template was not submitted");
    await expect(page.getByRole("status").filter({ hasText: "submitted to Meta" })).toHaveCount(0);
  });

  test("shows a loading state while submitting, then the result", async ({ page }) => {
    const release = await holdRoute(page, "**/api/templates", {
      status: 200,
      body: { id: "40000000-0000-0000-0000-000000000001", name: "booking_confirmed_v1", language: "en", status: "pending" },
    });
    await fillValid(page);
    await page.getByRole("button", { name: "Submit for review" }).click();
    await expect(page.getByRole("button", { name: "Submitting…" })).toBeDisabled();
    await expect(page.getByRole("status").filter({ hasText: "Submitting your template" })).toBeVisible();
    release();
    await expect(page.getByRole("status").filter({ hasText: "booking_confirmed_v1" })).toContainText(
      "(English) was submitted to Meta and is waiting for review.",
    );
  });

  test("a 200 whose body isn't a template is not shown as submitted", async ({ page }) => {
    await page.route("**/api/templates", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }));
    await fillValid(page);
    await page.getByRole("button", { name: "Submit for review" }).click();
    const alert = appAlert(page);
    await expect(alert).toContainText("Couldn't confirm the template");
    await expect(alert).toContainText("Check your templates before submitting it again.");
    await expect(page.getByText(/was submitted to Meta|was saved as a draft/)).toHaveCount(0);
  });

  test("says when the backend only saved a draft", async ({ page }) => {
    await page.route("**/api/templates", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "40000000-0000-0000-0000-000000000002", name: "booking_confirmed_v1", language: "ta", status: "draft" }),
      }),
    );
    await fillValid(page);
    await page.getByRole("button", { name: "Submit for review" }).click();
    const done = page.getByRole("status").filter({ hasText: "booking_confirmed_v1" });
    await expect(done).toContainText("(Tamil) was saved as a draft. It hasn't been submitted to Meta.");
  });

  test("keeps each sample with its variable when the message is edited", async ({ page }) => {
    await page.getByLabel("Message").fill("Hi {{1}}, see you on {{2}} at {{3}}.");
    await page.getByLabel("Sample for {{1}}").fill("Karthik");
    await page.getByLabel("Sample for {{2}}").fill("Sat 24 Oct");
    await page.getByLabel("Sample for {{3}}").fill("11 am");
    // Remove {{2}}: {{3}} keeps "11 am" instead of taking {{2}}'s sample.
    await page.getByLabel("Message").fill("Hi {{1}}, see you at {{3}}.");
    await expect(page.getByLabel("Sample for {{2}}")).toHaveCount(0);
    await expect(page.getByLabel("Sample for {{3}}")).toHaveValue("11 am");
    await expect(page.getByTestId("template-preview")).toContainText("Hi Karthik, see you at 11 am.");
    // Bring {{2}} back: its sample is still there.
    await page.getByLabel("Message").fill("Hi {{1}}, see you on {{2}} at {{3}}.");
    await expect(page.getByLabel("Sample for {{2}}")).toHaveValue("Sat 24 Oct");
  });

  test("sends header, footer and up to three buttons in the agreed shapes", async ({ page }) => {
    let sent: unknown;
    await page.route("**/api/templates", async (route) => {
      sent = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "40000000-0000-0000-0000-000000000003", name: "booking_confirmed_v1", language: "en", status: "pending" }),
      });
    });
    await fillValid(page);
    await page.getByLabel("Header (optional)").fill("Booking confirmed");
    await page.getByLabel("Footer (optional)").fill("Reply STOP to opt out");

    const add = page.getByRole("button", { name: "+ Add button" });
    await add.click();
    await page.getByRole("group", { name: "Button 1" }).getByLabel("Button text").fill("Reschedule");
    await add.click();
    const second = page.getByRole("group", { name: "Button 2" });
    await second.getByText("Website", { exact: true }).click();
    await second.getByLabel("Button text").fill("See booking");
    await second.getByLabel("Web address").fill("https://pakkaagent.in/b/1");
    await add.click();
    const third = page.getByRole("group", { name: "Button 3" });
    await third.getByText("Phone number", { exact: true }).click();
    await third.getByLabel("Button text").fill("Call us");
    await third.getByLabel("Phone number to call").fill("+919840012345");
    await expect(add).toBeDisabled();

    const preview = page.getByTestId("template-preview");
    await expect(preview).toContainText("Booking confirmed");
    await expect(preview).toContainText("Reply STOP to opt out");
    await expect(page.getByRole("list", { name: "Preview buttons" }).getByRole("listitem")).toHaveText(["Reschedule", "See booking", "Call us"]);
    await expectNoHorizontalOverflow(page);

    await page.getByRole("button", { name: "Submit for review" }).click();
    await expect(page.getByRole("status").filter({ hasText: "booking_confirmed_v1" })).toBeVisible();
    expect(sent).toEqual({
      name: "booking_confirmed_v1",
      category: "utility",
      language: "en",
      body: "Hi {{1}}, your visit is booked for {{2}}.",
      examples: ["Karthik", "Sat 24 Oct, 11 am"],
      header: "Booking confirmed",
      footer: "Reply STOP to opt out",
      buttons: [
        { type: "quick_reply", text: "Reschedule" },
        { type: "url", text: "See booking", url: "https://pakkaagent.in/b/1" },
        { type: "phone_number", text: "Call us", phoneNumber: "+919840012345" },
      ],
    });
  });

  test("validates buttons and leaves out empty optional fields", async ({ page }) => {
    let sent: Record<string, unknown> | undefined;
    await page.route("**/api/templates", async (route) => {
      sent = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "40000000-0000-0000-0000-000000000004", name: "booking_confirmed_v1", language: "en", status: "pending" }),
      });
    });
    await fillValid(page);
    await page.getByRole("button", { name: "+ Add button" }).click();
    const button = page.getByRole("group", { name: "Button 1" });
    await button.getByText("Website", { exact: true }).click();
    await button.getByLabel("Web address").fill("pakkaagent.in");
    await page.getByRole("button", { name: "Submit for review" }).click();
    await expect(button.getByLabel("Button text")).toBeFocused();
    await expect(button.getByLabel("Button text")).toHaveAccessibleDescription("Add the button text");
    await expect(button.getByLabel("Web address")).toHaveAccessibleDescription("Enter a web address starting with https://");
    expect(sent).toBeUndefined();

    await button.getByRole("button", { name: "Remove button 1" }).click();
    await page.getByRole("button", { name: "Submit for review" }).click();
    await expect(page.getByRole("status").filter({ hasText: "booking_confirmed_v1" })).toBeVisible();
    expect(Object.keys(sent ?? {}).sort()).toEqual(["body", "category", "examples", "language", "name"]);
  });

  test("reports a duplicate template", async ({ page }) => {
    await page.route("**/api/templates", (route) =>
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "conflict", message: "booking_confirmed_v1 already exists in English on this number." } }),
      }),
    );
    await fillValid(page);
    await page.getByRole("button", { name: "Submit for review" }).click();
    const alert = appAlert(page);
    await expect(alert).toContainText("That already exists");
    await expect(alert).toContainText("booking_confirmed_v1 already exists in English on this number.");
    await expect(page.getByRole("status").filter({ hasText: "submitted to Meta" })).toHaveCount(0);
  });

  test("shows server validation errors on the fields", async ({ page }) => {
    await page.route("**/api/templates", (route) =>
      route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "validation_failed", message: "Check the highlighted fields.", fields: { name: "That name is already used" } } }),
      }),
    );
    await fillValid(page);
    await page.getByRole("button", { name: "Submit for review" }).click();
    await expect(page.getByText("That name is already used")).toBeVisible();
    await expect(page.getByLabel("Template name")).toBeFocused();
    await expect(appAlert(page)).toContainText("Check the highlighted fields");
  });
});
