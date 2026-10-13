import { describe, expect, it } from "vitest";
import { FAST_REFRESH_MS, refreshIntervalMs, SLOW_REFRESH_MS } from "./auto-refresh";

describe("refreshIntervalMs", () => {
  it("is quick while a number is being set up or checked", () => {
    expect(refreshIntervalMs(["pending"])).toBe(FAST_REFRESH_MS);
    expect(refreshIntervalMs(["validating"])).toBe(FAST_REFRESH_MS);
    expect(refreshIntervalMs(["active", "validating"])).toBe(FAST_REFRESH_MS);
  });
  it("is slow while a number is live or failed, since the daily health check can change it on its own", () => {
    expect(refreshIntervalMs(["active"])).toBe(SLOW_REFRESH_MS);
    expect(refreshIntervalMs(["failed"])).toBe(SLOW_REFRESH_MS);
    expect(refreshIntervalMs(["disconnected", "active"])).toBe(SLOW_REFRESH_MS);
  });
  it("stops when nothing can change by itself", () => {
    expect(refreshIntervalMs([])).toBeNull();
    expect(refreshIntervalMs(["disconnected", "disconnected"])).toBeNull();
  });
});
