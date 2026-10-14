import type { Page } from "@playwright/test";
import { expect, expectNoHorizontalOverflow, mainNav, SIGNED_OUT, test } from "../support/app";
import { newDay3Account, open } from "../support/day3";
import { refusal, stubApi, type ApiAnswer, type ApiCall } from "../support/day5";

// /dashboard/settings/privacy (Data & privacy): an owner or admin finds a customer, sees what a deletion would remove, and confirms. The deletion routes
// (GET and POST /api/contacts/:id/deletion, #191) are stood in for with page.route so each answer can be chosen; the customer list is the mock Supabase's
// `contacts` under RLS. These tests prove what the screen sends and how it words each answer (success only for a confirmed deleted or already_deleted).
// They do not prove the real routes, the platform's role check, the database function or the Google Calendar clean-up.

const PATH = "/dashboard/settings/privacy";
const HEADING = "Data & privacy";
const DELETION = /\/api\/contacts\/[^/]+\/deletion$/;
const idOf = (call: ApiCall) => call.url.pathname.split("/")[3];

const preview = (call: ApiCall, over: Record<string, unknown> = {}) => ({
  contactId: idOf(call),
  deletedAt: null,
  conversations: 2,
  messages: 14,
  leads: 1,
  bookings: 1,
  upcomingBookings: 0,
  ...over,
});
const result = (over: Record<string, unknown> = {}) => ({
  status: "deleted",
  removed: { conversations: 2, messages: 14, leads: 1, bookings: 1 },
  calendarEvents: { removed: 1, left: 0 },
  ...over,
});

const panel = (page: Page) => page.getByTestId("deletion-panel");
const dialog = (page: Page) => page.getByRole("dialog");
const pick = (page: Page, name: string) => page.getByRole("button", { name: new RegExp(name) }).click();
const gets = (calls: ApiCall[]) => calls.filter((c) => c.method === "GET");
const posts = (calls: ApiCall[]) => calls.filter((c) => c.method === "POST");

async function openAs(page: Page, request: Parameters<typeof newDay3Account>[0], options: Parameters<typeof newDay3Account>[1] = { manyChats: 3 }) {
  const account = await newDay3Account(request, options);
  await open(page, account, PATH, HEADING);
  return account;
}

test.describe("Data & privacy", () => {
  test.use({ storageState: SIGNED_OUT });

  test("lists customers by name with a masked number, never the full number, and is in the navigation", async ({ page, request }) => {
    const calls = await stubApi(page, DELETION, () => refusal(500, "internal", "must not be called"));
    await openAs(page, request);
    await expect(mainNav(page).getByRole("link", { name: "Data & privacy" })).toHaveAttribute("aria-current", "page");
    const list = page.getByTestId("contact-list");
    await expect(list.getByRole("button")).toHaveCount(3);
    await expect(list).toContainText("Bulk chat 1");
    await expect(list).toContainText("+91 80xxx xxx00");
    expect(await page.content()).not.toContain("8000010000");
    await expectNoHorizontalOverflow(page);
    expect(calls).toHaveLength(0);
  });

  test("search narrows the list by name, or by part of a number, and says when nothing matches", async ({ page, request }) => {
    await stubApi(page, DELETION, () => refusal(500, "internal", "must not be called"));
    await openAs(page, request);
    const search = page.getByLabel("Search by name or by part of their number");
    await search.fill("chat 2");
    await expect(page.getByTestId("contact-list").getByRole("button")).toHaveCount(1);
    await search.fill("80000100");
    await expect(page.getByTestId("contact-list").getByRole("button")).toHaveCount(3);
    await search.fill("nobody");
    await expect(page.getByTestId("no-match")).toBeVisible();
  });

  test("picking a customer shows what a deletion removes, read for that customer and business, and sends nothing else", async ({ page, request }) => {
    const calls = await stubApi(page, DELETION, (_n, call) => ({ status: 200, body: preview(call) }));
    const account = await openAs(page, request);
    await pick(page, "Bulk chat 1");
    await expect(panel(page).getByTestId("preview-counts")).toContainText("Messages14");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].tenant).toBe(account.tenantId);
    expect(calls[0].authorization).toMatch(/^Bearer /);
    await expect(page.getByTestId("deletion-result")).toHaveCount(0);
  });

  test("a held preview shows a loading state, then the counts", async ({ page, request }) => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await stubApi(page, DELETION, async (_n, call) => (await held, { status: 200, body: preview(call) }));
    await openAs(page, request);
    await pick(page, "Bulk chat 1");
    await expect(panel(page)).toContainText("Checking what would be deleted");
    await expect(panel(page).getByRole("button", { name: "Delete their data" })).toHaveCount(0);
    release();
    await expect(panel(page).getByTestId("preview-counts")).toBeVisible();
  });

  test("deleting posts once with no body, and shows deleted, the counts and the server's calendar numbers only after the server confirms", async ({ page, request }) => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const calls = await stubApi(page, DELETION, async (_n, call): Promise<ApiAnswer> => {
      if (call.method === "GET") return { status: 200, body: preview(call) };
      await held;
      return { status: 200, body: result() };
    });
    const account = await openAs(page, request);
    await pick(page, "Bulk chat 1");
    await panel(page).getByRole("button", { name: "Delete their data" }).click();
    await expect(dialog(page)).toContainText("cannot be undone");
    await dialog(page).getByRole("button", { name: "Delete their data" }).click();
    await expect(dialog(page).getByRole("button", { name: "Deleting…" })).toBeDisabled();
    await expect(page.getByTestId("deletion-result")).toHaveCount(0);
    release();
    const done = page.getByTestId("deletion-result");
    await expect(done).toHaveAttribute("data-status", "deleted");
    await expect(done).toContainText("This customer's data was deleted.");
    await expect(done).toContainText("Removed 2 chats, 14 messages, 1 lead and 1 booking.");
    await expect(page.getByTestId("calendar-left")).toContainText("Left for you to remove: 0");
    await expect(page.getByTestId("calendar-warning")).toHaveCount(0);
    await expect(dialog(page)).toHaveCount(0);
    expect(posts(calls)).toHaveLength(1);
    expect(posts(calls)[0].body).toBeNull();
    expect(posts(calls)[0].tenant).toBe(account.tenantId);
    expect(posts(calls)[0].url.pathname).toBe(`/api/contacts/${idOf(posts(calls)[0])}/deletion`);
    await expect(page.getByTestId("contact-list")).toContainText("deleted");
  });

  test("calendar events the server could not take down are counted and the business is told to remove them", async ({ page, request }) => {
    await stubApi(page, DELETION, (_n, call) => (call.method === "GET" ? { status: 200, body: preview(call) } : { status: 200, body: result({ calendarEvents: { removed: 1, left: 2 } }) }));
    await openAs(page, request);
    await pick(page, "Bulk chat 1");
    await panel(page).getByRole("button", { name: "Delete their data" }).click();
    await dialog(page).getByRole("button", { name: "Delete their data" }).click();
    await expect(page.getByTestId("calendar-left")).toContainText("Left for you to remove: 2");
    await expect(page.getByTestId("calendar-warning")).toContainText("2 Google Calendar events could not be taken down");
  });

  test("already_deleted from the server says nothing changed, and claims nothing was removed", async ({ page, request }) => {
    await stubApi(page, DELETION, (_n, call) =>
      call.method === "GET" ? { status: 200, body: preview(call) } : { status: 200, body: result({ status: "already_deleted", removed: { conversations: 0, messages: 0, leads: 0, bookings: 0 } }) },
    );
    await openAs(page, request);
    await pick(page, "Bulk chat 1");
    await panel(page).getByRole("button", { name: "Delete their data" }).click();
    await dialog(page).getByRole("button", { name: "Delete their data" }).click();
    const done = page.getByTestId("deletion-result");
    await expect(done).toHaveAttribute("data-status", "already_deleted");
    await expect(done).toContainText("had already been deleted. Nothing changed now.");
    await expect(done).not.toContainText("Removed");
    await expect(page.getByTestId("calendar-left")).toContainText("Left for you to remove: 0");
  });

  test("a customer whose preview says deleted is shown as already deleted, with no button", async ({ page, request }) => {
    const calls = await stubApi(page, DELETION, (_n, call) => ({ status: 200, body: preview(call, { deletedAt: "2026-10-10T09:00:00.000Z", conversations: 0, messages: 0, leads: 0, bookings: 0 }) }));
    await openAs(page, request);
    await pick(page, "Bulk chat 1");
    await expect(page.getByTestId("already-deleted")).toContainText("was already deleted");
    await expect(page.getByTestId("already-deleted")).toContainText("10 Oct 2026");
    await expect(panel(page).getByRole("button", { name: "Delete their data" })).toHaveCount(0);
    expect(posts(calls)).toHaveLength(0);
  });

  test("a booking coming up blocks the button and says why, and nothing is sent", async ({ page, request }) => {
    const calls = await stubApi(page, DELETION, (_n, call) => ({ status: 200, body: preview(call, { upcomingBookings: 2 }) }));
    await openAs(page, request);
    await pick(page, "Bulk chat 1");
    await expect(page.getByTestId("upcoming-count")).toHaveText("2");
    await expect(page.getByTestId("upcoming-blocker")).toContainText("Cancel it first");
    await expect(panel(page).getByRole("button", { name: "Delete their data" })).toBeDisabled();
    expect(posts(calls)).toHaveLength(0);
  });

  test("a booking made since the preview is refused by the server (conflict): its words are shown, nothing is claimed, and the preview is read again", async ({ page, request }) => {
    let reads = 0;
    const message = "This customer has a booking coming up. Cancel it first (that tells them and takes it off your calendar), then delete their data.";
    const calls = await stubApi(page, DELETION, (_n, call) => {
      if (call.method === "GET") return { status: 200, body: preview(call, { upcomingBookings: ++reads > 1 ? 1 : 0 }) };
      return refusal(409, "conflict", message);
    });
    await openAs(page, request);
    await pick(page, "Bulk chat 1");
    await panel(page).getByRole("button", { name: "Delete their data" }).click();
    await dialog(page).getByRole("button", { name: "Delete their data" }).click();
    await expect(dialog(page)).toContainText("This customer has a booking coming up");
    await expect(dialog(page)).toContainText(message);
    await expect(page.getByTestId("deletion-result")).toHaveCount(0);
    await dialog(page).getByRole("button", { name: "Keep their data" }).click();
    await expect(page.getByTestId("upcoming-blocker")).toBeVisible();
    await expect(panel(page).getByRole("button", { name: "Delete their data" })).toBeDisabled();
    expect(posts(calls)).toHaveLength(1);
    expect(gets(calls)).toHaveLength(2);
  });

  test("pressing the confirm button twice sends one request", async ({ page, request }) => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const calls = await stubApi(page, DELETION, async (_n, call): Promise<ApiAnswer> => {
      if (call.method === "GET") return { status: 200, body: preview(call) };
      await held;
      return { status: 200, body: result() };
    });
    await openAs(page, request);
    await pick(page, "Bulk chat 1");
    await panel(page).getByRole("button", { name: "Delete their data" }).click();
    await dialog(page).getByRole("button", { name: "Delete their data" }).dblclick();
    await expect(dialog(page).getByRole("button", { name: "Deleting…" })).toBeDisabled();
    release();
    await expect(page.getByTestId("deletion-result")).toBeVisible();
    expect(posts(calls)).toHaveLength(1);
  });

  test("two presses in the same instant, before the screen can disable the button, still send one request", async ({ page, request }) => {
    // Playwright's own second click lands on an already-disabled button. Here both clicks run in one task, so the dialog's own busy flag has not
    // been re-rendered yet and only the screen's request lock stands between them and a second POST.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const calls = await stubApi(page, DELETION, async (_n, call): Promise<ApiAnswer> => {
      if (call.method === "GET") return { status: 200, body: preview(call) };
      await held;
      return { status: 200, body: result() };
    });
    await openAs(page, request);
    await pick(page, "Bulk chat 1");
    await panel(page).getByRole("button", { name: "Delete their data" }).click();
    await dialog(page).getByRole("button", { name: "Delete their data" }).evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
      button.click();
    });
    await expect(dialog(page).getByRole("button", { name: "Deleting…" })).toBeDisabled();
    await expect.poll(() => posts(calls).length).toBe(1);
    release();
    await expect(page.getByTestId("deletion-result")).toHaveAttribute("data-status", "deleted");
    expect(posts(calls)).toHaveLength(1);
  });

  test("a refusal for someone who is not an owner or admin is shown as the server's, with no retry and no delete button", async ({ page, request }) => {
    await stubApi(page, DELETION, () => refusal(403, "forbidden", "Only an owner or admin can delete a customer's data."));
    await openAs(page, request);
    await pick(page, "Bulk chat 1");
    const error = page.getByTestId("preview-error");
    await expect(error).toHaveAttribute("data-kind", "forbidden");
    await expect(error).toContainText("Only an owner or admin can delete a customer's data");
    await expect(error.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await expect(panel(page).getByRole("button", { name: "Delete their data" })).toHaveCount(0);
  });

  test("a staff member is told only an owner or admin can do this, and the screen calls nothing", async ({ page, request }) => {
    const calls = await stubApi(page, DELETION, () => refusal(403, "forbidden", "no"));
    await openAs(page, request, { manyChats: 3, role: "staff" });
    await expect(page.getByTestId("privacy-staff-notice")).toContainText("Only an owner or admin");
    await expect(page.getByTestId("contact-list")).toHaveCount(0);
    expect(calls).toHaveLength(0);
  });

  test("an admin may use it", async ({ page, request }) => {
    await stubApi(page, DELETION, (_n, call) => ({ status: 200, body: preview(call) }));
    await openAs(page, request, { manyChats: 3, role: "admin" });
    await pick(page, "Bulk chat 1");
    await expect(panel(page).getByRole("button", { name: "Delete their data" })).toBeEnabled();
  });

  test("a failed preview offers Try again, and the retry reads again", async ({ page, request }) => {
    const calls = await stubApi(page, DELETION, (n, call) => (n === 1 ? refusal(500, "internal", "boom") : { status: 200, body: preview(call) }));
    await openAs(page, request);
    await pick(page, "Bulk chat 1");
    await expect(page.getByTestId("preview-error")).toBeVisible();
    await page.getByTestId("preview-error").getByRole("button", { name: "Try again" }).click();
    await expect(panel(page).getByTestId("preview-counts")).toBeVisible();
    expect(gets(calls)).toHaveLength(2);
  });

  test("a failed deletion is not shown as done, says so, and can be asked again", async ({ page, request }) => {
    let tries = 0;
    const calls = await stubApi(page, DELETION, (_n, call) => {
      if (call.method === "GET") return { status: 200, body: preview(call) };
      return ++tries === 1 ? refusal(500, "internal", "boom") : { status: 200, body: result() };
    });
    await openAs(page, request);
    await pick(page, "Bulk chat 1");
    await panel(page).getByRole("button", { name: "Delete their data" }).click();
    await dialog(page).getByRole("button", { name: "Delete their data" }).click();
    await expect(dialog(page)).toContainText("Something went wrong");
    await expect(page.getByTestId("deletion-result")).toHaveCount(0);
    await dialog(page).getByRole("button", { name: "Delete their data" }).click();
    await expect(page.getByTestId("deletion-result")).toHaveAttribute("data-status", "deleted");
    expect(posts(calls)).toHaveLength(2);
  });

  const NOT_A_RESULT: [string, unknown][] = [
    ["an unknown status", { status: "queued" }],
    ["an empty object", {}],
    ["null", null],
    ["a bare string", "deleted"],
    ["a status with no counts", { status: "deleted" }],
    ["a result with no calendar numbers", { status: "deleted", removed: { conversations: 1, messages: 1, leads: 1, bookings: 1 } }],
    ["a negative count", result({ removed: { conversations: -1, messages: 0, leads: 0, bookings: 0 } })],
    ["a non-numeric calendar count", result({ calendarEvents: { removed: 0, left: "none" } })],
  ];
  for (const [what, body] of NOT_A_RESULT) {
    test(`an answer that is ${what} is never shown as a success`, async ({ page, request }) => {
      await stubApi(page, DELETION, (_n, call) => (call.method === "GET" ? { status: 200, body: preview(call) } : { status: 200, body }));
      await openAs(page, request);
      await pick(page, "Bulk chat 1");
      await panel(page).getByRole("button", { name: "Delete their data" }).click();
      await dialog(page).getByRole("button", { name: "Delete their data" }).click();
      await expect(dialog(page)).toContainText("We can't confirm what happened");
      await expect(page.getByTestId("deletion-result")).toHaveCount(0);
      await expect(page.getByText("This customer's data was deleted.")).toHaveCount(0);
      await expect(page.getByText("had already been deleted")).toHaveCount(0);
      await expect(page.getByTestId("contact-list")).not.toContainText("deleted");
    });
  }

  test("a business with no customers shows an empty state", async ({ page, request }) => {
    await openAs(page, request, {});
    await expect(page.getByText("No customers yet")).toBeVisible();
    await expect(page.getByTestId("contact-list")).toHaveCount(0);
  });

  test("a customer list that cannot be read says so with Try again, and the retry reads again", async ({ page, request }) => {
    let reads = 0;
    await page.route(/\/rest\/v1\/contacts/, (route) => {
      if (route.request().method() === "OPTIONS") return route.fallback();
      if (++reads === 1) return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": route.request().headers()["origin"] ?? "*" }, body: JSON.stringify([{ id: "not-a-contact" }]) });
      return route.fallback();
    });
    await openAs(page, request);
    await expect(page.getByTestId("contacts-error")).toBeVisible();
    await page.getByTestId("contacts-error").getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("contact-list")).toBeVisible();
    expect(reads).toBe(2);
  });
});
