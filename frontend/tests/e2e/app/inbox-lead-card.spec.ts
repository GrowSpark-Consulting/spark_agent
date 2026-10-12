import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect, expectNoHorizontalOverflow, MOCK_SUPABASE_URL, SIGNED_OUT, signIn, test } from "../support/app";
import { newDay3Account, type Day3Account } from "../support/day3";
import { CARD_HANDED_OVER, CARD_UNSCORED, failure, mockLeadCardApi, ok, type LeadCardAnswer, type LeadCardApi } from "../support/lead-card-api";

// The lead card beside an Inbox chat (Day 4): the chat's customer's lead as stored, read under RLS from
// mock-supabase.mjs (a Day 3 business with `inbox: true`: Karthik's chat has a scored lead with bookings,
// the unnamed customer's lead is unscored, Meena isn't a lead). Pinned beside the chat from 1180px; the
// tablet and phone projects open it from the chat's Lead button. Mocked E2E: the database is the mock, so
// this shows the screen's behaviour, not the real policies. The seeded bookings are in the week of
// 12 Oct 2026, and the card picks the next one still to come, so the browser's clock is fixed before
// them: the tests give the same answer whenever they run. (A time already past, so the mock's session
// tokens, issued on the real clock, never look expired to the browser.)
// The AI-written rows come from GET /api/conversations/:id/lead-card, which needs the model and the service-role
// database, so it is stood in for with page.route (support/lead-card-api.ts); its answers are contract-shaped samples.

const NOW = new Date("2026-10-09T12:00:00+05:30");
const inboxAt = (chatId: string) => `/dashboard/inbox?chat=${chatId}`;
const isWide = (page: Page) => (page.viewportSize()?.width ?? 1440) >= 1180;

async function holdRealtime(page: Page) {
  // Live updates aren't under test here: the socket is accepted and never answered.
  await page.routeWebSocket(/\/realtime\/v1\/websocket/, () => {});
}

async function openChat(
  page: Page,
  account: Day3Account,
  chatId: string,
  name: string | RegExp,
  cards: Record<string, LeadCardAnswer | "abort"> = {},
  /** Runs before the page opens, to hold or change an answer. */
  before: (api: LeadCardApi) => void = () => {},
) {
  await page.clock.setFixedTime(NOW);
  await holdRealtime(page);
  // Karthik's lead is scored and handed over; the unnamed customer's is not scored. Any other chat has no card (not_found).
  const api = await mockLeadCardApi(page, { [account.ids.karthikChat]: ok(CARD_HANDED_OVER), [account.ids.unnamedChat]: ok(CARD_UNSCORED), ...cards });
  before(api);
  await signIn(page, account.email, inboxAt(chatId));
  await expect(page.getByRole("log", { name: typeof name === "string" ? `Messages with ${name}` : name })).toBeVisible();
  return api;
}

/** The AI rows of a card by name: label → text. */
async function aiRows(card: Locator): Promise<Record<string, string>> {
  const rows = card.getByTestId("lead-card-ai-row");
  const out: Record<string, string> = {};
  for (let i = 0; i < (await rows.count()); i++) {
    out[(await rows.nth(i).getByRole("term").innerText()).trim()] = (await rows.nth(i).getByRole("definition").innerText()).trim();
  }
  return out;
}

/** The lead card as this viewport shows it: pinned beside the chat, or opened from the Lead button. */
async function leadCard(page: Page): Promise<Locator> {
  if (isWide(page)) {
    await expect(page.getByRole("button", { name: "Lead", exact: true })).toBeHidden();
    return page.getByRole("complementary", { name: "Lead card" });
  }
  await expect(page.getByRole("complementary", { name: "Lead card" })).toBeHidden();
  await page.getByRole("button", { name: "Lead", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Lead card" });
  await expect(sheet).toBeVisible();
  return sheet;
}

async function setReadError(request: APIRequestContext, email: string, table: "leads" | null) {
  await request.post(`${MOCK_SUPABASE_URL}/__mock/day3-error`, { data: { email, table } });
}

async function leadReads(request: APIRequestContext, email: string): Promise<{ method: string; table: string; query: string }[]> {
  const log = (await (await request.get(`${MOCK_SUPABASE_URL}/__mock/rest-log?email=${email}`)).json()) as { method: string; table: string; query: string }[];
  return log.filter((r) => r.table === "leads" || r.table === "bookings");
}

test.describe("Inbox · lead card", () => {
  test.use({ storageState: SIGNED_OUT });

  test("shows the stored lead: score, stage, labelled answers, handover, booking and a link", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true, inbox: true });
    await openChat(page, account, account.ids.karthikChat, "Karthik R");
    const card = await leadCard(page);

    await expect(card.getByTestId("score-badge")).toHaveText(/82\s*Hot/);
    await expect(card).toContainText("Karthik R");
    await expect(card).toContainText("+91 98xxx xxx21");
    await expect(card.getByRole("definition").first()).toHaveText("Qualified");
    await expect(card).toContainText("asked to talk to a person");
    await expect(card.getByTestId("lead-card-answer")).toHaveText([
      "Preferred area: Velachery",
      "Budget: ₹60,00,000 – ₹80,00,000",
      "When are you planning: Not answered yet",
      "Parking needed: Yes",
    ]);
    await expect(card).toContainText("Consultation with Asha");
    await expect(card).toContainText("Mon 12 Oct, 10:00 am · Confirmed");
    // The AI-written rows, from the lead-card route.
    await expect(card.getByTestId("lead-card-flags")).toHaveText("Hot lead · High priority");
    await expect(card.getByTestId("lead-card-ai-row").first()).toBeVisible();
    expect(await aiRows(card)).toEqual({
      Need: "2BHK near Velachery, ready in 3 months",
      Summary: "Wants a 2BHK in Velachery within three months.\nAsked for ₹70 lakh instead of ₹78 lakh.",
      "Suggested next step": "Decide whether any discount is possible, then reply with a clear answer.",
      "Discount request": "Asked for ₹70 lakh instead of ₹78 lakh",
      Sentiment: "Positive",
      Language: "Writes in Tanglish (Tamil in English letters)",
      Source: "WhatsApp",
      "Suggested reply": "Thanks for waiting! Let me check what is possible on the price and come back to you today.",
    });
    await expect(card).toContainText("Summary written by the AI from this chat.");
    // The score, answers and booking are the stored ones, drawn once; the route's own copies and the full number never show.
    await expect(card).not.toContainText("Budget: ₹80 lakh");
    await expect(card).not.toContainText("Consultation, Mon 12 Oct");
    await expect(page.locator("body")).not.toContainText("919812345621");
    // No Try again: nothing failed (the sheet's own Close button is not counted).
    await expect(card.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await expect(card.getByRole("link", { name: "Open lead" })).toHaveAttribute("href", `/dashboard/leads/${account.ids.karthik}`);
    await expectNoHorizontalOverflow(page);

    await card.getByRole("link", { name: "Open lead" }).click();
    await expect(page).toHaveURL(new RegExp(`/dashboard/leads/${account.ids.karthik}$`));
    await expect(page.getByRole("heading", { level: 1, name: "Karthik R" })).toBeVisible();
  });

  test("an unscored lead says so, with nothing filled in for it", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true, inbox: true });
    await openChat(page, account, account.ids.unnamedChat, "+91 90xxx xxx52");
    const card = await leadCard(page);
    await expect(card.getByTestId("score-badge")).toHaveText(/Not scored yet/);
    await expect(card.getByTestId("score-badge")).not.toContainText(/\d/);
    await expect(card.getByRole("definition").first()).toHaveText("Engaged");
    await expect(card.getByTestId("lead-card-answer").filter({ hasText: "Not answered yet" })).toHaveCount(3);
    await expect(card).toContainText("Callback");
    await expect(card).toContainText("Mon 12 Oct, 4:00 pm · Confirmed");
    await expect(card).not.toContainText("Handed over");
    // The route's score is null: nothing is drawn for it, and the AI rows still show what it does hold.
    expect(await aiRows(card)).toMatchObject({ Need: "Looking for a callback", Summary: "Looking for a callback.\nNo budget or area yet." });
    expect(Object.keys(await aiRows(card))).not.toEqual(expect.arrayContaining(["Discount request", "Suggested reply", "Owner"]));
    await expect(card.getByTestId("lead-card-flags")).toHaveCount(0);
    await expect(card).toContainText("The AI couldn’t write the summary this time");
    await expectNoHorizontalOverflow(page);
  });

  test("a customer who isn't a lead shows No lead yet", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true, inbox: true });
    const api = await openChat(page, account, account.ids.meenaChat, "Meena K");
    const card = await leadCard(page);
    await expect(card).toContainText("No lead yet");
    await expect(card).toContainText("Meena K isn’t on the Leads board.");
    await expect(card.getByRole("link", { name: "Open lead" })).toHaveCount(0);
    await expect(card.getByTestId("score-badge")).toHaveCount(0);
    // No lead, no card to write about: the route isn't even asked.
    expect(api.calls).toEqual([]);
    await expect(card.getByTestId("lead-card-ai-row")).toHaveCount(0);
  });

  test("a failed read shows Try again inside the card, and the chat keeps working", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true, inbox: true });
    await setReadError(request, account.email, "leads");
    await openChat(page, account, account.ids.karthikChat, "Karthik R");
    const card = await leadCard(page);
    await expect(card.getByRole("alert")).toContainText("Couldn't load the lead");
    await expect(card.getByRole("alert")).not.toContainText(/not-a-row|boom|unexpected shape/);
    // The chat itself is untouched.
    await expect(page.getByRole("log", { name: "Messages with Karthik R" })).toContainText("60 to 80 L");

    await setReadError(request, account.email, null);
    await card.getByRole("button", { name: "Try again" }).click();
    await expect(card.getByTestId("score-badge")).toHaveText(/82\s*Hot/);
    await expect(card.getByRole("alert")).toHaveCount(0);
  });

  test("switching chats never shows the previous chat's lead", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true, inbox: true });
    await openChat(page, account, account.ids.karthikChat, "Karthik R");
    let card = await leadCard(page);
    await expect(card).toContainText("Velachery");

    // Hold Meena's lead read, so the card is seen while it loads.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route(/\/rest\/v1\/leads\?/, async (route) => {
      if (route.request().url().includes("contact_id=eq.")) await held;
      await route.continue();
    });
    if (!isWide(page)) await page.getByRole("dialog", { name: "Lead card" }).getByRole("button", { name: "Close" }).click();
    // Phones show one column: back to the list first.
    if ((page.viewportSize()?.width ?? 1440) < 720) await page.getByRole("button", { name: "Back" }).click();
    await page.getByTestId("inbox").getByRole("button", { name: /Meena K/ }).click();
    await expect(page.getByRole("log", { name: "Messages with Meena K" })).toBeVisible();
    card = await leadCard(page);
    await expect(card).toContainText("Loading the lead");
    await expect(card).not.toContainText("Velachery");
    await expect(card).not.toContainText("Karthik");
    release();
    await expect(card).toContainText("No lead yet");
  });

  test("reads only this business's leads: another business's leads never show", async ({ page, request }) => {
    const other = await newDay3Account(request, { seed: true, inbox: true });
    const account = await newDay3Account(request, { seed: true, inbox: true });
    await openChat(page, account, account.ids.meenaChat, "Meena K");
    const card = await leadCard(page);
    await expect(card).toContainText("No lead yet");
    // The other business has the same people as leads; none of it reaches this account.
    await expect(page.locator("body")).not.toContainText(other.ids.karthik);
    const reads = await leadReads(request, account.email);
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) expect(new URLSearchParams(r.query).get("tenant_id")).toBe(`eq.${account.tenantId}`);
  });

  test("the AI rows load apart from the stored lead, and the request names this business and this chat", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true, inbox: true });
    let release!: () => void;
    const api = await openChat(page, account, account.ids.karthikChat, "Karthik R", {}, (a) => {
      release = a.hold(account.ids.karthikChat);
    });
    const card = await leadCard(page);
    // The stored lead is there while the AI part is still loading, and says so.
    await expect(card.getByTestId("score-badge")).toHaveText(/82\s*Hot/);
    await expect(card).toContainText("Loading the AI summary…");
    await expect(card.getByTestId("lead-card-ai-row")).toHaveCount(0);
    release();
    await expect(card.getByTestId("lead-card-ai-row").first()).toBeVisible();
    await expect(card).not.toContainText("Loading the AI summary…");

    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toMatchObject({ path: `/api/conversations/${account.ids.karthikChat}/lead-card`, tenant: account.tenantId });
    expect(api.calls[0].authorization).toMatch(/^Bearer /);
  });

  test("a failed AI read shows Try again inside the card, keeps the stored lead, and recovers", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true, inbox: true });
    const api = await openChat(page, account, account.ids.karthikChat, "Karthik R", { [account.ids.karthikChat]: failure(502, "upstream_failed", "We couldn't build the lead card just now. Try again in a moment.") });
    const card = await leadCard(page);
    await expect(card.getByTestId("lead-card-ai-unavailable")).toContainText("The AI summary isn’t available right now. We couldn't build the lead card just now.");
    await expect(card.getByTestId("lead-card-ai-unavailable")).not.toContainText(/upstream_failed|502/);
    // The stored lead, the chat and the page are untouched.
    await expect(card.getByTestId("score-badge")).toHaveText(/82\s*Hot/);
    await expect(card).toContainText("Preferred area: Velachery");
    await expect(card.getByTestId("lead-card-ai-row")).toHaveCount(0);
    await expect(page.getByRole("log", { name: "Messages with Karthik R" })).toContainText("60 to 80 L");

    api.set(account.ids.karthikChat, ok(CARD_HANDED_OVER));
    await card.getByRole("button", { name: "Try again" }).click();
    await expect(card.getByTestId("lead-card-ai-row").first()).toBeVisible();
    await expect(card.getByTestId("lead-card-ai-unavailable")).toHaveCount(0);
    expect(api.calls).toHaveLength(2);
    await expectNoHorizontalOverflow(page);
  });

  test("an answer that doesn't fit the contract is not half shown", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true, inbox: true });
    await openChat(page, account, account.ids.karthikChat, "Karthik R", { [account.ids.karthikChat]: ok({ ...CARD_HANDED_OVER, score: "high" }) });
    const card = await leadCard(page);
    await expect(card.getByTestId("lead-card-ai-unavailable")).toContainText("came back in a form we couldn't read");
    await expect(card.getByTestId("lead-card-ai-row")).toHaveCount(0);
    await expect(card.getByTestId("lead-card-flags")).toHaveCount(0);
    await expect(card.getByTestId("score-badge")).toHaveText(/82\s*Hot/);
  });

  test("a card the API doesn't find says so in its own words, and the API's error codes never show", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true, inbox: true });
    await openChat(page, account, account.ids.karthikChat, "Karthik R", { [account.ids.karthikChat]: failure(404, "not_found", "That conversation was not found.") });
    const card = await leadCard(page);
    await expect(card.getByTestId("lead-card-ai-unavailable")).toContainText("That conversation was not found.");
    await expect(card).not.toContainText("not_found");
  });

  test("a request that gets no answer fails inside the card with a safe message", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true, inbox: true });
    await openChat(page, account, account.ids.karthikChat, "Karthik R", { [account.ids.karthikChat]: "abort" });
    const card = await leadCard(page);
    await expect(card.getByTestId("lead-card-ai-unavailable")).toBeVisible();
    await expect(card.getByTestId("lead-card-ai-unavailable")).not.toContainText(/Failed to fetch|TypeError|ERR_/);
    await expect(card.getByTestId("score-badge")).toHaveText(/82\s*Hot/);
  });

  test("one chat's AI rows never show beside another chat while it loads", async ({ page, request }) => {
    const account = await newDay3Account(request, { seed: true, inbox: true });
    await openChat(page, account, account.ids.karthikChat, "Karthik R");
    let card = await leadCard(page);
    await expect(card).toContainText("Decide whether any discount is possible");

    const release = (await mockLeadCardApi(page, { [account.ids.unnamedChat]: ok(CARD_UNSCORED) })).hold(account.ids.unnamedChat);
    if (!isWide(page)) await page.getByRole("dialog", { name: "Lead card" }).getByRole("button", { name: "Close" }).click();
    if ((page.viewportSize()?.width ?? 1440) < 720) await page.getByRole("button", { name: "Back" }).click();
    await page.getByTestId("inbox").getByRole("button", { name: /xxx xxx52/ }).click();
    await expect(page.getByRole("log", { name: /Messages with/ })).toBeVisible();
    card = await leadCard(page);
    await expect(card).toContainText("Not scored yet");
    await expect(card).not.toContainText("Decide whether any discount is possible");
    await expect(card).not.toContainText("Velachery");
    release();
    await expect(card).toContainText("Looking for a callback");
  });

  test("the sheet below 1180px closes with Close or Escape and gives focus back to Lead", async ({ page, request }) => {
    test.skip(isWide(page), "Wide screens pin the card instead of a sheet.");
    const account = await newDay3Account(request, { seed: true, inbox: true });
    await openChat(page, account, account.ids.karthikChat, "Karthik R");
    const leadButton = page.getByRole("button", { name: "Lead", exact: true });

    await leadButton.click();
    const sheet = page.getByRole("dialog", { name: "Lead card" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Close" })).toBeFocused();
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(leadButton).toBeFocused();

    await leadButton.click();
    await expect(sheet).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(leadButton).toBeFocused();
    await expectNoHorizontalOverflow(page);
  });

  test("wide screens pin the card beside the chat, without a Lead button", async ({ page, request }) => {
    test.skip(!isWide(page), "Below 1180px the card opens as a sheet.");
    const account = await newDay3Account(request, { seed: true, inbox: true });
    await openChat(page, account, account.ids.karthikChat, "Karthik R");
    const card = page.getByRole("complementary", { name: "Lead card" });
    const chat = page.getByRole("log", { name: "Messages with Karthik R" });
    await expect(card).toBeVisible();
    const [cardBox, chatBox] = [await card.boundingBox(), await chat.boundingBox()];
    expect(cardBox!.x).toBeGreaterThanOrEqual(chatBox!.x + chatBox!.width - 1);
    await expect(page.getByRole("button", { name: "Lead", exact: true })).toBeHidden();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });
});
