import { defineConfig, devices } from "@playwright/test";

// Dashboard and onboarding smoke tests run against a production build (`next build && next start`),
// the same output users get, and the API (backend/) the browser calls. Supabase is replaced by
// tests/e2e/support/mock-supabase.mjs, which speaks the real Auth and PostgREST protocols, so login,
// sessions, bearer-token checks and tenant resolution run through the real code on both sides. Set
// PLAYWRIGHT_BASE_URL (and PLAYWRIGHT_API_URL) to test already running servers instead.
const PORT = 3100;
const MOCK_PORT = 54399;
const API_PORT = 4100;
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;
/** The API, as the browser reaches it (NEXT_PUBLIC_API_URL in the build below). */
export const API_URL = process.env.PLAYWRIGHT_API_URL ?? `http://127.0.0.1:${API_PORT}`;
/**
 * The main server runs with DEV_DASHBOARD_WITHOUT_TENANT=true (the development dashboard for an
 * account with no business). A second `next start` of the same build, with the flag off, keeps the
 * production behaviour under test. Not available when PLAYWRIGHT_BASE_URL points elsewhere.
 */
const FLAG_OFF_PORT = 3101;
export const FLAG_OFF_URL = process.env.PLAYWRIGHT_BASE_URL ? undefined : `http://localhost:${FLAG_OFF_PORT}`;

/** Placeholder service-role key: the mock accepts it for create_trial_tenant and credit_balance only. */
const SERVICE_ROLE_KEY = "e2e-service-role-key";
const supabaseEnv = {
  NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "e2e-anon-key",
};
// Env shared by both app servers: public values only, like Vercel.
// The demo number is a fictional one (a reserved 555-01xx range number): no test ever opens a real chat.
const appEnv = { ...supabaseEnv, NEXT_PUBLIC_API_URL: API_URL, NEXT_PUBLIC_DEMO_WHATSAPP_NUMBER: "15555550100" };
// The API's env. Placeholder server secrets keep serverEnv() valid without a .env.local and stop the
// tests from ever using real ones; they only ever reach the mock. Both app servers may call it.
const apiEnv = {
  ...supabaseEnv,
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
  EMBEDDINGS_API_KEY: "e2e-embeddings-key", // required by the API; the e2e mock never calls the provider
  ANTHROPIC_API_KEY: "e2e-anthropic-key", // required by the API; the e2e tests never call the model
  PORT: String(API_PORT),
  HOST: "127.0.0.1",
  NEXT_PUBLIC_APP_URL: `http://localhost:${PORT}`,
  CORS_ALLOWED_ORIGINS: `http://localhost:${FLAG_OFF_PORT}`,
};
/** Signed in as owner@test.local; written by auth.setup.ts. */
export const OWNER_STATE = "tests/e2e/.auth/owner.json";

const signedIn = { storageState: OWNER_STATE };

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // The three widths the dashboard is checked at. The prototype switches to its mobile layout below
  // 720px and shows the inbox lead panel inline from 1180px.
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    { name: "desktop", dependencies: ["setup"], use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, ...signedIn } },
    { name: "tablet", dependencies: ["setup"], use: { ...devices["Desktop Chrome"], viewport: { width: 820, height: 1180 }, hasTouch: true, ...signedIn } },
    { name: "mobile", dependencies: ["setup"], use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, ...signedIn } },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : [
        {
          command: "node tests/e2e/support/mock-supabase.mjs",
          url: `http://127.0.0.1:${MOCK_PORT}/health`,
          reuseExistingServer: false,
          env: { MOCK_SUPABASE_PORT: String(MOCK_PORT), MOCK_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY },
        },
        {
          command: "pnpm --filter @pakka/backend start",
          url: `${API_URL}/api/health`,
          reuseExistingServer: false,
          env: apiEnv,
        },
        {
          // Always a fresh build: NEXT_PUBLIC_* values are compiled in, and they must point at the mock.
          command: `next build && next start -p ${PORT}`,
          url: baseURL,
          reuseExistingServer: false,
          timeout: 300_000,
          env: { ...appEnv, DEV_DASHBOARD_WITHOUT_TENANT: "true" },
        },
        {
          // Started after the build above finishes (Playwright starts web servers one at a time).
          command: `next start -p ${FLAG_OFF_PORT}`,
          url: FLAG_OFF_URL,
          reuseExistingServer: false,
          env: { ...appEnv, DEV_DASHBOARD_WITHOUT_TENANT: "false" },
        },
      ],
});
