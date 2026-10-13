import type { APIRequestContext, Page, Request } from "@playwright/test";
import { expect, expectNoHorizontalOverflow, MOCK_SUPABASE_URL, SIGNED_OUT, signIn, test } from "../support/app";
import { refusal, stubApi } from "../support/day5";

// /dashboard/team, "How you take over chats": memberships.takeover_pref, with the own-number choices following the `handoff_own_number` row of
// GET /api/features. The features answer is stood in for with page.route (the rows a plan locks or a business switches off are the server's to
// decide); the membership read and write go through the mock Supabase's emulation of the own_preferences policy (0002). Mocked E2E: it proves
// how the screen reads each answer and what it writes, not that the real plan rules or policy agree.

type Role = "owner" | "admin" | "staff";
type TeamAccount = { email: string; tenantId: string; userId: string };
type StoredMembership = { tenant_id: string; user_id: string; role: Role; whatsapp_phone: string | null; takeover_pref: string | null };

const PATH = "/dashboard/team";
const FEATURES = /\/api\/features$/;

async function newTeamAccount(request: APIRequestContext, options: { role?: Role; phone?: string; refused?: boolean; takeoverPref?: string } = {}): Promise<TeamAccount> {
  return (await request.post(`${MOCK_SUPABASE_URL}/__mock/team-account`, { data: options })).json();
}
async function stored(request: APIRequestContext, email: string): Promise<StoredMembership[]> {
  return (await request.get(`${MOCK_SUPABASE_URL}/__mock/memberships?email=${email}`)).json();
}
async function openTeam(page: Page, account: TeamAccount) {
  await signIn(page, account.email, PATH);
  await expect(page.getByRole("heading", { level: 1, name: "Team" })).toBeVisible();
  await expect(takeover(page)).toBeVisible();
}
function membershipWrites(page: Page) {
  const writes: { method: string; query: URLSearchParams; body: unknown }[] = [];
  page.on("request", (req: Request) => {
    const url = new URL(req.url());
    if (url.pathname === "/rest/v1/memberships" && req.method() !== "GET" && req.method() !== "HEAD") {
      writes.push({ method: req.method(), query: url.searchParams, body: req.postDataJSON() });
    }
  });
  return writes;
}

/** The own-number row as GET /api/features answers it (packages/types/src/features.ts). */
const ownNumberFeature = (over: Record<string, unknown> = {}) => ({
  key: "handoff_own_number",
  name: "Reply from your own number",
  description: "Take over a chat from your own WhatsApp.",
  state: "on",
  enabled: true,
  requiredPlan: null,
  disabledReason: null,
  creditsPerMonth: null,
  creditNote: "No extra credits",
  settings: {},
  control: "switch",
  ...over,
});
const featureList = (row: Record<string, unknown> | null) => ({
  plan: { key: "growth", name: "Growth", monthlyCredits: 1500 },
  estimatedCreditsPerMonth: 0,
  groups: row ? [{ name: "Team alerts", features: [row] }] : [],
});

const takeover = (page: Page) => page.getByRole("region", { name: "How you take over chats" });
const choice = (page: Page, name: RegExp) => takeover(page).getByRole("radio", { name });
const toast = (page: Page, text: string) => page.getByRole("status").filter({ hasText: text });

test.describe("Team · how you take over chats (own-number entitlement from GET /api/features)", () => {
  test.use({ storageState: SIGNED_OUT });

  test("a plan that includes it: all three choices work, and the choice is saved on your own row only", async ({ page, request }) => {
    await stubApi(page, FEATURES, () => ({ status: 200, body: featureList(ownNumberFeature()) }));
    const account = await newTeamAccount(request, { phone: "+919840012345" });
    const writes = membershipWrites(page);
    await openTeam(page, account);
    await expect(takeover(page).getByRole("radio")).toHaveCount(3);
    for (const name of [/In the inbox/, /From my own WhatsApp number/, /Ask me each time/]) await expect(choice(page, name)).toBeEnabled();
    await expect(page.getByTestId("own-number-locked")).toHaveCount(0);
    await expect(takeover(page).getByRole("button", { name: "Save" })).toBeDisabled();

    await choice(page, /From my own WhatsApp number/).check();
    await takeover(page).getByRole("button", { name: "Save" }).click();
    await expect(toast(page, "Saved how you take over chats")).toBeVisible();
    expect((await stored(request, account.email))[0].takeover_pref).toBe("own_number");
    expect(writes.map((w) => w.body)).toEqual([{ takeover_pref: "own_number" }]);
    expect(writes[0].query.get("tenant_id")).toBe(`eq.${account.tenantId}`);
    expect(writes[0].query.get("user_id")).toBe(`eq.${account.userId}`);

    await page.reload();
    await expect(choice(page, /From my own WhatsApp number/)).toBeChecked();
    await expectNoHorizontalOverflow(page);
  });

  test("a locked feature with a required plan: own-number choices are unavailable and the upgrade path names the plan", async ({ page, request }) => {
    await stubApi(page, FEATURES, () => ({ status: 200, body: featureList(ownNumberFeature({ state: "locked", enabled: false, requiredPlan: "growth" })) }));
    const account = await newTeamAccount(request, { phone: "+919840012345" });
    const writes = membershipWrites(page);
    await openTeam(page, account);
    await expect(choice(page, /In the inbox/)).toBeEnabled();
    await expect(choice(page, /From my own WhatsApp number/)).toBeDisabled();
    await expect(choice(page, /Ask me each time/)).toBeDisabled();
    await expect(page.getByTestId("own-number-locked")).toContainText("needs the Growth plan");
    await expect(page.getByTestId("own-number-upgrade")).toHaveAttribute("href", "/dashboard/billing");
    // The inbox choice still saves.
    await choice(page, /In the inbox/).check();
    await takeover(page).getByRole("button", { name: "Save" }).click();
    await expect(toast(page, "Saved how you take over chats")).toBeVisible();
    expect(writes.map((w) => w.body)).toEqual([{ takeover_pref: "inbox" }]);
    await expectNoHorizontalOverflow(page);
  });

  test("locked with no plan named: unavailable, with no upgrade link to follow", async ({ page, request }) => {
    await stubApi(page, FEATURES, () => ({ status: 200, body: featureList(ownNumberFeature({ state: "locked", enabled: false, requiredPlan: null })) }));
    await openTeam(page, await newTeamAccount(request, { phone: "+919840012345" }));
    await expect(choice(page, /From my own WhatsApp number/)).toBeDisabled();
    await expect(page.getByTestId("own-number-locked")).toContainText("isn’t included in your plan");
    await expect(page.getByTestId("own-number-upgrade")).toHaveCount(0);
  });

  test("a feature the business has switched off, or that cannot work, says why", async ({ page, request }) => {
    await stubApi(page, FEATURES, (n) => ({
      status: 200,
      body: featureList(n === 1 ? ownNumberFeature({ state: "off", enabled: false }) : ownNumberFeature({ state: "disabled", enabled: false, disabledReason: "Connect a WhatsApp number first." })),
    }));
    await openTeam(page, await newTeamAccount(request, { phone: "+919840012345" }));
    await expect(choice(page, /From my own WhatsApp number/)).toBeDisabled();
    await expect(takeover(page)).toContainText("An owner or admin can switch it on under Features.");
    await page.reload();
    await expect(takeover(page)).toContainText("Connect a WhatsApp number first.");
  });

  test("own number also needs your alert number", async ({ page, request }) => {
    await stubApi(page, FEATURES, () => ({ status: 200, body: featureList(ownNumberFeature()) }));
    await openTeam(page, await newTeamAccount(request));
    await expect(choice(page, /From my own WhatsApp number/)).toBeDisabled();
    await expect(takeover(page)).toContainText("Add your WhatsApp number above first.");
    await expect(choice(page, /Ask me each time/)).toBeEnabled();
  });

  test("no own-number row in the features answer: unavailable, not guessed", async ({ page, request }) => {
    await stubApi(page, FEATURES, () => ({ status: 200, body: featureList(null) }));
    await openTeam(page, await newTeamAccount(request, { phone: "+919840012345" }));
    await expect(choice(page, /From my own WhatsApp number/)).toBeDisabled();
    await expect(takeover(page)).toContainText("Couldn't tell whether your plan includes this.");
  });

  test("a saved own-number choice the plan no longer allows is shown with a warning", async ({ page, request }) => {
    await stubApi(page, FEATURES, () => ({ status: 200, body: featureList(ownNumberFeature({ state: "locked", enabled: false, requiredPlan: "growth" })) }));
    await openTeam(page, await newTeamAccount(request, { phone: "+919840012345", takeoverPref: "own_number" }));
    await expect(page.getByTestId("saved-choice-blocked")).toContainText("Alerts open the chat in the inbox instead.");
  });

  test("a failed features read says so with Try again, and the inbox choice still works", async ({ page, request }) => {
    await stubApi(page, FEATURES, (n) => (n === 1 ? refusal(500, "internal", "Something went wrong. Try again in a moment.") : { status: 200, body: featureList(ownNumberFeature()) }));
    await openTeam(page, await newTeamAccount(request, { phone: "+919840012345" }));
    await expect(takeover(page).getByRole("alert")).toContainText("Couldn't check your plan");
    await expect(choice(page, /In the inbox/)).toBeEnabled();
    await expect(choice(page, /From my own WhatsApp number/)).toBeDisabled();
    await takeover(page).getByRole("button", { name: "Try again" }).click();
    await expect(choice(page, /From my own WhatsApp number/)).toBeEnabled();
  });

  test("a write the database refused is reported, never shown as saved", async ({ page, request }) => {
    await stubApi(page, FEATURES, () => ({ status: 200, body: featureList(ownNumberFeature()) }));
    await openTeam(page, await newTeamAccount(request, { phone: "+919840012345", refused: true }));
    await choice(page, /Ask me each time/).check();
    await takeover(page).getByRole("button", { name: "Save" }).click();
    await expect(takeover(page).getByRole("alert")).toContainText("Couldn't save your choice");
    await expect(toast(page, "Saved how you take over chats")).toHaveCount(0);
  });
});
