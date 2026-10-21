import type { Page } from "@playwright/test";
import { expect, expectNoHorizontalOverflow, MOCK_SUPABASE_URL, SIGNED_OUT, signIn, test } from "../support/app";
import { mockRealtime } from "../support/realtime";

// Photos and documents in the inbox (features/inbox/stored-media.tsx, media-url.ts). A message row with `media.path` is pushed over the Realtime stand-in,
// and Supabase Storage's `createSignedUrl` is answered with page.route, so these tests show what the screen asks for and draws: which path it signs (only one
// of this business and chat), that it signs once however often the chat is redrawn, and what it says when signing fails. They do NOT show that Storage
// applies the 0047 policy or that a real signed link opens a real file: that needs staging with a stored file (and `pnpm db:test` for the policy).

const INBOX_TENANT = "10000000-0000-0000-0000-000000000004";
const OTHER_TENANT = "10000000-0000-0000-0000-0000000000ff";
const cid = (n: number) => `40000000-0000-0000-0000-00000000000${n}`;
const mid = (n: number) => `41000000-0000-0000-0000-0000000009${String(n).padStart(2, "0")}`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

type Sign = { path: string; authorization: string | null };

/** Answers Storage's sign call (POST) with a signed path and the signed link itself (GET) with a one-pixel picture. Returns the sign calls. */
async function stubStorage(page: Page, { failures = 0 }: { failures?: number } = {}) {
  const signs: Sign[] = [];
  const fetched: string[] = [];
  let failed = 0;
  await page.route(/\/storage\/v1\/object\/sign\/message-media\//, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fallback();
    const cors = { "access-control-allow-origin": req.headers()["origin"] ?? "*" };
    if (req.method() === "POST") {
      const path = decodeURIComponent(new URL(req.url()).pathname.split("/object/sign/message-media/")[1]);
      signs.push({ path, authorization: req.headers()["authorization"] ?? null });
      if (failed < failures) {
        failed += 1;
        return route.fulfill({ status: 500, contentType: "application/json", headers: cors, body: JSON.stringify({ message: "boom" }) });
      }
      return route.fulfill({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify({ signedURL: `/object/sign/message-media/${path}?token=signed-${signs.length}` }) });
    }
    fetched.push(req.url());
    return route.fulfill({ status: 200, contentType: "image/png", headers: cors, body: PNG });
  });
  return { signs, fetched };
}

async function openChat(page: Page) {
  const realtime = await mockRealtime(page);
  await signIn(page, "inbox@test.local", "/dashboard/inbox");
  await page.getByTestId("inbox").getByRole("button", { name: /Lakshmi V/ }).click();
  await expect(page.getByRole("log")).toContainText("Visit ku varen");
  await expect.poll(() => realtime.joins.length).toBe(1);
  return realtime;
}

let tick = 0;
const row = (n: number, kind: "image" | "document" | "audio", media: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  id: mid(n),
  tenant_id: INBOX_TENANT,
  conversation_id: cid(3),
  direction: "in",
  sender: "customer",
  kind,
  body: null,
  media,
  meta: {},
  template_name: null,
  delivery_status: null,
  created_at: new Date(Date.now() + ++tick * 1000).toISOString(),
  ...over,
});
const pathFor = (n: number, ext: string, tenant = INBOX_TENANT, chat = cid(3)) => `${tenant}/${chat}/${mid(n)}.${ext}`;

test.describe("Inbox · stored media", () => {
  test.use({ storageState: SIGNED_OUT });

  test("a stored photo is signed once, as the member, for its own path, and drawn from the signed link", async ({ page }) => {
    const { signs, fetched } = await stubStorage(page);
    const realtime = await openChat(page);
    const path = pathFor(1, "jpg");
    realtime.push("messages", "INSERT", row(1, "image", { id: "media-1", mime: "image/jpeg", path, size: 68, storedAt: "2026-10-15T08:00:00Z" }));

    const image = page.getByRole("log").getByRole("img", { name: "Photo" });
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute("src", new RegExp(`^${MOCK_SUPABASE_URL}/storage/v1/object/sign/message-media/.+\\?token=signed-1$`));
    await expect.poll(() => fetched.length).toBeGreaterThan(0);
    expect(signs).toHaveLength(1);
    expect(signs[0].path).toBe(path);
    expect(signs[0].authorization).toMatch(/^Bearer /);
    // The path is not text on the page and not a link of its own; the only link is the signed one, opened safely.
    await expect(page.getByRole("log")).not.toContainText(path);
    const link = page.getByTestId("media-image-link");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);
    await expect(link).toHaveAttribute("href", /token=signed-1$/);
    await expect(page.locator(`a[href="${path}"], a[href="/${path}"], img[src="${path}"]`)).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });

  test("redrawing the chat does not ask for another link", async ({ page }) => {
    const { signs } = await stubStorage(page);
    const realtime = await openChat(page);
    realtime.push("messages", "INSERT", row(2, "image", { id: "media-2", mime: "image/png", path: pathFor(2, "png") }));
    await expect(page.getByRole("log").getByRole("img", { name: "Photo" })).toBeVisible();
    // More messages arrive and the chat redraws each time: the photo is not signed again.
    realtime.push("messages", "INSERT", { ...row(3, "image", {}, { kind: null, body: "Is this the one?", media: null }) });
    await expect(page.getByRole("log")).toContainText("Is this the one?");
    realtime.push("messages", "INSERT", { ...row(13, "image", {}, { kind: null, body: "Or this one?", media: null }) });
    await expect(page.getByRole("log")).toContainText("Or this one?");
    await expect(page.getByRole("log").getByRole("img", { name: "Photo" })).toBeVisible();
    expect(signs).toHaveLength(1);
  });

  test("a stored document is a link on the signed address, not a picture", async ({ page }) => {
    const { signs } = await stubStorage(page);
    const realtime = await openChat(page);
    const path = pathFor(4, "pdf");
    realtime.push("messages", "INSERT", row(4, "document", { id: "media-4", mime: "application/pdf", path, name: "Brochure.pdf" }));
    const link = page.getByTestId("media-document-link");
    await expect(link).toHaveText("Open Brochure.pdf");
    await expect(link).toHaveAttribute("href", /token=signed-1$/);
    await expect(link).toHaveAttribute("rel", /noopener/);
    await expect(page.getByRole("log").locator("img")).toHaveCount(0);
    expect(signs[0].path).toBe(path);
  });

  test("when signing fails it says so, shows nothing broken, and Try again makes a link", async ({ page }) => {
    const { signs } = await stubStorage(page, { failures: 1 });
    const realtime = await openChat(page);
    realtime.push("messages", "INSERT", row(5, "image", { id: "media-5", mime: "image/jpeg", path: pathFor(5, "jpg") }));
    await expect(page.getByTestId("media-failed")).toContainText("Couldn't load this file.");
    await expect(page.getByRole("log").locator("img")).toHaveCount(0);
    await expect(page.getByRole("log")).not.toContainText("boom");
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("log").getByRole("img", { name: "Photo" })).toBeVisible();
    expect(signs).toHaveLength(2);
  });

  test("a path for another business is never signed", async ({ page }) => {
    const { signs } = await stubStorage(page);
    const realtime = await openChat(page);
    realtime.push("messages", "INSERT", row(6, "image", { id: "media-6", mime: "image/jpeg", path: pathFor(6, "jpg", OTHER_TENANT) }));
    await expect(page.getByRole("log")).toContainText("Can't be shown here");
    await expect(page.getByRole("log").locator("img")).toHaveCount(0);
    await page.waitForTimeout(600);
    expect(signs).toHaveLength(0);
  });

  test("a path for another chat, a traversal and a URL are never signed", async ({ page }) => {
    const { signs } = await stubStorage(page);
    const realtime = await openChat(page);
    realtime.push("messages", "INSERT", row(7, "image", { id: "m7", mime: "image/jpeg", path: pathFor(7, "jpg", INBOX_TENANT, cid(2)) }));
    realtime.push("messages", "INSERT", row(8, "image", { id: "m8", mime: "image/jpeg", path: `../${pathFor(8, "jpg")}` }));
    realtime.push("messages", "INSERT", row(9, "image", { id: "m9", mime: "image/jpeg", path: "https://evil.example/x.jpg" }));
    await expect(page.getByRole("log").getByText("Can't be shown here")).toHaveCount(3);
    await page.waitForTimeout(600);
    expect(signs).toHaveLength(0);
  });

  test("a file the job left out says why and is not signed; a voice message keeps its placeholder", async ({ page }) => {
    const { signs } = await stubStorage(page);
    const realtime = await openChat(page);
    realtime.push("messages", "INSERT", row(10, "image", { id: "m10", mime: "image/jpeg", skipped: "too_big" }));
    realtime.push("messages", "INSERT", row(11, "audio", { id: "m11", mime: "audio/ogg; codecs=opus", path: pathFor(11, "ogg") }));
    await expect(page.getByRole("log")).toContainText("Too large to keep");
    await expect(page.getByRole("log")).toContainText("Can't be played here yet");
    await page.waitForTimeout(600);
    expect(signs).toHaveLength(0);
  });

  test("a message with no stored file keeps its placeholder and asks for nothing", async ({ page }) => {
    const { signs } = await stubStorage(page);
    const realtime = await openChat(page);
    realtime.push("messages", "INSERT", row(12, "image", { id: "m12", mime: "image/jpeg" }));
    await expect(page.getByRole("log")).toContainText("Can't be shown here yet");
    await page.waitForTimeout(600);
    expect(signs).toHaveLength(0);
  });
});
