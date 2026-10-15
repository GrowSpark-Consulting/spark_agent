import { expect, expectNoHorizontalOverflow, openApp, test } from "./fixtures";

// The Agent settings screen of the sample-data preview writes nothing: there is no confirmed write contract for tenants.agent_settings yet
// (docs/dashboard-screen-contracts.md, "Agent settings": PATCH /api/agent/settings is PROPOSED). So it must never say it saved, whatever is
// changed, and must send nothing to the API or the database.

test.describe("agent settings (preview)", () => {
  test("never claims a save: Save is off, a change does not turn it on, and the note says nothing is saved", async ({ page }) => {
    const writes: string[] = [];
    page.on("request", (r) => {
      if (["POST", "PUT", "PATCH", "DELETE"].includes(r.method()) && !/_next|__nextjs/.test(r.url())) writes.push(`${r.method()} ${r.url()}`);
    });
    await openApp(page, "screen=agent");

    const save = page.getByTestId("agent-save");
    await expect(save).toBeVisible();
    await expect(save).toBeDisabled();
    await expect(page.getByText(/not saved yet/i)).toBeVisible();

    // Change a field, then try to save.
    const persona = page.locator("input.input").first();
    await persona.fill("Priya");
    await save.click({ force: true }).catch(() => {});
    await expect(save).toBeDisabled();
    await expect(page.getByText(/^Saved/)).toHaveCount(0);
    await expect(page.getByText("All changes saved")).toHaveCount(0);
    await expect(page.getByText("Maya uses this from the next message")).toHaveCount(0);
    await expect(page.getByText(/not saved yet/i)).toBeVisible();
    expect(writes, "the screen must not send anything").toEqual([]);
    await expectNoHorizontalOverflow(page);
  });

  test("shows languages as information, links business hours to their one editor, and offers only the switchable handovers", async ({ page }) => {
    await openApp(page, "screen=agent");
    await expect(page.getByTestId("agent-languages")).toContainText("detects each customer");
    await expect(page.getByRole("button", { name: "Malayalam" })).toHaveCount(0);
    await expect(page.getByRole("switch", { name: /open$/ })).toHaveCount(0);
    const link = page.getByTestId("agent-hours-link");
    await expect(link).toHaveAttribute("href", "/dashboard/settings/booking");
    for (const name of ["Maya is stuck", "Credits run out"]) await expect(page.getByRole("switch", { name })).toHaveCount(0);
    await expect(page.getByRole("switch", { name: "Customer asks for a person" })).toBeVisible();
    await expect(page.getByTestId("agent-always-on")).toContainText("can’t be switched off");
    await expectNoHorizontalOverflow(page);
  });
});
