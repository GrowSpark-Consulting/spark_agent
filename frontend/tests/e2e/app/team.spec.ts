import type { APIRequestContext, Page, Request } from "@playwright/test";
import { expect, expectNoHorizontalOverflow, mainNav, MOCK_SUPABASE_URL, SIGNED_OUT, signIn, test } from "../support/app";
import { stubApi } from "../support/day5";

// /dashboard/team, first slice: the signed-in member's own WhatsApp alert number
// (memberships.whatsapp_phone), read and updated under RLS as mock-supabase.mjs emulates it (0002
// own_preferences: a member updates only their own row's whatsapp_phone and takeover_pref). Mocked E2E:
// the database is the mock and the app is real, so this doesn't prove the real policy (its own tests do).

type Role = "owner" | "admin" | "staff";
type TeamAccount = { email: string; tenantId: string; userId: string };
type StoredMembership = { tenant_id: string; user_id: string; role: Role; whatsapp_phone: string | null; takeover_pref: string | null };

const PATH = "/dashboard/team";

async function newTeamAccount(request: APIRequestContext, options: { role?: Role; phone?: string; refused?: boolean; readError?: boolean } = {}): Promise<TeamAccount> {
  return (await request.post(`${MOCK_SUPABASE_URL}/__mock/team-account`, { data: options })).json();
}
async function stored(request: APIRequestContext, email: string): Promise<StoredMembership[]> {
  return (await request.get(`${MOCK_SUPABASE_URL}/__mock/memberships?email=${email}`)).json();
}
async function openTeam(page: Page, account: TeamAccount) {
  await signIn(page, account.email, PATH);
  await expect(page.getByRole("heading", { level: 1, name: "Team" })).toBeVisible();
}
/** The browser's writes to memberships, as sent: method, query and body. */
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

const alerts = (page: Page) => page.getByRole("region", { name: "Your WhatsApp alerts" });
const numberField = (page: Page) => alerts(page).getByRole("textbox", { name: "WhatsApp number", exact: true });
const toast = (page: Page, text: string) => page.getByRole("status").filter({ hasText: text });

test.describe("Team · your WhatsApp alert number", () => {
  test.use({ storageState: SIGNED_OUT });

  // The screen also asks GET /api/features for the own-number entitlement (team-takeover.spec.ts covers that); here it gets a plain answer.
  test.beforeEach(async ({ page }) => {
    await stubApi(page, /\/api\/features$/, () => ({
      status: 200,
      body: { plan: { key: "growth", name: "Growth", monthlyCredits: 1500 }, estimatedCreditsPerMonth: 0, groups: [] },
    }));
  });

  test("adds, changes and removes your own number", async ({ page, request }) => {
    const account = await newTeamAccount(request);
    const writes = membershipWrites(page);
    await openTeam(page, account);
    await expect(mainNav(page).getByRole("link", { name: "Team", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(alerts(page)).toContainText("No WhatsApp number yet");
    await expectNoHorizontalOverflow(page);

    // Add: typed with spaces, stored as E.164.
    await alerts(page).getByRole("button", { name: "Add your number" }).click();
    await numberField(page).fill(" +91 98400 12345 ");
    await alerts(page).getByRole("button", { name: "Save number" }).click();
    await expect(toast(page, "Saved your WhatsApp number")).toBeVisible();
    await expect(alerts(page).getByRole("definition")).toHaveText("+919840012345");
    expect((await stored(request, account.email))[0].whatsapp_phone).toBe("+919840012345");

    // Still there after a reload: it came from the database, not the page.
    await page.reload();
    await expect(alerts(page).getByRole("definition")).toHaveText("+919840012345");

    // Change.
    await alerts(page).getByRole("button", { name: "Edit" }).click();
    await expect(numberField(page)).toHaveValue("+919840012345");
    await numberField(page).fill("+447700900123");
    await alerts(page).getByRole("button", { name: "Save number" }).click();
    await expect(alerts(page).getByRole("definition")).toHaveText("+447700900123");

    // Remove: Keep it changes nothing; confirming clears it.
    await alerts(page).getByRole("button", { name: "Remove" }).click();
    await expect(page.getByRole("dialog")).toContainText("Remove your WhatsApp number?");
    await page.getByRole("dialog").getByRole("button", { name: "Keep it" }).click();
    await expect(alerts(page).getByRole("definition")).toHaveText("+447700900123");
    await alerts(page).getByRole("button", { name: "Remove" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove number" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(toast(page, "Removed your WhatsApp number")).toBeVisible();
    await expect(alerts(page)).toContainText("No WhatsApp number yet");
    expect((await stored(request, account.email))[0].whatsapp_phone).toBeNull();

    // Every write named this business and this member, and sent only whatsapp_phone.
    expect(writes.map((w) => w.body)).toEqual([{ whatsapp_phone: "+919840012345" }, { whatsapp_phone: "+447700900123" }, { whatsapp_phone: null }]);
    for (const w of writes) {
      expect(w.method).toBe("PATCH");
      expect(w.query.get("tenant_id")).toBe(`eq.${account.tenantId}`);
      expect(w.query.get("user_id")).toBe(`eq.${account.userId}`);
    }
  });

  test("checks the number before saving, and sends nothing until it's right", async ({ page, request }) => {
    const account = await newTeamAccount(request);
    const writes = membershipWrites(page);
    await openTeam(page, account);
    await alerts(page).getByRole("button", { name: "Add your number" }).click();

    await alerts(page).getByRole("button", { name: "Save number" }).click();
    await expect(alerts(page).getByText("Enter your WhatsApp number")).toBeVisible();
    await numberField(page).fill("98400 12345");
    await alerts(page).getByRole("button", { name: "Save number" }).click();
    await expect(alerts(page).getByText("Enter the number with country code, like +919840012345")).toBeVisible();
    await expect(numberField(page)).toHaveAttribute("aria-invalid", "true");
    expect(writes).toEqual([]);

    // Cancel leaves it as it was.
    await alerts(page).getByRole("button", { name: "Cancel" }).click();
    await expect(alerts(page)).toContainText("No WhatsApp number yet");
    expect(writes).toEqual([]);
    expect((await stored(request, account.email))[0].whatsapp_phone).toBeNull();
  });

  for (const role of ["admin", "staff"] as const) {
    test(`${role === "admin" ? "an admin" : "staff"} set their own number`, async ({ page, request }) => {
      const account = await newTeamAccount(request, { role, phone: "+919840012345" });
      const writes = membershipWrites(page);
      await openTeam(page, account);
      await expect(alerts(page).getByRole("definition")).toHaveText("+919840012345");
      await alerts(page).getByRole("button", { name: "Edit" }).click();
      await numberField(page).fill("+919840054321");
      await alerts(page).getByRole("button", { name: "Save number" }).click();
      await expect(toast(page, "Saved your WhatsApp number")).toBeVisible();
      expect((await stored(request, account.email))[0]).toMatchObject({ role, whatsapp_phone: "+919840054321" });
      expect(writes).toHaveLength(1);
      expect(writes[0].query.get("user_id")).toBe(`eq.${account.userId}`);
      await expectNoHorizontalOverflow(page);
    });
  }

  test("an update the database refused is reported, never shown as saved", async ({ page, request }) => {
    const account = await newTeamAccount(request, { phone: "+919840012345", refused: true });
    await openTeam(page, account);
    await alerts(page).getByRole("button", { name: "Edit" }).click();
    await numberField(page).fill("+919840054321");
    await alerts(page).getByRole("button", { name: "Save number" }).click();
    await expect(alerts(page).getByRole("alert")).toContainText("Couldn't save your number");
    await expect(alerts(page).getByRole("alert")).toContainText("Your number wasn't saved. Refresh and try again.");
    await expect(numberField(page)).toHaveValue("+919840054321");
    await expect(alerts(page).getByRole("button", { name: "Save number" })).toBeEnabled();
    await expect(toast(page, "Saved")).toHaveCount(0);
    expect((await stored(request, account.email))[0].whatsapp_phone).toBe("+919840012345");

    // Removing is refused the same way, inside the dialog.
    await alerts(page).getByRole("button", { name: "Cancel" }).click();
    await alerts(page).getByRole("button", { name: "Remove" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove number" }).click();
    await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Couldn't remove your number");
    await expect(toast(page, "Removed")).toHaveCount(0);
    expect((await stored(request, account.email))[0].whatsapp_phone).toBe("+919840012345");
  });

  test("a failed read shows an error with Try again, without the database's details", async ({ page, request }) => {
    const account = await newTeamAccount(request, { readError: true });
    await openTeam(page, account);
    await expect(alerts(page).getByRole("alert")).toContainText("Couldn't load your number");
    await expect(alerts(page).getByRole("alert")).not.toContainText(/not-a-tenant|unexpected shape/);
    await alerts(page).getByRole("button", { name: "Try again" }).click();
    await expect(alerts(page).getByRole("alert")).toBeVisible();
    await expect(alerts(page).getByRole("button", { name: /^(Add your number|Edit|Remove)$/ })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });
});
