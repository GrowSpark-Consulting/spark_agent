import type { FeatureList, FeatureRow } from "@pakka/types";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/errors";
import type { FeatureService } from "@/features/toggles/feature-api";
import { describeSaveError, PartialFeatureError, rowsFor, setWizardFeature, viewOf, WIZARD_FEATURES } from "./persistence";
import { FEATURES } from "./data";

const TENANT = "10000000-0000-0000-0000-000000000004";
const row = (key: string, over: Partial<FeatureRow> = {}): FeatureRow => ({
  key,
  name: key,
  description: "d",
  state: "on",
  enabled: true,
  requiredPlan: null,
  disabledReason: null,
  creditsPerMonth: null,
  creditNote: null,
  settings: {},
  control: "switch",
  ...over,
});
const list = (rows: FeatureRow[]): FeatureList => ({ plan: { key: "growth", name: "Growth", monthlyCredits: 1500 }, estimatedCreditsPerMonth: 0, groups: [{ name: "All", features: rows }] });
const spec = (key: string) => WIZARD_FEATURES.find((f) => f.keys[0] === key)!;
const apiError = (status: number, code: string, message = "x") => new ApiError(status, { error: { code, message } } as never);

describe("WIZARD_FEATURES", () => {
  it("has one entry per wizard row, in the wizard's order, for feature keys that exist in the seed", () => {
    expect(WIZARD_FEATURES.map((f) => f.label)).toEqual(FEATURES.map((f) => f.name));
    const seeded = ["ai_auto_reply", "lead_qualification", "booking", "reminder_24h", "reminder_2h", "staff_alerts", "feedback_request"];
    expect(WIZARD_FEATURES.flatMap((f) => f.keys).sort()).toEqual([...seeded].sort());
  });
});

describe("viewOf", () => {
  it("shows the server's switch, interactive for an owner or admin", () => {
    const l = list([row("ai_auto_reply", { enabled: false, state: "off" })]);
    expect(viewOf(l, spec("ai_auto_reply"), "owner")).toEqual({ kind: "interactive", checked: false });
    expect(viewOf(list([row("ai_auto_reply")]), spec("ai_auto_reply"), "admin")).toEqual({ kind: "interactive", checked: true });
  });

  it("never shows a locked feature as on, and says which plan has it", () => {
    const l = list([row("staff_alerts", { state: "locked", enabled: true, requiredPlan: "growth" })]);
    expect(viewOf(l, spec("staff_alerts"), "owner")).toEqual({ kind: "fixed", checked: false, why: "Needs the Growth plan." });
  });

  it("is read-only for staff, and shows an unavailable feature off with its reason", () => {
    expect(viewOf(list([row("booking")]), spec("booking"), "staff")).toMatchObject({ kind: "fixed", why: "Only an owner or admin can change this." });
    const l = list([row("booking", { state: "disabled", enabled: false, disabledReason: "Add a service first." })]);
    expect(viewOf(l, spec("booking"), "owner")).toEqual({ kind: "fixed", checked: false, why: "Add a service first." });
  });

  it("is on only when every row behind it is on (Reminders is two rows)", () => {
    const both = list([row("reminder_24h"), row("reminder_2h")]);
    expect(viewOf(both, spec("reminder_24h"), "owner")).toEqual({ kind: "interactive", checked: true });
    const one = list([row("reminder_24h"), row("reminder_2h", { enabled: false, state: "off" })]);
    expect(viewOf(one, spec("reminder_24h"), "owner")).toEqual({ kind: "interactive", checked: false });
  });

  it("hides a row the server does not list", () => {
    expect(viewOf(list([]), spec("booking"), "owner")).toEqual({ kind: "missing" });
    expect(rowsFor(list([row("reminder_24h")]), spec("reminder_24h"))).toHaveLength(1);
  });
});

describe("setWizardFeature", () => {
  const service = (update: FeatureService["update"]): FeatureService => ({ load: vi.fn(), update });

  it("PATCHes only the rows that differ and returns the server's list", async () => {
    const l = list([row("reminder_24h"), row("reminder_2h", { enabled: false, state: "off" })]);
    const update = vi.fn(async (_t: string, key: string) => row(key, { enabled: true, state: "on" }));
    const result = await setWizardFeature(TENANT, l, spec("reminder_24h"), "owner", true, service(update));
    expect(update.mock.calls).toEqual([[TENANT, "reminder_2h", { enabled: true }]]);
    expect(result.changed).toBe(1);
    expect(rowsFor(result.list, spec("reminder_24h")).every((r) => r.enabled)).toBe(true);
  });

  it("sends nothing for a locked feature, a read-only member, or a switch already in that state", async () => {
    const update = vi.fn();
    const locked = list([row("staff_alerts", { state: "locked", enabled: false, requiredPlan: "pro" })]);
    expect((await setWizardFeature(TENANT, locked, spec("staff_alerts"), "owner", true, service(update))).changed).toBe(0);
    expect((await setWizardFeature(TENANT, list([row("booking")]), spec("booking"), "staff", false, service(update))).changed).toBe(0);
    expect((await setWizardFeature(TENANT, list([row("booking")]), spec("booking"), "owner", true, service(update))).changed).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps the server's list when a later row fails, and says it was partly saved", async () => {
    const l = list([row("reminder_24h", { enabled: false, state: "off" }), row("reminder_2h", { enabled: false, state: "off" })]);
    const update = vi.fn(async (_t: string, key: string) => {
      if (key === "reminder_2h") throw apiError(500, "internal", "Something went wrong. Try again in a moment.");
      return row(key, { enabled: true, state: "on" });
    });
    const error = await setWizardFeature(TENANT, l, spec("reminder_24h"), "owner", true, service(update)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PartialFeatureError);
    const partial = error as PartialFeatureError;
    expect(partial.changed).toBe(1);
    expect(rowsFor(partial.list, spec("reminder_24h")).map((r) => r.enabled)).toEqual([true, false]);
    expect(describeSaveError(error, spec("reminder_24h"), l)).toContain("only partly saved");
  });
});

describe("describeSaveError", () => {
  const l = list([row("staff_alerts", { state: "locked", enabled: false, requiredPlan: "pro" })]);

  it("names the plan for plan_required", () => {
    expect(describeSaveError(apiError(403, "plan_required"), spec("staff_alerts"), l)).toBe("Staff WhatsApp alerts needs the Pro plan. Nothing was changed.");
  });
  it("uses the API's own words otherwise, and says nothing changed", () => {
    expect(describeSaveError(apiError(403, "forbidden", "Only an owner or admin can change this."), spec("staff_alerts"), l)).toBe(
      "Only an owner or admin can change this. Staff WhatsApp alerts was not changed.",
    );
    expect(describeSaveError(new TypeError("Failed to fetch"), spec("staff_alerts"), l)).toContain("was not changed");
  });
});
