import type { Page } from "@playwright/test";
import { appAlert, expect, SIGNED_OUT, signIn, test } from "../support/app";
import { newDay3Account } from "../support/day3";

// The inbox's page limits (mocked E2E: mock-supabase.mjs answers conversation reads newest first and at most `limit`, as
// PostgREST does). The list holds the newest 200 chats and says so; a link to an older chat (a staff alert uses
// ?conversation=, the takeover link ?chat=) still opens it. What this shows is the screen's behaviour against the
// contract, not a real PostgREST.

const NEWEST_PAGE = 200;
const CHATS = NEWEST_PAGE + 5;

const rows = (page: Page) => page.locator(".app-inbox-row");

async function holdRealtime(page: Page) {
  // Live updates aren't under test here: the socket is accepted and never answered.
  await page.routeWebSocket(/\/realtime\/v1\/websocket/, () => {});
}

test.describe("Inbox · page limits and links to older chats", () => {
  test.use({ storageState: SIGNED_OUT });

  test("lists the newest 200 chats and says that older ones aren't listed", async ({ page, request }) => {
    const account = await newDay3Account(request, { manyChats: CHATS });
    await holdRealtime(page);
    await signIn(page, account.email, "/dashboard/inbox");
    await expect(page.getByTestId("inbox-list-truncated")).toHaveText(`Showing your newest ${NEWEST_PAGE} chats. Older chats aren't listed here.`);
    await expect(rows(page)).toHaveCount(NEWEST_PAGE);
    await expect(rows(page).filter({ hasText: `Bulk chat ${CHATS}` })).toHaveCount(0);
  });

  test("says nothing about a limit when every chat is listed", async ({ page, request }) => {
    const account = await newDay3Account(request, { manyChats: 3 });
    await holdRealtime(page);
    await signIn(page, account.email, "/dashboard/inbox");
    await expect(rows(page)).toHaveCount(3);
    await expect(page.getByTestId("inbox-list-truncated")).toHaveCount(0);
  });

  for (const param of ["conversation", "chat"] as const) {
    test(`opens a chat older than the newest page from ?${param}=`, async ({ page, request }) => {
      const account = await newDay3Account(request, { manyChats: CHATS });
      const oldest = account.ids.oldestChat;
      await holdRealtime(page);
      await signIn(page, account.email, `/dashboard/inbox?${param}=${oldest}`);
      await expect(page.getByRole("log", { name: `Messages with Bulk chat ${CHATS}` })).toContainText(`Message ${CHATS}`);
      // It joins the list, selected, beside the newest 200.
      await expect(rows(page)).toHaveCount(NEWEST_PAGE + 1);
      await expect(rows(page).filter({ hasText: `Bulk chat ${CHATS}` })).toHaveAttribute("aria-current", "true");
      // The address is left as it came; it says `chat` once the member opens a chat themselves (inbox-screen.tsx setChatParam).
      await expect(page).toHaveURL(new RegExp(`[?&]${param}=${oldest}`));
    });
  }

  test("a link to a chat that doesn't exist opens the list, with no error", async ({ page, request }) => {
    const account = await newDay3Account(request, { manyChats: CHATS });
    await holdRealtime(page);
    await signIn(page, account.email, "/dashboard/inbox?conversation=99999999-9999-4999-8999-999999999999");
    await expect(rows(page)).toHaveCount(NEWEST_PAGE);
    await expect(appAlert(page)).toHaveCount(0);
  });

  test("never opens another business's chat from a link", async ({ page, request }) => {
    const mine = await newDay3Account(request, { manyChats: 2 });
    const other = await newDay3Account(request, { manyChats: CHATS });
    await holdRealtime(page);
    await signIn(page, mine.email, `/dashboard/inbox?conversation=${other.ids.oldestChat}`);
    await expect(rows(page)).toHaveCount(2);
    await expect(page.getByText(`Bulk chat ${CHATS}`)).toHaveCount(0);
  });
});
