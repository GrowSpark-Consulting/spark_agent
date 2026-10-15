import type { AdminConnection } from "@pakka/types";
import { expect, expectNoHorizontalOverflow, test } from "../support/app";
import { refusal, stubApi } from "../support/day5";

// /dashboard/admin/connections: the admin list is Dev 1's route (GET /api/admin/whatsapp/connections, backend/src/admin/connections.ts) and
// needs a platform admin, so it is stood in for with page.route. The rows are typed as the shared AdminConnection contract. These tests prove
// what the screen sends, how it words each status and each missing field, and that a refusal for a non-admin shows no data. They do not prove
// the platform-admin check or the real route.

const LIST = /\/api\/admin\/whatsapp\/connections$/;

const row = (over: Partial<AdminConnection> = {}): AdminConnection => ({
  id: "c1",
  tenantId: "t1",
  tenantName: "Skyline Homes",
  method: "embedded_signup",
  status: "active",
  displayPhone: "+91 98765 43210",
  verifiedName: "Skyline Homes",
  coexistence: false,
  qualityRating: "GREEN",
  messagingLimit: "TIER_1K",
  tokenExpiresAt: null,
  lastCheck: {
    ranAt: "2026-10-11T08:00:00.000Z",
    overall: "pass",
    checks: [
      { key: "token_permissions", status: "pass", message: "Access is fine." },
      { key: "webhook_subscribed", status: "pass", message: null },
    ],
  },
  createdAt: "2026-10-10T08:00:00.000Z",
  updatedAt: "2026-10-11T08:00:00.000Z",
  ...over,
});

test.describe("Admin: WhatsApp connections", () => {
  test("lists a connection with its business, method, status, number and each check, sending one read and nothing else", async ({ page }) => {
    const reads = await stubApi(page, LIST, () => ({ status: 200, body: [row()] }));
    await page.goto("/dashboard/admin/connections");
    const r = page.getByTestId("connection-row");
    await expect(r).toHaveCount(1);
    await expect(r.getByTestId("connection-business")).toHaveText("Skyline Homes");
    await expect(r.getByTestId("connection-status")).toHaveText("Connected");
    await expect(r.getByTestId("connection-method")).toHaveText("Facebook sign-up");
    await expect(r.getByTestId("connection-phone")).toHaveText("+91 98765 43210");
    await expect(r.getByTestId("connection-check")).toContainText("All 2 checks passed.");
    await expect(r.getByTestId("check-item")).toHaveCount(2);
    await expect(r.getByTestId("check-item").first()).toContainText("Access and permissions");
    await expect(r.getByTestId("check-item").first()).toContainText("Access is fine.");
    // read only: no buttons on a row
    await expect(r.getByRole("button")).toHaveCount(0);
    expect(reads).toHaveLength(1);
    expect(reads[0].method).toBe("GET");
    expect(reads[0].tenant).toBeNull();
    expect(reads[0].authorization).toMatch(/^Bearer /);
    await expectNoHorizontalOverflow(page);
  });

  test("handles every status, null fields and a connection never checked, without inventing a number or a health claim", async ({ page }) => {
    await stubApi(page, LIST, () => ({
      status: 200,
      body: [
        row({ id: "a", tenantName: "Failed Co", status: "failed", lastCheck: { ranAt: "2026-10-11T08:00:00.000Z", overall: "fail", checks: [{ key: "webhook_subscribed", status: "fail", message: "Not subscribed." }] } }),
        row({ id: "b", tenantName: "Gone Co", status: "disconnected", displayPhone: null, verifiedName: null, qualityRating: null, messagingLimit: null, lastCheck: null }),
        row({ id: "c", tenantName: "Waiting Co", status: "pending", displayPhone: null, lastCheck: null }),
        row({ id: "d", tenantName: "Checking Co", status: "validating", lastCheck: null }),
        row({ id: "e", tenantName: "", status: "active", lastCheck: null }),
      ],
    }));
    await page.goto("/dashboard/admin/connections");
    const of = (name: string) => page.getByTestId("connection-row").filter({ hasText: name });

    await expect(of("Failed Co").getByTestId("connection-status")).toHaveText("Failed");
    await expect(of("Failed Co").getByTestId("check-item")).toContainText("Not subscribed.");
    await expect(of("Failed Co").getByTestId("connection-check")).toContainText("At least one check failed");

    const gone = of("Gone Co");
    await expect(gone.getByTestId("connection-status")).toHaveText("Disconnected");
    await expect(gone.getByTestId("connection-phone")).toHaveText("Not read from Meta yet");
    await expect(gone.getByTestId("connection-check")).toContainText("Not checked yet");
    await expect(gone.getByTestId("connection-check")).toHaveAttribute("data-overall", "none");
    await expect(gone.getByTestId("check-item")).toHaveCount(0);
    await expect(gone).not.toContainText("passed");

    await expect(of("Waiting Co").getByTestId("connection-status")).toHaveText("Connecting");
    await expect(of("Checking Co").getByTestId("connection-status")).toHaveText("Checking");
    await expect(page.getByTestId("connection-row").filter({ hasText: "Unnamed business" })).toHaveCount(1);
    await expectNoHorizontalOverflow(page);
  });

  test("labels our platform number as ours", async ({ page }) => {
    await stubApi(page, LIST, () => ({ status: 200, body: [row({ method: "platform", tenantName: "Spark Agent front desk" })] }));
    await page.goto("/dashboard/admin/connections");
    const r = page.getByTestId("connection-row");
    await expect(r.getByTestId("connection-method")).toHaveText("Spark Agent platform number");
    await expect(r).toContainText("ours, not the business's own number");
  });

  test("an empty list says so", async ({ page }) => {
    await stubApi(page, LIST, () => ({ status: 200, body: [] }));
    await page.goto("/dashboard/admin/connections");
    await expect(page.getByTestId("no-connections")).toBeVisible();
    await expect(page.getByTestId("connection-row")).toHaveCount(0);
  });

  test("says it is loading, with no rows and no empty message, until the list arrives", async ({ page }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    await stubApi(page, LIST, async () => (await gate, { status: 200, body: [row()] }));
    await page.goto("/dashboard/admin/connections");
    await expect(page.getByText("Loading connections…")).toBeVisible();
    await expect(page.getByTestId("connection-row")).toHaveCount(0);
    await expect(page.getByTestId("no-connections")).toHaveCount(0);
    release();
    await expect(page.getByTestId("connection-row")).toHaveCount(1);
  });

  test("a refusal for someone off the platform-admin list shows that and no data", async ({ page }) => {
    await stubApi(page, LIST, () => refusal(403, "forbidden", "not a platform admin"));
    await page.goto("/dashboard/admin/connections");
    const error = page.getByTestId("admin-error");
    await expect(error).toContainText("Only the Spark Agent team can see this.");
    await expect(error).toHaveAttribute("data-code", "forbidden");
    await expect(error.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await expect(page.getByTestId("connection-row")).toHaveCount(0);
    await expect(page.getByTestId("no-connections")).toHaveCount(0);
  });

  test("a failed request says so and Try again reads it once more", async ({ page }) => {
    const reads = await stubApi(page, LIST, (n) => (n === 1 ? refusal(500, "internal", "boom") : { status: 200, body: [row()] }));
    await page.goto("/dashboard/admin/connections");
    const error = page.getByTestId("admin-error");
    await expect(error).toBeVisible();
    await expect(page.getByTestId("no-connections")).toHaveCount(0);
    await error.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("connection-row")).toHaveCount(1);
    expect(reads).toHaveLength(2);
  });

  test("an answer that is not the contract's shape is refused, not half drawn", async ({ page }) => {
    await stubApi(page, LIST, () => ({ status: 200, body: [{ id: "c1", status: "paused" }] }));
    await page.goto("/dashboard/admin/connections");
    await expect(page.getByTestId("admin-error")).toBeVisible();
    await expect(page.getByTestId("connection-row")).toHaveCount(0);
  });

  test("a list at the server's cap of 500 says older ones are not shown", async ({ page }) => {
    await stubApi(page, LIST, () => ({ status: 200, body: Array.from({ length: 500 }, (_, i) => row({ id: `c${i}`, tenantName: `Business ${i}` })) }));
    await page.goto("/dashboard/admin/connections");
    await expect(page.getByTestId("connections-count")).toContainText("Only the newest 500 are listed");
    await expect(page.getByTestId("connection-row")).toHaveCount(500);
  });
});
