import { AGENT_TRIGGER_KEYS, type AgentSettings } from "@pakka/types";
import type { Page } from "@playwright/test";
import { expect, expectNoHorizontalOverflow, SIGNED_OUT, signIn, test } from "../support/app";
import { newDay3Account } from "../support/day3";
import { refusal, stubApi } from "../support/day5";

// /dashboard/agent: GET and PATCH /api/agent/settings are Dev 1's (#228, packages/types/src/agent-settings.ts). The answers here are stood in for with
// page.route and typed as the shared AgentSettings, so these tests prove what the screen sends, how it reads each answer and that it never claims a
// save the server did not confirm. They do not prove the real route or its database. The screen has no other way to write: any call to Supabase for
// these settings would show up as a request below.

const SETTINGS = /\/api\/agent\/settings$/;

const LABELS: Record<(typeof AGENT_TRIGGER_KEYS)[number], [string, string, boolean]> = {
  kb_gap: ["Assistant doesn't know the answer", "Two questions in a row that are not in your knowledge base", false],
  asked_human: ["Customer asks for a person", "“Can I talk to someone?”", false],
  complaint: ["Complaint or angry tone", "Refund demand, bad experience", true],
  negotiation: ["Price negotiation", "“Best price if I book two?”", false],
  hot_lead: ["High-value lead", "Score above Hot", true],
};

const settings = (over: Partial<AgentSettings> = {}): AgentSettings => ({
  persona: "Maya",
  tone: "friendly",
  privacyNotice: false,
  bookingServiceId: null,
  handoffTriggers: AGENT_TRIGGER_KEYS.map((key) => ({ key, label: LABELS[key][0], example: LABELS[key][1], highPriority: LABELS[key][2], enabled: true })),
  ...over,
});

const save = (page: Page) => page.getByTestId("agent-save");
const sw = (page: Page, name: string) => page.getByRole("switch", { name, exact: true });
const persona = (page: Page) => page.getByLabel("Assistant's name");

/** Records every write the page makes to anything but the API route, to show the screen never goes around it. */
function watchOtherWrites(page: Page): string[] {
  const writes: string[] = [];
  page.on("request", (r) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(r.method()) && !SETTINGS.test(r.url()) && !/_next|__nextjs|\/api\/auth|logout/.test(r.url())) writes.push(`${r.method()} ${r.url()}`);
  });
  return writes;
}

test.describe("Agent settings", () => {
  test("loads the settings with the server's own labels and examples, five switches and no others", async ({ page }) => {
    const reads = await stubApi(page, SETTINGS, () => ({ status: 200, body: settings() }));
    await page.goto("/dashboard/agent");
    await expect(page.getByRole("heading", { level: 1, name: "Agent settings" })).toBeVisible();
    await expect(persona(page)).toHaveValue("Maya");
    await expect(page.getByRole("button", { name: "Friendly" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Formal" })).toHaveAttribute("aria-pressed", "false");
    await expect(sw(page, "Add a privacy notice to the first reply")).not.toBeChecked();
    const rows = page.getByTestId("agent-trigger");
    await expect(rows).toHaveCount(5);
    await expect(rows.nth(2)).toContainText("Complaint or angry tone");
    await expect(rows.nth(2)).toContainText("Refund demand, bad experience");
    await expect(rows.nth(2)).toContainText("High priority");
    await expect(rows.nth(0)).not.toContainText("High priority");
    for (const name of ["stuck", "credits", "opt out"]) await expect(page.getByRole("switch", { name: new RegExp(name, "i") })).toHaveCount(0);
    await expect(page.getByTestId("agent-always-on")).toContainText("can't be switched off");
    await expect(page.getByTestId("agent-languages")).toContainText("follows the language each customer writes in");
    await expect(page.getByRole("button", { name: "Malayalam" })).toHaveCount(0);
    await expect(page.getByTestId("agent-hours-link")).toHaveAttribute("href", "/dashboard/settings/booking");
    await expect(save(page)).toBeDisabled();
    expect(reads).toHaveLength(1);
    expect(reads[0].method).toBe("GET");
    expect(reads[0].authorization).toMatch(/^Bearer /);
    expect(reads[0].tenant).not.toBeNull();
    await expectNoHorizontalOverflow(page);
  });

  test("a business with no name set and the privacy notice at its default (off) shows an empty name box", async ({ page }) => {
    await stubApi(page, SETTINGS, () => ({ status: 200, body: settings({ persona: null }) }));
    await page.goto("/dashboard/agent");
    await expect(persona(page)).toHaveValue("");
    await expect(sw(page, "Add a privacy notice to the first reply")).not.toBeChecked();
    await expect(save(page)).toBeDisabled();
  });

  test("says it is loading, then shows the error and retries", async ({ page }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    await stubApi(page, SETTINGS, async (n) => {
      if (n === 1) await gate;
      return n === 1 ? refusal(500, "internal", "Something went wrong. Try again in a moment.") : { status: 200, body: settings() };
    });
    await page.goto("/dashboard/agent");
    await expect(page.getByText("Loading your assistant's settings")).toBeVisible();
    await expect(persona(page)).toHaveCount(0);
    release();
    await expect(page.locator('[role="alert"].app-state')).toContainText("Couldn't load your assistant's settings");
    await expect(save(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(persona(page)).toHaveValue("Maya");
  });

  test("an answer that is not the contract's shape is refused, not drawn", async ({ page }) => {
    await stubApi(page, SETTINGS, () => ({ status: 200, body: { ...settings(), tone: "warm" } }));
    await page.goto("/dashboard/agent");
    await expect(page.locator('[role="alert"].app-state')).toBeVisible();
    await expect(persona(page)).toHaveCount(0);
  });

  test("sends only what changed, shows Saved only after the server answers, and then shows the server's settings", async ({ page }) => {
    const other = watchOtherWrites(page);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const calls = await stubApi(page, SETTINGS, async (n, call) => {
      if (call.method === "GET") return { status: 200, body: settings() };
      await gate;
      return { status: 200, body: settings({ tone: "formal", persona: "Priya", handoffTriggers: settings().handoffTriggers.map((t) => (t.key === "negotiation" ? { ...t, enabled: false } : t)) }) };
    });
    await page.goto("/dashboard/agent");
    await persona(page).fill("  Priya ");
    await page.getByRole("button", { name: "Formal" }).click();
    await sw(page, "Price negotiation").click();
    await expect(save(page)).toBeEnabled();
    await save(page).click();

    // In flight: no second request, nothing says Saved, the draft is still there.
    await expect(save(page)).toHaveText("Saving…");
    await expect(save(page)).toBeDisabled();
    await expect(page.getByText(/^Saved/)).toHaveCount(0);
    await expect(persona(page)).toHaveValue("  Priya ");
    release();
    await expect(page.getByText("Saved. Your assistant uses this from the next message.")).toBeVisible();

    const patches = calls.filter((c) => c.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toEqual({ persona: "Priya", tone: "formal", handoffTriggers: [{ key: "negotiation", enabled: false }] });
    expect(patches[0].authorization).toMatch(/^Bearer /);
    expect(patches[0].tenant).not.toBeNull();
    await expect(persona(page)).toHaveValue("Priya");
    await expect(sw(page, "Price negotiation")).not.toBeChecked();
    await expect(save(page)).toBeDisabled();
    expect(other, "no write went anywhere but /api/agent/settings").toEqual([]);
  });

  test("clearing the name sends null, and turning the privacy notice on sends just that", async ({ page }) => {
    const calls = await stubApi(page, SETTINGS, (n, call) => (call.method === "GET" ? { status: 200, body: settings() } : { status: 200, body: settings({ persona: null, privacyNotice: true }) }));
    await page.goto("/dashboard/agent");
    await persona(page).fill("");
    await sw(page, "Add a privacy notice to the first reply").click();
    await save(page).click();
    await expect(page.getByText(/^Saved/)).toBeVisible();
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ persona: null, privacyNotice: true });
  });

  test("a name over 30 characters is stopped before anything is sent", async ({ page }) => {
    const calls = await stubApi(page, SETTINGS, () => ({ status: 200, body: settings() }));
    await page.goto("/dashboard/agent");
    await persona(page).fill("x".repeat(31));
    await expect(page.getByTestId("agent-persona-error")).toContainText("30 characters");
    await expect(save(page)).toBeDisabled();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  test("a validation refusal puts the server's message beside the box, keeps the draft and never says Saved", async ({ page }) => {
    await stubApi(page, SETTINGS, (n, call) =>
      call.method === "GET" ? { status: 200, body: settings() } : { status: 422, body: { error: { code: "validation_failed", message: "Check the fields.", fields: { persona: "Use letters, numbers, spaces and . ' & - only." } } } },
    );
    await page.goto("/dashboard/agent");
    await persona(page).fill("Maya #1");
    await save(page).click();
    await expect(page.getByTestId("agent-persona-error")).toContainText("Use letters, numbers");
    await expect(page.getByTestId("agent-save-error")).toContainText("Nothing was saved");
    await expect(persona(page)).toHaveValue("Maya #1");
    await expect(page.getByText(/^Saved/)).toHaveCount(0);
    // changing the field clears the old refusal, and the save is offered again
    await persona(page).fill("Maya");
    await expect(page.getByTestId("agent-persona-error")).toHaveCount(0);
  });

  test("a server failure keeps the draft, says nothing was saved, and a second try can succeed", async ({ page }) => {
    let patches = 0;
    await stubApi(page, SETTINGS, (n, call) => {
      if (call.method === "GET") return { status: 200, body: settings() };
      patches += 1;
      return patches === 1 ? refusal(500, "internal", "Something went wrong. Try again in a moment.") : { status: 200, body: settings({ tone: "formal" }) };
    });
    await page.goto("/dashboard/agent");
    await page.getByRole("button", { name: "Formal" }).click();
    await save(page).click();
    await expect(page.getByTestId("agent-save-error")).toContainText("Nothing was saved");
    await expect(page.getByRole("button", { name: "Formal" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText(/^Saved/)).toHaveCount(0);
    await expect(save(page)).toBeEnabled();
    await save(page).click();
    await expect(page.getByText(/^Saved/)).toBeVisible();
    expect(patches).toBe(2);
  });

  test("a conflict says the settings changed elsewhere and loads the current ones on request", async ({ page }) => {
    let gets = 0;
    await stubApi(page, SETTINGS, (n, call) => {
      if (call.method === "PATCH") return refusal(409, "conflict", "changed");
      gets += 1;
      return { status: 200, body: gets === 1 ? settings() : settings({ persona: "Someone Else" }) };
    });
    await page.goto("/dashboard/agent");
    await page.getByRole("button", { name: "Formal" }).click();
    await save(page).click();
    await expect(page.getByTestId("agent-save-error")).toContainText("changed somewhere else");
    await expect(page.getByText(/^Saved/)).toHaveCount(0);
    await page.getByTestId("agent-reload").click();
    await expect(persona(page)).toHaveValue("Someone Else");
    await expect(page.getByRole("button", { name: "Friendly" })).toHaveAttribute("aria-pressed", "true");
  });

  test("a refusal for someone who may not write (403) says so and keeps the draft", async ({ page }) => {
    await stubApi(page, SETTINGS, (n, call) => (call.method === "GET" ? { status: 200, body: settings() } : refusal(403, "forbidden", "Only an owner or admin can change this.")));
    await page.goto("/dashboard/agent");
    await page.getByRole("button", { name: "Formal" }).click();
    await save(page).click();
    await expect(page.getByTestId("agent-save-error")).toContainText("Only an owner or admin");
    await expect(page.getByRole("button", { name: "Formal" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText(/^Saved/)).toHaveCount(0);
  });

  test.describe("staff", () => {
    test.use({ storageState: SIGNED_OUT });

    test("read the settings and cannot change them: every control is off and there is no Save", async ({ page, request }) => {
      const account = await newDay3Account(request, { role: "staff" });
      const calls = await stubApi(page, SETTINGS, () => ({ status: 200, body: settings() }));
      await signIn(page, account.email, "/dashboard/agent");
      await expect(page.getByRole("heading", { level: 1, name: "Agent settings" })).toBeVisible();
      await expect(page.getByTestId("agent-readonly")).toContainText("Only an owner or admin can change them.");
      await expect(persona(page)).toHaveValue("Maya");
      await expect(persona(page)).toBeDisabled();
      await expect(page.getByRole("button", { name: "Formal" })).toBeDisabled();
      for (const s of await page.getByRole("switch").all()) await expect(s).toBeDisabled();
      await expect(page.getByTestId("agent-trigger")).toHaveCount(5);
      await expect(save(page)).toHaveCount(0);
      expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    });
  });
});
