import { appendFileSync } from "node:fs";
import { auditPage, type A11yFinding } from "../support/a11y";
import { expect, SIGNED_OUT, signIn, test } from "../support/app";

// Accessibility audit of every screen on main, at a phone, a tablet and a desktop width. The checks are in support/a11y.ts (DOM rules,
// computed-colour contrast, a Tab walk); they are not axe and not a screen-reader test. Every finding is written to A11Y_REPORT_FILE when
// set, one JSON line per page and width. The test fails only for the rules in PINNED: rules this app has been fixed for and must not
// regress. It runs in the desktop project only; each test sets its own viewport.

const WIDTHS = [390, 820, 1440];
const REPORT = process.env.A11Y_REPORT_FILE;

// CONTRAST IS NOT PINNED, AND IS NOT FIXED. The brand red (#ec3013) is 3.76:1 on the page colour, under the 4.5:1 text needs, and the
// "Needs human" badge, the "AI" label, the avatar, links and primary buttons use it or a similar low-contrast colour. The deeper red
// and green that would fix them are a visible design change that is waiting for design approval (commit 68c0e9d on the local branch
// a11y/contrast-landmarks-headings). Until that lands, contrast findings are only reported to A11Y_REPORT_FILE, and this suite makes
// no claim that the app meets WCAG contrast. Add "contrast" to PINNED in the change that applies the colours.

/** Rules with no remaining finding on any audited screen. A new finding for one of these fails the suite. */
const PINNED = [
  "document-lang",
  "document-title",
  "landmark-main",
  "landmark-nav-name",
  "heading-h1",
  "heading-empty",
  "field-name",
  "control-name",
  "img-alt",
  "link-href",
  "role-button-focus",
  "tabindex-positive",
  "aria-hidden-focus",
  "aria-ref-missing",
  "duplicate-id",
  "dialog-name",
  "focus-visible",
  "focus-reach",
  "zoom-blocked",
];

const TOKEN = "Qx9_k-Q2mP4rT7vB1nL6cD8fH3jW5yA0sE2uI4oG6hM";

const SIGNED_IN: { email: string; paths: string[] }[] = [
  {
    email: "owner@test.local",
    paths: [
      "/dashboard",
      "/dashboard/leads",
      "/dashboard/calendar",
      "/dashboard/knowledge",
      "/dashboard/billing",
      "/dashboard/team",
      "/dashboard/agent",
      "/dashboard/features",
      "/dashboard/whatsapp",
      "/dashboard/templates/new",
      "/dashboard/messages/test",
      "/dashboard/settings/booking",
      "/dashboard/settings/privacy",
      "/dashboard/settings/integrations",
      "/onboarding",
    ],
  },
  { email: "inbox@test.local", paths: ["/dashboard/inbox", "/dashboard/inbox?chat=40000000-0000-0000-0000-000000000002"] },
  {
    email: "wa-platform@test.local",
    paths: ["/dashboard/admin/whatsapp", "/dashboard/admin/billing", "/dashboard/admin/connections", "/dashboard/admin/metrics", "/dashboard/admin/plans"],
  },
];
const SIGNED_OUT_PATHS = ["/login", "/signup", "/forgot-password", "/reset-password", `/invite/${TOKEN}`, `/connect/${TOKEN}`];

/** The mock database has no plans or features tables; give the admin plan editor a plan and a feature so the audit sees its forms, not an error. */
async function stubCatalogue(page: import("@playwright/test").Page) {
  const rows: Record<string, unknown[]> = {
    plans: [{ key: "growth", name: "Growth", price_inr: 2499, monthly_credits: 1500, seats: 5, whatsapp_numbers: 2, feature_keys: ["booking"] }],
    features: [{ key: "booking", name: "Booking in chat", description: "Offers slots and books them.", default_on: true }],
  };
  for (const table of Object.keys(rows)) {
    await page.route(
      (url) => url.pathname === `/rest/v1/${table}`,
      (route) => {
        const req = route.request();
        if (req.method() === "OPTIONS") return route.fallback();
        return route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": req.headers()["origin"] ?? "*" }, body: JSON.stringify(rows[table]) });
      },
    );
  }
}

async function run(page: import("@playwright/test").Page, path: string, width: number): Promise<A11yFinding[]> {
  if (path === "/dashboard/admin/plans") await stubCatalogue(page);
  await page.goto(path);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(400);
  const findings = await auditPage(page);
  if (REPORT) appendFileSync(REPORT, JSON.stringify({ width, path, findings }) + "\n");
  return findings;
}

const pinnedFindings = (findings: A11yFinding[]) => findings.filter((f) => PINNED.includes(f.rule));

for (const target of SIGNED_IN) {
  for (const width of WIDTHS) {
    test(`${target.email} @${width}`, async ({ page }) => {
      test.setTimeout(240_000);
      test.skip(test.info().project.name !== "desktop", "sets its own viewport");
      await page.setViewportSize({ width, height: width < 700 ? 800 : width < 1100 ? 1000 : 900 });
      await page.context().clearCookies();
      await signIn(page, target.email, target.paths[0]);
      await page.waitForURL(/\/dashboard|\/onboarding/);
      for (const path of target.paths) {
        const pinned = pinnedFindings(await run(page, path, width));
        expect.soft(pinned, `${path} @${width}: ${JSON.stringify(pinned)}`).toEqual([]);
      }
    });
  }
}

test.describe("signed-out screens", () => {
  test.use({ storageState: SIGNED_OUT });
  for (const width of WIDTHS) {
    test(`signed-out @${width}`, async ({ page }) => {
      test.setTimeout(240_000);
      test.skip(test.info().project.name !== "desktop", "sets its own viewport");
      await page.setViewportSize({ width, height: width < 700 ? 800 : 900 });
      for (const path of SIGNED_OUT_PATHS) {
        const pinned = pinnedFindings(await run(page, path, width));
        expect.soft(pinned, `${path} @${width}: ${JSON.stringify(pinned)}`).toEqual([]);
      }
    });
  }
});

test("the audit itself catches a missing label and a low-contrast line", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "one project is enough");
  await page.setContent(
    `<!doctype html><html><head></head><body><input><p style="color:#bbb;background:#fff">faint</p><img src="data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=" width="20" height="20"></body></html>`,
  );
  const rules = (await auditPage(page, { tabStops: 3 })).map((f) => f.rule);
  expect(rules).toEqual(expect.arrayContaining(["document-lang", "document-title", "field-name", "contrast", "img-alt", "landmark-main", "heading-h1"]));
});
