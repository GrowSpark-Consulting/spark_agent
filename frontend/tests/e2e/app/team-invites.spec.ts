import type { APIRequestContext, Page } from "@playwright/test";
import { expect, expectNoHorizontalOverflow, MOCK_SUPABASE_URL, SIGNED_OUT, signIn, test } from "../support/app";
import { refusal, stubApi, type ApiAnswer, type ApiCall } from "../support/day5";

// /dashboard/team: members, seats and invitations. The routes are real on the API (backend/src/team) but their database is the mock here, so
// every answer is stood in for with page.route. This proves what the screen shows for each role and each answer and what it sends; the
// authorisation matrix, seat counting and tokens are proved by the backend tests and the pgTAP test (Docker), not here.

test.use({ storageState: SIGNED_OUT });

const TEAM = /\/api\/team$/;
const INVITE = /\/api\/team\/invite$/;
const RESEND = /\/api\/team\/invites\/[^/]+\/resend$/;
const CANCEL = /\/api\/team\/invites\/[^/]+\/cancel$/;
const URL_ONE = "https://app.example.com/invite/Aa1_Aa1_Aa1_Aa1_Aa1_Aa1_Aa1_Aa1_Aa1_Aa1_Aa1";
const URL_TWO = "https://app.example.com/invite/Bb2_Bb2_Bb2_Bb2_Bb2_Bb2_Bb2_Bb2_Bb2_Bb2_Bb2";

type Role = "owner" | "admin" | "staff";
const invite = (over: Record<string, unknown> = {}) => ({
  id: "i1", email: "asha@example.com", name: "Asha", role: "staff", createdAt: "2026-10-15T10:00:00.000Z", expiresAt: "2099-01-01T10:00:00.000Z", expired: false, ...over,
});
const overview = (role: Role, over: Record<string, unknown> = {}) => ({
  viewerRole: role,
  inviteRoles: role === "owner" ? ["admin", "staff"] : role === "admin" ? ["staff"] : [],
  seats: { used: 2, members: 1, pending: 1, limit: 5, planName: "Growth" },
  members: [{ userId: "u1", role, name: null, email: role === "staff" ? null : "me@example.com", you: true }],
  invites: role === "staff" ? [] : [invite()],
  ...over,
});

async function openTeam(page: Page, request: APIRequestContext, role: Role, team: (n: number, call: ApiCall) => ApiAnswer) {
  const account = (await (await request.post(`${MOCK_SUPABASE_URL}/__mock/team-account`, { data: { role } })).json()) as { email: string };
  await stubApi(page, /\/api\/features$/, () => ({ status: 200, body: { plan: { key: "growth", name: "Growth", monthlyCredits: 1500 }, estimatedCreditsPerMonth: 0, groups: [] } }));
  const calls = await stubApi(page, TEAM, team);
  await signIn(page, account.email, "/dashboard/team");
  await expect(page.getByRole("heading", { level: 2, name: "Team members" })).toBeVisible();
  return calls;
}

const form = (page: Page) => page.getByRole("form", { name: "Invite a teammate" });

test("an owner sees seats including the pending invitation, may pick admin or staff, and gets the link once", async ({ page, request, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openTeam(page, request, "owner", () => ({ status: 200, body: overview("owner") }));
  await expect(page.getByTestId("seat-summary")).toContainText("2 of 5 seats used (1 member, 1 invited)");
  await expect(page.getByRole("list", { name: "Pending invitations" })).toContainText("asha@example.com");
  await expect(form(page).getByRole("combobox", { name: "Role" }).locator("option")).toHaveText(["Choose a role", "Admin", "Staff"]);

  const sent = await stubApi(page, INVITE, () => ({ status: 201, body: { invite: invite({ id: "i2", name: "Ben", email: "ben@example.com", role: "admin" }), url: URL_ONE } }));
  await form(page).getByLabel("Name").fill("  Ben ");
  await form(page).getByLabel("Email").fill(" Ben@Example.com ");
  await form(page).getByRole("combobox", { name: "Role" }).selectOption("admin");
  await form(page).getByRole("button", { name: "Make invitation link" }).click();

  const panel = page.getByTestId("invite-link-panel");
  await expect(panel).toContainText("Invitation link for Ben");
  await expect(panel).toContainText("We haven't emailed anyone");
  await expect(panel.getByRole("textbox", { name: "Invitation link" })).toHaveValue(URL_ONE);
  expect(sent[0].body).toEqual({ name: "Ben", email: "ben@example.com", role: "admin" });
  expect(sent[0].tenant).not.toBeNull();
  await panel.getByRole("button", { name: "Copy link" }).click();
  await expect(panel.getByText("Link copied.")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(URL_ONE);

  // Done clears it, and nothing on the page can show it again; a reload has no link either.
  await panel.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("invite-link-panel")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { level: 2, name: "Team members" })).toBeVisible();
  await expect(page.getByText(URL_ONE)).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

test("an admin can invite staff only, and staff see no invitations and no form", async ({ page, request }) => {
  await openTeam(page, request, "admin", () => ({ status: 200, body: overview("admin") }));
  await expect(form(page).getByRole("combobox", { name: "Role" }).locator("option")).toHaveText(["Staff"]);
  await expect(form(page).getByRole("combobox", { name: "Role" })).toHaveValue("staff");

  const staffPage = await page.context().newPage();
  await openTeam(staffPage, request, "staff", () => ({ status: 200, body: overview("staff") }));
  await expect(form(staffPage)).toHaveCount(0);
  await expect(staffPage.getByText("Only an owner or admin can invite people.")).toBeVisible();
  await expect(staffPage.getByRole("list", { name: "Pending invitations" })).toHaveCount(0);
  await expect(staffPage.getByText("me@example.com")).toHaveCount(0);
});

test("the form checks the fields before it sends anything", async ({ page, request }) => {
  await openTeam(page, request, "owner", () => ({ status: 200, body: overview("owner") }));
  const sent = await stubApi(page, INVITE, () => ({ status: 201, body: { invite: invite(), url: URL_ONE } }));
  await form(page).getByRole("button", { name: "Make invitation link" }).click();
  await expect(form(page).getByText("Enter their name.")).toBeVisible();
  await expect(form(page).getByText("Enter their email address.")).toBeVisible();
  await expect(form(page).getByText("Choose a role.")).toBeVisible();
  await form(page).getByLabel("Name").fill("Ben");
  await form(page).getByLabel("Email").fill("not-an-email");
  await form(page).getByRole("button", { name: "Make invitation link" }).click();
  await expect(form(page).getByText("Enter a valid email address.")).toBeVisible();
  expect(sent).toHaveLength(0);
});

test("a full team says so with the way out, a duplicate lands on the email field, and a 403 is shown", async ({ page, request }) => {
  await openTeam(page, request, "owner", () => ({ status: 200, body: overview("owner") }));
  const answers: ApiAnswer[] = [
    refusal(409, "seat_limit", "Every team seat on your plan is taken, counting people already invited. Upgrade to add more."),
    { status: 409, body: { error: { code: "conflict", message: "That email already has a pending invitation.", fields: { email: "That email already has a pending invitation." } } } },
    refusal(403, "forbidden", "Admins can invite staff only. Ask an owner to invite an admin."),
  ];
  await stubApi(page, INVITE, (n) => answers[n - 1]);
  await form(page).getByLabel("Name").fill("Ben");
  await form(page).getByLabel("Email").fill("ben@example.com");
  await form(page).getByRole("combobox", { name: "Role" }).selectOption("staff");
  const submit = form(page).getByRole("button", { name: "Make invitation link" });

  await submit.click();
  await expect(form(page).getByRole("alert")).toContainText("No team seats left");
  await expect(form(page).getByRole("link", { name: "See plans" })).toHaveAttribute("href", "/dashboard/billing");
  await submit.click();
  await expect(form(page).getByText("That email already has a pending invitation.").first()).toBeVisible();
  await submit.click();
  await expect(form(page).getByRole("alert")).toContainText("Admins can invite staff only");
  await expect(page.getByTestId("invite-link-panel")).toHaveCount(0);
});

test("a new link replaces the old one, shows what is left, and the daily limit is explained", async ({ page, request }) => {
  await openTeam(page, request, "owner", () => ({ status: 200, body: overview("owner") }));
  const answers: ApiAnswer[] = [
    { status: 200, body: { invite: invite(), url: URL_TWO, resendsLeft: 4 } },
    refusal(429, "rate_limited", "This invitation was already sent 5 times in the last day. Try again tomorrow."),
  ];
  const calls = await stubApi(page, RESEND, (n) => answers[n - 1]);
  const row = page.getByRole("list", { name: "Pending invitations" }).getByRole("listitem");
  await row.getByRole("button", { name: "New link" }).click();
  const panel = page.getByTestId("invite-link-panel");
  await expect(panel.getByRole("textbox", { name: "Invitation link" })).toHaveValue(URL_TWO);
  await expect(panel).toContainText("4 new links left today");
  expect(calls[0].method).toBe("POST");
  expect(calls[0].body).toBeNull();
  await row.getByRole("button", { name: "New link" }).click();
  await expect(row.getByRole("alert")).toContainText("Try again tomorrow");
});

test("cancelling asks first, then removes the invitation from the list", async ({ page, request }) => {
  let cancelled = false;
  await openTeam(page, request, "owner", () => ({ status: 200, body: overview("owner", cancelled ? { invites: [], seats: { used: 1, members: 1, pending: 0, limit: 5, planName: "Growth" } } : {}) }));
  const calls = await stubApi(page, CANCEL, () => {
    cancelled = true;
    return { status: 204, body: null };
  });
  await page.getByRole("list", { name: "Pending invitations" }).getByRole("button", { name: "Cancel" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Cancel the invitation for Asha?");
  expect(calls).toHaveLength(0);
  await dialog.getByRole("button", { name: "Cancel invitation" }).click();
  await expect(page.getByRole("list", { name: "Pending invitations" })).toHaveCount(0);
  await expect(page.getByTestId("seat-summary")).toContainText("1 of 5 seats used (1 member)");
  expect(calls).toHaveLength(1);
});

test("an expired invitation is marked as holding no seat", async ({ page, request }) => {
  await openTeam(page, request, "owner", () => ({
    status: 200,
    body: overview("owner", { invites: [invite({ expired: true, expiresAt: "2026-10-14T10:00:00.000Z" })], seats: { used: 1, members: 1, pending: 0, limit: 5, planName: "Growth" } }),
  }));
  await expect(page.getByRole("list", { name: "Pending invitations" })).toContainText("Expired 14 Oct");
  await expect(page.getByRole("list", { name: "Pending invitations" })).toContainText("no longer holds a seat");
});

test("a failed read shows the error with a retry, and the alert-number section still works", async ({ page, request }) => {
  await openTeam(page, request, "owner", (n) => (n === 1 ? refusal(502, "upstream_failed", "Down.") : { status: 200, body: overview("owner") }));
  await expect(page.getByText("Couldn't load your team")).toBeVisible();
  await expect(page.getByRole("region", { name: "Your WhatsApp alerts" })).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).first().click();
  await expect(page.getByTestId("seat-summary")).toBeVisible();
});
