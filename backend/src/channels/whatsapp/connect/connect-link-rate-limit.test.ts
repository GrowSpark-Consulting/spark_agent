import { describe, expect, it } from "vitest";
import { clientKey, createRateLimiter } from "./connect-link-rate-limit";

describe("createRateLimiter", () => {
  it("allows 30 a minute per key and refuses the 31st", () => {
    const now = 0;
    const allow = createRateLimiter({ limit: 30, windowMs: 60_000, now: () => now });
    for (let i = 0; i < 30; i++) expect(allow("a")).toBe(true);
    expect(allow("a")).toBe(false);
    expect(allow("b")).toBe(true);
  });

  it("starts again when the minute is over", () => {
    let now = 0;
    const allow = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => now });
    allow("a");
    allow("a");
    expect(allow("a")).toBe(false);
    now = 60_001;
    expect(allow("a")).toBe(true);
  });

  it("a flood of new addresses sweeps the full map at most once a second", () => {
    let now = 0;
    const allow = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => now, maxKeys: 10 });
    for (let i = 0; i < 10; i++) allow(`k${i}`); // full, all live
    for (let i = 0; i < 100; i++) allow(`flood${i}`); // nothing to sweep, and no sweep per request
    expect(allow.size()).toBeLessThanOrEqual(110);
    now = 61_000; // everything expired: one sweep clears it
    allow("late");
    expect(allow.size()).toBeLessThanOrEqual(2);
  });

  it("forgets old keys so memory stays bounded", () => {
    let now = 0;
    const allow = createRateLimiter({ limit: 1, windowMs: 1000, now: () => now, maxKeys: 50 });
    for (let i = 0; i < 200; i++) {
      now += 2000;
      allow(`k${i}`);
    }
    expect(allow.size()).toBeLessThanOrEqual(51);
  });
});

describe("clientKey", () => {
  const req = (headers: Record<string, string>) => new Request("http://x/", { headers });

  it("uses the address the proxy appended (the last of x-forwarded-for), not what the caller wrote first", () => {
    expect(clientKey(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("falls back to one shared key when there is no header", () => {
    expect(clientKey(req({}))).toBe("unknown");
  });
});
