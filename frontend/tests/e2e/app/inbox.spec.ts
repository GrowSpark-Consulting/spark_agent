import type { Page, WebSocketRoute } from "@playwright/test";
import { appAlert, expect, expectNoHorizontalOverflow, mainNav, MOCK_SUPABASE_URL, SIGNED_OUT, signIn, test } from "../support/app";

// The real inbox at /dashboard/inbox, against mock-supabase.mjs (inbox@test.local has four chats in
// "Inbox Realty"). Supabase Realtime is emulated per test with page.routeWebSocket, speaking the Phoenix
// protocol realtime-js uses, so the app's real subscription code runs.

const INBOX_TENANT = "10000000-0000-0000-0000-000000000004";
const cid = (n: number) => `40000000-0000-0000-0000-00000000000${n}`;
const isMobile = (page: Page) => (page.viewportSize()?.width ?? 1440) < 720;

type Join = { topic: string; joinRef: string; accessToken: string; changes: { id: number; event: string; schema: string; table: string; filter?: string }[] };

/** Answers the realtime socket: joins succeed (or fail), and the test can push row changes. */
async function mockRealtime(page: Page, { fail = false } = {}) {
  const joins: Join[] = [];
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => {
    socket = ws;
    ws.onMessage((raw) => {
      const [joinRef, ref, topic, event, payload] = JSON.parse(String(raw));
      const reply = (status: string, response: unknown) => ws.send(JSON.stringify([joinRef, ref, topic, "phx_reply", { status, response }]));
      if (event === "heartbeat" || event === "phx_leave") reply("ok", {});
      else if (event === "phx_join") {
        if (fail) return reply("error", { reason: "Unable to subscribe to changes with given parameters" });
        const changes = payload.config.postgres_changes.map((f: Omit<Join["changes"][number], "id">, i: number) => ({ ...f, id: i + 1 }));
        joins.push({ topic, joinRef, accessToken: payload.access_token, changes });
        reply("ok", { postgres_changes: changes });
      }
    });
  });
  return {
    joins,
    push(table: string, type: "INSERT" | "UPDATE", record: Record<string, unknown>) {
      const join = joins[joins.length - 1];
      const ids = join.changes.filter((c) => c.table === table && c.event === type).map((c) => c.id);
      socket!.send(JSON.stringify([null, null, join.topic, "postgres_changes", {
        ids,
        data: { type, schema: "public", table, commit_timestamp: new Date().toISOString(), columns: [], record, errors: null },
      }]));
    },
  };
}

const row = (page: Page, name: string | RegExp) => page.getByTestId("inbox").getByRole("button", { name });
const chatLog = (page: Page) => page.getByRole("log");

async function openInbox(page: Page, email = "inbox@test.local") {
  await signIn(page, email, "/dashboard/inbox");
  await expect(page).toHaveURL(/\/dashboard\/inbox/);
}

test.describe("Inbox", () => {
  test.use({ storageState: SIGNED_OUT });

  test("lists the business's chats, newest first, with AI / Needs human / Human tags", async ({ page }) => {
    await mockRealtime(page);
    await openInbox(page);
    await expect(mainNav(page).getByRole("link", { name: "Inbox", exact: true })).toHaveAttribute("aria-current", "page");

    const rows = page.locator(".app-inbox-row");
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText("Karthik R");
    await expect(rows.nth(0)).toContainText("Needs human");
    await expect(rows.nth(0)).toContainText("Can I talk to someone about the price?");
    await expect(rows.nth(1)).toContainText("Priya S");
    await expect(rows.nth(1)).toContainText("AI: Hi Priya!");
    await expect(rows.nth(1).locator("span").filter({ hasText: /^AI$/ })).toBeVisible();
    await expect(rows.nth(2)).toContainText("Lakshmi V");
    await expect(rows.nth(2)).toContainText("Human");
    await expect(rows.nth(2)).toContainText("Staff: Yes ma’am");
    // No name: the masked number stands in; the full number never appears.
    await expect(rows.nth(3)).toContainText("+91 90xxx xxx52");
    await expect(rows.nth(3)).toContainText("Own number");
    await expect(page.locator("body")).not.toContainText("9000000052");
    // No persona name is invented, and unread isn't faked.
    await expect(page.getByTestId("inbox")).not.toContainText("Maya");
    await expect(page.getByRole("button", { name: "Unread" })).toBeDisabled();
    await expectNoHorizontalOverflow(page);
  });

  test("opens a chat with the prototype's bubbles, labels and strips", async ({ page }) => {
    await mockRealtime(page);
    await openInbox(page);
    await row(page, /Karthik R/).click();

    const log = chatLog(page);
    await expect(log).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`chat=${cid(1)}`));
    await expect(log.getByText("TODAY")).toBeVisible();
    await expect(log.getByText("Velachery la 3BHK irukka? Ready to move venum")).toBeVisible();
    await expect(log.locator('[data-sender="customer"]').first()).toHaveCSS("align-self", "flex-start");
    const ai = log.locator('[data-sender="ai"]');
    await expect(ai).toHaveCSS("align-self", "flex-end");
    await expect(ai).toContainText(/^AI/);
    await expect(log.getByText("Handed to team · asked for a person")).toBeVisible();
    await expect(page.getByText("Needs you:")).toBeVisible();
    await expect(page.getByText("asked to talk to a person.")).toBeVisible();

    // The AI has this chat: the switch is live (AI is the pressed one), and there is no reply box until a
    // person takes over.
    const switchGroup = page.getByRole("group", { name: "Who replies" });
    await expect(switchGroup.getByRole("button", { name: "AI" })).toBeEnabled();
    await expect(switchGroup.getByRole("button", { name: "AI" })).toHaveAttribute("aria-pressed", "true");
    await expect(switchGroup.getByRole("button", { name: "Human" })).toBeEnabled();
    await expect(page.getByText("AI is replying. Switch to Human to reply.")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send" })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    // A chat whose 24-hour window has closed, answered by staff.
    if (isMobile(page)) await page.getByRole("button", { name: "Back" }).click();
    await row(page, /Lakshmi V/).click();
    await expect(chatLog(page).locator('[data-sender="staff"]')).toContainText(/^Staff/);
    await expect(page.getByText("24-hour window closed.")).toBeVisible();
    await expect(page.getByText("Lakshmi last wrote on")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);
    await expect(page.getByText("A team member is replying.")).toBeVisible();
  });

  test("shows each kind of inbound WhatsApp message, without downloading anything", async ({ page }) => {
    await mockRealtime(page);
    await openInbox(page);
    await row(page, /Priya S/).click();
    const log = chatLog(page);
    const bubble = (kind: string) => log.locator(`[data-kind="${kind}"]`);

    // Text, before and after, is unchanged.
    await expect(log.getByText("Hi, OMR 2BHK price enna?")).toBeVisible();
    await expect(log.getByText("Hi Priya! 2BHKs on OMR start from ₹62 L.")).toBeVisible();

    const images = bubble("image");
    await expect(images).toHaveCount(2);
    await expect(images.nth(0)).toContainText("IMG");
    await expect(images.nth(0)).toContainText("Photo");
    await expect(images.nth(0)).toContainText("Can't be shown here yet");
    await expect(images.nth(0)).toContainText("This one, near the lake?");
    await expect(images.nth(1)).toContainText("Photo");
    await expect(images.nth(1)).not.toContainText("lake");

    await expect(bubble("document")).toContainText("PDF");
    await expect(bubble("document")).toContainText("Document");
    await expect(bubble("document")).toContainText("Can't be opened here yet");
    await expect(bubble("document")).toContainText("My salary slip");

    await expect(bubble("audio")).toContainText("Voice message");
    await expect(bubble("audio")).toContainText("Can't be played here yet");

    await expect(bubble("location")).toContainText("Phoenix Marketcity Velachery Main Road, Chennai");
    await expect(bubble("location")).toContainText("12.9791, 80.2209");
    await expect(bubble("location")).not.toContainText("12.9791,80.2209");

    await expect(bubble("unsupported")).toHaveText(/Message type not supported \(sticker\)/);
    await expect(bubble("interactive")).toContainText("Book a site visit");

    // All from the customer, on the left; no image, player or link to a file that wasn't downloaded.
    for (const kind of ["image", "document", "audio", "location", "unsupported", "interactive"]) {
      for (const b of await bubble(kind).all()) {
        await expect(b).toHaveAttribute("data-sender", "customer");
        await expect(b).toHaveCSS("align-self", "flex-start");
      }
    }
    await expect(log.locator("img, audio, video, a")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    // Both reads ask for kind and meta.
    const rest = await (await page.request.get(`${MOCK_SUPABASE_URL}/__mock/rest-log?email=inbox@test.local`)).json();
    const selects = (rest as { table: string; query: string }[])
      .filter((r) => r.table === "conversations" || r.table === "messages")
      .map((r) => new URLSearchParams(r.query).get("select") ?? "");
    expect(selects.length).toBeGreaterThan(0);
    for (const s of selects) expect(s).toMatch(/\bkind\b[\s\S]*\bmeta\b/);
  });

  test("a live sticker or voice message shows the same way in the chat and the list", async ({ page }) => {
    const realtime = await mockRealtime(page);
    await openInbox(page);
    await row(page, /Lakshmi V/).click();
    await expect(chatLog(page)).toContainText("Visit ku varen");
    await expect.poll(() => realtime.joins.length).toBe(1);

    const base = {
      tenant_id: INBOX_TENANT, conversation_id: cid(3), direction: "in", sender: "customer", template_name: null,
      delivery_status: null, created_at: new Date().toISOString(),
    };
    realtime.push("messages", "INSERT", {
      ...base, id: "41000000-0000-0000-0000-000000000911", kind: "audio", body: null, media: { id: "media-911", mime: "audio/ogg; codecs=opus" }, meta: {},
    });
    await expect(chatLog(page).locator('[data-kind="audio"]')).toContainText("Voice message");
    realtime.push("messages", "INSERT", {
      ...base, id: "41000000-0000-0000-0000-000000000912", kind: "unsupported", body: null, media: null, meta: { unsupportedType: "sticker" },
      created_at: new Date(Date.now() + 1000).toISOString(),
    });
    await expect(chatLog(page).locator('[data-kind="unsupported"]')).toHaveText(/Message type not supported \(sticker\)/);

    if (isMobile(page)) await page.getByRole("button", { name: "Back" }).click();
    await expect(page.locator(".app-inbox-row").first()).toContainText("Lakshmi V");
    await expect(page.locator(".app-inbox-row").first()).toContainText("Message type not supported (sticker)");
  });

  test("filters and search", async ({ page }) => {
    await mockRealtime(page);
    await openInbox(page);
    await expect(page.getByRole("button", { name: "All 4" })).toBeVisible();
    await page.getByRole("button", { name: "Needs human 1" }).click();
    await expect(page.locator(".app-inbox-row")).toHaveCount(1);
    await expect(row(page, /Karthik R/)).toBeVisible();
    await page.getByRole("button", { name: "AI handling 1" }).click();
    await expect(page.locator(".app-inbox-row")).toHaveCount(1);
    await expect(row(page, /Priya S/)).toBeVisible();
    await page.getByRole("button", { name: "All 4" }).click();
    await page.getByRole("searchbox", { name: "Search name or number" }).fill("lak");
    await expect(page.locator(".app-inbox-row")).toHaveCount(1);
    await page.getByRole("searchbox", { name: "Search name or number" }).fill("00000037");
    await expect(row(page, /Priya S/)).toBeVisible();
    await expect(page.locator(".app-inbox-row")).toHaveCount(1);
    await page.getByRole("searchbox", { name: "Search name or number" }).fill("nobody");
    await expect(page.getByText("No chats here right now.")).toBeVisible();
  });

  test("phones show one column at a time", async ({ page }) => {
    test.skip(!isMobile(page), "phone layout only");
    await mockRealtime(page);
    await openInbox(page);
    await expect(page.locator(".app-inbox-list")).toBeVisible();
    await expect(page.locator(".app-inbox-chat")).toBeHidden();
    await row(page, /Priya S/).click();
    await expect(page.locator(".app-inbox-list")).toBeHidden();
    await expect(chatLog(page)).toContainText("Hi Priya! 2BHKs on OMR start from ₹62 L.");
    await expectNoHorizontalOverflow(page);
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.locator(".app-inbox-list")).toBeVisible();
    await expect(page).not.toHaveURL(/chat=/);
  });

  test("wide screens show the list and the first chat side by side", async ({ page }) => {
    test.skip(isMobile(page), "tablet and desktop layout");
    await mockRealtime(page);
    await openInbox(page);
    await expect(page.locator(".app-inbox-list")).toBeVisible();
    await expect(chatLog(page)).toContainText("Can I talk to someone about the price?");
    await expect(page.getByRole("button", { name: "Back" })).toBeHidden();
    // The inbox fills the window; the list and the chat scroll on their own.
    const box = await page.getByTestId("inbox").boundingBox();
    expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(page.viewportSize()!.height);
  });

  test("subscribes once, as the member, to the business's own rows", async ({ page }) => {
    const realtime = await mockRealtime(page);
    await openInbox(page);
    await expect.poll(() => realtime.joins.length).toBe(1);
    const [join] = realtime.joins;
    expect(join.topic).toBe(`realtime:inbox:${INBOX_TENANT}`);
    expect(join.changes.map((c) => `${c.table}:${c.event}:${c.filter}`).sort()).toEqual(
      ["conversations", "handoffs", "messages"].flatMap((t) => [`${t}:INSERT:tenant_id=eq.${INBOX_TENANT}`, `${t}:UPDATE:tenant_id=eq.${INBOX_TENANT}`]).sort(),
    );
    // The member's JWT, not the anonymous key: Realtime applies their RLS.
    expect(JSON.parse(Buffer.from(join.accessToken.split(".")[1], "base64url").toString()).email).toBe("inbox@test.local");

    // Every read names the session's business.
    const log = await (await page.request.get(`${MOCK_SUPABASE_URL}/__mock/rest-log?email=inbox@test.local`)).json();
    const reads = (log as { table: string; query: string }[]).filter((r) => r.table === "conversations" || r.table === "messages");
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) expect(decodeURIComponent(r.query)).toContain(`tenant_id=eq.${INBOX_TENANT}`);
  });

  test("live changes update the list and the open chat, once each, in time order", async ({ page }) => {
    const realtime = await mockRealtime(page);
    await openInbox(page);
    await row(page, /Priya S/).click();
    await expect(chatLog(page)).toContainText("Hi Priya!");
    await expect.poll(() => realtime.joins.length).toBe(1);

    const message = {
      id: "41000000-0000-0000-0000-000000000901", tenant_id: INBOX_TENANT, conversation_id: cid(2), direction: "in",
      sender: "customer", body: "Is there parking?", media: null, template_name: null, delivery_status: null,
      created_at: new Date().toISOString().replace("T", " ").replace("Z", "+00"),
    };
    realtime.push("messages", "INSERT", message);
    realtime.push("messages", "INSERT", message); // a duplicate delivery
    await expect(chatLog(page).getByText("Is there parking?")).toHaveCount(1);
    await expect(page.locator(".app-inbox-row").first()).toContainText("Priya S");
    await expect(page.locator(".app-inbox-row").first()).toContainText("Is there parking?");

    // An older message arriving late goes above it, not below.
    realtime.push("messages", "INSERT", { ...message, id: "41000000-0000-0000-0000-000000000902", body: "Sent earlier", created_at: new Date(Date.now() - 60 * 60_000).toISOString() });
    await expect(chatLog(page).getByText("Sent earlier")).toBeVisible();
    const order = await chatLog(page).locator("[data-sender]").allInnerTexts();
    expect(order.findIndex((t) => t.includes("Sent earlier"))).toBeLessThan(order.findIndex((t) => t.includes("Is there parking?")));
    await expect(page.locator(".app-inbox-row").first()).toContainText("Is there parking?");

    // A handoff opens: the chat now needs a person.
    realtime.push("handoffs", "INSERT", { id: "42000000-0000-0000-0000-000000000902", tenant_id: INBOX_TENANT, conversation_id: cid(2), trigger: "negotiation", resolved_at: null });
    await expect(page.getByText("wants to negotiate the price.")).toBeVisible();

    // Staff take over (mode change on the conversation), then the handoff is resolved.
    realtime.push("conversations", "UPDATE", { id: cid(2), tenant_id: INBOX_TENANT, mode: "human", status: "open", last_customer_msg_at: new Date().toISOString() });
    await expect(page.getByText("wants to negotiate the price.")).toBeVisible(); // an open handoff still wins
    realtime.push("handoffs", "UPDATE", { id: "42000000-0000-0000-0000-000000000902", tenant_id: INBOX_TENANT, conversation_id: cid(2), trigger: "negotiation", resolved_at: new Date().toISOString() });
    await expect(page.getByText("A team member is replying.")).toBeVisible();

    // A row for another business is ignored even if it were delivered.
    realtime.push("messages", "INSERT", { ...message, id: "41000000-0000-0000-0000-000000000903", tenant_id: "10000000-0000-0000-0000-000000000001", body: "Not yours" });
    await expect(page.getByText("Not yours")).toHaveCount(0);

    // The list (on phones, back from the chat) reflects all of it.
    if (isMobile(page)) await page.getByRole("button", { name: "Back" }).click();
    await expect(page.locator(".app-inbox-row").first()).toContainText("Is there parking?");
    await expect(page.locator(".app-inbox-row").first()).toContainText("Human");
    await expect(page.getByRole("button", { name: "Needs human 1" })).toBeVisible();
    realtime.push("handoffs", "INSERT", { id: "42000000-0000-0000-0000-000000000904", tenant_id: INBOX_TENANT, conversation_id: cid(2), trigger: "stuck", resolved_at: null });
    await expect(page.getByRole("button", { name: "Needs human 2" })).toBeVisible();
  });

  test("says so when live updates aren't connected", async ({ page }) => {
    await mockRealtime(page, { fail: true });
    await openInbox(page);
    await expect(page.getByText("Live updates aren't connected. New messages show when you refresh.")).toBeVisible();
    await expect(page.locator(".app-inbox-row")).toHaveCount(4);
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.locator(".app-inbox-row")).toHaveCount(4);
  });

  test("says it is loading chats while they are read, then lists them", async ({ page }) => {
    await mockRealtime(page);
    // Hold the chats read until the test lets it go (the rest of the traffic goes straight through).
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/rest\/v1\/conversations(\?|$)/, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await gate;
      return route.fallback();
    });
    await openInbox(page);
    await expect(page.getByRole("status").filter({ hasText: "Loading chats" })).toBeVisible();
    await expect(page.locator(".app-inbox-row")).toHaveCount(0);
    await expect(page.getByText("No conversations yet")).toHaveCount(0); // not mistaken for an empty inbox
    release();
    await expect(page.locator(".app-inbox-row")).toHaveCount(4);
    await expect(page.getByRole("status").filter({ hasText: "Loading chats" })).toHaveCount(0);
  });

  test("an inbox with no chats says so", async ({ page }) => {
    await mockRealtime(page);
    await openInbox(page, "owner@test.local");
    await expect(page.getByText("No conversations yet")).toBeVisible();
    await expect(page.getByText("Your first chat will open here")).toBeVisible({ visible: !isMobile(page) });
    await expect(page.locator(".app-inbox-row")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });

  test("a failed read shows an error with Try again", async ({ page }) => {
    await mockRealtime(page);
    await openInbox(page, "inboxerror@test.local");
    await expect(appAlert(page)).toContainText("Couldn't load your chats");
    await expect(appAlert(page)).toContainText("Something went wrong. Try again in a moment.");
    await expect(appAlert(page)).not.toContainText(/boom|unexpected shape/);
    await expect(appAlert(page).getByRole("button", { name: "Try again" })).toBeVisible();
  });
});

const REPLY_PATH = new RegExp(`/api/conversations/${cid(1)}/messages$`);
const MODE_PATH = new RegExp(`/api/conversations/${cid(1)}/mode$`);

type ModeCall = { method: string; tenant: string | null; authorization: string | null; body: string };
type ModeAnswer = { status: number; body: unknown };

/** Stands in for POST /api/conversations/:id/mode (backend/src/conversations/mode.ts). Answers call n with `answer(n)`. */
async function mockMode(page: Page, answer: (n: number) => ModeAnswer | Promise<ModeAnswer> = () => ({ status: 200, body: { mode: "human", changed: true } })) {
  const calls: ModeCall[] = [];
  await page.route(MODE_PATH, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fallback();
    calls.push({ method: req.method(), tenant: req.headers()["x-pakka-tenant"] ?? null, authorization: req.headers()["authorization"] ?? null, body: req.postData() ?? "" });
    const result = await answer(calls.length);
    return route.fulfill({ status: result.status, contentType: "application/json", body: JSON.stringify(result.body) });
  });
  return calls;
}
const modeBody = (call: ModeCall) => JSON.parse(call.body);
const whoReplies = (page: Page) => page.getByRole("group", { name: "Who replies" });
const noteRow = (id: string, body: string, event: string) => ({
  id, tenant_id: INBOX_TENANT, conversation_id: cid(1), direction: "out", sender: "system", body, media: null, template_name: null,
  delivery_status: null, meta: { event }, created_at: new Date().toISOString().replace("T", " ").replace("Z", "+00"),
});

test.describe("Inbox · staff reply", () => {
  test.use({ storageState: SIGNED_OUT });

  type Reply = { status: number; body: unknown } | "abort";
  type Sent = { method: string; tenant: string | null; authorization: string | null; body: string };

  /** Stands in for POST /api/conversations/:id/messages (backend/src/conversations/staff-reply.ts). */
  async function mockReply(page: Page, answer: (n: number) => Reply | Promise<Reply>) {
    const sent: Sent[] = [];
    await page.route(REPLY_PATH, async (route) => {
      const req = route.request();
      if (req.method() === "OPTIONS") return route.fallback();
      sent.push({ method: req.method(), tenant: req.headers()["x-pakka-tenant"] ?? null, authorization: req.headers()["authorization"] ?? null, body: req.postData() ?? "" });
      const result = await answer(sent.length);
      if (result === "abort") return route.abort("failed");
      return route.fulfill({ status: result.status, contentType: "application/json", body: JSON.stringify(result.body) });
    });
    return sent;
  }
  const accepted = { status: 200, body: { messageId: "41000000-0000-0000-0000-000000000801", providerMsgId: "wamid.OUT", status: "accepted" } };
  const refusal = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });

  /** The composer's own notice; Next's route announcer is also a role=alert. */
  const notice = (page: Page) => page.locator('form [role="alert"]');

  /** Karthik's chat starts with the AI; a person takes it over (the mode route is stood in for), which opens the reply box. */
  async function openKarthik(page: Page) {
    const realtime = await mockRealtime(page);
    await mockMode(page);
    await openInbox(page);
    await row(page, /Karthik R/).click();
    await expect(page.getByText("AI is replying. Switch to Human to reply.")).toBeVisible();
    await whoReplies(page).getByRole("button", { name: "Human" }).click();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
    return realtime;
  }

  test("sends the trimmed text as the member, clears the box, and leaves the chat to realtime", async ({ page }) => {
    const sent = await mockReply(page, () => accepted);
    const realtime = await openKarthik(page);
    const box = page.getByRole("textbox", { name: "Message" });
    await box.fill("  Namaste Karthik, the 3BHK is ready.  ");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(box).toHaveValue("");
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe("POST");
    expect(sent[0].tenant).toBe(INBOX_TENANT);
    expect(sent[0].authorization).toMatch(/^Bearer /);
    expect(JSON.parse(sent[0].body)).toEqual({ body: "Namaste Karthik, the 3BHK is ready." });
    // Nothing is drawn until the stored row arrives, and then it appears once.
    await expect(chatLog(page).getByText("Namaste Karthik, the 3BHK is ready.")).toHaveCount(0);
    const message = {
      id: "41000000-0000-0000-0000-000000000801", tenant_id: INBOX_TENANT, conversation_id: cid(1), direction: "out",
      sender: "staff", body: "Namaste Karthik, the 3BHK is ready.", media: null, template_name: null, delivery_status: "accepted",
      created_at: new Date().toISOString().replace("T", " ").replace("Z", "+00"),
    };
    await expect.poll(() => realtime.joins.length).toBe(1);
    realtime.push("messages", "INSERT", message);
    realtime.push("messages", "INSERT", message);
    await expect(chatLog(page).getByText("Namaste Karthik, the 3BHK is ready.")).toHaveCount(1);
    await expectNoHorizontalOverflow(page);
  });

  test("Enter sends, Shift+Enter adds a line, and a double Enter sends once", async ({ page }) => {
    const sent = await mockReply(page, async () => {
      await new Promise((r) => setTimeout(r, 400));
      return accepted;
    });
    await openKarthik(page);
    const box = page.getByRole("textbox", { name: "Message" });
    await box.fill("Line one");
    await box.press("Shift+Enter");
    await box.pressSequentially("Line two");
    expect(sent).toHaveLength(0);
    await box.press("Enter");
    await box.press("Enter");
    await expect(box).toHaveValue("");
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0].body)).toEqual({ body: "Line one\nLine two" });
  });

  test("keeps the draft and says nothing was sent when the API refuses", async ({ page }) => {
    const sent = await mockReply(page, () => refusal(409, "outside_window", "This customer hasn't written in the last 24 hours, so WhatsApp only allows an approved template."));
    await openKarthik(page);
    const box = page.getByRole("textbox", { name: "Message" });
    await box.fill("Are you still interested?");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(notice(page)).toContainText("Not sent.");
    await expect(notice(page)).toContainText("only allows an approved template");
    await expect(notice(page)).toContainText("Your message is still here.");
    await expect(box).toHaveValue("Are you still interested?");
    expect(sent).toHaveLength(1);
    await expect(chatLog(page).getByText("Are you still interested?")).toHaveCount(0);
  });

  test("when there's no answer it says the message may have gone out and does not resend", async ({ page }) => {
    const sent = await mockReply(page, () => "abort");
    await openKarthik(page);
    const box = page.getByRole("textbox", { name: "Message" });
    await box.fill("Shall I book the visit?");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(notice(page)).toContainText("Couldn’t confirm it was sent.");
    await expect(notice(page)).toContainText("Check the chat before sending it again.");
    await expect(box).toHaveValue("Shall I book the visit?");
    await page.waitForTimeout(500);
    expect(sent).toHaveLength(1);
  });

  test("a draft never moves to another chat, and a closed window offers no box", async ({ page }) => {
    await mockReply(page, () => accepted);
    await openKarthik(page);
    await page.getByRole("textbox", { name: "Message" }).fill("Half written");
    if (isMobile(page)) await page.getByRole("button", { name: "Back" }).click();
    await row(page, /Lakshmi V/).click();
    await expect(page.getByText("24-hour window closed.")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);
    if (isMobile(page)) await page.getByRole("button", { name: "Back" }).click();
    await row(page, /Priya S/).click();
    await expect(page.getByText("AI is replying. Switch to Human to reply.")).toBeVisible();
    if (isMobile(page)) await page.getByRole("button", { name: "Back" }).click();
    await row(page, /Karthik R/).click();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");
  });
});

test.describe("Inbox · who replies", () => {
  test.use({ storageState: SIGNED_OUT });

  async function openKarthik(page: Page) {
    const realtime = await mockRealtime(page);
    await openInbox(page);
    await row(page, /Karthik R/).click();
    await expect(whoReplies(page).getByRole("button", { name: "AI" })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => realtime.joins.length).toBe(1);
    return realtime;
  }

  test("taking over sends the mode as the member, opens the reply box, and the note appears once", async ({ page }) => {
    const calls = await mockMode(page);
    const realtime = await openKarthik(page);
    await whoReplies(page).getByRole("button", { name: "Human" }).click();

    await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
    await expect(page.getByText("AI is replying. Switch to Human to reply.")).toHaveCount(0);
    await expect(whoReplies(page).getByRole("button", { name: "Human" })).toHaveAttribute("aria-pressed", "true");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", tenant: INBOX_TENANT });
    expect(calls[0].authorization).toMatch(/^Bearer /);
    expect(modeBody(calls[0])).toEqual({ mode: "human" });

    // The API writes the note; realtime brings it (and the conversation update), possibly twice.
    const note = noteRow("41000000-0000-0000-0000-000000000a01", "A team member took over this chat. The AI won’t reply.", "takeover");
    realtime.push("messages", "INSERT", note);
    realtime.push("messages", "INSERT", note);
    realtime.push("conversations", "UPDATE", { id: cid(1), tenant_id: INBOX_TENANT, mode: "human", status: "open", last_customer_msg_at: new Date().toISOString() });
    await expect(chatLog(page).getByText("A team member took over this chat.")).toHaveCount(1);
    // A system note never becomes the chat's preview line in the list.
    if (isMobile(page)) await page.getByRole("button", { name: "Back" }).click();
    await expect(row(page, /Karthik R/)).not.toContainText("A team member took over");
    await expectNoHorizontalOverflow(page);
  });

  test("Return to AI hands the chat back: the reply box goes, the note appears once", async ({ page }) => {
    const calls = await mockMode(page, (n) => ({ status: 200, body: { mode: n === 1 ? "human" : "ai", changed: true } }));
    const realtime = await openKarthik(page);
    await whoReplies(page).getByRole("button", { name: "Human" }).click();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();

    await whoReplies(page).getByRole("button", { name: "AI" }).click();
    await expect(page.getByText("AI is replying. Switch to Human to reply.")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);
    expect(calls.map(modeBody)).toEqual([{ mode: "human" }, { mode: "ai" }]);

    const note = noteRow("41000000-0000-0000-0000-000000000a02", "Returned to the AI. It will reply to new messages.", "return_to_ai");
    realtime.push("messages", "INSERT", note);
    realtime.push("messages", "INSERT", note);
    await expect(chatLog(page).getByText("Returned to the AI.")).toHaveCount(1);
  });

  test("a second click while a switch is in flight sends one request", async ({ page }) => {
    const calls = await mockMode(page, async () => {
      await new Promise((r) => setTimeout(r, 400));
      return { status: 200, body: { mode: "human", changed: true } };
    });
    await openKarthik(page);
    const human = whoReplies(page).getByRole("button", { name: "Human" });
    await human.click();
    await human.click({ force: true, timeout: 1000 }).catch(() => undefined);
    await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
    expect(calls).toHaveLength(1);
  });

  test("when the API refuses, it says so, changes nothing and keeps the reply gate", async ({ page }) => {
    await mockMode(page, () => ({ status: 409, body: { error: { code: "conflict", message: "This chat was just changed by someone else. Check who is replying, then try again." } } }));
    await openKarthik(page);
    await whoReplies(page).getByRole("button", { name: "Human" }).click();
    const failure = page.getByRole("alert").filter({ hasText: "Couldn’t switch." });
    await expect(failure).toContainText("was just changed by someone else");
    await expect(failure).toContainText("Nothing was changed.");
    await expect(whoReplies(page).getByRole("button", { name: "AI" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("AI is replying. Switch to Human to reply.")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);
    // It can be tried again.
    await expect(whoReplies(page).getByRole("button", { name: "Human" })).toBeEnabled();
  });

  test("a change made elsewhere reaches this screen through realtime, both ways", async ({ page }) => {
    const realtime = await openKarthik(page);
    const change = (mode: string) => realtime.push("conversations", "UPDATE", { id: cid(1), tenant_id: INBOX_TENANT, mode, status: "open", last_customer_msg_at: new Date().toISOString() });
    change("human");
    await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
    await expect(whoReplies(page).getByRole("button", { name: "Human" })).toHaveAttribute("aria-pressed", "true");
    change("ai");
    await expect(page.getByText("AI is replying. Switch to Human to reply.")).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);
  });

  test("a chat handled from the owner's own number can't be switched here", async ({ page }) => {
    await mockRealtime(page);
    await openInbox(page);
    await row(page, /xxx xxx52/).click();
    const reason = "This chat is handled from the business’s own WhatsApp number, so it can’t be switched here.";
    await expect(whoReplies(page)).toHaveAccessibleDescription(reason);
    for (const name of ["AI", "Human"]) await expect(whoReplies(page).getByRole("button", { name })).toBeDisabled();
    await expect(page.getByText(reason)).toBeVisible();
  });
});

