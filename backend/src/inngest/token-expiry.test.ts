import { describe, expect, it, vi } from "vitest";
import { functions } from "./functions";
import { handleTokenExpiry, tokenExpiry, type TokenExpiryDeps } from "./token-expiry";

// token-expiry (Day 6): once a day, every manual connection whose token runs out within 7 days is warned about, one step per connection.

const A = "e0000000-0000-4000-8000-00000000000a";
const conn = (n: number) => ({ tenantId: A, connectionId: `d4000000-0000-4000-8000-0000000000a${n}`, phoneMasked: "+9198xxxxxx10", expiresAt: new Date("2026-10-18T09:30:00.000Z") });

const stepper = () => {
  const ran: string[] = [];
  // A step's result is stored as JSON: what comes out of a step has been through JSON, like Inngest's.
  return { ran, step: { run: async <T>(id: string, fn: () => Promise<T>) => (ran.push(id), JSON.parse(JSON.stringify((await fn()) ?? null)) as T) } };
};
const deps = (over: Partial<TokenExpiryDeps> = {}): TokenExpiryDeps => ({
  due: vi.fn(async () => [conn(1), conn(2)]),
  warn: vi.fn(async () => ({ recipients: 1, sent: 1, skipped: 0, failed: 0 })),
  ...over,
});

describe("the daily token-expiry run", () => {
  it("warns about each connection in a step of its own, so a retry repeats only what failed", async () => {
    const s = stepper();
    const d = deps();
    const result = await handleTokenExpiry({ step: s.step }, d);
    expect(s.ran).toEqual(["due", `warn-${conn(1).connectionId}`, `warn-${conn(2).connectionId}`]);
    expect(d.warn).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ due: 2, warned: { recipients: 2, sent: 2, skipped: 0, failed: 0 } });
  });

  // Exit test 1 (Day 7; inngest/replay-coverage.test.ts): each warning is named by the connection, the expiry date and the person, so the
  // same date is never warned twice (channels/whatsapp/connect/token-expiry.test.ts).
  it("replay: the same run twice warns about the same connections and expiry dates, so nobody is warned twice", async () => {
    const d = deps();
    await handleTokenExpiry({ step: stepper().step }, d);
    await handleTokenExpiry({ step: stepper().step }, d);
    const warned = vi.mocked(d.warn).mock.calls.map(([c]) => `${c.connectionId}:${c.expiresAt.toISOString()}`);
    expect(warned.slice(2)).toEqual(warned.slice(0, 2));
  });

  it("with nothing expiring, does nothing", async () => {
    const d = deps({ due: vi.fn(async () => []) });
    expect(await handleTokenExpiry({ step: stepper().step }, d)).toEqual({ due: 0, warned: { recipients: 0, sent: 0, skipped: 0, failed: 0 } });
    expect(d.warn).not.toHaveBeenCalled();
  });

  it("a connection's expiry date survives the trip through a step's stored result as a date", async () => {
    const d = deps();
    await handleTokenExpiry({ step: stepper().step }, d);
    expect(d.warn).toHaveBeenCalledWith(expect.objectContaining({ expiresAt: new Date("2026-10-18T09:30:00.000Z") }));
  });

  it("reports counts only: no number, no date, no business", async () => {
    expect(JSON.stringify(await handleTokenExpiry({ step: stepper().step }, deps()))).not.toMatch(/9198|2026|e0000000/);
  });

  it("a failure to list is thrown, so Inngest retries", async () => {
    await expect(handleTokenExpiry({ step: stepper().step }, deps({ due: vi.fn(async () => Promise.reject(new Error("down"))) }))).rejects.toThrow("down");
  });

  it("is served once a day at 04:00 UTC", () => {
    expect(functions).toContain(tokenExpiry);
    expect((tokenExpiry as unknown as { opts: unknown }).opts).toMatchObject({ id: "token-expiry", triggers: [{ cron: "0 4 * * *" }] });
  });
});
