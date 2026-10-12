import { test as base, expect, type Page } from "@playwright/test";
import { mockRealtime } from "./realtime";

/** Password for every account in mock-supabase.mjs. */
export const PASSWORD = "e2e-password-1";

/** Signed-out browser state, for tests that start without a session. */
export const SIGNED_OUT = { cookies: [], origins: [] };

/**
 * `test` with a console guard: any console error or page error fails the test. The one exception is
 * the browser's own "Failed to load resource" line for our API routes, which tests trigger on
 * purpose to check error states (the response is asserted instead).
 */
export const test = base.extend<{ consoleErrors: string[]; quietRealtime: void }>({
  // Screens subscribe to Realtime for the tables the database publishes (lib/realtime/published-tables.ts: inbox, leads, calendar...).
  // The mock Supabase has no socket, so without this every such page logs a failed WebSocket handshake and the console guard below
  // fails the test. This answers joins and does nothing else; a test that needs to push a change (or refuse the join) calls
  // mockRealtime itself, which is registered later and so wins.
  quietRealtime: [
    async ({ page }, use) => {
      await mockRealtime(page);
      await use();
    },
    { auto: true },
  ],
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("console", (m) => {
        if (m.type() !== "error") return;
        if (m.text().startsWith("Failed to load resource") && m.location().url.includes("/api/")) return;
        errors.push(m.text());
      });
      page.on("pageerror", (e) => errors.push(String(e)));
      await use(errors);
      expect(errors, "console errors").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export async function signIn(page: Page, email: string, next?: string) {
  await page.goto(next ? `/login?next=${encodeURIComponent(next)}` : "/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/**
 * The signed-in user's access token, read from the Supabase session cookie the way the browser client
 * reads it (possibly split into .0, .1… chunks, base64url with a "base64-" prefix). For calling the API
 * directly, as the app's lib/api/client.ts does.
 */
export async function accessToken(page: Page): Promise<string> {
  const chunks = (await page.context().cookies())
    .filter((c) => /^sb-.+-auth-token(\.\d+)?$/.test(c.name))
    .sort((a, b) => Number(a.name.split(".")[1] ?? -1) - Number(b.name.split(".")[1] ?? -1));
  let raw = chunks.map((c) => c.value).join("");
  if (raw.startsWith("base64-")) raw = Buffer.from(raw.slice("base64-".length), "base64url").toString();
  const token = (JSON.parse(raw) as { access_token?: string }).access_token;
  if (!token) throw new Error("no Supabase session cookie: sign in first");
  return token;
}

/** Headers for an API call as the signed-in user. */
export async function asUser(page: Page): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await accessToken(page)}` };
}

/** Mock Supabase (tests/e2e/support/mock-supabase.mjs), for reading the emails it "sends". */
export const MOCK_SUPABASE_URL = "http://127.0.0.1:54399";

/** An address no other test (or project) uses. `@confirm.test.local` needs email confirmation. */
export function uniqueEmail(domain: "test.local" | "confirm.test.local" = "test.local") {
  return `new-${crypto.randomUUID()}@${domain}`;
}

/** Fills in and submits the signup form. */
export async function signUp(page: Page, email: string, password = PASSWORD, confirm = password) {
  await page.goto("/signup");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(confirm);
  await page.getByRole("button", { name: "Sign up", exact: true }).click();
}

export async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "page is wider than the viewport").toBeLessThanOrEqual(0);
}

/** The app shell's main navigation (sidebar on desktop, scrolling row on phones). */
export const mainNav = (page: Page) => page.getByRole("navigation", { name: "Main" });

/** Our ErrorState (role="alert"), not Next.js's route announcer, which also has role="alert". */
export const appAlert = (page: Page) => page.locator('[role="alert"].app-state');
