import { AI_PAUSED_REASONS } from "@pakka/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getJson = vi.fn();
vi.mock("@/lib/api/client", () => ({ getJson: (...args: unknown[]) => getJson(...args) }));

const { changeNote, daysLeft, HomeDataError, homeService, leadsLeft, meterShare, pausedNotice } = await import("./home-api");
const TENANT = "10000000-0000-0000-0000-000000000004";

/** The full DashboardSummary (packages/types/src/dashboard.ts). */
const summary = {
  month: "2026-10",
  stats: { enquiries: 40, qualified: 12, booked: 5, afterHours: 9, enquiriesChangePct: 18 },
  overnightHandled: 9,
  hotLeads: [
    { leadId: "l1", conversationId: "c1", name: "Asha", need: "Dental check-up", score: 82, temperature: "hot", reason: "Hot lead", waitingSince: null, assignedTo: null },
  ],
  todayBookings: [{ bookingId: "b1", startAt: "2026-10-13T04:30:00.000Z", name: "Asha", place: "Chair 1", staff: "Dr Rao", status: "confirmed" }],
};

/** The full AccountStatus. */
const status = (over: Record<string, unknown> = {}) => ({
  status: "active",
  plan: { key: "growth", name: "Growth", monthlyCredits: 1500 },
  credits: { plan: 1000, topup: 0, total: 1000 },
  creditsGranted: 1500,
  renewsAt: "2026-11-01T00:00:00.000Z",
  trialEndsAt: null,
  aiPaused: false,
  aiPausedReason: null,
  lowCredits: false,
  aiAutoReply: true,
  ...over,
});

beforeEach(() => {
  getJson.mockReset();
});

describe("homeService", () => {
  it("reads the summary and the balance from their routes for this business", async () => {
    getJson.mockResolvedValueOnce(summary);
    const read = await homeService.summary(TENANT);
    expect(read.stats.afterHours).toBe(9);
    expect(read.hotLeads).toHaveLength(1);
    expect(getJson).toHaveBeenLastCalledWith("/api/dashboard/summary", { tenantId: TENANT, signal: undefined });
    getJson.mockResolvedValueOnce(status());
    expect((await homeService.balance(TENANT)).plan.name).toBe("Growth");
    expect(getJson).toHaveBeenLastCalledWith("/api/billing/balance", { tenantId: TENANT, signal: undefined });
  });

  it("refuses answers that are not the contract's shapes", async () => {
    getJson.mockResolvedValueOnce({ stats: { enquiries: "many" } });
    await expect(homeService.summary(TENANT)).rejects.toBeInstanceOf(HomeDataError);
    getJson.mockResolvedValueOnce({ credits: { total: 1 } });
    await expect(homeService.balance(TENANT)).rejects.toBeInstanceOf(HomeDataError);
  });

  it("refuses an answer with an aiPausedReason the contract does not list", async () => {
    getJson.mockResolvedValueOnce(status({ aiPaused: true, aiPausedReason: "mystery" }));
    await expect(homeService.balance(TENANT)).rejects.toBeInstanceOf(HomeDataError);
  });

  it("refuses a summary missing the lists the screen draws, instead of drawing them empty", async () => {
    const withoutHot: Partial<typeof summary> = { ...summary };
    delete withoutHot.hotLeads;
    getJson.mockResolvedValueOnce(withoutHot);
    await expect(homeService.summary(TENANT)).rejects.toBeInstanceOf(HomeDataError);
  });
});

describe("pausedNotice", () => {
  it("says nothing while the assistant can reply", () => {
    expect(pausedNotice(null)).toBeNull();
  });

  it("has distinct words for every reason the contract lists, and each says where chats go", () => {
    const notices = AI_PAUSED_REASONS.map((reason) => pausedNotice(reason));
    for (const [i, notice] of notices.entries()) {
      expect(notice, AI_PAUSED_REASONS[i]).not.toBeNull();
      expect(notice?.reason).toBe(AI_PAUSED_REASONS[i]);
      expect(notice?.detail).toMatch(/inbox/);
    }
    expect(new Set(notices.map((n) => n?.title)).size).toBe(AI_PAUSED_REASONS.length);
  });

  it("offers a top-up only for no_credits and a plan choice for an ended trial or a cancelled subscription", () => {
    expect(pausedNotice("no_credits")?.action?.label).toBe("Top up credits");
    expect(pausedNotice("trial_ended")?.action?.label).toBe("Choose a plan");
    expect(pausedNotice("cancelled")?.action?.label).toBe("Choose a plan");
    expect(pausedNotice("paused")?.action?.label).toBe("See your plan");
    // A paying business with no active number fixes it on the WhatsApp screen, not by paying.
    expect(pausedNotice("whatsapp_not_connected")?.action).toEqual({ label: "Connect WhatsApp", href: "/dashboard/whatsapp" });
  });
});

describe("daysLeft", () => {
  const now = new Date("2026-10-13T10:00:00.000Z");
  it("rounds up to whole days and stops at zero", () => {
    expect(daysLeft("2026-10-20T10:00:00.000Z", now)).toBe(7);
    expect(daysLeft("2026-10-13T18:00:00.000Z", now)).toBe(1);
    expect(daysLeft("2026-10-12T10:00:00.000Z", now)).toBe(0);
  });
  it("is null with no usable date", () => {
    expect(daysLeft(null, now)).toBeNull();
    expect(daysLeft("not a date", now)).toBeNull();
  });
});

describe("leadsLeft", () => {
  const balance = (total: number, granted = 0) => status({ credits: { plan: total, topup: 0, total }, creditsGranted: granted }) as unknown as Parameters<typeof leadsLeft>[0];
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
  const credits = (total: number, granted: number) => status({ credits: { plan: 0, topup: 0, total }, creditsGranted: granted }) as unknown as Parameters<typeof meterShare>[0];
  it("clamps the share and needs a denominator", () => {
    expect(meterShare(credits(375, 1500))).toBe(25);
    expect(meterShare(credits(3000, 1500))).toBe(100);
    expect(meterShare(credits(1, 0))).toBeNull();
  });
  it("words the change, or nothing", () => {
    expect(changeNote(18.4)).toBe("+18% vs last month");
    expect(changeNote(-4)).toBe("-4% vs last month");
    expect(changeNote(null)).toBeNull();
  });
});
