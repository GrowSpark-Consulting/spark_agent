import { beforeEach, describe, expect, it, vi } from "vitest";

const getJson = vi.fn();
vi.mock("@/lib/api/client", () => ({ getJson: (...args: unknown[]) => getJson(...args) }));

const { changeNote, HomeDataError, homeService, leadsLeft, meterShare } = await import("./home-api");
const TENANT = "10000000-0000-0000-0000-000000000004";
const summary = { month: "2026-10", stats: { enquiries: 40, qualified: 12, booked: 5, afterHours: 9, enquiriesChangePct: 18 }, overnightHandled: 9 };

beforeEach(() => {
  getJson.mockReset();
});

describe("homeService", () => {
  it("reads the summary and the balance from their routes for this business", async () => {
    getJson.mockResolvedValueOnce(summary);
    expect((await homeService.summary(TENANT)).stats.afterHours).toBe(9);
    expect(getJson).toHaveBeenLastCalledWith("/api/dashboard/summary", { tenantId: TENANT, signal: undefined });
    getJson.mockResolvedValueOnce({ credits: { plan: 100, topup: 0, total: 100 } });
    await homeService.balance(TENANT);
    expect(getJson).toHaveBeenLastCalledWith("/api/billing/balance", { tenantId: TENANT, signal: undefined });
  });

  it("refuses answers that are not the proposed shapes", async () => {
    getJson.mockResolvedValueOnce({ stats: { enquiries: "many" } });
    await expect(homeService.summary(TENANT)).rejects.toBeInstanceOf(HomeDataError);
    getJson.mockResolvedValueOnce({ credits: { total: 1 } });
    await expect(homeService.balance(TENANT)).rejects.toBeInstanceOf(HomeDataError);
  });
});

describe("leadsLeft", () => {
  const balance = (total: number, granted?: number) => ({ credits: { plan: total, topup: 0, total }, creditsGranted: granted });
  it("divides credits left by the credits each enquiry has cost this cycle", () => {
    // 500 of 1,500 spent over 50 enquiries = 10 credits a lead; 1,000 left = 100 leads.
    expect(leadsLeft(balance(1000, 1500), 50)).toEqual({ kind: "estimate", leads: 100, creditsPerLead: 10 });
  });
  it("says nothing without a denominator, enquiries or spend", () => {
    expect(leadsLeft(balance(1000), 50)).toEqual({ kind: "unknown" });
    expect(leadsLeft(balance(1000, 1500), 0)).toEqual({ kind: "unknown" });
    expect(leadsLeft(balance(1000, 1500), null)).toEqual({ kind: "unknown" });
    expect(leadsLeft(balance(1500, 1500), 10)).toEqual({ kind: "unknown" });
  });
  it("reaches zero leads at zero credits", () => {
    expect(leadsLeft(balance(0, 1500), 50)).toMatchObject({ kind: "estimate", leads: 0 });
  });
});

describe("meterShare and changeNote", () => {
  it("clamps the share and needs a denominator", () => {
    expect(meterShare({ credits: { plan: 0, topup: 0, total: 375 }, creditsGranted: 1500 })).toBe(25);
    expect(meterShare({ credits: { plan: 0, topup: 0, total: 3000 }, creditsGranted: 1500 })).toBe(100);
    expect(meterShare({ credits: { plan: 0, topup: 0, total: 1 } })).toBeNull();
  });
  it("words the change, or nothing", () => {
    expect(changeNote(18.4)).toBe("+18% vs last month");
    expect(changeNote(-4)).toBe("-4% vs last month");
    expect(changeNote(null)).toBeNull();
  });
});
