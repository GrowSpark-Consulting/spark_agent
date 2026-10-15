import type { APIRequestContext } from "@playwright/test";
import { expect, expectNoHorizontalOverflow, MOCK_SUPABASE_URL, SIGNED_OUT, signIn, test } from "../support/app";
import { refusal, stubApi } from "../support/day5";

// /invite/:token, the team invitation page. GET /api/team/invites/:token is public; accepting needs a signed-in account. The routes are real
// on the API (backend/src/team), but the database behind them is the mock here, so every answer is stood in for with page.route. This proves
// how the page reads each answer and what it sends; it does not prove the invitation functions, seat counting or the email match (the pgTAP
// test, the backend tests and the concurrency script do, and need Docker or real Supabase).

test.use({ storageState: SIGNED_OUT });

const TOKEN = "Qx9_k-Q2mP4rT7vB1nL6cD8fH3jW5yA0sE2uI4oG6hM";
const PREVIEW = /\/api\/team\/invites\/[A-Za-z0-9_-]{43}$/;
const ACCEPT = /\/api\/team\/invites\/[A-Za-z0-9_-]{43}\/accept$/;
const valid = { status: "valid", businessName: "Sunrise Salon", role: "staff", expiresAt: "2099-01-01T10:00:00.000Z" };

async function newAccount(request: APIRequestContext) {
  return (await request.post(`${MOCK_SUPABASE_URL}/__mock/team-account`, { data: { role: "owner" } })).json() as Promise<{ email: string }>;
}

test("a valid invitation says who invited you and as what, and signed out offers sign-in and sign-up that return here", async ({ page }) => {
  const calls = await stubApi(page, PREVIEW, () => ({ status: 200, body: valid }));
  await page.goto(`/invite/${TOKEN}`);
  await expect(page.getByRole("heading", { level: 1, name: "Join Sunrise Salon" })).toBeVisible();
  await expect(page.getByText(/as a staff member/)).toBeVisible();
  // Public and anonymous: no business header, no bearer token.
  expect(calls[0].method).toBe("GET");
  expect(calls[0].tenant).toBeNull();
  expect(calls[0].authorization).toBeNull();
  const back = encodeURIComponent(`/invite/${TOKEN}`);
  await expect(page.getByRole("link", { name: "Sign in to join" })).toHaveAttribute("href", `/login?next=${back}`);
  await expect(page.getByRole("link", { name: "Create an account" })).toHaveAttribute("href", `/signup?next=${back}`);
  await expect(page.getByRole("button", { name: /^Join / })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

test("a link that is not the shape of a token is invalid at once, with no request", async ({ page }) => {
  const calls = await stubApi(page, PREVIEW, () => ({ status: 200, body: valid }));
  await page.goto("/invite/not-a-token");
  await expect(page.getByTestId("invite-invalid")).toContainText("This invitation isn't valid");
  expect(calls).toHaveLength(0);
});

test("an unknown token (404) is invalid, with no way to continue", async ({ page }) => {
  await stubApi(page, PREVIEW, () => refusal(404, "not_found", "This invitation isn't valid anymore."));
  await page.goto(`/invite/${TOKEN}`);
  await expect(page.getByTestId("invite-invalid")).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in to join" })).toHaveCount(0);
});

for (const [status, testId, text] of [
  ["expired", "invite-expired", "This invitation has expired"],
  ["used", "invite-used", "This invitation was already used"],
  ["revoked", "invite-revoked", "This invitation was cancelled"],
] as const) {
  test(`a ${status} invitation says so and offers no way to join`, async ({ page }) => {
    await stubApi(page, PREVIEW, () => ({ status: 200, body: { ...valid, status } }));
    await page.goto(`/invite/${TOKEN}`);
    await expect(page.getByTestId(testId)).toContainText(text);
    await expect(page.getByRole("link", { name: "Create an account" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Join / })).toHaveCount(0);
  });
}

test("a failed read can be tried again", async ({ page }) => {
  await stubApi(page, PREVIEW, (n) => (n === 1 ? refusal(502, "upstream_failed", "Down.") : { status: 200, body: valid }));
  await page.goto(`/invite/${TOKEN}`);
  await expect(page.getByTestId("invite-problem")).toContainText("We couldn't check this invitation");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Join Sunrise Salon" })).toBeVisible();
});

test.describe("signed in", () => {
  test("joining is shown only after the server confirms, then opens the business", async ({ page, request }) => {
    const account = await newAccount(request);
    await stubApi(page, PREVIEW, () => ({ status: 200, body: valid }));
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const accepts = await stubApi(page, ACCEPT, async () => {
      await held;
      return { status: 200, body: { tenantId: "11111111-1111-4111-8111-111111111111", businessName: "Sunrise Salon", role: "staff", alreadyMember: false } };
    });
    // Signing in with next=/invite/… returns here by itself (lib/auth/redirect.ts).
    await signIn(page, account.email, `/invite/${TOKEN}`);
    await expect(page).toHaveURL(`/invite/${TOKEN}`);
    const join = page.getByRole("button", { name: "Join Sunrise Salon" });
    await expect(page.getByText(account.email)).toBeVisible();
    await join.click();
    // Held: nothing says joined yet, and a second press does not send a second request.
    await expect(page.getByRole("button", { name: "Joining…" })).toBeDisabled();
    await expect(page.getByTestId("invite-joined")).toHaveCount(0);
    expect(accepts).toHaveLength(1);
    release();
    await expect(page.getByTestId("invite-joined")).toContainText("You've joined Sunrise Salon");
    expect(accepts).toHaveLength(1);
    expect(accepts[0].method).toBe("POST");
    expect(accepts[0].body).toBeNull();
    expect(accepts[0].authorization).toMatch(/^Bearer /);
    await expect(page.getByRole("button", { name: "Open Sunrise Salon" })).toBeVisible();
  });

  for (const [name, answer, testId, text] of [
    ["a different email", refusal(403, "forbidden", "This invitation was sent to a different email address. Sign in with the address it was sent to."), "invite-failed", "sent to a different email address"],
    ["an invitation that can no longer be used", refusal(404, "not_found", "This invitation isn't valid anymore."), "invite-failed", "isn't valid anymore"],
    ["a business with no free seat", refusal(409, "seat_limit", "Every team seat on your plan is taken."), "invite-failed", "no free team seat"],
  ] as const) {
    test(`${name} is refused plainly and nothing is shown as joined`, async ({ page, request }) => {
      const account = await newAccount(request);
      await stubApi(page, PREVIEW, () => ({ status: 200, body: valid }));
      await stubApi(page, ACCEPT, () => answer);
      await signIn(page, account.email, `/invite/${TOKEN}`);
      await expect(page).toHaveURL(`/invite/${TOKEN}`);
      await page.getByRole("button", { name: "Join Sunrise Salon" }).click();
      await expect(page.getByTestId(testId)).toContainText(text);
      await expect(page.getByTestId("invite-joined")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Use a different account" })).toBeVisible();
    });
  }
});
