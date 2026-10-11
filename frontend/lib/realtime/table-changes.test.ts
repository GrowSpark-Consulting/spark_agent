import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/browser", () => ({ ensureRealtimeAuth: vi.fn(async () => true), getSupabaseBrowserClient: () => ({}) }));

const { createCoalescer, REFRESH_WAIT_MS, RESUBSCRIBE_MIN_GAP_MS, subscribeToTableChanges } = await import("./table-changes");

// The "read again when something changed" layer, against a fake Realtime client and fake timers. It shows the logic:
// which tables are subscribed, that bursts become one read, that nothing outlives the screen, and that another business's
// change is ignored. It does NOT show that a real Supabase delivers anything: the tables the screens care about
// (leads, bookings) are not in the publication yet, and only staging can show events arriving.

const TENANT = "a0000000-0000-4000-8000-00000000000a";
const OTHER = "b0000000-0000-4000-8000-00000000000b";

type Handler = (payload: { new?: unknown; old?: unknown }) => void;
interface FakeChannel {
  topic: string;
  handlers: { table: string; event: string; filter: string; fn: Handler }[];
  status?: (s: string) => void;
}

function fakeRealtime(existing: string[] = []) {
  const channels: FakeChannel[] = [];
  const removed: string[] = [];
  const present: { topic: string }[] = existing.map((topic) => ({ topic: `realtime:${topic}` }));
  const client = {
    getChannels: () => present,
    removeChannel: vi.fn(async (c: { topic: string }) => {
      removed.push(c.topic);
      const at = present.findIndex((p) => p.topic === c.topic);
      if (at >= 0) present.splice(at, 1);
    }),
    channel: (topic: string) => {
      const ch: FakeChannel = { topic: `realtime:${topic}`, handlers: [] };
      channels.push(ch);
      present.push(ch);
      const api = {
        topic: ch.topic,
        on: (_type: string, spec: { table: string; event: string; filter: string }, fn: Handler) => {
          ch.handlers.push({ table: spec.table, event: spec.event, filter: spec.filter, fn });
          return api;
        },
        subscribe: (cb: (s: string) => void) => {
          ch.status = cb;
          return api;
        },
      };
      return api;
    },
  } as unknown as SupabaseClient;
  return { client, channels, removed };
}

const tick = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-12T09:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

function open(over: Partial<Parameters<typeof subscribeToTableChanges>[0]> = {}) {
  const rt = fakeRealtime();
  const onRefresh = vi.fn(async () => {});
  const states: string[] = [];
  const stop = subscribeToTableChanges({
    client: rt.client, tenantId: TENANT, tables: ["messages"], screen: "board", onRefresh, onState: (s) => states.push(s),
    ensureAuth: async () => true, ...over,
  });
  return { ...rt, onRefresh, states, stop };
}

describe("which tables are subscribed", () => {
  it("subscribes to nothing for tables the database doesn't publish, and says updates aren't live", async () => {
    const { channels, states, onRefresh } = open({ tables: ["leads", "bookings"] });
    await tick(1000);
    expect(channels).toHaveLength(0);
    expect(states).toEqual(["unavailable"]);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("subscribes only to the published ones when some are asked for, for this business only, on every kind of change", async () => {
    const { channels } = open({ tables: ["leads", "messages", "handoffs"] });
    await tick();
    expect(channels).toHaveLength(1);
    expect(channels[0].topic).toBe(`realtime:refresh:board:${TENANT}`);
    expect(channels[0].handlers.map((h) => [h.table, h.event, h.filter])).toEqual([
      ["messages", "*", `tenant_id=eq.${TENANT}`],
      ["handoffs", "*", `tenant_id=eq.${TENANT}`],
    ]);
  });

  it("makes one channel per screen and business, never one per row or per event", async () => {
    const { channels } = open({ tables: ["messages", "conversations"] });
    await tick();
    expect(channels).toHaveLength(1);
  });

  it("says unavailable and subscribes to nothing when there is no session", async () => {
    const { channels, states } = open({ ensureAuth: async () => false });
    await tick();
    expect(channels).toHaveLength(0);
    expect(states).toEqual(["connecting", "unavailable"]);
  });

  it("removes a channel left over from a previous mount before making its own", async () => {
    const rt = fakeRealtime([`refresh:board:${TENANT}`]);
    subscribeToTableChanges({ client: rt.client, tenantId: TENANT, tables: ["messages"], screen: "board", onRefresh: async () => {}, onState: () => {}, ensureAuth: async () => true });
    await tick();
    expect(rt.removed).toEqual([`realtime:refresh:board:${TENANT}`]);
    expect(rt.channels).toHaveLength(1);
  });
});

describe("reading again", () => {
  it("turns a burst of changes into one read, after a short wait", async () => {
    const { channels, onRefresh } = open();
    await tick();
    channels[0].status?.("SUBSCRIBED");
    await tick(REFRESH_WAIT_MS + 1);
    onRefresh.mockClear();
    for (let i = 0; i < 25; i++) channels[0].handlers[0].fn({ new: { tenant_id: TENANT, id: `row-${i}` } });
    await tick(REFRESH_WAIT_MS - 1);
    expect(onRefresh).not.toHaveBeenCalled();
    await tick(2);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("reads exactly once more for changes that arrive while a read is running", async () => {
    let finish: () => void = () => {};
    const onRefresh = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { channels } = open({ onRefresh });
    await tick();
    channels[0].handlers[0].fn({ new: { tenant_id: TENANT } });
    await tick(REFRESH_WAIT_MS + 1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 10; i++) channels[0].handlers[0].fn({ new: { tenant_id: TENANT } }); // during the read
    await tick(REFRESH_WAIT_MS * 3);
    expect(onRefresh).toHaveBeenCalledTimes(1); // still the first, never overlapped
    finish();
    await tick(REFRESH_WAIT_MS + 1);
    expect(onRefresh).toHaveBeenCalledTimes(2);
    finish();
    await tick(REFRESH_WAIT_MS * 3);
    expect(onRefresh).toHaveBeenCalledTimes(2); // not a third
  });

  it("ignores a change that names another business, new or old", async () => {
    const { channels, onRefresh } = open();
    await tick();
    channels[0].handlers[0].fn({ new: { tenant_id: OTHER } });
    channels[0].handlers[0].fn({ old: { tenant_id: OTHER } });
    await tick(REFRESH_WAIT_MS * 3);
    expect(onRefresh).not.toHaveBeenCalled();
    channels[0].handlers[0].fn({ new: { tenant_id: TENANT } });
    await tick(REFRESH_WAIT_MS + 1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("keeps listening after a read fails", async () => {
    const onRefresh = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const { channels } = open({ onRefresh });
    await tick();
    channels[0].handlers[0].fn({ new: { tenant_id: TENANT } });
    await tick(REFRESH_WAIT_MS + 1);
    channels[0].handlers[0].fn({ new: { tenant_id: TENANT } });
    await tick(REFRESH_WAIT_MS + 1);
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });
});

describe("connection state and catching up", () => {
  it("is live once subscribed, and reads once to catch what happened before the subscription", async () => {
    const { channels, states, onRefresh } = open();
    await tick();
    expect(states).toEqual(["connecting"]);
    channels[0].status?.("SUBSCRIBED");
    expect(states).toEqual(["connecting", "live"]);
    await tick(REFRESH_WAIT_MS + 1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("says unavailable when the channel fails or closes, and catches up when it comes back (not more than once per gap)", async () => {
    const { channels, states, onRefresh } = open();
    await tick();
    channels[0].status?.("SUBSCRIBED");
    await tick(REFRESH_WAIT_MS + 1);
    onRefresh.mockClear();
    channels[0].status?.("CHANNEL_ERROR");
    expect(states.at(-1)).toBe("unavailable");
    channels[0].status?.("SUBSCRIBED"); // back immediately: too soon after the last catch-up
    await tick(REFRESH_WAIT_MS + 1);
    expect(onRefresh).not.toHaveBeenCalled();
    await tick(RESUBSCRIBE_MIN_GAP_MS);
    channels[0].status?.("CLOSED");
    channels[0].status?.("SUBSCRIBED");
    await tick(REFRESH_WAIT_MS + 1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toBe("live");
  });
});

describe("cleaning up", () => {
  it("removes the channel and drops a pending read when the screen leaves", async () => {
    const { channels, removed, onRefresh, stop } = open();
    await tick();
    channels[0].handlers[0].fn({ new: { tenant_id: TENANT } });
    stop();
    await tick(REFRESH_WAIT_MS * 5);
    expect(removed).toEqual([`realtime:refresh:board:${TENANT}`]);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("ignores later status changes and later changes once stopped", async () => {
    const { channels, states, onRefresh, stop } = open();
    await tick();
    stop();
    channels[0].status?.("SUBSCRIBED");
    channels[0].handlers[0].fn({ new: { tenant_id: TENANT } });
    await tick(REFRESH_WAIT_MS * 5);
    expect(states).toEqual(["connecting"]);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("never makes a channel if it was stopped before the subscription finished", async () => {
    const rt = fakeRealtime();
    let release: (signedIn: boolean) => void = () => {};
    const stop = subscribeToTableChanges({
      client: rt.client, tenantId: TENANT, tables: ["messages"], screen: "board", onRefresh: async () => {}, onState: () => {},
      ensureAuth: () => new Promise<boolean>((resolve) => { release = resolve; }),
    });
    await tick();
    stop();
    release(true);
    await tick();
    expect(rt.channels).toHaveLength(0);
  });

  it("moves to another business cleanly: the old channel is removed and its late changes are ignored", async () => {
    const rt = fakeRealtime();
    const refreshA = vi.fn(async () => {});
    const refreshB = vi.fn(async () => {});
    const stopA = subscribeToTableChanges({ client: rt.client, tenantId: TENANT, tables: ["messages"], screen: "board", onRefresh: refreshA, onState: () => {}, ensureAuth: async () => true });
    await tick();
    const channelA = rt.channels[0];
    stopA();
    subscribeToTableChanges({ client: rt.client, tenantId: OTHER, tables: ["messages"], screen: "board", onRefresh: refreshB, onState: () => {}, ensureAuth: async () => true });
    await tick();
    expect(rt.removed).toContain(`realtime:refresh:board:${TENANT}`);
    expect(rt.channels[1].handlers[0].filter).toBe(`tenant_id=eq.${OTHER}`);
    channelA.handlers[0].fn({ new: { tenant_id: TENANT } }); // A's channel was torn down but a late event slips in
    rt.channels[1].handlers[0].fn({ new: { tenant_id: OTHER } });
    await tick(REFRESH_WAIT_MS + 1);
    expect(refreshA).not.toHaveBeenCalled();
    expect(refreshB).toHaveBeenCalledTimes(1);
  });
});

describe("createCoalescer", () => {
  it("runs once for a burst, and not at all after cancel", async () => {
    const run = vi.fn();
    const c = createCoalescer(run, 100);
    c.notify();
    c.notify();
    c.notify();
    await tick(101);
    expect(run).toHaveBeenCalledTimes(1);
    c.notify();
    c.cancel();
    await tick(500);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
