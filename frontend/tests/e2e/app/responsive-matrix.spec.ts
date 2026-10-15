import { appendFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, SIGNED_OUT, signIn, test } from "../support/app";

// Responsive audit: every signed-in and sign-in screen at ten widths. For each page it measures, in the browser, what a person
// would notice: the page scrolling sideways, an element sticking out of the viewport outside a scroller of its own, a text
// control or icon-only button without a name, and (touch widths) a control too small to hit. Findings are reported through
// REPORT_FILE when set and fail the test only for page-level horizontal overflow, which the app promises never to have.
// It runs in the desktop project only: each test sets its own viewport.

const WIDTHS = [320, 360, 375, 393, 430, 600, 768, 1024, 1280, 1440];
const REPORT = process.env.RESPONSIVE_REPORT_FILE;

interface Target {
  email: string;
  paths: string[];
}

const TARGETS: Target[] = [
  {
    email: "owner@test.local",
    paths: [
      "/dashboard",
      "/dashboard/leads",
      "/dashboard/calendar",
      "/dashboard/knowledge",
      "/dashboard/billing",
      "/dashboard/team",
      "/dashboard/features",
      "/dashboard/whatsapp",
      "/dashboard/templates/new",
      "/dashboard/messages/test",
      "/dashboard/settings/booking",
      "/dashboard/settings/privacy",
      "/dashboard/preview",
      "/onboarding",
    ],
  },
  { email: "inbox@test.local", paths: ["/dashboard/inbox", "/dashboard/inbox?chat=40000000-0000-0000-0000-000000000002"] },
  { email: "wa-platform@test.local", paths: ["/dashboard/admin/whatsapp", "/dashboard/admin/billing", "/dashboard/admin/connections"] },
];

async function audit(page: Page, touch: boolean) {
  return page.evaluate((touch) => {
    const vw = document.documentElement.clientWidth;
    const out = {
      pageOverflow: document.documentElement.scrollWidth - vw,
      clipped: [] as string[],
      unnamed: [] as string[],
      small: [] as string[],
      textOverflow: [] as string[],
    };
    const describe = (el: Element) => {
      const t = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 30);
      const c = typeof el.className === "string" ? el.className.split(" ").slice(0, 2).join(".") : "";
      return `${el.tagName.toLowerCase()}${c ? "." + c : ""}${t ? ` "${t}"` : ""}`;
    };
    const inOwnScroller = (el: Element) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX;
        if ((o === "auto" || o === "scroll" || o === "hidden") && p.scrollWidth > p.clientWidth + 1) return true;
        if (o === "hidden" || o === "auto" || o === "scroll") {
          const r = p.getBoundingClientRect();
          if (r.right <= vw + 1 && r.left >= -1) return true;
        }
      }
      return false;
    };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    for (const el of document.querySelectorAll("body *")) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if ((r.right > vw + 1 || r.left < -1) && !inOwnScroller(el) && getComputedStyle(el).position !== "fixed") {
        if (out.clipped.length < 8) out.clipped.push(`${describe(el)} [${Math.round(r.left)}..${Math.round(r.right)}]`);
      }
      const tag = el.tagName;
      if (tag === "BUTTON" || tag === "A" || tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
        const he = el as HTMLElement;
        if (tag === "INPUT" && ["hidden", "radio", "checkbox"].includes((el as HTMLInputElement).type)) {
          /* visually hidden segmented inputs: their label is the target */
        } else {
          const name = (he.getAttribute("aria-label") ?? "") || (he.getAttribute("aria-labelledby") ? "x" : "") || he.innerText?.trim() || (el as HTMLInputElement).labels?.[0]?.textContent?.trim() || he.getAttribute("title") || "";
          if (!name && out.unnamed.length < 6) out.unnamed.push(describe(el));
          if (touch && (r.height < 36 || (tag !== "A" && r.width < 36)) && out.small.length < 8) out.small.push(`${describe(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
      }
      if (el.children.length === 0 && el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX === "visible" && r.width > 0 && out.textOverflow.length < 5) {
        out.textOverflow.push(describe(el));
      }
    }
    return out;
  }, touch);
}

for (const target of TARGETS) {
  for (const width of WIDTHS) {
    test(`${target.email} @${width}`, async ({ page }) => {
      test.setTimeout(180_000);
      test.skip(test.info().project.name !== "desktop", "sets its own viewport");
      const height = width < 700 ? 800 : width < 1100 ? 1000 : 900;
      await page.setViewportSize({ width, height });
      await page.context().clearCookies();
      await signIn(page, target.email, target.paths[0]);
      await page.waitForURL(/\/dashboard|\/onboarding/);
      for (const path of target.paths) {
        await page.goto(path);
        await page.waitForLoadState("networkidle").catch(() => {});
        await page.waitForTimeout(400);
        const r = await audit(page, width < 1024);
        const line = JSON.stringify({ width, path, ...r });
        if (REPORT) appendFileSync(REPORT, line + "\n");
        expect.soft(r.pageOverflow, `${path} @${width} page is wider than the viewport`).toBeLessThanOrEqual(0);
      }
    });
  }
}

test.describe("signed-out screens", () => {
  test.use({ storageState: SIGNED_OUT });
  for (const width of WIDTHS) {
    test(`auth screens @${width}`, async ({ page }) => {
      test.skip(test.info().project.name !== "desktop", "sets its own viewport");
      await page.setViewportSize({ width, height: 800 });
      for (const path of ["/login", "/signup", "/forgot-password", "/reset-password"]) {
        await page.goto(path);
        await page.waitForLoadState("networkidle").catch(() => {});
        const r = await audit(page, width < 1024);
        if (REPORT) appendFileSync(REPORT, JSON.stringify({ width, path, ...r }) + "\n");
        expect.soft(r.pageOverflow, `${path} @${width}`).toBeLessThanOrEqual(0);
      }
    });
  }
});
