import type { Page } from "@playwright/test";
import { expect, expectNoHorizontalOverflow, signIn, SIGNED_OUT, test } from "../support/app";
import { refusal, stubApi } from "../support/day5";

// The template picker for a chat whose 24-hour window has closed (Lakshmi V, inbox@test.local). POST /api/conversations/:id/messages with
// `{ template: { name, language, params } }` is the route Dev 2 put on main (backend/src/conversations/staff-reply.ts); both it and the
// GET /api/conversations/:id/templates list (Dev 2, #141) are stood in for per page (page.route), so this proves what the screen reads and sends and how it shows each
// answer, not that the real route, Meta or RLS agree.

const TENANT = "10000000-0000-0000-0000-000000000004";
const MESSAGES = /\/api\/conversations\/[0-9a-f-]+\/messages$/;
const accepted = { status: 200, body: { messageId: "41000000-0000-0000-0000-000000000801", providerMsgId: "wamid.OUT", status: "accepted" } };
const isMobile = (page: Page) => (page.viewportSize()?.width ?? 1440) < 720;

const TEMPLATES = /\/api\/conversations\/[0-9a-f-]+\/templates$/;
const CONNECTION = "80000000-0000-0000-0000-000000000001";

/** One template as GET /api/conversations/:id/templates answers it (backend/src/conversations/templates.ts). */
const template = (over: Record<string, unknown> = {}) => ({
  id: "70000000-0000-0000-0000-000000000001",
  name: "visit_reminder_v1",
  language: "en",
  category: "UTILITY",
  variableCount: 2,
  body: "Hi {{1}}, your visit is at {{2}}.",
  ...over,
});

/** The server's list for the chat: `templates` on a connected number, or a bare answer (an error, a disconnected number) as `body`. */
const list = (templates: unknown[], connectionId: string | null = CONNECTION) => ({ connectionId, templates });

/** Answers the page's call for the chat's templates (optionally after `held`); returns the calls so a test can see what was asked. */
async function stubTemplates(page: Page, status: number, body: unknown, held?: Promise<void>) {
  return stubApi(page, TEMPLATES, async () => {
    if (held) await held;
    return { status, body };
  });
}

const inboxRow = (page: Page, name: RegExp) => page.getByTestId("inbox").getByRole("button", { name });

/** The inbox subscribes to Realtime; answer the Phoenix joins and heartbeats so the socket stays quiet (no pushes are needed here). */
async function quietRealtime(page: Page) {
  await page.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => {
    ws.onMessage((raw) => {
      const [joinRef, ref, topic, event, payload] = JSON.parse(String(raw));
      const reply = (response: unknown) => ws.send(JSON.stringify([joinRef, ref, topic, "phx_reply", { status: "ok", response }]));
      if (event === "heartbeat" || event === "phx_leave") reply({});
      else if (event === "phx_join") {
        const changes = (payload.config.postgres_changes as object[]).map((f, i) => ({ ...f, id: i + 1 }));
        reply({ postgres_changes: changes });
      }
    });
  });
}

async function openClosedChat(page: Page) {
  await quietRealtime(page);
  await signIn(page, "inbox@test.local", "/dashboard/inbox");
  await inboxRow(page, /Lakshmi V/).click();
  await expect(page.getByText("24-hour window closed.")).toBeVisible();
}

const panel = (page: Page) => page.getByTestId("template-reply");
const picker = (page: Page) => panel(page).getByLabel("Send an approved template");
const pickFirst = (page: Page) => picker(page).selectOption({ index: 1 });
const send = (page: Page) => panel(page).getByRole("button", { name: /Send template|Sending/ });
const ACCEPTED_TEXT = "WhatsApp accepted the template.";

test.describe("Inbox · template picker", () => {
  test.use({ storageState: SIGNED_OUT });

  test("lists only approved templates, previews the message, sends the exact payload and shows success only after the API accepts", async ({ page }) => {
    // The server sorts (name, then language) and picks the chat's number; the screen lists what it is given, in that order.
    const listed = await stubTemplates(page, 200, list([
      template({ id: "70000000-0000-0000-0000-000000000002", name: "thanks_v1", language: "ta", variableCount: 0, body: "Thanks!" }),
      template(),
    ]));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const calls = await stubApi(page, MESSAGES, async () => {
      await held;
      return accepted;
    });
    await openClosedChat(page);
    await expect(panel(page)).toBeVisible();
    expect(listed).toHaveLength(1);
    expect(listed[0].method).toBe("GET");
    expect(listed[0].tenant).toBe(TENANT);
    expect(listed[0].authorization).toMatch(/^Bearer /);
    expect(listed[0].url.pathname).toMatch(/^\/api\/conversations\/40000000-0000-0000-0000-00000000000\d\/templates$/);
    await expect(panel(page).getByRole("option")).toHaveText(["Choose a template", "thanks_v1 · Tamil", "visit_reminder_v1 · English"]);
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);

    await picker(page).selectOption({ label: "visit_reminder_v1 · English" });
    await expect(page.getByTestId("template-meta")).toHaveText("utility · English");
    await expect(page.getByTestId("template-preview")).toHaveText("Hi {{1}}, your visit is at {{2}}.");
    await panel(page).getByLabel("Value for {{1}}").fill("  Lakshmi ");
    await panel(page).getByLabel("Value for {{2}}").fill("5 pm");
    await expect(page.getByTestId("template-preview")).toHaveText("Hi Lakshmi, your visit is at 5 pm.");

    await send(page).dblclick();
    await expect(send(page)).toHaveText("Sending…");
    await expect(page.getByText(ACCEPTED_TEXT)).toHaveCount(0);
    await expect(send(page)).toBeDisabled();
    expect(calls).toHaveLength(1);
    release();
    await expect(page.getByText(ACCEPTED_TEXT)).toBeVisible();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].tenant).toBe(TENANT);
    expect(calls[0].authorization).toMatch(/^Bearer /);
    expect(calls[0].url.pathname).toMatch(/^\/api\/conversations\/40000000-0000-0000-0000-00000000000\d\/messages$/);
    expect(calls[0].body).toEqual({ template: { name: "visit_reminder_v1", language: "en", params: ["Lakshmi", "5 pm"] } });
    await expectNoHorizontalOverflow(page);
  });

  test("a template with no values sends an empty list; every value is needed before anything is sent", async ({ page }) => {
    await stubTemplates(page, 200, list([template(), template({ id: "70000000-0000-0000-0000-000000000003", name: "hello_v1", variableCount: 0, body: "Hello!" })]));
    const calls = await stubApi(page, MESSAGES, () => accepted);
    await openClosedChat(page);
    await picker(page).selectOption({ label: "visit_reminder_v1 · English" });
    await panel(page).getByLabel("Value for {{1}}").fill("Lakshmi");
    await send(page).click();
    await expect(page.getByText("Fill in every value.")).toBeVisible();
    await expect(panel(page).getByLabel("Value for {{2}}")).toHaveAttribute("aria-invalid", "true");
    expect(calls).toHaveLength(0);

    await picker(page).selectOption({ label: "hello_v1 · English" });
    await expect(panel(page).getByRole("textbox")).toHaveCount(0);
    await send(page).click();
    await expect(page.getByText(ACCEPTED_TEXT)).toBeVisible();
    expect(calls[0].body).toEqual({ template: { name: "hello_v1", language: "en", params: [] } });
  });

  test("a refusal is shown, nothing is claimed as sent, and the choice and values stay for another try", async ({ page }) => {
    await stubTemplates(page, 200, list([template()]));
    const calls = await stubApi(page, MESSAGES, (n) =>
      n === 1 ? refusal(404, "not_found", "That template is not approved for this WhatsApp number.") : n === 2 ? refusal(422, "validation_failed", "This template needs 2 values.") : accepted,
    );
    await openClosedChat(page);
    await pickFirst(page);
    await panel(page).getByLabel("Value for {{1}}").fill("Lakshmi");
    await panel(page).getByLabel("Value for {{2}}").fill("5 pm");
    await send(page).click();
    await expect(panel(page).getByRole("alert")).toContainText("That template is not approved for this WhatsApp number.");
    await expect(panel(page).getByRole("alert")).toContainText("Not sent.");
    await expect(page.getByText(ACCEPTED_TEXT)).toHaveCount(0);
    await expect(panel(page).getByLabel("Value for {{2}}")).toHaveValue("5 pm");
    await send(page).click();
    await expect(panel(page).getByRole("alert")).toContainText("This template needs 2 values.");
    await send(page).click();
    await expect(page.getByText(ACCEPTED_TEXT)).toBeVisible();
    expect(calls).toHaveLength(3);
  });

  test("a server fault says it could not be confirmed, and an odd answer is never shown as sent", async ({ page }) => {
    await stubTemplates(page, 200, list([template({ variableCount: 0, body: "Hello!" })]));
    const calls = await stubApi(page, MESSAGES, (n) => (n === 1 ? refusal(502, "upstream_failed", "WhatsApp did not answer.") : { status: 200, body: { ok: true } }));
    await openClosedChat(page);
    await pickFirst(page);
    await send(page).click();
    await expect(panel(page).getByRole("alert")).toContainText("Couldn’t confirm it was sent.");
    await expect(panel(page).getByRole("alert")).toContainText("Check the chat before sending it again.");
    await send(page).click();
    await expect(panel(page).getByRole("alert")).toContainText("Couldn’t confirm it was sent.");
    await expect(page.getByText(ACCEPTED_TEXT)).toHaveCount(0);
    expect(calls).toHaveLength(2);
  });

  test("no approved templates: says so, offers nothing to send", async ({ page }) => {
    await stubTemplates(page, 200, list([]));
    const calls = await stubApi(page, MESSAGES, () => accepted);
    await openClosedChat(page);
    await expect(page.getByTestId("no-approved-templates")).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    expect(calls).toHaveLength(0);
  });

  test("a template with no readable body is not offered", async ({ page }) => {
    await stubTemplates(page, 200, list([template({ variableCount: null, body: null })]));
    await openClosedChat(page);
    await expect(page.getByTestId("no-approved-templates")).toBeVisible();
  });

  test("templates that can't be read: says so, sends nothing, and Try again reads them again", async ({ page }) => {
    const reads = await stubTemplates(page, 500, { error: { code: "internal", message: "boom" } });
    const calls = await stubApi(page, MESSAGES, () => accepted);
    await openClosedChat(page);
    await expect(page.getByText(/Couldn’t load your message templates/)).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    expect(calls).toHaveLength(0);
    expect(reads).toHaveLength(1);

    // The same route now answers: Try again asks again and shows the list.
    await page.unroute(TEMPLATES);
    await stubTemplates(page, 200, list([template()]));
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(panel(page)).toBeVisible();
  });

  test("an answer that isn't the contract's shape is an error, never a half-shown list", async ({ page }) => {
    await stubTemplates(page, 200, { templates: [{ name: "x" }] });
    await openClosedChat(page);
    await expect(page.getByText(/Couldn’t load your message templates/)).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
  });

  test("a chat whose number isn't connected says so and offers nothing to send", async ({ page }) => {
    await stubTemplates(page, 200, list([], null));
    const calls = await stubApi(page, MESSAGES, () => accepted);
    await openClosedChat(page);
    await expect(page.getByTestId("number-not-connected")).toBeVisible();
    await expect(page.getByTestId("no-approved-templates")).toHaveCount(0);
    await expect(panel(page)).toHaveCount(0);
    expect(calls).toHaveLength(0);
  });

  test("while templates load it says so, and the free-text box is never shown for a closed window", async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await stubTemplates(page, 200, list([template()]), held);
    await openClosedChat(page);
    await expect(page.getByText("Loading approved templates…")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);
    release();
    await expect(panel(page)).toBeVisible();
  });

  test("a choice never moves to another chat", async ({ page }) => {
    await stubTemplates(page, 200, list([template()]));
    await openClosedChat(page);
    await pickFirst(page);
    await panel(page).getByLabel("Value for {{1}}").fill("Half written");
    if (isMobile(page)) await page.getByRole("button", { name: "Back" }).click();
    await inboxRow(page, /Priya S/).click();
    await expect(page.getByText("AI is replying. Switch to Human to reply.")).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    if (isMobile(page)) await page.getByRole("button", { name: "Back" }).click();
    await inboxRow(page, /Lakshmi V/).click();
    await expect(picker(page)).toHaveValue("");
  });

  test("the picker fits every width", async ({ page }) => {
    await stubTemplates(page, 200, list([template()]));
    await openClosedChat(page);
    await pickFirst(page);
    await expect(send(page)).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
