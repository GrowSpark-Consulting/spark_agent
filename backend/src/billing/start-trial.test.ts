import { beforeEach, describe, expect, it, vi } from "vitest";
import { startTrialFor, trialPackKey, type SessionState, type StartTrialDeps } from "./start-trial";

const USER = { id: "e0000000-0000-0000-0000-000000000001" };
const TENANT = "d0000000-0000-0000-0000-0000000000c1";
const NOW = Date.parse("2026-10-06T10:00:00Z");
const ENDS = "2026-10-13T10:00:00+00:00"; // now + 7 days, as create_trial_tenant sets it

const member = (role: "owner" | "admin" | "staff"): SessionState => ({
  status: "ok",
  memberships: [{ tenantId: "t-1", name: "Test Realty", role }],
  context: {
    user: { id: USER.id, email: "x@example.com" },
    role,
    tenant: { id: "t-1", name: "Test Realty", vertical: "real-estate", timezone: "Asia/Kolkata", status: "active", planKey: "growth", trialEndsAt: null },
  },
});

let deps: StartTrialDeps & {
  currentUser: ReturnType<typeof vi.fn>;
  sessionState: ReturnType<typeof vi.fn>;
  createTrialTenant: ReturnType<typeof vi.fn>;
  getBalance: ReturnType<typeof vi.fn>;
  phoneUsed: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  deps = {
    currentUser: vi.fn().mockResolvedValue(USER),
    sessionState: vi.fn().mockResolvedValue({ status: "no_membership" }),
    createTrialTenant: vi.fn().mockResolvedValue({ tenantId: TENANT, routeCode: "TRIAL-7KQM", trialEndsAt: ENDS, created: true }),
    getBalance: vi.fn().mockResolvedValue({ plan: 300, topup: 0, total: 300 }),
    phoneUsed: vi.fn().mockResolvedValue(false),
    now: () => NOW,
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("trialPackKey", () => {
  it("maps only the trades that have a pack", () => {
    expect(trialPackKey("re")).toBe("real-estate");
    expect(trialPackKey("int")).toBe("interiors");
    expect(trialPackKey("salon")).toBe("salon");
    expect(trialPackKey("hotel")).toBeNull();
    expect(trialPackKey("rest")).toBeNull();
    expect(trialPackKey("fix")).toBeNull();
  });
});

describe("startTrialFor", () => {
  it("creates the trial for the session's user with the typed name and the trade's pack", async () => {
    const result = await startTrialFor({ name: "  Sunrise Homes ", industry: "re" }, deps);
    expect(deps.createTrialTenant).toHaveBeenCalledWith({ userId: USER.id, name: "Sunrise Homes", vertical: "real-estate" });
    expect(deps.getBalance).toHaveBeenCalledWith(TENANT);
    expect(result).toEqual({ status: "ready", trial: { routeCode: "TRIAL-7KQM", trialDays: 7, credits: 300 } });
  });

  it("sends no timezone, so createTrialTenant's own default applies", async () => {
    await startTrialFor({ name: "Glow Studio", industry: "salon", timezone: "Europe/London" }, deps);
    expect(deps.createTrialTenant.mock.calls[0][0]).not.toHaveProperty("timezone");
  });

  it("ignores a user id, tenant id or pack key sent from the browser", async () => {
    await startTrialFor(
      { name: "Glow Studio", industry: "int", userId: "e0000000-0000-0000-0000-0000000000ff", tenantId: TENANT, vertical: "clinic" },
      deps,
    );
    expect(deps.createTrialTenant).toHaveBeenCalledWith({ userId: USER.id, name: "Glow Studio", vertical: "interiors" });
  });

  it("returns the same business on a repeat call (created: false)", async () => {
    deps.createTrialTenant.mockResolvedValue({ tenantId: TENANT, routeCode: "TRIAL-7KQM", trialEndsAt: ENDS, created: false });
    const result = await startTrialFor({ name: "Sunrise Homes", industry: "re" }, deps);
    expect(result).toEqual({ status: "ready", trial: { routeCode: "TRIAL-7KQM", trialDays: 7, credits: 300 } });
  });

  it("does nothing when signed out", async () => {
    deps.currentUser.mockResolvedValue(null);
    const result = await startTrialFor({ name: "Sunrise Homes", industry: "re" }, deps);
    expect(result).toMatchObject({ status: "failed", message: expect.stringContaining("Sign in again") });
    expect(deps.sessionState).not.toHaveBeenCalled();
    expect(deps.createTrialTenant).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin", "staff"] as const)("never creates a trial for a member (%s) of a business", async (role) => {
    deps.sessionState.mockResolvedValue(member(role));
    expect(await startTrialFor({ name: "Sunrise Homes", industry: "re" }, deps)).toEqual({ status: "has_business" });
    expect(deps.createTrialTenant).not.toHaveBeenCalled();
  });

  it("never creates a trial for an account with several businesses", async () => {
    deps.sessionState.mockResolvedValue({ status: "choose", memberships: [] });
    expect(await startTrialFor({ name: "Sunrise Homes", industry: "re" }, deps)).toEqual({ status: "has_business" });
    expect(deps.createTrialTenant).not.toHaveBeenCalled();
  });

  it("creates nothing if the memberships can't be checked", async () => {
    deps.sessionState.mockRejectedValue(new Error("upstream down"));
    expect(await startTrialFor({ name: "Sunrise Homes", industry: "re" }, deps)).toMatchObject({ status: "failed" });
    expect(deps.createTrialTenant).not.toHaveBeenCalled();
  });

  it.each(["hotel", "rest", "fix"])("doesn't call createTrialTenant for a trade without a pack (%s)", async (industry) => {
    expect(await startTrialFor({ name: "Hotel Kaveri", industry }, deps)).toEqual({ status: "unavailable" });
    expect(deps.createTrialTenant).not.toHaveBeenCalled();
  });

  it.each([
    [{ name: "   ", industry: "re" }, { name: "Enter your business name" }],
    [{ name: "x".repeat(121), industry: "re" }, { name: "Keep it under 120 characters" }],
    [{ name: "Sunrise Homes", industry: "real-estate" }, { industry: "Choose what you do" }],
    [{}, { name: expect.any(String), industry: "Choose what you do" }],
  ])("rejects invalid input %j", async (input, fields) => {
    expect(await startTrialFor(input, deps)).toEqual({ status: "invalid", fields });
    expect(deps.createTrialTenant).not.toHaveBeenCalled();
  });

  it("answers an owner of a paying business with a safe message", async () => {
    deps.createTrialTenant.mockRejectedValue(new Error("create_trial_tenant failed: create_trial_tenant: this account already owns a business"));
    expect(await startTrialFor({ name: "Sunrise Homes", industry: "re" }, deps)).toEqual({
      status: "failed",
      message: "This account already owns a business. Open your dashboard to continue.",
    });
  });

  it("logs other failures without credentials and shows a generic message", async () => {
    deps.createTrialTenant.mockRejectedValue(new Error("create_trial_tenant failed: Bearer abc.def.ghi"));
    expect(await startTrialFor({ name: "Sunrise Homes", industry: "re" }, deps)).toEqual({
      status: "failed",
      message: "We couldn't set up your trial. Try again in a moment.",
    });
    const logged = String(vi.mocked(console.error).mock.calls[0][0]);
    expect(logged).toContain("Bearer [redacted]");
    expect(logged).not.toContain("abc.def.ghi");
  });

  it("still reports the trial when the balance can't be read", async () => {
    deps.getBalance.mockRejectedValue(new Error("credit_balance failed"));
    expect(await startTrialFor({ name: "Sunrise Homes", industry: "re" }, deps)).toEqual({
      status: "ready",
      trial: { routeCode: "TRIAL-7KQM", trialDays: 7, credits: null },
    });
  });
});

describe("a WhatsApp number that already had a trial (the wizard's early warning)", () => {
  const input = { name: "Skyline Homes", industry: "re", phone: "+919800000601" };

  it("refuses with phone_used and creates nothing", async () => {
    deps.phoneUsed.mockResolvedValue(true);
    const result = await startTrialFor(input, deps);
    expect(result).toEqual({ status: "phone_used", message: expect.stringContaining("already had a free trial") });
    expect(deps.phoneUsed).toHaveBeenCalledWith("+919800000601");
    expect(deps.createTrialTenant).not.toHaveBeenCalled();
  });

  it("starts the trial when the number is new, and checks nothing when no number is sent", async () => {
    expect((await startTrialFor(input, deps)).status).toBe("ready");
    expect(deps.createTrialTenant).toHaveBeenCalledTimes(1);
    deps.phoneUsed.mockClear();
    expect((await startTrialFor({ name: "Skyline Homes", industry: "re" }, deps)).status).toBe("ready");
    expect(deps.phoneUsed).not.toHaveBeenCalled();
  });

  it("asks for the number with its country code, and says try again when the check fails", async () => {
    const invalid = await startTrialFor({ ...input, phone: "98000 00601" }, deps);
    expect(invalid).toMatchObject({ status: "invalid", fields: { phone: expect.any(String) } });
    expect(deps.phoneUsed).not.toHaveBeenCalled();
    deps.phoneUsed.mockRejectedValue(new Error("db down"));
    expect(await startTrialFor(input, deps)).toMatchObject({ status: "failed" });
    expect(deps.createTrialTenant).not.toHaveBeenCalled();
  });

  it("tells a member of a business that first, without checking the number", async () => {
    deps.sessionState.mockResolvedValue(member("owner"));
    expect(await startTrialFor(input, deps)).toEqual({ status: "has_business" });
    expect(deps.phoneUsed).not.toHaveBeenCalled();
  });
});
