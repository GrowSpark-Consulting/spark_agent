import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/errors";

const getJson = vi.fn();
const patchJson = vi.fn();
vi.mock("@/lib/api/client", () => ({
  getJson: (...args: unknown[]) => getJson(...args),
  patchJson: (...args: unknown[]) => patchJson(...args),
}));

const { changeFor, FeatureDataError, featureService, isFeatureApiMissing, isPlanRequired, offsetLabel, rowControl, savedOffset, withRow } = await import("./feature-api");
type FeatureRow = import("./feature-api").FeatureRow;
type FeatureList = import("./feature-api").FeatureList;

const TENANT = "10000000-0000-0000-0000-000000000004";

const row = (over: Partial<FeatureRow> = {}): FeatureRow => ({
  key: "reminder_24h",
  name: "24-hour reminder",
  description: "Reminds the customer the day before.",
  state: "on",
  enabled: true,
  requiredPlan: null,
  disabledReason: null,
  creditsPerMonth: 12,
  creditNote: null,
  settings: {},
  control: "switch",
  ...over,
});

const list = (features: FeatureRow[]): FeatureList => ({
  plan: { key: "starter", name: "Starter", monthlyCredits: 1500 },
  estimatedCreditsPerMonth: 0,
  groups: [{ name: "Reminders", features }],
});

beforeEach(() => {
  getJson.mockReset();
  patchJson.mockReset();
});

describe("featureService.load", () => {
  it("GETs /api/features for this business and returns the parsed list", async () => {
    getJson.mockResolvedValue(list([row()]));
    const result = await featureService.load(TENANT);
    expect(getJson).toHaveBeenCalledWith("/api/features", { tenantId: TENANT, signal: undefined });
    expect(result.groups[0].features[0].key).toBe("reminder_24h");
  });

  it.each([
    ["a missing plan", { groups: [], estimatedCreditsPerMonth: 0 }],
    ["a state outside the contract", list([row({ state: "maybe" as never })])],
    ["a negative credit figure", list([row({ creditsPerMonth: -1 })])],
    ["null", null],
  ])("refuses %s instead of drawing it", async (_name, answer) => {
    getJson.mockResolvedValue(answer);
    await expect(featureService.load(TENANT)).rejects.toBeInstanceOf(FeatureDataError);
  });
});

describe("featureService.update", () => {
  it("PATCHes the feature's own key, encoded, with exactly the change", async () => {
    patchJson.mockResolvedValue(row({ enabled: false, state: "off" }));
    await featureService.update(TENANT, "../reminder_24h?x=1", { enabled: false });
    expect(patchJson).toHaveBeenCalledWith("/api/features/..%2Freminder_24h%3Fx%3D1", { enabled: false }, { tenantId: TENANT });
  });

  it("returns the row as the server now has it", async () => {
    patchJson.mockResolvedValue(row({ enabled: false, state: "off" }));
    expect((await featureService.update(TENANT, "reminder_24h", { enabled: false })).state).toBe("off");
  });

  it("refuses an answer that is not a feature row", async () => {
    patchJson.mockResolvedValue({ ok: true });
    await expect(featureService.update(TENANT, "reminder_24h", { enabled: false })).rejects.toBeInstanceOf(FeatureDataError);
  });

  it("passes the API's refusal on untouched", async () => {
    const err = new ApiError(403, { error: { code: "plan_required", message: "Follow-up nudges needs the Growth plan." } });
    patchJson.mockRejectedValue(err);
    await expect(featureService.update(TENANT, "followup_nudges", { enabled: true })).rejects.toBe(err);
  });
});

describe("rowControl", () => {
  it("never lets a locked row be switched, for any role, and names the plan it needs", () => {
    const locked = row({ state: "locked", enabled: false, requiredPlan: "growth" });
    for (const role of ["owner", "admin", "staff"] as const) {
      expect(rowControl(locked, role)).toEqual({ kind: "fixed", checked: false, why: "Needs the Growth plan." });
    }
  });

  it("shows a locked row as off even when the business's own switch is on (a plan downgrade)", () => {
    expect(rowControl(row({ state: "locked", enabled: true, requiredPlan: "pro" }), "owner")).toMatchObject({ kind: "fixed", checked: false });
  });

  it("lets owners and admins use an ordinary row and keeps staff read-only", () => {
    expect(rowControl(row(), "owner")).toEqual({ kind: "interactive", checked: true });
    expect(rowControl(row(), "admin")).toEqual({ kind: "interactive", checked: true });
    expect(rowControl(row(), "staff")).toMatchObject({ kind: "fixed", checked: true });
  });

  it("cannot switch a row on that cannot work, and says why", () => {
    expect(rowControl(row({ state: "disabled", enabled: false, disabledReason: "Add a service first." }), "owner")).toEqual({
      kind: "fixed",
      checked: false,
      why: "Add a service first.",
    });
  });

  it("still lets a disabled row that is on be switched off", () => {
    expect(rowControl(row({ state: "disabled", enabled: true, disabledReason: "Not available yet." }), "owner")).toEqual({ kind: "interactive", checked: true });
  });
});

describe("changeFor", () => {
  it("sends nothing for a locked row, even when asked to switch it on", () => {
    expect(changeFor(row({ state: "locked", enabled: false, requiredPlan: "growth" }), "owner", true)).toBeNull();
    expect(changeFor(row({ state: "locked", enabled: true, requiredPlan: "growth" }), "admin", true)).toBeNull();
  });

  it("sends nothing for staff", () => {
    expect(changeFor(row(), "staff", false)).toBeNull();
  });

  it("sends nothing when the switch is already where it is asked to go", () => {
    expect(changeFor(row({ enabled: true }), "owner", true)).toBeNull();
  });

  it("sends enabled: false to switch an on row off and enabled: true to switch an off row on", () => {
    expect(changeFor(row({ enabled: true }), "owner", false)).toEqual({ enabled: false });
    expect(changeFor(row({ state: "off", enabled: false }), "owner", true)).toEqual({ enabled: true });
  });
});

describe("withRow", () => {
  it("replaces the row and recomputes the estimate as the credits of the rows that are on", () => {
    const a = row({ key: "a", creditsPerMonth: 10 });
    const b = row({ key: "b", creditsPerMonth: 5 });
    const c = row({ key: "c", creditsPerMonth: null, creditNote: "No extra credits" });
    const next = withRow(list([a, b, c]), { ...a, state: "off", enabled: false });
    expect(next.groups[0].features.map((f) => f.state)).toEqual(["off", "on", "on"]);
    expect(next.estimatedCreditsPerMonth).toBe(5);
  });

  it("does not count a locked or disabled row's credits", () => {
    const next = withRow(list([row({ key: "a", state: "locked", creditsPerMonth: 99 }), row({ key: "b", creditsPerMonth: 3 })]), row({ key: "b", creditsPerMonth: 4 }));
    expect(next.estimatedCreditsPerMonth).toBe(4);
  });
});

describe("reminder timing", () => {
  it("reads the saved offset and falls back to the documented 24 hours", () => {
    expect(savedOffset(row({ settings: { offset_minutes: 720 } }))).toBe(720);
    expect(savedOffset(row({ settings: {} }))).toBe(1440);
    expect(savedOffset(row({ settings: { offset_minutes: "720" } }))).toBe(1440);
  });

  it("words an offset in hours", () => {
    expect(offsetLabel(2880)).toBe("48 hours before");
    expect(offsetLabel(180)).toBe("3 hours before");
    expect(offsetLabel(90)).toBe("90 minutes before");
  });
});

describe("error kinds", () => {
  it("tells a missing route from other refusals", () => {
    expect(isFeatureApiMissing(new ApiError(404, { error: { code: "not_found", message: "x" } }))).toBe(true);
    expect(isFeatureApiMissing(new ApiError(403, { error: { code: "forbidden", message: "x" } }))).toBe(false);
    expect(isFeatureApiMissing(new Error("x"))).toBe(false);
  });

  it("recognises plan_required", () => {
    expect(isPlanRequired(new ApiError(403, { error: { code: "plan_required", message: "x" } }))).toBe(true);
    expect(isPlanRequired(new ApiError(403, { error: { code: "forbidden", message: "x" } }))).toBe(false);
  });
});
