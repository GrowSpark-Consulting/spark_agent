import { beforeEach, describe, expect, it, vi } from "vitest";

const getJson = vi.fn();
vi.mock("@/lib/api/client", () => ({ getJson: (...a: unknown[]) => getJson(...a) }));

const { compareToTarget, fetchAdminMetrics, formatAsOf, formatInr, formatInrPerCredit, formatPercent, formatUsd, windowLabel } = await import("./metrics");
const { AdminDataError } = await import("./billing");

const window7 = { days: 7, creditsSpent: 1200, aiCostUsd: 4.5, aiCostInr: 405, aiCalls: 310, costPerCreditInr: 0.338, trialsStarted: 8, trialsPaid: 2, trialToPaidPct: 25 };
const metrics = { windows: [window7, { ...window7, days: 30 }], targetCostPerCreditInr: 0.35, usdInr: 90, asOf: "2026-10-15T06:00:00.000Z" };

beforeEach(() => getJson.mockReset());

describe("fetchAdminMetrics", () => {
  it("reads the documented path with no business header", async () => {
    getJson.mockResolvedValue(metrics);
    expect(await fetchAdminMetrics()).toEqual(metrics);
    expect(getJson).toHaveBeenCalledTimes(1);
    expect(getJson.mock.calls[0][0]).toBe("/api/admin/metrics");
    expect(getJson.mock.calls[0][1].tenantId).toBeUndefined();
  });

  it("passes a server refusal on unchanged, so a non-admin sees an error and never data", async () => {
    getJson.mockRejectedValueOnce(new Error("forbidden"));
    await expect(fetchAdminMetrics()).rejects.toThrow("forbidden");
  });

  it("refuses an answer that is not the contract's shape instead of showing it", async () => {
    getJson.mockResolvedValue({ ...metrics, windows: [{ ...window7, creditsSpent: "many" }] });
    await expect(fetchAdminMetrics()).rejects.toBeInstanceOf(AdminDataError);
    getJson.mockResolvedValue({ windows: [] });
    await expect(fetchAdminMetrics()).rejects.toBeInstanceOf(AdminDataError);
  });

  it("accepts null ratios and an empty list of windows", async () => {
    getJson.mockResolvedValue({ ...metrics, windows: [{ ...window7, creditsSpent: 0, costPerCreditInr: null, trialsStarted: 0, trialsPaid: 0, trialToPaidPct: null }] });
    expect((await fetchAdminMetrics()).windows[0].costPerCreditInr).toBeNull();
    getJson.mockResolvedValue({ ...metrics, windows: [] });
    expect((await fetchAdminMetrics()).windows).toEqual([]);
  });
});

describe("compareToTarget", () => {
  it("says nothing when no credits were spent", () => {
    expect(compareToTarget(null, 0.35)).toEqual({ kind: "no_credits" });
  });
  it("is within the target at or under it, and above it over it, with the gap to 3 places", () => {
    expect(compareToTarget(0.338, 0.35)).toEqual({ kind: "within", gapInr: 0.012 });
    expect(compareToTarget(0.35, 0.35)).toEqual({ kind: "within", gapInr: 0 });
    expect(compareToTarget(0.412, 0.35)).toEqual({ kind: "above", gapInr: 0.062 });
  });
});

describe("formatting", () => {
  it("shows rupees with Indian grouping, cost per credit to 3 places, dollars and percentages as stated", () => {
    expect(formatInr(12345.6)).toBe("₹12,345.60");
    expect(formatInrPerCredit(0.338)).toBe("₹0.338");
    expect(formatUsd(4.5)).toBe("$4.50");
    expect(formatUsd(0.1234)).toBe("$0.1234");
    expect(formatPercent(25)).toBe("25.0%");
    expect(formatPercent(12.5)).toBe("12.5%");
    expect(windowLabel(7)).toBe("Last 7 days");
  });
  it("does not throw on a date it cannot read", () => {
    expect(formatAsOf("not a date")).toBe("an unknown time");
    expect(formatAsOf("2026-10-15T06:00:00.000Z")).toContain("2026");
  });
});
