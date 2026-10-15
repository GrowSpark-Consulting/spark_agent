import { describe, expect, it, vi } from "vitest";
import { functions } from "./functions";
import { connectionHealth, connectionHealthCheck, handleHealthCheck, handleHealthSweep, HEALTH_CHECK_EVENT, type HealthJobDeps } from "./connection-health";

// connection-health (Day 6): a daily sweep lists the manual connections that are due and starts one check per connection (an event with the day in
// its id, so a repeat sweep starts nothing twice); each check re-asks Meta, and a connection that has just failed is reported to its owners.

const A = "e0000000-0000-4000-8000-00000000000a";
const C1 = "d4000000-0000-4000-8000-0000000000a1";
const C2 = "d4000000-0000-4000-8000-0000000000a2";
const NOW = new Date("2026-10-13T01:30:00.000Z");

const stepper = () => {
  const ran: string[] = [];
  const events: { id: string; payload: { id?: string; name: string; data: unknown }[] }[] = [];
  return {
    ran,
    events,
    step: {
      // A step's result is stored as JSON, so what comes out of a step has been through JSON, like Inngest's.
      run: async <T>(id: string, fn: () => Promise<T>) => (ran.push(id), JSON.parse(JSON.stringify((await fn()) ?? null)) as T),
      sendEvent: async (id: string, payload: { id?: string; name: string; data: unknown }[]) => void events.push({ id, payload }),
    },
  };
};

const deps = (over: Partial<HealthJobDeps> = {}): HealthJobDeps => ({
  due: vi.fn(async () => [{ tenantId: A, connectionId: C1 }, { tenantId: A, connectionId: C2 }]),
  check: vi.fn(async () => ({ status: "checked" as const, overall: "pass" as const, failed: false as const })),
  alert: vi.fn(async () => ({ recipients: 1, sent: 1, skipped: 0, failed: 0 })),
  report: vi.fn(async () => true),
  now: () => NOW,
  ...over,
});

describe("the daily sweep", () => {
  it("starts one check per due connection, each event named by the connection and the day", async () => {
    const s = stepper();
    expect(await handleHealthSweep({ step: s.step }, deps())).toEqual({ due: 2 });
    expect(s.events).toEqual([
      {
        id: "fan-out",
        payload: [
          { id: `connection_health:${C1}:2026-10-13`, name: HEALTH_CHECK_EVENT, data: { tenantId: A, connectionId: C1 } },
          { id: `connection_health:${C2}:2026-10-13`, name: HEALTH_CHECK_EVENT, data: { tenantId: A, connectionId: C2 } },
        ],
      },
    ]);
  });

  // Exit test 1 (Day 7; inngest/replay-coverage.test.ts): Inngest drops an event whose id it has seen, so a repeated sweep starts no check twice.
  it("replay: the same sweep twice starts the same events (named by connection and day), so each connection is checked once", async () => {
    const first = stepper();
    const second = stepper();
    await handleHealthSweep({ step: first.step }, deps());
    await handleHealthSweep({ step: second.step }, deps());
    expect(second.events.flatMap((e) => e.payload.map((p) => p.id))).toEqual(first.events.flatMap((e) => e.payload.map((p) => p.id)));
  });

  it("with nothing due, starts nothing", async () => {
    const s = stepper();
    expect(await handleHealthSweep({ step: s.step }, deps({ due: vi.fn(async () => []) }))).toEqual({ due: 0 });
    expect(s.events).toEqual([]);
  });

  it("the day in the event id is the India day, so a sweep near midnight UTC does not collide with the next", async () => {
    const s = stepper();
    await handleHealthSweep({ step: s.step }, deps({ now: () => new Date("2026-10-13T19:00:00.000Z") }));
    expect(s.events[0].payload[0].id).toBe(`connection_health:${C1}:2026-10-14`);
  });

  it("a failure to list is thrown, so Inngest retries the sweep", async () => {
    await expect(handleHealthSweep({ step: stepper().step }, deps({ due: vi.fn(async () => Promise.reject(new Error("down"))) }))).rejects.toThrow("down");
  });
});

describe("one check", () => {
  const event = { data: { tenantId: A, connectionId: C1 } };

  it("checks the connection named, and reports only what happened, never a number or a token", async () => {
    const s = stepper();
    const d = deps();
    expect(await handleHealthCheck({ event, step: s.step }, d)).toEqual({ status: "checked", overall: "pass", failed: false });
    expect(d.check).toHaveBeenCalledWith({ tenantId: A, connectionId: C1 });
    expect(d.alert).not.toHaveBeenCalled();
    expect(s.ran).toEqual(["check"]);
  });

  it("a connection that has just failed is reported to its owners, in a step of its own, with the failure's key", async () => {
    const s = stepper();
    const alert = { reason: "token" as const, detail: "expired", phoneMasked: "+9198xxxxxx10", key: "connection_failed:c1:never" };
    const d = deps({ check: vi.fn(async () => ({ status: "checked" as const, overall: "fail" as const, failed: true as const, alert })) });
    const result = await handleHealthCheck({ event, step: s.step }, d);
    expect(d.alert).toHaveBeenCalledWith(A, alert);
    expect(s.ran).toEqual(["check", "alert", "report"]);
    expect(d.report).toHaveBeenCalledWith({ tenantId: A, connectionId: C1 }, "token");
    expect(result).toEqual({ status: "checked", overall: "fail", failed: true, alerts: { recipients: 1, sent: 1, skipped: 0, failed: 0 } });
    expect(JSON.stringify(result)).not.toContain("919876543210");
  });

  // Exit test 1: the failure's key (connection_health/health.ts) names this failure, and account notices send once per key and person.
  it("replay: the same check twice reports the same failure under the same key, so the owners hear once", async () => {
    const alert = { reason: "token" as const, detail: "expired", phoneMasked: "+9198xxxxxx10", key: "connection_failed:c1:never" };
    const d = deps({ check: vi.fn(async () => ({ status: "checked" as const, overall: "fail" as const, failed: true as const, alert })) });
    await handleHealthCheck({ event, step: stepper().step }, d);
    await handleHealthCheck({ event, step: stepper().step }, d);
    expect(vi.mocked(d.alert).mock.calls).toEqual([
      [A, alert],
      [A, alert],
    ]);
  });

  it("a check that was skipped (Meta not reached, not active any more) sends nothing", async () => {
    const d = deps({ check: vi.fn(async () => ({ status: "skipped" as const, reason: "unreachable" as const })) });
    expect(await handleHealthCheck({ event, step: stepper().step }, d)).toEqual({ status: "skipped", reason: "unreachable" });
    expect(d.alert).not.toHaveBeenCalled();
  });

  it("refuses an event that is not two ids", async () => {
    const d = deps();
    for (const data of [{}, { tenantId: A }, { tenantId: "x", connectionId: C1 }, null, "text"]) {
      await expect(handleHealthCheck({ event: { data }, step: stepper().step }, d)).rejects.toThrow();
    }
    expect(d.check).not.toHaveBeenCalled();
  });

  it("a database error is thrown so the step is retried", async () => {
    await expect(handleHealthCheck({ event, step: stepper().step }, deps({ check: vi.fn(async () => Promise.reject(new Error("down"))) }))).rejects.toThrow("down");
  });
});

describe("registration", () => {
  it("both functions are served, the sweep once a day at 01:30 UTC and the check on its event, five at a time", () => {
    expect(functions).toContain(connectionHealth);
    expect(functions).toContain(connectionHealthCheck);
    const config = (fn: unknown) => (fn as { opts: { id: string; triggers?: unknown[]; concurrency?: unknown } }).opts;
    expect(config(connectionHealth)).toMatchObject({ id: "connection-health", triggers: [{ cron: "30 1 * * *" }] });
    expect(config(connectionHealthCheck)).toMatchObject({ id: "connection-health-check", triggers: [{ event: HEALTH_CHECK_EVENT }], concurrency: { limit: 5 } });
  });
});
