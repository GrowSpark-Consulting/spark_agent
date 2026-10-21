import type { WebhookEndpoint, WebhookSettings } from "@pakka/types";
import type { Page } from "@playwright/test";
import { expect, expectNoHorizontalOverflow, SIGNED_OUT, signIn, test } from "../support/app";
import { newDay3Account } from "../support/day3";
import { refusal, stubApi, type ApiAnswer } from "../support/day5";

// /dashboard/settings/integrations: the five routes of docs/contracts.md "Outbound webhooks" (Dev 2, packages/types/src/integrations.ts) are
// stood in for with page.route and typed as the shared schemas. So these tests prove what the screen sends, how it reads each answer, that the secret
// is shown only when the answer carries it and only once, and that a refusal is never shown as success. They do not prove the real routes, the
// Pro gate or the database: that needs staging.

const ENDPOINT = /\/api\/integrations\/webhook$/;
const ROTATE = /\/api\/integrations\/webhook\/rotate-secret$/;
const TEST = /\/api\/integrations\/webhook\/test$/;
const HOOK_URL = "https://hooks.example.com/spark";
const ADDRESS = "Address that receives the events";

const endpoint = (over: Partial<WebhookEndpoint> = {}): WebhookEndpoint => ({
  url: HOOK_URL,
  events: ["lead.created", "booking.confirmed"],
  secretHint: "a1b2",
  active: true,
  createdAt: "2026-10-14T08:00:00.000Z",
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailure: null,
  ...over,
});
const settings = (over: Partial<WebhookSettings> = {}): WebhookSettings => ({ inPlan: true, sending: true, endpoint: null, ...over });

const open = async (page: Page) => {
  await page.goto("/dashboard/settings/integrations");
  await expect(page.getByRole("heading", { level: 1, name: "Integrations" })).toBeVisible();
};
const checkbox = (page: Page, name: RegExp) => page.getByRole("checkbox", { name });
const errorAlert = (page: Page) => page.locator('[role="alert"].app-state');

/** Records every write the page makes to anything but the webhook routes. */
function watchOtherWrites(page: Page): string[] {
  const writes: string[] = [];
  page.on("request", (r) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(r.method()) && !/\/api\/integrations\/webhook/.test(r.url()) && !/_next|__nextjs|\/api\/auth|logout/.test(r.url())) writes.push(`${r.method()} ${r.url()}`);
  });
  return writes;
}

test.describe("Integrations · webhook (owner)", () => {
  test("loads a business with no webhook: an empty form, no event chosen, the member's token and business on the read", async ({ page }) => {
    const calls = await stubApi(page, ENDPOINT, () => ({ status: 200, body: settings() }));
    await open(page);
    await expect(page.getByLabel(ADDRESS)).toHaveValue("");
    await expect(page.getByRole("checkbox")).toHaveCount(5);
    for (const box of await page.getByRole("checkbox").all()) await expect(box).not.toBeChecked();
    await expect(page.getByTestId("webhook-save")).toHaveText("Create webhook");
    await expect(page.getByTestId("webhook-details")).toHaveCount(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].authorization).toMatch(/^Bearer /);
    expect(calls[0].tenant).not.toBeNull();
    await expectNoHorizontalOverflow(page);
  });

  test("asks for an address and an event before sending anything", async ({ page }) => {
    const calls = await stubApi(page, ENDPOINT, () => ({ status: 200, body: settings() }));
    await open(page);
    await page.getByTestId("webhook-save").click();
    await expect(page.getByTestId("webhook-url-error")).toBeVisible();
    await expect(page.getByTestId("webhook-events-error")).toHaveText("Choose at least one event.");
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  test("creates a webhook: sends url and events, shows the secret once, then only its last four characters", async ({ page }) => {
    const otherWrites = watchOtherWrites(page);
    const calls = await stubApi(page, ENDPOINT, (_n, c) =>
      c.method === "PUT" ? { status: 200, body: { endpoint: endpoint(), secret: "whsec_TheOnlyTimeYouSeeThis" } } : { status: 200, body: settings() },
    );
    await open(page);
    await page.getByLabel(ADDRESS).fill(HOOK_URL);
    await checkbox(page, /A booking is confirmed/).check();
    await checkbox(page, /A new lead/).check();
    await page.getByTestId("webhook-save").click();

    await expect(page.getByTestId("webhook-secret-value")).toHaveValue("whsec_TheOnlyTimeYouSeeThis");
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toEqual({ url: HOOK_URL, events: ["lead.created", "booking.confirmed"] });
    expect(put.authorization).toMatch(/^Bearer /);
    expect(put.tenant).not.toBeNull();
    await expect(page.getByTestId("webhook-hint")).toHaveText("Signing secret ending in a1b2");
    await expect(page.getByTestId("webhook-save")).toHaveText("Save changes");
    await expect(page.getByTestId("webhook-save")).toBeDisabled();

    await page.getByTestId("webhook-secret-done").click();
    await expect(page.getByTestId("webhook-secret")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("whsec_TheOnlyTimeYouSeeThis");
    expect(otherWrites, "nothing is written anywhere but the API route").toEqual([]);
    await expectNoHorizontalOverflow(page);
  });

  test("a secret is gone after a reload", async ({ page }) => {
    let created = false;
    await stubApi(page, ENDPOINT, (_n, c) => {
      if (c.method === "PUT") {
        created = true;
        return { status: 200, body: { endpoint: endpoint(), secret: "whsec_gone_after_reload" } };
      }
      return { status: 200, body: settings({ endpoint: created ? endpoint() : null }) };
    });
    await open(page);
    await page.getByLabel(ADDRESS).fill(HOOK_URL);
    await checkbox(page, /A new lead/).check();
    await page.getByTestId("webhook-save").click();
    await expect(page.getByTestId("webhook-secret-value")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("webhook-hint")).toBeVisible();
    await expect(page.getByTestId("webhook-secret")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("whsec_gone_after_reload");
  });

  test("a second press while saving sends one request", async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const calls = await stubApi(page, ENDPOINT, async (_n, c) => {
      if (c.method !== "PUT") return { status: 200, body: settings() };
      await held;
      return { status: 200, body: { endpoint: endpoint(), secret: "whsec_x" } };
    });
    await open(page);
    await page.getByLabel(ADDRESS).fill(HOOK_URL);
    await checkbox(page, /A new lead/).check();
    const save = page.getByTestId("webhook-save");
    await save.click();
    await expect(save).toBeDisabled();
    await expect(save).toHaveText("Saving…");
    await save.click({ force: true, timeout: 1000 }).catch(() => {});
    await page.getByLabel(ADDRESS).press("Enter").catch(() => {});
    release();
    await expect(page.getByTestId("webhook-secret")).toBeVisible();
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  test("shows the server's reason at the address field, and keeps what was typed", async ({ page }) => {
    await stubApi(page, ENDPOINT, (_n, c) =>
      c.method === "PUT"
        ? { status: 400, body: { error: { code: "validation_failed", message: "Check the highlighted fields and try again.", fields: { url: "Use an https address." } } } }
        : { status: 200, body: settings() },
    );
    await open(page);
    await page.getByLabel(ADDRESS).fill("http://hooks.example.com/x");
    await checkbox(page, /A new lead/).check();
    await page.getByTestId("webhook-save").click();
    await expect(page.getByTestId("webhook-url-error")).toHaveText("Use an https address.");
    await expect(page.getByLabel(ADDRESS)).toHaveValue("http://hooks.example.com/x");
    await expect(page.getByTestId("webhook-secret")).toHaveCount(0);
  });

  test("a plan refusal on save is shown as one, never as saved", async ({ page }) => {
    await stubApi(page, ENDPOINT, (_n, c) => (c.method === "PUT" ? refusal(403, "plan_required", "Outbound webhooks are part of the Pro plan.") : { status: 200, body: settings() }));
    await open(page);
    await page.getByLabel(ADDRESS).fill(HOOK_URL);
    await checkbox(page, /A new lead/).check();
    await page.getByTestId("webhook-save").click();
    await expect(errorAlert(page)).toContainText("Outbound webhooks are part of the Pro plan.");
    await expect(page.getByTestId("webhook-details")).toHaveCount(0);
    await expect(page.getByText("Webhook created.")).toHaveCount(0);
  });

  test("a change to an existing webhook shows no secret and says saved only after the answer", async ({ page }) => {
    const calls = await stubApi(page, ENDPOINT, (_n, c) =>
      c.method === "PUT" ? { status: 200, body: { endpoint: endpoint({ events: ["lead.created"] }), secret: null } } : { status: 200, body: settings({ endpoint: endpoint() }) },
    );
    await open(page);
    await expect(page.getByLabel(ADDRESS)).toHaveValue(HOOK_URL);
    await expect(checkbox(page, /A booking is confirmed/)).toBeChecked();
    await expect(page.getByTestId("webhook-save")).toBeDisabled();
    await checkbox(page, /A booking is confirmed/).uncheck();
    await page.getByTestId("webhook-save").click();
    await expect(page.getByText("Webhook saved.")).toBeVisible();
    await expect(page.getByTestId("webhook-secret")).toHaveCount(0);
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ url: HOOK_URL, events: ["lead.created"] });
  });

  test("shows the last delivery and why the last one failed, from the server's fields", async ({ page }) => {
    await stubApi(page, ENDPOINT, () => ({
      status: 200,
      body: settings({ endpoint: endpoint({ lastSuccessAt: "2026-10-15T07:00:00.000Z", lastFailureAt: "2026-10-15T09:00:00.000Z", lastFailure: "http_503" }) }),
    }));
    await open(page);
    await expect(page.getByTestId("webhook-last-failure")).toHaveText("The receiver answered with an error (HTTP 503).");
    await expect(page.getByTestId("webhook-details")).toContainText("Last delivered");
  });

  test("a test event shows the real result, delivered or not, and is off while the form has unsaved changes", async ({ page }) => {
    const answers: ApiAnswer[] = [
      { status: 200, body: { delivered: true, status: 200, error: null } },
      { status: 200, body: { delivered: false, status: 500, error: "http_500" } },
    ];
    const tests = await stubApi(page, TEST, (n) => answers[n - 1]);
    await stubApi(page, ENDPOINT, () => ({ status: 200, body: settings({ endpoint: endpoint() }) }));
    await open(page);
    const send = page.getByTestId("webhook-test");
    await send.click();
    await expect(page.getByTestId("webhook-test-result")).toHaveText("Delivered. The receiver answered HTTP 200.");
    await send.click();
    await expect(page.getByTestId("webhook-test-result")).toHaveText("Not delivered. The receiver answered with an error (HTTP 500).");
    expect(tests[0].method).toBe("POST");
    expect(tests[0].tenant).not.toBeNull();
    await checkbox(page, /A booking is cancelled/).check();
    await expect(send).toBeDisabled();
    await expect(page.getByText(/Save your changes before sending a test/)).toBeVisible();
  });

  test("a test refused for the plan says so", async ({ page }) => {
    await stubApi(page, TEST, () => refusal(403, "plan_required", "Outbound webhooks are part of the Pro plan."));
    await stubApi(page, ENDPOINT, () => ({ status: 200, body: settings({ endpoint: endpoint() }) }));
    await open(page);
    await page.getByTestId("webhook-test").click();
    await expect(errorAlert(page)).toContainText("Pro plan");
    await expect(page.getByTestId("webhook-test-result")).toHaveCount(0);
  });

  test("replacing the secret asks first, sends nothing on Keep it, and shows the new secret once", async ({ page }) => {
    const rotations = await stubApi(page, ROTATE, () => ({ status: 200, body: { secret: "whsec_Brand_New", secretHint: "9z9z" } }));
    await stubApi(page, ENDPOINT, () => ({ status: 200, body: settings({ endpoint: endpoint() }) }));
    await open(page);
    await page.getByTestId("webhook-rotate").click();
    await expect(page.getByRole("dialog")).toContainText("The old one stops working at once");
    await page.getByRole("button", { name: "Keep it" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(rotations).toHaveLength(0);

    await page.getByTestId("webhook-rotate").click();
    await page.getByTestId("webhook-confirm").click();
    await expect(page.getByTestId("webhook-secret-value")).toHaveValue("whsec_Brand_New");
    await expect(page.getByTestId("webhook-hint")).toHaveText("Signing secret ending in 9z9z");
    expect(rotations).toHaveLength(1);
    await page.getByTestId("webhook-secret-done").click();
    await expect(page.locator("body")).not.toContainText("whsec_Brand_New");
  });

  test("a failed rotation says so, keeps the old hint and shows no secret", async ({ page }) => {
    await stubApi(page, ROTATE, () => refusal(404, "not_found", "There is no webhook to change."));
    await stubApi(page, ENDPOINT, () => ({ status: 200, body: settings({ endpoint: endpoint() }) }));
    await open(page);
    await page.getByTestId("webhook-rotate").click();
    await page.getByTestId("webhook-confirm").click();
    await expect(page.getByRole("dialog")).toContainText("There is no webhook to change.");
    await expect(page.getByTestId("webhook-secret")).toHaveCount(0);
    await page.getByRole("button", { name: "Keep it" }).click();
    await expect(page.getByTestId("webhook-hint")).toHaveText("Signing secret ending in a1b2");
  });

  test("deleting asks first, then returns to an empty form", async ({ page }) => {
    const calls = await stubApi(page, ENDPOINT, (_n, c) => (c.method === "DELETE" ? { status: 204, body: null } : { status: 200, body: settings({ endpoint: endpoint() }) }));
    await open(page);
    await page.getByTestId("webhook-delete").click();
    await expect(page.getByRole("dialog")).toContainText("Delete this webhook?");
    await page.getByRole("button", { name: "Keep it" }).click();
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    await page.getByTestId("webhook-delete").click();
    await page.getByTestId("webhook-confirm").click();
    await expect(page.getByText("Webhook deleted.")).toBeVisible();
    await expect(page.getByTestId("webhook-details")).toHaveCount(0);
    await expect(page.getByLabel(ADDRESS)).toHaveValue("");
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });

  test("a business off the Pro plan sees why, and cannot save or send a test", async ({ page }) => {
    const calls = await stubApi(page, ENDPOINT, () => ({ status: 200, body: settings({ inPlan: false, sending: false, endpoint: endpoint() }) }));
    await open(page);
    await expect(page.getByTestId("webhook-plan")).toContainText("Pro plan");
    await expect(page.getByTestId("webhook-save")).toBeDisabled();
    await expect(page.getByTestId("webhook-test")).toBeDisabled();
    await expect(page.getByLabel(ADDRESS)).toBeDisabled();
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  test("says events are not being sent while the switch is off, without hiding the settings", async ({ page }) => {
    await stubApi(page, ENDPOINT, () => ({ status: 200, body: settings({ sending: false, endpoint: endpoint() }) }));
    await open(page);
    await expect(page.getByTestId("webhook-not-sending")).toContainText("aren't being sent");
    await expect(page.getByTestId("webhook-hint")).toBeVisible();
  });

  test("a refused read shows the error and Try again reads it again", async ({ page }) => {
    const calls = await stubApi(page, ENDPOINT, (n) => (n === 1 ? refusal(403, "forbidden", "Only an owner or admin can do that.") : { status: 200, body: settings() }));
    await open(page);
    await expect(errorAlert(page)).toContainText("Only an owner or admin can do that.");
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByLabel(ADDRESS)).toBeVisible();
    expect(calls).toHaveLength(2);
  });

  test("an answer of the wrong shape is an error, not a half-drawn form", async ({ page }) => {
    await stubApi(page, ENDPOINT, () => ({ status: 200, body: { inPlan: "yes" } }));
    await open(page);
    await expect(errorAlert(page)).toContainText("Couldn't load your webhook");
    await expect(page.getByLabel(ADDRESS)).toHaveCount(0);
  });
});

test.describe("Integrations · staff", () => {
  test.use({ storageState: SIGNED_OUT });

  test("staff are told it is for owners and admins, and nothing is asked of the API", async ({ page, request }) => {
    const account = await newDay3Account(request, { role: "staff" });
    const calls = await stubApi(page, /\/api\/integrations\/webhook/, () => ({ status: 200, body: settings({ endpoint: endpoint() }) }));
    await signIn(page, account.email, "/dashboard/settings/integrations");
    await expect(page.getByRole("heading", { level: 1, name: "Integrations" })).toBeVisible();
    await expect(page.getByTestId("webhook-no-access")).toContainText("owners and admins");
    await expect(page.getByLabel(ADDRESS)).toHaveCount(0);
    expect(calls).toHaveLength(0);
    await expectNoHorizontalOverflow(page);
  });
});
