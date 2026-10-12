import type { APIRequestContext, Page, WebSocketRoute } from "@playwright/test";
import { appAlert, expect, expectNoHorizontalOverflow, mainNav, MOCK_SUPABASE_URL, SIGNED_OUT, signIn, test as base } from "../support/app";
import { mockKbApi, ROUTE_MISSING, type Gap, type KbApi } from "../support/kb-api";

// The real Knowledge base at /dashboard/knowledge. Services, FAQs and documents are read from
// mock-supabase.mjs under RLS; the knowledge-base API (docs/contracts.md section 9: FAQs, uploads,
// gaps) is support/kb-api.ts, a contract-shaped stand-in (the document routes mirror the built API;
// the FAQ and gap routes aren't built yet). Every test
// gets its own account and business (POST /__mock/services-account), so the desktop, tablet and phone
// projects can add, edit and delete at the same time.

type Role = "owner" | "admin" | "staff";
const test = base.extend<{ kbRole: Role; kb: KbApi }>({
  kbRole: ["owner", { option: true }],
  kb: [async ({ page, request, kbRole }, use) => use(await mockKbApi(page, request, { role: kbRole })), { auto: true }],
});

type Account = { email: string; tenantId: string };
type StoredService = { id: string; tenant_id: string; name: string; duration_min: number; price_min: number | null; price_max: number | null; resource_type: string; active: boolean };

async function newAccount(
  request: APIRequestContext,
  options: { seed?: boolean; error?: boolean; docs?: boolean; docsError?: boolean; faqs?: boolean; role?: Role } = {},
): Promise<Account> {
  return (await request.post(`${MOCK_SUPABASE_URL}/__mock/services-account`, { data: options })).json();
}
async function stored(request: APIRequestContext, tenantId: string): Promise<StoredService[]> {
  return (await request.get(`${MOCK_SUPABASE_URL}/__mock/services?tenant=${tenantId}`)).json();
}
async function openKnowledge(page: Page, account: Account) {
  await signIn(page, account.email, "/dashboard/knowledge");
  await expect(page.getByRole("heading", { level: 1, name: "Knowledge base" })).toBeVisible();
}

const table = (page: Page) => page.getByRole("table");
const rowFor = (page: Page, name: string) => table(page).getByRole("row").filter({ has: page.getByRole("cell", { name, exact: true }) });
const dialog = (page: Page) => page.getByRole("dialog");
/** The services section's Add (the FAQs section has its own, switched off). */
const servicesAdd = (page: Page) => page.getByRole("region", { name: /^Services & prices/ }).getByRole("button", { name: "Add", exact: true });
const toast = (page: Page, text: string) => page.getByRole("status").filter({ hasText: text });

async function expectDialogFits(page: Page) {
  const box = await dialog(page).boundingBox();
  const vw = page.viewportSize()!.width;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(vw);
}

test.describe("Knowledge base · services", () => {
  test.use({ storageState: SIGNED_OUT });

  test("an empty business says so and offers to add a service", async ({ page, request }) => {
    const account = await newAccount(request);
    await openKnowledge(page, account);
    await expect(mainNav(page).getByRole("link", { name: "Knowledge base", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: "Services & prices · 0" })).toBeVisible();
    await expect(page.getByText("No services yet")).toBeVisible();
    await expect(table(page)).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await page.getByRole("button", { name: "Add a service" }).click();
    await expect(dialog(page)).toContainText("Add a service");
    await expectDialogFits(page);
  });

  test("lists the business's services in the prototype's table", async ({ page, request }) => {
    const account = await newAccount(request, { seed: true });
    await openKnowledge(page, account);
    await expect(page.getByRole("heading", { name: "Services & prices · 3" })).toBeVisible();
    await expect(table(page).getByRole("columnheader")).toHaveText(["Service", "Length", "Booking rules", "Booked with", "Price range", "Status", "Actions"]);
    const rows = table(page).locator("tbody tr");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("Bridal trial");
    await expect(rows.nth(0)).toContainText("90 min");
    await expect(rows.nth(0)).toContainText("₹2,500 – ₹5,000");
    await expect(rows.nth(1)).toContainText("Hair spa");
    await expect(rows.nth(1)).toContainText("—");
    await expect(rows.nth(1)).toContainText("Off");
    await expect(rows.nth(2)).toContainText("Haircut");
    await expect(rows.nth(2)).toContainText("₹300 – ₹600");
    await expect(rows.nth(2)).toContainText("Active");
    // The table scrolls inside its own box on narrow screens; the page never scrolls sideways.
    await expectNoHorizontalOverflow(page);
    // Only real data: none of the prototype's sample services, FAQs, questions or documents.
    await expect(page.locator("body")).not.toContainText(/Skyline|HD bridal package|Mehendi|Do you do home service|sent \d+ times/);
  });

  test("adds a service for this business only", async ({ page, request }) => {
    const account = await newAccount(request, { seed: true });
    await openKnowledge(page, account);
    await servicesAdd(page).click();
    await expectDialogFits(page);
    await dialog(page).getByLabel("Name").fill("Keratin");
    await dialog(page).getByLabel("Length (minutes)").fill("150");
    await dialog(page).getByLabel("Booked with").fill("stylist");
    await dialog(page).getByLabel("Lowest price (₹)").fill("4,500");
    await dialog(page).getByLabel("Highest price (₹)").fill("8000");
    await dialog(page).getByRole("button", { name: "Add service" }).click();

    await expect(dialog(page)).toHaveCount(0);
    await expect(toast(page, "Added Keratin")).toBeVisible();
    await expect(rowFor(page, "Keratin")).toContainText("150 min");
    await expect(rowFor(page, "Keratin")).toContainText("₹4,500 – ₹8,000");
    await expect(page.getByRole("heading", { name: "Services & prices · 4" })).toBeVisible();

    const saved = (await stored(request, account.tenantId)).find((s) => s.name === "Keratin");
    expect(saved).toMatchObject({ tenant_id: account.tenantId, duration_min: 150, price_min: 4500, price_max: 8000, resource_type: "stylist", active: true });
  });

  test("edits a service", async ({ page, request }) => {
    const account = await newAccount(request, { seed: true });
    await openKnowledge(page, account);
    await page.getByRole("button", { name: "Edit Haircut" }).click();
    await expect(dialog(page)).toContainText("Edit Haircut");
    await expect(dialog(page).getByLabel("Name")).toHaveValue("Haircut");
    await expect(dialog(page).getByLabel("Lowest price (₹)")).toHaveValue("300");
    await dialog(page).getByLabel("Name").fill("Haircut and wash");
    await dialog(page).getByLabel("Lowest price (₹)").fill("");
    await dialog(page).getByLabel("Highest price (₹)").fill("750");
    await dialog(page).getByLabel("Customers can book this").uncheck();
    await dialog(page).getByRole("button", { name: "Save changes" }).click();

    await expect(dialog(page)).toHaveCount(0);
    await expect(toast(page, "Saved Haircut and wash")).toBeVisible();
    await expect(rowFor(page, "Haircut and wash")).toContainText("Up to ₹750");
    await expect(rowFor(page, "Haircut and wash")).toContainText("Off");
    await expect(rowFor(page, "Haircut")).toHaveCount(0);
    const saved = (await stored(request, account.tenantId)).find((s) => s.name === "Haircut and wash");
    expect(saved).toMatchObject({ price_min: null, price_max: 750, active: false });
  });

  test("deletes a service after confirming, and keeps it on Keep it", async ({ page, request }) => {
    const account = await newAccount(request, { seed: true });
    await openKnowledge(page, account);
    await page.getByRole("button", { name: "Delete Hair spa" }).click();
    await expect(dialog(page)).toContainText("Delete Hair spa?");
    await expectDialogFits(page);
    await dialog(page).getByRole("button", { name: "Keep it" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(rowFor(page, "Hair spa")).toHaveCount(1);

    await page.getByRole("button", { name: "Delete Hair spa" }).click();
    await dialog(page).getByRole("button", { name: "Delete service" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(toast(page, "Deleted Hair spa")).toBeVisible();
    await expect(rowFor(page, "Hair spa")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Services & prices · 2" })).toBeVisible();
    expect((await stored(request, account.tenantId)).map((s) => s.name).sort()).toEqual(["Bridal trial", "Haircut"]);
  });

  test("validates before saving and sends nothing until the form is right", async ({ page, request }) => {
    const account = await newAccount(request, { seed: true });
    await openKnowledge(page, account);
    await servicesAdd(page).click();
    await dialog(page).getByRole("button", { name: "Add service" }).click();
    await expect(dialog(page).getByText("Give the service a name")).toBeVisible();
    await expect(dialog(page).getByText("Enter how many minutes a booking takes")).toBeVisible();
    await expect(dialog(page).getByText("Say who or what is booked, like staff")).toBeVisible();
    await expect(dialog(page).getByLabel("Name")).toHaveAttribute("aria-invalid", "true");

    await dialog(page).getByLabel("Name").fill("haircut");
    await dialog(page).getByLabel("Length (minutes)").fill("0");
    await dialog(page).getByLabel("Booked with").fill("stylist");
    await dialog(page).getByLabel("Lowest price (₹)").fill("12.50");
    await dialog(page).getByLabel("Highest price (₹)").fill("100");
    await dialog(page).getByRole("button", { name: "Add service" }).click();
    await expect(dialog(page).getByText("You already have a service with this name")).toBeVisible();
    await expect(dialog(page).getByText("A booking takes at least 1 minute")).toBeVisible();
    await expect(dialog(page).getByText("Enter whole rupees, like 1500")).toBeVisible();

    await dialog(page).getByLabel("Name").fill("Head massage");
    await dialog(page).getByLabel("Length (minutes)").fill("20");
    await dialog(page).getByLabel("Lowest price (₹)").fill("500");
    await dialog(page).getByRole("button", { name: "Add service" }).click();
    await expect(dialog(page).getByText("The highest price can't be below the lowest")).toBeVisible();

    // Nothing was written while the form was invalid.
    const log = await (await request.get(`${MOCK_SUPABASE_URL}/__mock/rest-log?email=${account.email}`)).json();
    expect((log as { method: string; table: string }[]).filter((r) => r.table === "services" && r.method !== "GET")).toEqual([]);
    expect(await stored(request, account.tenantId)).toHaveLength(3);

    // Escape closes the dialog without saving.
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
  });

  test("a save or delete that didn't happen is reported, never shown as done", async ({ page, request }) => {
    const account = await newAccount(request, { seed: true });
    await openKnowledge(page, account);
    const haircut = (await stored(request, account.tenantId)).find((s) => s.name === "Haircut")!;

    // Someone else removes the service while this dialog is open; the update then matches no row.
    await page.getByRole("button", { name: "Edit Haircut" }).click();
    await request.delete(`${MOCK_SUPABASE_URL}/__mock/services?id=${haircut.id}`);
    await dialog(page).getByLabel("Length (minutes)").fill("45");
    await dialog(page).getByRole("button", { name: "Save changes" }).click();
    await expect(dialog(page).getByRole("alert")).toContainText("This service no longer exists");
    await expect(dialog(page)).toBeVisible();
    await dialog(page).getByRole("button", { name: "Cancel" }).click();
    await expect(rowFor(page, "Haircut")).toHaveCount(1); // not silently changed or removed

    await page.getByRole("button", { name: "Delete Haircut" }).click();
    await dialog(page).getByRole("button", { name: "Delete service" }).click();
    await expect(dialog(page).getByRole("alert")).toContainText("This service no longer exists");
    await expect(dialog(page).getByRole("button", { name: "Delete service" })).toBeEnabled();
    await expect(toast(page, "Deleted")).toHaveCount(0);
  });

  test("every read and write names the session's business", async ({ page, request }) => {
    const account = await newAccount(request, { seed: true });
    await openKnowledge(page, account);
    await page.getByRole("button", { name: "Edit Bridal trial" }).click();
    await dialog(page).getByRole("button", { name: "Save changes" }).click();
    await expect(toast(page, "Saved Bridal trial")).toBeVisible();
    await page.getByRole("button", { name: "Delete Hair spa" }).click();
    await dialog(page).getByRole("button", { name: "Delete service" }).click();
    await expect(toast(page, "Deleted Hair spa")).toBeVisible();

    const log = (await (await request.get(`${MOCK_SUPABASE_URL}/__mock/rest-log?email=${account.email}`)).json()) as { method: string; table: string; query: string }[];
    const services = log.filter((r) => r.table === "services");
    expect(services.map((r) => r.method).sort()).toEqual(["DELETE", "GET", "PATCH"]);
    for (const r of services) expect(decodeURIComponent(r.query)).toContain(`tenant_id=eq.${account.tenantId}`);
  });

  test("a failed read shows an error with Try again", async ({ page, request }) => {
    const account = await newAccount(request, { error: true });
    await openKnowledge(page, account);
    await expect(appAlert(page)).toContainText("Couldn't load your services");
    await expect(appAlert(page)).toContainText("Something went wrong. Try again in a moment.");
    await expect(appAlert(page)).not.toContainText(/boom|unexpected shape/);
    await expect(servicesAdd(page)).toBeDisabled();
    await appAlert(page).getByRole("button", { name: "Try again" }).click();
    await expect(appAlert(page)).toContainText("Couldn't load your services");
    await expectNoHorizontalOverflow(page);
  });
});


// FAQs, documents and unanswered questions ---------------------------------------------------------

const faqs = (page: Page) => page.getByRole("region", { name: /^FAQs/ });
const docsRegion = (page: Page) => page.getByRole("region", { name: /^Documents/ });
const gapsRegion = (page: Page) => page.getByRole("region", { name: /^Questions the AI couldn’t answer/ });
const tile = (page: Page, name: string) => docsRegion(page).getByRole("listitem").filter({ hasText: name });

type StoredDoc = { id: string; tenant_id: string; source_type: string; title: string | null; body: string | null; status: string };
async function storedDocs(request: APIRequestContext, tenantId: string): Promise<StoredDoc[]> {
  return (await request.get(`${MOCK_SUPABASE_URL}/__mock/kb-documents?tenant=${tenantId}`)).json();
}
async function addDoc(request: APIRequestContext, row: { tenant_id: string; source_type: string; title: string; status: string; body?: string; error?: string }): Promise<StoredDoc> {
  return (await request.post(`${MOCK_SUPABASE_URL}/__mock/kb-documents`, { data: row })).json();
}
/** What the ingest job does when it finishes (or gives up on) a document; `error` is its reason for failing. */
async function setStatus(request: APIRequestContext, id: string, status: "ready" | "failed", error?: string) {
  await request.patch(`${MOCK_SUPABASE_URL}/__mock/kb-documents?id=${id}`, { data: { status, error } });
}
async function kbReads(request: APIRequestContext, email: string): Promise<{ method: string; table: string; query: string }[]> {
  const log = (await (await request.get(`${MOCK_SUPABASE_URL}/__mock/rest-log?email=${email}`)).json()) as { method: string; table: string; query: string }[];
  return log.filter((r) => r.table === "kb_documents");
}

const gap = (n: number, question: string, askedCount: number, lastAskedBy: string | null = "Priya"): Gap => ({
  id: `a0000000-0000-4000-8000-00000000000${n}`,
  question,
  askedCount,
  lastAskedBy,
});
const GAPS = [gap(1, "Do you open on Sundays?", 2, "+91 98••• ••321"), gap(2, "Do you do keratin?", 4), gap(3, "Is there a student discount?", 1, null)];

/** Answers the Realtime socket (Phoenix protocol, as inbox.spec.ts): joins succeed or fail; tests push row changes. */
async function mockRealtime(page: Page, { fail = false } = {}) {
  const joins: { topic: string; changes: { id: number; event: string; table: string; filter?: string }[] }[] = [];
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => {
    socket = ws;
    ws.onMessage((raw) => {
      const [joinRef, ref, topic, event, payload] = JSON.parse(String(raw));
      const reply = (status: string, response: unknown) => ws.send(JSON.stringify([joinRef, ref, topic, "phx_reply", { status, response }]));
      if (event === "heartbeat" || event === "phx_leave") reply("ok", {});
      else if (event === "phx_join") {
        if (fail) return reply("error", { reason: "Unable to subscribe to changes with given parameters" });
        const changes = payload.config.postgres_changes.map((f: { event: string; table: string; filter?: string }, i: number) => ({ ...f, id: i + 1 }));
        joins.push({ topic, changes });
        reply("ok", { postgres_changes: changes });
      }
    });
  });
  return {
    joins,
    push(table: string, record: Record<string, unknown>) {
      const join = joins[joins.length - 1];
      const ids = join.changes.filter((c) => c.table === table).map((c) => c.id);
      socket!.send(JSON.stringify([null, null, join.topic, "postgres_changes", {
        ids,
        data: { type: "UPDATE", schema: "public", table, commit_timestamp: new Date().toISOString(), columns: [], record, errors: null },
      }]));
    },
  };
}

function expectSignedCall(call: { tenant: string | null; authorization: string | null; body: string } | undefined, tenantId: string) {
  expect(call, "API call").toBeTruthy();
  expect(call!.tenant).toBe(tenantId);
  expect(call!.authorization).toMatch(/^Bearer \S+/);
  // The business is named by the header only, never in a body.
  expect(call!.body).not.toContain(tenantId);
}

test.describe("Knowledge base · FAQs", () => {
  test.use({ storageState: SIGNED_OUT });

  test("lists the business's FAQs in the prototype's accordion, in page order", async ({ page, request }) => {
    const account = await newAccount(request, { seed: true, faqs: true, docs: true });
    await openKnowledge(page, account);
    await expect(page.getByRole("heading", { level: 2 })).toHaveText([
      "Questions the AI couldn’t answer · 0",
      "Services & prices · 3",
      "FAQs · 2",
      "Documents · 2",
    ]);
    const first = faqs(page).getByRole("button", { name: "Do you do home visits?", exact: true });
    await expect(first).toHaveAttribute("aria-expanded", "true");
    await expect(faqs(page)).toContainText("Yes, within 5 km of the studio");
    await expect(faqs(page).getByRole("button", { name: "Edit FAQ: Do you do home visits?" })).toBeVisible();
    const second = faqs(page).getByRole("button", { name: "Is there parking?", exact: true });
    await expect(second).toHaveAttribute("aria-expanded", "false");
    await second.click();
    await expect(faqs(page)).toContainText("two-wheeler parking");
    // FAQs are kb_documents rows too, but only knowledge sources are listed under Documents.
    await expect(docsRegion(page)).not.toContainText("home visits");
    await expectNoHorizontalOverflow(page);
  });

  test("adds an FAQ through the API, saying so only once it's saved", async ({ page, request, kb }) => {
    const account = await newAccount(request, { faqs: true });
    await openKnowledge(page, account);
    await faqs(page).getByRole("button", { name: "Add", exact: true }).click();
    await expect(dialog(page)).toContainText("Add an FAQ");
    await expectDialogFits(page);
    await dialog(page).getByLabel("Question").fill("  Do you take card payments? ");
    await dialog(page).getByLabel("Answer").fill("Yes: cards, UPI and cash.");

    const release = kb.hold("POST /api/kb/faqs");
    await dialog(page).getByRole("button", { name: "Add FAQ" }).click();
    await expect(dialog(page).getByRole("button", { name: "Saving…" })).toBeDisabled();
    await expect(dialog(page).getByRole("button", { name: "Cancel" })).toBeDisabled();
    await expect(toast(page, "Added to FAQs")).toHaveCount(0);
    release();

    await expect(dialog(page)).toHaveCount(0);
    await expect(toast(page, "Added to FAQs")).toBeVisible();
    await expect(page.getByRole("heading", { name: "FAQs · 3" })).toBeVisible();
    await expect(faqs(page).getByRole("button", { name: "Do you take card payments?", exact: true })).toBeVisible();

    const [call] = kb.writes();
    expect(call.route).toBe("POST /api/kb/faqs");
    expect(call.contentType).toBe("application/json");
    expect(JSON.parse(call.body)).toEqual({ q: "Do you take card payments?", a: "Yes: cards, UPI and cash." });
    expectSignedCall(call, account.tenantId);
    expect((await storedDocs(request, account.tenantId)).filter((d) => d.source_type === "manual")).toHaveLength(3);
  });

  test("edits an FAQ, sending only what changed", async ({ page, request, kb }) => {
    const account = await newAccount(request, { faqs: true });
    await openKnowledge(page, account);
    await faqs(page).getByRole("button", { name: "Edit FAQ: Do you do home visits?" }).click();
    await expect(dialog(page)).toContainText("Edit FAQ");
    await expectDialogFits(page);
    await expect(dialog(page).getByLabel("Question")).toHaveValue("Do you do home visits?");
    await dialog(page).getByLabel("Answer").fill("Yes, anywhere in Chennai.");
    await dialog(page).getByRole("button", { name: "Save changes" }).click();

    await expect(dialog(page)).toHaveCount(0);
    await expect(toast(page, "Saved the FAQ")).toBeVisible();
    await expect(faqs(page)).toContainText("Yes, anywhere in Chennai.");
    const [call] = kb.writes();
    expect(call.route).toBe("PATCH /api/kb/faqs/:id");
    expect(JSON.parse(call.body)).toEqual({ a: "Yes, anywhere in Chennai." });
    expectSignedCall(call, account.tenantId);
  });

  test("deletes an FAQ after confirming, and keeps it on Keep it", async ({ page, request, kb }) => {
    const account = await newAccount(request, { faqs: true });
    await openKnowledge(page, account);
    const del = faqs(page).getByRole("button", { name: "Delete FAQ: Do you do home visits?" });
    await del.click();
    await expect(dialog(page)).toContainText("Delete this FAQ?");
    await expectDialogFits(page);
    await dialog(page).getByRole("button", { name: "Keep it" }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(kb.writes()).toEqual([]);

    await del.click();
    await dialog(page).getByRole("button", { name: "Delete FAQ" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(toast(page, "Deleted the FAQ")).toBeVisible();
    await expect(page.getByRole("heading", { name: "FAQs · 1" })).toBeVisible();
    await expect(faqs(page).getByRole("button", { name: "Do you do home visits?", exact: true })).toHaveCount(0);
    expect(kb.writes().map((c) => c.route)).toEqual(["DELETE /api/kb/faqs/:id"]);
    expectSignedCall(kb.writes()[0], account.tenantId);
  });

  test("validates before sending, and shows a duplicate question on the question field", async ({ page, request, kb }) => {
    const account = await newAccount(request, { faqs: true });
    await openKnowledge(page, account);
    await faqs(page).getByRole("button", { name: "Add", exact: true }).click();
    await dialog(page).getByRole("button", { name: "Add FAQ" }).click();
    await expect(dialog(page).getByText("Write the question the way customers ask it")).toBeVisible();
    await expect(dialog(page).getByText("Write the answer", { exact: true })).toBeVisible();
    await expect(dialog(page).getByLabel("Question")).toHaveAttribute("aria-invalid", "true");

    // Already listed: refused here, ignoring case and spaces.
    await dialog(page).getByLabel("Question").fill("  IS THERE PARKING? ");
    await dialog(page).getByLabel("Answer").fill("x".repeat(2001));
    await dialog(page).getByRole("button", { name: "Add FAQ" }).click();
    await expect(dialog(page).getByText("You already have an FAQ with this question")).toBeVisible();
    await expect(dialog(page).getByText("Keep the answer under 2000 characters")).toBeVisible();
    expect(kb.writes()).toEqual([]);

    // Added elsewhere since the page loaded: the API answers conflict, shown on the same field.
    await addDoc(request, { tenant_id: account.tenantId, source_type: "manual", title: "Do you sell gift cards?", body: "Yes.", status: "ready" });
    await dialog(page).getByLabel("Question").fill("Do you sell gift cards?");
    await dialog(page).getByLabel("Answer").fill("Yes, from ₹500.");
    await dialog(page).getByRole("button", { name: "Add FAQ" }).click();
    await expect(dialog(page).getByText("You already have an FAQ with this question")).toBeVisible();
    await expect(dialog(page).getByLabel("Question")).toHaveAttribute("aria-invalid", "true");
    await expect(dialog(page).getByRole("button", { name: "Add FAQ" })).toBeEnabled();
    expect(kb.writes().map((c) => c.route)).toEqual(["POST /api/kb/faqs"]);
    await expect(toast(page, "Added")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "FAQs · 2" })).toBeVisible();
  });

  test("a save or delete the API refused is reported, never shown as done", async ({ page, request, kb }) => {
    const account = await newAccount(request, { faqs: true });
    await openKnowledge(page, account);
    kb.fail("POST /api/kb/faqs", { status: 502, code: "upstream_failed", message: "Couldn't prepare this answer for the AI. Try again in a moment." });
    await faqs(page).getByRole("button", { name: "Add", exact: true }).click();
    await dialog(page).getByLabel("Question").fill("Do you take card payments?");
    await dialog(page).getByLabel("Answer").fill("Yes.");
    await dialog(page).getByRole("button", { name: "Add FAQ" }).click();
    await expect(dialog(page).getByRole("alert")).toContainText("Couldn't save the FAQ");
    await expect(dialog(page).getByRole("alert")).toContainText("Couldn't prepare this answer for the AI");
    await expect(dialog(page).getByLabel("Answer")).toHaveValue("Yes.");
    await dialog(page).getByRole("button", { name: "Cancel" }).click();

    // Deleted by someone else meanwhile: not_found, and the FAQ stays listed.
    const [visits] = (await storedDocs(request, account.tenantId)).filter((d) => d.title === "Do you do home visits?");
    await request.delete(`${MOCK_SUPABASE_URL}/__mock/kb-documents?id=${visits.id}`);
    await faqs(page).getByRole("button", { name: "Delete FAQ: Do you do home visits?" }).click();
    await dialog(page).getByRole("button", { name: "Delete FAQ" }).click();
    await expect(dialog(page).getByRole("alert")).toContainText("This FAQ no longer exists");
    await expect(dialog(page).getByRole("alert")).not.toContainText("not available yet");
    await expect(dialog(page).getByRole("button", { name: "Delete FAQ" })).toBeEnabled();
    await expect(toast(page, "Deleted")).toHaveCount(0);
    await expectDialogFits(page);
  });

  test("a FAQ the AI can't use yet is retried by saving it again, even unchanged", async ({ page, request, kb }) => {
    const account = await newAccount(request);
    const answer = "Yes, from ₹4,500. It takes about 2 hours.";
    await addDoc(request, { tenant_id: account.tenantId, source_type: "manual", title: "Do you do keratin?", body: answer, status: "failed", error: "We couldn't save this question for search. Save it again in a moment." });
    await addDoc(request, { tenant_id: account.tenantId, source_type: "manual", title: "Is there parking?", body: "Yes, two-wheeler parking.", status: "ready" });
    await openKnowledge(page, account);
    const notInUse = faqs(page).getByText("Not in use: edit to try again");
    await expect(notInUse).toHaveCount(1);

    // A ready FAQ saved unchanged still sends nothing.
    await faqs(page).getByRole("button", { name: "Is there parking?", exact: true }).click();
    await faqs(page).getByRole("button", { name: "Edit FAQ: Is there parking?" }).click();
    await dialog(page).getByRole("button", { name: "Save changes" }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(kb.writes()).toEqual([]);

    // Still failing: the unchanged save is sent, the dialog keeps it, and the list shows it still not in use.
    kb.failEmbedding(true);
    await faqs(page).getByRole("button", { name: "Edit FAQ: Do you do keratin?" }).click();
    await dialog(page).getByRole("button", { name: "Save changes" }).click();
    await expect(dialog(page).getByRole("alert")).toContainText("Couldn't save the FAQ");
    await expect(dialog(page).getByRole("alert")).toContainText("We couldn't save this question for search just now");
    await expect(dialog(page).getByLabel("Answer")).toHaveValue(answer);
    await expect(dialog(page).getByRole("button", { name: "Save changes" })).toBeEnabled();
    await expect(notInUse).toHaveCount(1);
    await expect(toast(page, "Saved the FAQ")).toHaveCount(0);

    // Working again: the same unchanged save goes through, and the list read afterwards shows it in use.
    kb.failEmbedding(false);
    const readsBefore = (await kbReads(request, account.email)).length;
    await dialog(page).getByRole("button", { name: "Save changes" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(toast(page, "Saved the FAQ")).toBeVisible();
    await expect(notInUse).toHaveCount(0);
    expect((await kbReads(request, account.email)).length).toBeGreaterThan(readsBefore);
    expect((await storedDocs(request, account.tenantId)).find((d) => d.title === "Do you do keratin?")?.status).toBe("ready");

    const writes = kb.writes();
    expect(writes.map((c) => c.route)).toEqual(["PATCH /api/kb/faqs/:id", "PATCH /api/kb/faqs/:id"]);
    for (const call of writes) {
      expect(JSON.parse(call.body)).toEqual({ a: answer });
      expectSignedCall(call, account.tenantId);
    }
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("Knowledge base · documents", () => {
  test.use({ storageState: SIGNED_OUT });

  test("lists the business's documents with their status", async ({ page, request }) => {
    const account = await newAccount(request, { docs: true });
    await addDoc(request, { tenant_id: account.tenantId, source_type: "upload", title: "Old menu.docx", status: "failed" });
    await openKnowledge(page, account);
    await expect(docsRegion(page).getByRole("heading")).toHaveText("Documents · 3");
    const tiles = docsRegion(page).getByRole("listitem");
    // Newest first; the tile label comes from the file type, else from where it came from.
    await expect(tiles.nth(0)).toContainText("DOCX");
    await expect(tiles.nth(0)).toContainText("Failed");
    await expect(tiles.nth(0)).toContainText("Couldn’t be read");
    await expect(tiles.nth(1)).toContainText("WEB");
    await expect(tiles.nth(1)).toContainText("From your website · 5 Oct 2026");
    await expect(tiles.nth(1)).toContainText("Ready");
    await expect(tiles.nth(2)).toContainText("Bridal price list.pdf");
    await expect(tiles.nth(2)).toContainText("Uploaded · 1 Oct 2026");
    await expect(docsRegion(page).getByRole("list")).not.toContainText(/sent \d+ times/);
    await expectNoHorizontalOverflow(page);
  });

  test("uploads a document: Uploading, then Processing, then Ready when Realtime reports it", async ({ page, request, kb }) => {
    const realtime = await mockRealtime(page);
    const account = await newAccount(request, { docs: true });
    await openKnowledge(page, account);
    await docsRegion(page).getByRole("button", { name: "Upload" }).click();
    await expect(dialog(page)).toContainText("Upload a document");
    await expectDialogFits(page);
    await dialog(page).getByLabel("File").setInputFiles({ name: "Price list.md", mimeType: "text/markdown", buffer: Buffer.from("# Prices\nHaircut ₹300") });
    await dialog(page).getByLabel("Title (optional)").fill("Salon prices");

    const release = kb.hold("POST /api/kb/documents");
    await dialog(page).getByRole("button", { name: "Upload" }).click();
    await expect(dialog(page).getByRole("button", { name: "Uploading…" })).toBeDisabled();
    await expectDialogFits(page);
    release();

    await expect(dialog(page)).toHaveCount(0);
    await expect(toast(page, "Salon prices is processing")).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: /uploaded successfully/i })).toHaveCount(0);
    await expect(docsRegion(page).getByRole("heading")).toHaveText("Documents · 3");
    await expect(tile(page, "Salon prices")).toContainText("Processing");

    const [call] = kb.writes();
    expect(call.route).toBe("POST /api/kb/documents");
    expect(call.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(call.body).toContain('name="file"; filename="Price list.md"');
    expect(call.body).toMatch(/name="title"\r\n\r\nSalon prices\r\n/);
    expectSignedCall(call, account.tenantId);

    // The ingest job finishes; Realtime (subscribed while something processes) reports the change.
    await expect.poll(() => realtime.joins.flatMap((j) => j.changes.map((c) => `${c.table} ${c.filter}`))).toContain(`kb_documents tenant_id=eq.${account.tenantId}`);
    const uploaded = (await storedDocs(request, account.tenantId)).find((d) => d.title === "Salon prices")!;
    expect(uploaded).toMatchObject({ source_type: "upload", status: "processing" });
    await setStatus(request, uploaded.id, "ready");
    realtime.push("kb_documents", { ...uploaded, status: "ready" });
    await expect(tile(page, "Salon prices")).toContainText("Ready");
    await expect(tile(page, "Salon prices")).not.toContainText("Processing");
  });

  test("without Realtime, polls a processing document until it fails, then stops polling", async ({ page, request }) => {
    await page.clock.install();
    await mockRealtime(page, { fail: true });
    const account = await newAccount(request);
    const doc = await addDoc(request, { tenant_id: account.tenantId, source_type: "upload", title: "Scanned brochure.pdf", status: "processing" });
    await openKnowledge(page, account);
    await expect(tile(page, "Scanned brochure.pdf")).toContainText("Processing");

    // The job gives up and writes its reason (backend/src/kb/ingest.ts), which the tile shows as it is.
    await setStatus(request, doc.id, "failed", "This document has no text to learn from.");
    await page.clock.runFor(3_000);
    await expect(tile(page, "Scanned brochure.pdf")).toContainText("Failed");
    await expect(tile(page, "Scanned brochure.pdf")).toContainText("This document has no text to learn from.");

    // Nothing is processing any more: ten minutes later, no further reads.
    const before = (await kbReads(request, account.email)).length;
    await page.clock.runFor(10 * 60_000);
    expect((await kbReads(request, account.email)).length).toBe(before);
  });

  test("stops polling after the polling window and offers Check again", async ({ page, request }) => {
    await page.clock.install();
    await mockRealtime(page, { fail: true });
    const account = await newAccount(request);
    const doc = await addDoc(request, { tenant_id: account.tenantId, source_type: "upload", title: "Long catalogue.pdf", status: "processing" });
    await openKnowledge(page, account);
    await expect(tile(page, "Long catalogue.pdf")).toContainText("Processing");
    // One poll every 3 s, each re-read landing before the next is due, up to the 100-poll window.
    let reads = (await kbReads(request, account.email)).length;
    for (let i = 0; i < 100; i += 1) {
      await page.clock.runFor(3_000);
      // A short back-off: the default one (100 ms before the second look) is paid on each of the 100 rounds and was most of this
      // test's 20 s against a 30 s limit. Every round still waits for its own read and checks the exact count.
      await expect.poll(async () => (await kbReads(request, account.email)).length, { intervals: [20, 50, 100, 250] }).toBe(reads + 1);
      reads += 1;
    }
    await expect(docsRegion(page)).toContainText("Still processing");
    const before = (await kbReads(request, account.email)).length;
    await page.clock.runFor(10 * 60_000);
    expect((await kbReads(request, account.email)).length).toBe(before);

    await setStatus(request, doc.id, "ready");
    await docsRegion(page).getByRole("button", { name: "Check again" }).click();
    await expect(tile(page, "Long catalogue.pdf")).toContainText("Ready");
    await expect(docsRegion(page)).not.toContainText("Still processing");
  });

  test("refuses a file over 5 MB or of another type before sending, and shows the API's file error", async ({ page, request, kb }) => {
    const account = await newAccount(request);
    await openKnowledge(page, account);
    await docsRegion(page).getByRole("button", { name: "Upload" }).click();
    const fileInput = dialog(page).getByLabel("File");

    await fileInput.setInputFiles({ name: "big.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(5 * 1024 * 1024 + 1) });
    await expect(dialog(page).getByText("This file is 5.1 MB. The limit is 5 MB")).toBeVisible();
    await expect(fileInput).toHaveAttribute("aria-invalid", "true");
    await dialog(page).getByRole("button", { name: "Upload" }).click();
    await expect(dialog(page).getByText("This file is 5.1 MB. The limit is 5 MB")).toBeVisible();

    await fileInput.setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: Buffer.from("png") });
    await expect(dialog(page).getByText("Choose a PDF, Word (.docx), text (.txt) or Markdown (.md) file")).toBeVisible();
    await dialog(page).getByRole("button", { name: "Upload" }).click();
    expect(kb.writes()).toEqual([]);

    // The API checks again (it reads the file); its fields.file message goes on the same field.
    kb.fail("POST /api/kb/documents", { status: 400, code: "validation_failed", message: "Check the file.", fields: { file: "This PDF couldn't be opened." } });
    await fileInput.setInputFiles({ name: "locked.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7") });
    await expect(dialog(page).getByText("PDF, Word (.docx), text (.txt) or Markdown (.md), up to 5 MB.")).toBeVisible();
    await dialog(page).getByRole("button", { name: "Upload" }).click();
    await expect(dialog(page).getByText("This PDF couldn't be opened.")).toBeVisible();
    await expect(dialog(page).getByRole("button", { name: "Upload" })).toBeEnabled();
    expect(kb.writes().map((c) => c.route)).toEqual(["POST /api/kb/documents"]);
    await expectDialogFits(page);
    await expectNoHorizontalOverflow(page);
    await dialog(page).getByRole("button", { name: "Cancel" }).click();
    await expect(docsRegion(page).getByRole("heading")).toHaveText("Documents · 0");
  });

  test("a failed document shows the server's reason, and offers Upload again and Delete", async ({ page, request, kb }) => {
    // The new upload is processing, so the page subscribes to Realtime.
    await mockRealtime(page);
    const account = await newAccount(request);
    const reason = "We couldn't reach the embeddings service. Try again in a moment.";
    await addDoc(request, { tenant_id: account.tenantId, source_type: "upload", title: "Brochure.pdf", status: "failed", error: reason });
    await addDoc(request, { tenant_id: account.tenantId, source_type: "upload", title: "Menu.pdf", status: "ready" });
    await openKnowledge(page, account);
    await expect(tile(page, "Brochure.pdf")).toContainText(reason);
    await expect(tile(page, "Brochure.pdf")).not.toContainText("Couldn’t be read");
    await expect(tile(page, "Brochure.pdf").getByRole("button", { name: "Delete Brochure.pdf" })).toBeVisible();
    // Only failed tiles offer Upload again; the file isn't kept, so it opens the upload dialog.
    await expect(tile(page, "Menu.pdf").getByRole("button", { name: /again/ })).toHaveCount(0);
    await tile(page, "Brochure.pdf").getByRole("button", { name: "Upload Brochure.pdf again" }).click();
    await expect(dialog(page)).toContainText("Upload a document");
    await dialog(page).getByLabel("File").setInputFiles({ name: "Brochure.txt", mimeType: "text/plain", buffer: Buffer.from("Bridal package ₹25,000") });
    await dialog(page).getByRole("button", { name: "Upload" }).click();
    await expect(dialog(page)).toHaveCount(0);
    // No title: named after the file without its extension, like the API does.
    await expect(tile(page, "Brochure")).toHaveCount(2);
    await expect(toast(page, "Brochure is processing")).toBeVisible();
    expect(kb.writes().map((c) => c.route)).toEqual(["POST /api/kb/documents"]);
    expectSignedCall(kb.writes()[0], account.tenantId);
    await expectNoHorizontalOverflow(page);
  });

  test("a title over 200 characters is refused before sending, and the API's title error shows on the title field", async ({ page, request, kb }) => {
    const account = await newAccount(request);
    await openKnowledge(page, account);
    await docsRegion(page).getByRole("button", { name: "Upload" }).click();
    await dialog(page).getByLabel("File").setInputFiles({ name: "Prices.md", mimeType: "text/markdown", buffer: Buffer.from("# Prices") });
    const title = dialog(page).getByLabel("Title (optional)");
    await title.fill("x".repeat(201));
    await dialog(page).getByRole("button", { name: "Upload" }).click();
    await expect(dialog(page).getByText("Use at most 200 characters")).toBeVisible();
    await expect(title).toHaveAttribute("aria-invalid", "true");
    expect(kb.writes()).toEqual([]);

    // Typing clears it; exactly 200 is allowed, and the API's own title error goes on the same field.
    await title.fill("x".repeat(200));
    await expect(dialog(page).getByText("Use at most 200 characters")).toHaveCount(0);
    kb.fail("POST /api/kb/documents", { status: 400, code: "validation_failed", message: "Titles can be at most 200 characters.", fields: { title: "Use at most 200 characters." } });
    await dialog(page).getByRole("button", { name: "Upload" }).click();
    await expect(dialog(page).getByText("Use at most 200 characters.")).toBeVisible();
    await expect(title).toHaveAttribute("aria-invalid", "true");
    await expect(dialog(page).getByLabel("File")).not.toHaveAttribute("aria-invalid", "true");
    expect(kb.writes().map((c) => c.route)).toEqual(["POST /api/kb/documents"]);
    await expectDialogFits(page);
  });

  test("when the job can't start (upstream_failed), says so and shows the document the API saved as failed", async ({ page, request, kb }) => {
    const account = await newAccount(request);
    await openKnowledge(page, account);
    await expect(docsRegion(page).getByRole("heading")).toHaveText("Documents · 0");
    // What the API leaves behind: the upload saved, then marked failed because Inngest refused the event.
    await addDoc(request, { tenant_id: account.tenantId, source_type: "upload", title: "Price list", status: "failed", error: "We couldn't start processing this file. Upload it again." });
    kb.fail("POST /api/kb/documents", { status: 502, code: "upstream_failed", message: "We couldn't start processing this file. Upload it again." });

    await docsRegion(page).getByRole("button", { name: "Upload" }).click();
    await dialog(page).getByLabel("File").setInputFiles({ name: "Price list.md", mimeType: "text/markdown", buffer: Buffer.from("# Prices") });
    await dialog(page).getByRole("button", { name: "Upload" }).click();
    await expect(dialog(page).getByRole("alert")).toContainText("Couldn't upload the document");
    await expect(dialog(page).getByRole("alert")).toContainText("We couldn't start processing this file. Upload it again.");
    await expect(docsRegion(page).getByRole("heading")).toHaveText("Documents · 1");
    await expect(tile(page, "Price list")).toContainText("Failed");
    await expect(page.getByRole("status").filter({ hasText: /processing/ })).toHaveCount(0);
  });

  test("at 100 documents Upload is off and says why, until one is deleted", async ({ page, request, kb }) => {
    const account = await newAccount(request);
    await addDoc(request, { tenant_id: account.tenantId, source_type: "upload", title: "Old scan.pdf", status: "failed", error: "This document has no text to learn from." });
    for (let i = 1; i < 100; i += 1) await addDoc(request, { tenant_id: account.tenantId, source_type: "upload", title: `Doc ${i}.txt`, status: "ready" });
    await openKnowledge(page, account);
    await expect(docsRegion(page).getByRole("heading")).toHaveText("Documents · 100");
    await expect(docsRegion(page).getByRole("button", { name: "Upload", exact: true })).toBeDisabled();
    await expect(docsRegion(page)).toContainText("You have 100 documents, the most a business can keep. Delete one to upload another.");
    await expect(tile(page, "Old scan.pdf").getByRole("button", { name: "Upload Old scan.pdf again" })).toBeDisabled();

    await tile(page, "Old scan.pdf").getByRole("button", { name: "Delete Old scan.pdf" }).click();
    await dialog(page).getByRole("button", { name: "Delete document" }).click();
    await expect(docsRegion(page).getByRole("heading")).toHaveText("Documents · 99");
    await expect(docsRegion(page).getByRole("button", { name: "Upload", exact: true })).toBeEnabled();
    await expect(docsRegion(page)).not.toContainText("the most a business can keep");
    expect(kb.writes().map((c) => c.route)).toEqual(["DELETE /api/kb/documents/:id"]);
  });

  test("deletes a document after confirming", async ({ page, request, kb }) => {
    const account = await newAccount(request, { docs: true });
    await openKnowledge(page, account);
    await docsRegion(page).getByRole("button", { name: "Delete Bridal price list.pdf" }).click();
    await expect(dialog(page)).toContainText("Delete Bridal price list.pdf?");
    await expectDialogFits(page);
    await dialog(page).getByRole("button", { name: "Delete document" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(toast(page, "Deleted Bridal price list.pdf")).toBeVisible();
    await expect(docsRegion(page).getByRole("heading")).toHaveText("Documents · 1");
    await expect(tile(page, "Bridal price list.pdf")).toHaveCount(0);
    expect(kb.writes().map((c) => c.route)).toEqual(["DELETE /api/kb/documents/:id"]);
    expectSignedCall(kb.writes()[0], account.tenantId);
    expect((await storedDocs(request, account.tenantId)).map((d) => d.title)).toEqual([null]);
  });
});

test.describe("Knowledge base · questions the AI couldn't answer", () => {
  test.use({ storageState: SIGNED_OUT });

  test("loads the open questions, most asked first", async ({ page, request, kb }) => {
    kb.setGaps(GAPS);
    const account = await newAccount(request);
    await openKnowledge(page, account);
    await expect(gapsRegion(page).getByRole("heading")).toHaveText("Questions the AI couldn’t answer · 3");
    const rows = gapsRegion(page).getByText(/^“/);
    await expect(rows).toHaveText(["“Do you do keratin?”", "“Do you open on Sundays?”", "“Is there a student discount?”"]);
    await expect(gapsRegion(page)).toContainText("Asked 4 times · last by Priya");
    await expect(gapsRegion(page)).toContainText("Asked twice · last by +91 98••• ••321");
    await expect(gapsRegion(page)).toContainText(/Asked once(?! · last by)/);
    const [list] = kb.calls.filter((c) => c.route === "GET /api/kb/gaps");
    expectSignedCall(list, account.tenantId);
    await expectNoHorizontalOverflow(page);
  });

  test("answering a question adds it to the FAQs and takes it off the list", async ({ page, request, kb }) => {
    kb.setGaps(GAPS);
    const account = await newAccount(request, { faqs: true });
    await openKnowledge(page, account);
    await gapsRegion(page).getByRole("button", { name: "Add answer: Do you do keratin?" }).click();
    const answer = gapsRegion(page).getByLabel("Answer to “Do you do keratin?”");
    await gapsRegion(page).getByRole("button", { name: "Save answer" }).click();
    await expect(gapsRegion(page).getByText("Write the answer")).toBeVisible();
    expect(kb.writes()).toEqual([]);

    await answer.fill("Yes, from ₹4,500. It takes about 2 hours.");
    const release = kb.hold("POST /api/kb/gaps/:id/answer");
    await gapsRegion(page).getByRole("button", { name: "Save answer" }).click();
    await expect(gapsRegion(page).getByRole("button", { name: "Saving…" })).toBeDisabled();
    release();

    await expect(toast(page, "Added to FAQs")).toBeVisible();
    await expect(gapsRegion(page).getByRole("heading")).toHaveText("Questions the AI couldn’t answer · 2");
    await expect(gapsRegion(page)).not.toContainText("keratin");
    await expect(page.getByRole("heading", { name: "FAQs · 3" })).toBeVisible();
    await faqs(page).getByRole("button", { name: "Do you do keratin?", exact: true }).click();
    await expect(faqs(page)).toContainText("Yes, from ₹4,500. It takes about 2 hours.");

    const [call] = kb.writes();
    expect(call.route).toBe("POST /api/kb/gaps/:id/answer");
    expect(call.path).toBe(`/api/kb/gaps/${GAPS[1].id}/answer`);
    expect(JSON.parse(call.body)).toEqual({ a: "Yes, from ₹4,500. It takes about 2 hours." });
    expectSignedCall(call, account.tenantId);
  });

  test("dismisses a question after confirming", async ({ page, request, kb }) => {
    kb.setGaps([GAPS[0]]);
    const account = await newAccount(request);
    await openKnowledge(page, account);
    const dismiss = gapsRegion(page).getByRole("button", { name: "Dismiss: Do you open on Sundays?" });
    await dismiss.click();
    await expect(dialog(page)).toContainText("Dismiss this question?");
    await expectDialogFits(page);
    await dialog(page).getByRole("button", { name: "Keep it" }).click();
    expect(kb.writes()).toEqual([]);

    await dismiss.click();
    await dialog(page).getByRole("button", { name: "Dismiss question" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(toast(page, "Dismissed the question")).toBeVisible();
    await expect(gapsRegion(page)).toContainText("All caught up. Nothing new to answer.");
    await expect(page.getByRole("heading", { name: "FAQs · 0" })).toBeVisible();
    expect(kb.writes().map((c) => [c.route, c.body])).toEqual([["POST /api/kb/gaps/:id/dismiss", ""]]);
    expectSignedCall(kb.writes()[0], account.tenantId);
  });

  test("failures load and save nothing silently: Try again, and the question stays", async ({ page, request, kb }) => {
    kb.setGaps(GAPS);
    kb.fail("GET /api/kb/gaps", { status: 500, code: "internal", message: "Something went wrong. Try again in a moment." });
    const account = await newAccount(request, { seed: true });
    await openKnowledge(page, account);
    await expect(gapsRegion(page).getByRole("alert")).toContainText("Couldn't load the questions");
    // The rest of the page still works.
    await expect(table(page).locator("tbody tr")).toHaveCount(3);
    kb.fail("GET /api/kb/gaps", null);
    await gapsRegion(page).getByRole("button", { name: "Try again" }).click();
    await expect(gapsRegion(page).getByRole("heading")).toHaveText("Questions the AI couldn’t answer · 3");

    // Closed by someone else meanwhile: the API no longer lists it, so its answer route says not_found.
    await gapsRegion(page).getByRole("button", { name: "Add answer: Do you do keratin?" }).click();
    await gapsRegion(page).getByLabel("Answer to “Do you do keratin?”").fill("Yes.");
    kb.setGaps(GAPS.filter((g) => g.question !== "Do you do keratin?"));
    await gapsRegion(page).getByRole("button", { name: "Save answer" }).click();
    await expect(gapsRegion(page).getByRole("alert")).toContainText("This question no longer exists");
    await expect(gapsRegion(page).getByRole("alert")).not.toContainText("not available yet");
    await expect(gapsRegion(page).getByLabel("Answer to “Do you do keratin?”")).toHaveValue("Yes.");
    await expect(gapsRegion(page).getByRole("heading")).toHaveText("Questions the AI couldn’t answer · 3");

    // Asked again, it's open again (record_kb_gap reopens an answered question). An FAQ with the same
    // question was added meanwhile: conflict, and the question stays open.
    kb.setGaps(GAPS);
    await addDoc(request, { tenant_id: account.tenantId, source_type: "manual", title: "Do you do keratin?", body: "Yes.", status: "ready" });
    await gapsRegion(page).getByRole("button", { name: "Save answer" }).click();
    await expect(gapsRegion(page).getByRole("alert")).toContainText("already answered, or one of your FAQs already asks it");
    await expect(gapsRegion(page).getByRole("heading")).toHaveText("Questions the AI couldn’t answer · 3");
    await expect(toast(page, "Added to FAQs")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });

  test("an answer stored but not prepared for the AI leaves the list, shows as a FAQ not in use, and says how to retry it", async ({ page, request, kb }) => {
    kb.setGaps(GAPS);
    const account = await newAccount(request, { faqs: true });
    await openKnowledge(page, account);
    await expect(gapsRegion(page).getByRole("heading")).toHaveText("Questions the AI couldn’t answer · 3");
    const gapReads = () => kb.calls.filter((c) => c.route === "GET /api/kb/gaps").length;
    const readsBefore = gapReads();

    // The API stores the FAQ and closes the question, then the embedding fails: 502 upstream_failed.
    kb.failEmbedding(true);
    await gapsRegion(page).getByRole("button", { name: "Add answer: Do you do keratin?" }).click();
    await gapsRegion(page).getByLabel("Answer to “Do you do keratin?”").fill("Yes, from ₹4,500.");
    await gapsRegion(page).getByRole("button", { name: "Save answer" }).click();

    const notice = gapsRegion(page).getByRole("alert");
    await expect(notice).toContainText("Answer saved, but the AI can’t use it yet");
    await expect(notice).toContainText("It’s under FAQs, marked “Not in use”. Open it there, choose Edit, then Save changes to try again.");
    await expect(notice).not.toContainText(/answer (it|the question) again|Try again in a moment/);
    await expect(gapsRegion(page).getByRole("heading")).toHaveText("Questions the AI couldn’t answer · 2");
    await expect(gapsRegion(page).getByRole("button", { name: "Add answer: Do you do keratin?" })).toHaveCount(0);
    expect(gapReads()).toBeGreaterThan(readsBefore);
    await expect(page.getByRole("heading", { name: "FAQs · 3" })).toBeVisible();
    await expect(faqs(page).getByRole("button", { name: "Do you do keratin?", exact: true })).toBeVisible();
    await expect(faqs(page).getByText("Not in use: edit to try again")).toHaveCount(1);
    await expect(toast(page, "Added to FAQs")).toHaveCount(0);
    expect(kb.writes().map((c) => c.route)).toEqual(["POST /api/kb/gaps/:id/answer"]);
    await expectNoHorizontalOverflow(page);

    // Retried from the FAQ list, as the notice says: in use, and the notice goes.
    kb.failEmbedding(false);
    await faqs(page).getByRole("button", { name: "Do you do keratin?", exact: true }).click();
    await faqs(page).getByRole("button", { name: "Edit FAQ: Do you do keratin?" }).click();
    await dialog(page).getByRole("button", { name: "Save changes" }).click();
    await expect(toast(page, "Saved the FAQ")).toBeVisible();
    await expect(faqs(page).getByText(/^Not in use/)).toHaveCount(0);
    await expect(notice).toHaveCount(0);
    expect(kb.writes().map((c) => [c.route, JSON.parse(c.body)])).toEqual([
      ["POST /api/kb/gaps/:id/answer", { a: "Yes, from ₹4,500." }],
      ["PATCH /api/kb/faqs/:id", { a: "Yes, from ₹4,500." }],
    ]);
  });
});

// Today's main: the API has none of the knowledge-base routes and answers each with ROUTE_MISSING.
test.describe("Knowledge base · routes not deployed yet", () => {
  test.use({ storageState: SIGNED_OUT });
  const UNAVAILABLE = "Knowledge base is not available yet.";

  test("says the knowledge base isn't available yet, changes nothing, and the rest of the page works", async ({ page, request, kb }) => {
    for (const route of ["GET /api/kb/gaps", "POST /api/kb/faqs", "POST /api/kb/documents"]) kb.fail(route, ROUTE_MISSING);
    const account = await newAccount(request, { seed: true, faqs: true, docs: true });
    await openKnowledge(page, account);

    // Questions: a calm notice, not an error with Try again.
    await expect(gapsRegion(page)).toContainText(UNAVAILABLE);
    await expect(gapsRegion(page)).toContainText("The knowledge-base service is still being connected.");
    await expect(gapsRegion(page).getByRole("alert")).toHaveCount(0);
    await expect(gapsRegion(page).getByRole("button", { name: "Try again" })).toHaveCount(0);
    // Everything read under RLS still shows.
    await expect(table(page).locator("tbody tr")).toHaveCount(3);
    await expect(faqs(page).getByRole("heading")).toHaveText("FAQs · 2");
    await expect(docsRegion(page).getByRole("heading")).toHaveText("Documents · 2");

    // Adding an FAQ: refused as not available, never as "no longer exists"; what was typed stays.
    await faqs(page).getByRole("button", { name: "Add", exact: true }).click();
    await dialog(page).getByLabel("Question").fill("Do you take card payments?");
    await dialog(page).getByLabel("Answer").fill("Yes.");
    await dialog(page).getByRole("button", { name: "Add FAQ" }).click();
    await expect(dialog(page).getByRole("alert")).toContainText(UNAVAILABLE);
    await expect(dialog(page).getByRole("alert")).toContainText("Nothing was changed.");
    await expect(dialog(page).getByRole("alert")).not.toContainText("no longer exists");
    await expect(dialog(page).getByLabel("Answer")).toHaveValue("Yes.");
    await expectDialogFits(page);
    await dialog(page).getByRole("button", { name: "Cancel" }).click();
    // The section then says so and switches its changes off.
    await expect(faqs(page)).toContainText(UNAVAILABLE);
    await expect(faqs(page).getByRole("button", { name: "Add", exact: true })).toBeDisabled();
    await expect(faqs(page).getByRole("button", { name: "Edit FAQ: Do you do home visits?" })).toBeDisabled();
    await expect(faqs(page).getByRole("button", { name: "Delete FAQ: Do you do home visits?" })).toBeDisabled();
    await expect(toast(page, "Added")).toHaveCount(0);

    // Uploading: the same.
    await docsRegion(page).getByRole("button", { name: "Upload" }).click();
    await dialog(page).getByLabel("File").setInputFiles({ name: "Price list.md", mimeType: "text/markdown", buffer: Buffer.from("# Prices") });
    await dialog(page).getByRole("button", { name: "Upload" }).click();
    await expect(dialog(page).getByRole("alert")).toContainText(UNAVAILABLE);
    await expect(dialog(page).getByRole("alert")).not.toContainText("no longer exists");
    await expectDialogFits(page);
    await dialog(page).getByRole("button", { name: "Cancel" }).click();
    await expect(docsRegion(page)).toContainText(UNAVAILABLE);
    await expect(docsRegion(page).getByRole("button", { name: "Upload" })).toBeDisabled();
    await expect(docsRegion(page).getByRole("button", { name: "Delete Bridal price list.pdf" })).toBeDisabled();
    await expect(docsRegion(page).getByRole("heading")).toHaveText("Documents · 2");

    // Each refused write was sent once; nothing was stored.
    expect(kb.writes().map((c) => c.route)).toEqual(["POST /api/kb/faqs", "POST /api/kb/documents"]);
    expect(await storedDocs(request, account.tenantId)).toHaveLength(4);
    await expectNoHorizontalOverflow(page);
  });

  test("a not_found for something still listed is the route missing, not the thing gone", async ({ page, request, kb }) => {
    kb.setGaps(GAPS);
    for (const route of ["DELETE /api/kb/faqs/:id", "DELETE /api/kb/documents/:id", "POST /api/kb/gaps/:id/answer", "POST /api/kb/gaps/:id/dismiss"]) {
      kb.fail(route, ROUTE_MISSING);
    }
    const account = await newAccount(request, { faqs: true, docs: true });
    await openKnowledge(page, account);
    await expect(gapsRegion(page).getByRole("heading")).toHaveText("Questions the AI couldn’t answer · 3");

    // The FAQ is still stored, so the 404 came from a route that isn't there.
    await faqs(page).getByRole("button", { name: "Delete FAQ: Do you do home visits?" }).click();
    await dialog(page).getByRole("button", { name: "Delete FAQ" }).click();
    await expect(dialog(page).getByRole("alert")).toContainText(UNAVAILABLE);
    await expect(dialog(page).getByRole("alert")).not.toContainText("no longer exists");
    await dialog(page).getByRole("button", { name: "Keep it" }).click();
    await expect(faqs(page).getByRole("heading")).toHaveText("FAQs · 2");
    await expect(faqs(page)).toContainText(UNAVAILABLE);

    await docsRegion(page).getByRole("button", { name: "Delete Bridal price list.pdf" }).click();
    await dialog(page).getByRole("button", { name: "Delete document" }).click();
    await expect(dialog(page).getByRole("alert")).toContainText(UNAVAILABLE);
    await dialog(page).getByRole("button", { name: "Keep it" }).click();
    await expect(tile(page, "Bridal price list.pdf")).toBeVisible();
    await expect(docsRegion(page)).toContainText(UNAVAILABLE);

    // The question is still listed by the API, so its answer and dismiss routes are what's missing.
    await gapsRegion(page).getByRole("button", { name: "Add answer: Do you do keratin?" }).click();
    await gapsRegion(page).getByLabel("Answer to “Do you do keratin?”").fill("Yes.");
    await gapsRegion(page).getByRole("button", { name: "Save answer" }).click();
    await expect(gapsRegion(page).getByRole("alert")).toContainText(UNAVAILABLE);
    await expect(gapsRegion(page).getByRole("alert")).not.toContainText("no longer exists");
    await expect(gapsRegion(page).getByLabel("Answer to “Do you do keratin?”")).toHaveValue("Yes.");
    await gapsRegion(page).getByRole("button", { name: "Cancel" }).click();
    await gapsRegion(page).getByRole("button", { name: "Dismiss: Is there a student discount?" }).click();
    await dialog(page).getByRole("button", { name: "Dismiss question" }).click();
    await expect(dialog(page).getByRole("alert")).toContainText(UNAVAILABLE);
    await dialog(page).getByRole("button", { name: "Keep it" }).click();
    await expect(gapsRegion(page).getByRole("heading")).toHaveText("Questions the AI couldn’t answer · 3");

    expect(kb.writes().map((c) => c.route)).toEqual([
      "DELETE /api/kb/faqs/:id",
      "DELETE /api/kb/documents/:id",
      "POST /api/kb/gaps/:id/answer",
      "POST /api/kb/gaps/:id/dismiss",
    ]);
    expect(await storedDocs(request, account.tenantId)).toHaveLength(4);
    await expect(toast(page, "Deleted")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("Knowledge base · who can change it", () => {
  test.use({ storageState: SIGNED_OUT });

  test.describe("admin", () => {
    test.use({ kbRole: "admin" });

    test("an admin can add, edit, delete, upload, answer and dismiss", async ({ page, request, kb }) => {
      kb.setGaps([GAPS[0]]);
      const account = await newAccount(request, { faqs: true, docs: true, role: "admin" });
      await openKnowledge(page, account);
      await expect(faqs(page).getByRole("button", { name: "Add", exact: true })).toBeEnabled();
      await expect(faqs(page).getByRole("button", { name: "Edit FAQ: Do you do home visits?" })).toBeEnabled();
      await expect(docsRegion(page).getByRole("button", { name: "Upload" })).toBeEnabled();
      await expect(docsRegion(page).getByRole("button", { name: "Delete Bridal price list.pdf" })).toBeEnabled();
      await expect(gapsRegion(page).getByRole("button", { name: "Dismiss: Do you open on Sundays?" })).toBeEnabled();

      await faqs(page).getByRole("button", { name: "Add", exact: true }).click();
      await dialog(page).getByLabel("Question").fill("Do you do threading?");
      await dialog(page).getByLabel("Answer").fill("Yes, ₹50.");
      await dialog(page).getByRole("button", { name: "Add FAQ" }).click();
      await expect(toast(page, "Added to FAQs")).toBeVisible();
      expectSignedCall(kb.writes()[0], account.tenantId);
    });
  });

  test.describe("staff", () => {
    test.use({ kbRole: "staff" });

    test("staff can answer questions, and read FAQs and documents without changing them", async ({ page, request, kb }) => {
      kb.setGaps(GAPS);
      const account = await newAccount(request, { faqs: true, docs: true, role: "staff" });
      await openKnowledge(page, account);
      await expect(page.getByRole("heading", { name: "FAQs · 2" })).toBeVisible();
      await expect(faqs(page)).toContainText("Yes, within 5 km of the studio");
      await expect(faqs(page).getByRole("button", { name: "Add", exact: true })).toBeDisabled();
      await expect(faqs(page).getByText("Only an owner or admin can change FAQs.")).toBeVisible();
      await expect(faqs(page).getByRole("button", { name: /^(Edit|Delete) FAQ/ })).toHaveCount(0);

      await expect(docsRegion(page).getByRole("listitem")).toHaveCount(2);
      await expect(docsRegion(page).getByRole("button", { name: "Upload" })).toBeDisabled();
      await expect(docsRegion(page).getByText("Only an owner or admin can upload or delete documents.")).toBeVisible();
      await expect(docsRegion(page).getByRole("button", { name: /^Delete/ })).toHaveCount(0);
      await expect(page.locator('input[type="file"]')).toHaveCount(0);

      expect(kb.writes()).toEqual([]);
      await expectNoHorizontalOverflow(page);

      // Any team member can answer a question (section 9, Raja 7 Oct); dismissing stays with owner and admin.
      await expect(gapsRegion(page).getByRole("heading")).toHaveText("Questions the AI couldn’t answer · 3");
      await expect(gapsRegion(page)).toContainText("Answer once and the AI uses it from then on");
      await expect(gapsRegion(page).getByRole("button", { name: /^Dismiss/ })).toHaveCount(0);
      await gapsRegion(page).getByRole("button", { name: "Add answer: Do you open on Sundays?" }).click();
      await gapsRegion(page).getByLabel("Answer to “Do you open on Sundays?”").fill("Yes, 10 am to 6 pm.");
      await gapsRegion(page).getByRole("button", { name: "Save answer" }).click();
      await expect(toast(page, "Added to FAQs")).toBeVisible();
      await expect(gapsRegion(page).getByRole("heading")).toHaveText("Questions the AI couldn’t answer · 2");
      await expect(page.getByRole("heading", { name: "FAQs · 3" })).toBeVisible();
      expect(kb.writes().map((c) => c.route)).toEqual(["POST /api/kb/gaps/:id/answer"]);
      expectSignedCall(kb.writes()[0], account.tenantId);
    });

    test("staff whose answer couldn't be prepared for the AI are told an owner or admin has to retry it", async ({ page, request, kb }) => {
      kb.setGaps(GAPS);
      const account = await newAccount(request, { faqs: true, role: "staff" });
      await openKnowledge(page, account);
      kb.failEmbedding(true);
      await gapsRegion(page).getByRole("button", { name: "Add answer: Do you open on Sundays?" }).click();
      await gapsRegion(page).getByLabel("Answer to “Do you open on Sundays?”").fill("Yes, 10 am to 6 pm.");
      await gapsRegion(page).getByRole("button", { name: "Save answer" }).click();

      const notice = gapsRegion(page).getByRole("alert");
      await expect(notice).toContainText("Answer saved, but the AI can’t use it yet");
      await expect(notice).toContainText("An owner or admin needs to open it there and save it again.");
      await expect(notice).not.toContainText(/Edit|answer (it|the question) again/);
      await expect(gapsRegion(page).getByRole("heading")).toHaveText("Questions the AI couldn’t answer · 2");
      await expect(page.getByRole("heading", { name: "FAQs · 3" })).toBeVisible();
      await expect(faqs(page).getByText("Not in use: an owner or admin can save it again")).toHaveCount(1);
      await expect(faqs(page).getByRole("button", { name: /^(Edit|Delete) FAQ/ })).toHaveCount(0);
      expect(kb.writes().map((c) => c.route)).toEqual(["POST /api/kb/gaps/:id/answer"]);
      await expectNoHorizontalOverflow(page);
    });
  });
});

test.describe("Knowledge base · failed reads", () => {
  test.use({ storageState: SIGNED_OUT });

  test("failed FAQ and document reads show errors with Try again, and the rest of the page still works", async ({ page, request }) => {
    const account = await newAccount(request, { seed: true, docsError: true });
    await openKnowledge(page, account);
    await expect(faqs(page).getByRole("alert")).toContainText("Couldn't load the FAQs");
    await expect(faqs(page).getByRole("button", { name: "Add", exact: true })).toBeDisabled();
    await expect(docsRegion(page).getByRole("alert")).toContainText("Couldn't load your documents");
    await expect(docsRegion(page).getByRole("button", { name: "Upload" })).toBeDisabled();
    for (const region of [faqs(page), docsRegion(page)]) {
      await expect(region.getByRole("alert")).not.toContainText(/boom|unexpected shape/);
      await region.getByRole("button", { name: "Try again" }).click();
      await expect(region.getByRole("alert")).toBeVisible();
    }
    await expect(table(page).locator("tbody tr")).toHaveCount(3);
    await expectNoHorizontalOverflow(page);
  });
});
