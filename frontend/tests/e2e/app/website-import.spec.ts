import type { APIRequestContext, Page } from "@playwright/test";
import { expect, expectNoHorizontalOverflow, MOCK_SUPABASE_URL, SIGNED_OUT, signIn, test } from "../support/app";
import { refusal, stubApi, type ApiAnswer, type ApiCall } from "../support/day5";

// "Import a web page" in the Knowledge base's Documents section (and, in onboarding.spec.ts, the Teach step: the same form).
// POST /api/onboarding/import-site is Dev 1's (#235). It fetches a real public page, which the e2e API cannot do, so the route is stood in for with
// page.route: the stand-in writes the document row into mock-supabase as the real route does (processing), answers 202, and a test then moves the
// row to ready or failed as the ingest job would. The page's documents list is the real RLS read. These tests prove what the screen sends, how it
// words each answer and that it says Ready only when the row does; they do NOT prove the real route, its network fetch or the ingest job.

type Account = { email: string; tenantId: string };
const IMPORT = /\/api\/onboarding\/import-site$/;
const PAGE = "https://www.example.com/about";

async function newAccount(request: APIRequestContext, options: { role?: "owner" | "admin" | "staff" } = {}): Promise<Account> {
  return (await request.post(`${MOCK_SUPABASE_URL}/__mock/services-account`, { data: options })).json();
}
async function addDoc(request: APIRequestContext, row: { tenant_id: string; source_type: string; title: string; status: string; error?: string }): Promise<{ id: string; created_at: string }> {
  return (await request.post(`${MOCK_SUPABASE_URL}/__mock/kb-documents`, { data: row })).json();
}
async function setStatus(request: APIRequestContext, id: string, status: "ready" | "failed", error?: string) {
  await request.patch(`${MOCK_SUPABASE_URL}/__mock/kb-documents?id=${id}`, { data: { status, error } });
}
async function storedDocs(request: APIRequestContext, tenantId: string): Promise<{ id: string; source_type: string; title: string | null; status: string }[]> {
  return (await request.get(`${MOCK_SUPABASE_URL}/__mock/kb-documents?tenant=${tenantId}`)).json();
}

const docsRegion = (page: Page) => page.getByRole("region", { name: /^Documents/ });
const tiles = (page: Page) => docsRegion(page).getByRole("listitem");
const progress = (page: Page) => page.getByTestId("import-progress");
const address = (page: Page) => page.getByLabel("Web page address");
const submit = (page: Page) => page.getByTestId("import-submit");

async function openKnowledge(page: Page, account: Account) {
  await signIn(page, account.email, "/dashboard/knowledge");
  await expect(page.getByRole("heading", { level: 1, name: "Knowledge base" })).toBeVisible();
  await expect(docsRegion(page)).toBeVisible();
}

/** What the real route does on success: stores the page as a processing document and answers 202 with it. */
function accepting(request: APIRequestContext, account: Account, sink: { id: string | null }, over: { title?: string; replaced?: boolean } = {}) {
  return async (n: number, call: ApiCall): Promise<ApiAnswer> => {
    const url = (call.body as { url: string }).url;
    if (!sink.id) {
      const row = await addDoc(request, { tenant_id: account.tenantId, source_type: "website", title: over.title ?? "About us", status: "processing" });
      sink.id = row.id;
      return { status: 202, body: { id: row.id, title: over.title ?? "About us", sourceType: "website", sourceUrl: url, status: "processing", createdAt: row.created_at, replaced: false } };
    }
    return { status: 202, body: { id: sink.id, title: over.title ?? "About us", sourceType: "website", sourceUrl: url, status: "processing", createdAt: new Date().toISOString(), replaced: over.replaced ?? true } };
  };
}

test.describe("Knowledge base · import a web page", () => {
  test.use({ storageState: SIGNED_OUT });

  test("an owner imports a page: sends only the address, shows Processing, and says Ready only when the document does", async ({ page, request }) => {
    const account = await newAccount(request);
    const sink = { id: null as string | null };
    const calls = await stubApi(page, IMPORT, accepting(request, account, sink));
    await openKnowledge(page, account);
    await expect(page.getByTestId("import-hint")).toContainText("One public page at a time, up to 2 MB, read within 15 seconds.");
    await expect(page.getByTestId("import-note")).toContainText("no review step yet");
    await expect(page.getByTestId("import-note")).toContainText("costs no credits");

    await address(page).fill(`  ${PAGE} `);
    await submit(page).click();

    await expect(progress(page)).toHaveAttribute("data-kind", "processing");
    await expect(progress(page)).toContainText("Reading the page");
    await expect(progress(page)).not.toContainText("Ready");
    await expect(tiles(page).filter({ hasText: "About us" })).toContainText("Processing");
    await expect(tiles(page).filter({ hasText: "About us" })).toContainText("WEB");
    await expect(page.getByRole("status").filter({ hasText: /imported successfully|uploaded successfully/i })).toHaveCount(0);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ url: PAGE });
    expect(calls[0].authorization).toMatch(/^Bearer /);
    expect(calls[0].tenant).toBe(account.tenantId);

    // The ingest job finishes: the list sees it on its next read and the form follows the row.
    await setStatus(request, sink.id!, "ready");
    await expect(progress(page)).toHaveAttribute("data-kind", "ready", { timeout: 15_000 });
    await expect(progress(page)).toContainText("Your assistant can now answer from this page");
    await expect(tiles(page).filter({ hasText: "About us" })).toContainText("Ready");
    await expectNoHorizontalOverflow(page);
  });

  test("a page that fails processing shows the server's reason on the form and on its tile", async ({ page, request }) => {
    const account = await newAccount(request);
    const sink = { id: null as string | null };
    await stubApi(page, IMPORT, accepting(request, account, sink));
    await openKnowledge(page, account);
    await address(page).fill(PAGE);
    await submit(page).click();
    await expect(progress(page)).toHaveAttribute("data-kind", "processing");
    await setStatus(request, sink.id!, "failed", "This page has no text to learn from.");
    await expect(progress(page)).toHaveAttribute("data-kind", "failed", { timeout: 15_000 });
    await expect(progress(page)).toContainText("This page has no text to learn from.");
    await expect(tiles(page).filter({ hasText: "About us" })).toContainText("Failed");
    await expect(progress(page)).not.toContainText("Ready");
  });

  test("a page still processing after two minutes is called slow, and that stops when it becomes ready", async ({ page, request }) => {
    await page.clock.install();
    const account = await newAccount(request);
    const sink = { id: null as string | null };
    await stubApi(page, IMPORT, accepting(request, account, sink));
    await openKnowledge(page, account);
    await address(page).fill(PAGE);
    await submit(page).click();
    await expect(progress(page)).toHaveAttribute("data-kind", "processing");
    await page.clock.runFor(60_000);
    await expect(progress(page)).toHaveAttribute("data-kind", "processing");
    await page.clock.runFor(61_000);
    await expect(progress(page)).toHaveAttribute("data-kind", "slow");
    await expect(progress(page)).toContainText("taking longer than usual");
    await setStatus(request, sink.id!, "ready");
    await page.clock.runFor(3_000);
    await expect(progress(page)).toHaveAttribute("data-kind", "ready");
  });

  test("an empty address is stopped before anything is sent", async ({ page, request }) => {
    const account = await newAccount(request);
    const calls = await stubApi(page, IMPORT, () => refusal(500, "internal", "should not be called"));
    await openKnowledge(page, account);
    await submit(page).click();
    await expect(page.getByTestId("import-url-error")).toContainText("Enter the full address of the page");
    await expect(address(page)).toHaveAttribute("aria-invalid", "true");
    expect(calls).toHaveLength(0);
  });

  test("a refused address shows the server's message under the box, keeps what was typed, and adds nothing to the list", async ({ page, request }) => {
    const account = await newAccount(request);
    const text = "That address isn't allowed: it points to a private or internal network. Use your website's public address.";
    await stubApi(page, IMPORT, () => ({ status: 422, body: { error: { code: "validation_failed", message: "Check the address and try again.", fields: { url: text } } } }));
    await openKnowledge(page, account);
    await address(page).fill("http://192.168.0.10/admin");
    await submit(page).click();
    await expect(page.getByTestId("import-url-error")).toHaveText(text);
    await expect(address(page)).toHaveValue("http://192.168.0.10/admin");
    await expect(progress(page)).toHaveCount(0);
    await expect(tiles(page)).toHaveCount(0);
    // Typing again clears the old refusal.
    await address(page).fill("https://www.example.com/");
    await expect(page.getByTestId("import-url-error")).toHaveCount(0);
  });

  test("each other refusal is worded as the API wrote it, nothing is added, and the form can be used again", async ({ page, request }) => {
    const account = await newAccount(request);
    const answers: ApiAnswer[] = [
      refusal(401, "unauthenticated", "Your session has ended. Sign in again."),
      refusal(403, "forbidden", "Only an owner or admin can import a web page."),
      refusal(409, "conflict", "This page is still being processed from the last import. Try again in a minute."),
      refusal(422, "validation_failed", "You can keep up to 100 documents. Delete one you no longer need, then import again."),
      refusal(429, "rate_limited", "You've imported a lot of pages in the last hour. Try again later."),
      refusal(502, "upstream_failed", "We couldn't open that page. Check the address and that the site is online, then try again."),
      refusal(500, "internal", "Something went wrong on our side. Try again in a moment."),
    ];
    const calls = await stubApi(page, IMPORT, (n) => answers[n - 1]);
    await openKnowledge(page, account);
    await address(page).fill(PAGE);
    for (const answer of answers) {
      await submit(page).click();
      await expect(page.getByRole("alert").filter({ hasText: "Couldn't import the page" })).toContainText((answer.body as { error: { message: string } }).error.message);
      await expect(page.getByTestId("import-url-error")).toHaveCount(0);
      await expect(submit(page)).toBeEnabled();
      await expect(address(page)).toHaveValue(PAGE);
    }
    expect(calls).toHaveLength(answers.length);
    await expect(tiles(page)).toHaveCount(0);
    await expect(progress(page)).toHaveCount(0);
    await expect(page.getByText(/Something went wrong on our side/)).toBeVisible();
  });

  test("a second click or Enter while the request is out sends nothing more", async ({ page, request }) => {
    const account = await newAccount(request);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const sink = { id: null as string | null };
    const accept = accepting(request, account, sink);
    const calls = await stubApi(page, IMPORT, async (n, call) => (await gate, accept(n, call)));
    await openKnowledge(page, account);
    await address(page).fill(PAGE);
    await submit(page).click();
    await expect(submit(page)).toHaveText("Importing…");
    await expect(submit(page)).toBeDisabled();
    await expect(address(page)).toBeDisabled();
    await submit(page).click({ force: true }).catch(() => {});
    await address(page).press("Enter", { noWaitAfter: true }).catch(() => {});
    release();
    await expect(progress(page)).toBeVisible();
    expect(calls).toHaveLength(1);
  });

  test("importing the same address again replaces its page: one tile, processing again", async ({ page, request }) => {
    const account = await newAccount(request);
    const sink = { id: null as string | null };
    const calls = await stubApi(page, IMPORT, accepting(request, account, sink));
    await openKnowledge(page, account);
    await address(page).fill(PAGE);
    await submit(page).click();
    await expect(progress(page)).toHaveAttribute("data-kind", "processing");
    await setStatus(request, sink.id!, "ready");
    await expect(progress(page)).toHaveAttribute("data-kind", "ready", { timeout: 15_000 });

    // The second import: the stand-in answers with the same document, now processing again (as the real route's replace does).
    await request.patch(`${MOCK_SUPABASE_URL}/__mock/kb-documents?id=${sink.id}`, { data: { status: "processing" } });
    await submit(page).click();
    await expect(progress(page)).toHaveAttribute("data-replaced", "true");
    await expect(progress(page)).toHaveAttribute("data-kind", "processing");
    await expect(progress(page)).toContainText("Replacing this page’s earlier import");
    await expect(tiles(page)).toHaveCount(1);
    await expect(tiles(page).first()).toContainText("Processing");
    expect(calls).toHaveLength(2);
    expect((await storedDocs(request, account.tenantId)).filter((d) => d.source_type === "website")).toHaveLength(1);
  });

  test("a page that is deleted from the list stops being talked about", async ({ page, request }) => {
    const account = await newAccount(request);
    const sink = { id: null as string | null };
    await stubApi(page, IMPORT, accepting(request, account, sink));
    await page.route(/\/api\/kb\/documents\/[^/]+$/, (route) => route.fulfill({ status: 204, headers: { "access-control-allow-origin": route.request().headers()["origin"] ?? "*" } }));
    await openKnowledge(page, account);
    await address(page).fill(PAGE);
    await submit(page).click();
    await expect(progress(page)).toBeVisible();
    await tiles(page).filter({ hasText: "About us" }).getByRole("button", { name: /^Delete/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete document" }).click();
    await expect(tiles(page)).toHaveCount(0);
    await expect(progress(page)).toHaveCount(0);
  });

  test("the pre-existing documents are untouched by an import", async ({ page, request }) => {
    const account = await newAccount(request);
    await addDoc(request, { tenant_id: account.tenantId, source_type: "upload", title: "Price list.pdf", status: "ready" });
    const sink = { id: null as string | null };
    await stubApi(page, IMPORT, accepting(request, account, sink));
    await openKnowledge(page, account);
    await expect(tiles(page)).toHaveCount(1);
    await address(page).fill(PAGE);
    await submit(page).click();
    await expect(tiles(page)).toHaveCount(2);
    await expect(tiles(page).filter({ hasText: "Price list.pdf" })).toContainText("Ready");
  });

  test("on a server without the route, the form says the service is not available and nothing is added", async ({ page, request }) => {
    const account = await newAccount(request);
    await stubApi(page, IMPORT, () => refusal(404, "not_found", "Not found."));
    await openKnowledge(page, account);
    await address(page).fill(PAGE);
    await submit(page).click();
    await expect(page.getByRole("alert").filter({ hasText: "Knowledge base is not available yet." })).toBeVisible();
    await expect(tiles(page)).toHaveCount(0);
  });

  test("staff see the form switched off with the reason, and nothing can be sent", async ({ page, request }) => {
    const account = await newAccount(request, { role: "staff" });
    const calls = await stubApi(page, IMPORT, () => refusal(403, "forbidden", "Only an owner or admin can import a web page."));
    await openKnowledge(page, account);
    await expect(page.getByTestId("import-hint")).toHaveText("Only an owner or admin can import a web page.");
    await expect(address(page)).toBeDisabled();
    await expect(submit(page)).toBeDisabled();
    await submit(page).click({ force: true }).catch(() => {});
    expect(calls).toHaveLength(0);
  });

  test("an admin can import", async ({ page, request }) => {
    const account = await newAccount(request, { role: "admin" });
    const sink = { id: null as string | null };
    const calls = await stubApi(page, IMPORT, accepting(request, account, sink));
    await openKnowledge(page, account);
    await address(page).fill(PAGE);
    await submit(page).click();
    await expect(progress(page)).toHaveAttribute("data-kind", "processing");
    expect(calls).toHaveLength(1);
  });
});
