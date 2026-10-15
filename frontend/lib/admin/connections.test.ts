import type { AdminConnection } from "@pakka/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getJson = vi.fn();
vi.mock("@/lib/api/client", () => ({ getJson: (...a: unknown[]) => getJson(...a) }));

const { AdminDataError } = await import("./billing");
const { businessName, fetchAdminConnections, isPlatformNumber, lastCheckLine, METHOD_LABEL, STATUS_VIEW, whenText } = await import("./connections");

// Typed as the shared contract, so a field the contract drops or renames fails the typecheck here, not in the browser.
const connection = (over: Partial<AdminConnection> = {}): AdminConnection => ({
  id: "c1",
  tenantId: "t1",
  tenantName: "Skyline Homes",
  method: "embedded_signup",
  status: "active",
  displayPhone: "+91 98765 43210",
  verifiedName: "Skyline Homes",
  coexistence: false,
  qualityRating: "GREEN",
  messagingLimit: "TIER_1K",
  tokenExpiresAt: null,
  lastCheck: null,
  createdAt: "2026-10-10T08:00:00.000Z",
  updatedAt: "2026-10-11T08:00:00.000Z",
  ...over,
});

beforeEach(() => {
  getJson.mockReset();
});

describe("fetchAdminConnections", () => {
  it("reads the documented path with no business header and returns the plain array as sent", async () => {
    const rows = [connection(), connection({ id: "c2", status: "disconnected", displayPhone: null, verifiedName: null, qualityRating: null, messagingLimit: null })];
    getJson.mockResolvedValue(rows);
    expect(await fetchAdminConnections()).toEqual(rows);
    expect(getJson.mock.calls[0][0]).toBe("/api/admin/whatsapp/connections");
    expect(getJson.mock.calls[0][1].tenantId).toBeUndefined();
  });

  it("accepts every documented method and status, nullable fields and a missing lastCheck", async () => {
    const methods = Object.keys(METHOD_LABEL) as AdminConnection["method"][];
    const statuses = Object.keys(STATUS_VIEW) as AdminConnection["status"][];
    getJson.mockResolvedValue([...methods.map((method, i) => connection({ id: `m${i}`, method })), ...statuses.map((status, i) => connection({ id: `s${i}`, status, lastCheck: null }))]);
    expect(await fetchAdminConnections()).toHaveLength(methods.length + statuses.length);
  });

  it("accepts an empty list", async () => {
    getJson.mockResolvedValue([]);
    expect(await fetchAdminConnections()).toEqual([]);
  });

  it("refuses an answer that is not the contract's shape, rather than showing part of it", async () => {
    getJson.mockResolvedValue([{ ...connection(), status: "paused" }]);
    await expect(fetchAdminConnections()).rejects.toBeInstanceOf(AdminDataError);
    getJson.mockResolvedValue({ connections: [] });
    await expect(fetchAdminConnections()).rejects.toBeInstanceOf(AdminDataError);
  });

  it("passes a server refusal on unchanged (forbidden is worded by the screen)", async () => {
    getJson.mockRejectedValue(new Error("forbidden"));
    await expect(fetchAdminConnections()).rejects.toThrow("forbidden");
  });
});

describe("how a connection reads", () => {
  it("words every status, and only an active one reads as ok", () => {
    expect(Object.entries(STATUS_VIEW).filter(([, v]) => v.tone === "ok").map(([k]) => k)).toEqual(["active"]);
    expect(STATUS_VIEW.failed.tone).toBe("warn");
    expect(STATUS_VIEW.disconnected.tone).toBe("off");
  });

  it("labels the platform number as ours", () => {
    expect(isPlatformNumber(connection({ method: "platform" }))).toBe(true);
    expect(isPlatformNumber(connection())).toBe(false);
    expect(METHOD_LABEL.platform).toMatch(/platform number/i);
  });

  it("falls back for a blank business name and a missing or unreadable date", () => {
    expect(businessName(connection({ tenantName: "" }))).toBe("Unnamed business");
    expect(businessName(connection({ tenantName: "  " }))).toBe("Unnamed business");
    expect(whenText(null)).toBe("—");
    expect(whenText("not a date")).toBe("—");
    expect(whenText("2026-10-10T08:00:00.000Z")).toContain("2026");
  });

  it("says nothing about the health of a connection that was never checked", () => {
    expect(lastCheckLine({ lastCheck: null })).toMatch(/not checked yet/i);
  });

  it("claims only what overall proves", () => {
    const check = (overall: "pass" | "warn" | "fail", n: number) => ({ lastCheck: { ranAt: "2026-10-11T00:00:00.000Z", overall, checks: Array.from({ length: n }, (_, i) => ({ key: `k${i}`, status: "pass" as const, message: null })) } });
    expect(lastCheckLine(check("pass", 6))).toBe("All 6 checks passed.");
    expect(lastCheckLine(check("warn", 6))).toMatch(/no check failed/i);
    expect(lastCheckLine(check("fail", 6))).toMatch(/failed/i);
    expect(lastCheckLine(check("pass", 0))).toBe("Checked, but no results were stored.");
  });
});
