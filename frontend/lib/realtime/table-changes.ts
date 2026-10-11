import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { ensureRealtimeAuth } from "@/lib/supabase/browser";
import { watchableTables } from "./published-tables";

// "Something changed in these tables for this business: read again." Used by screens that read their data with a normal
// query and only need to know WHEN to read again (the Leads board, the Calendar), not what changed. Because the answer
// is a fresh read, an event that arrives twice, in the wrong order or for a row the screen never showed cannot put a
// duplicate or a stale row on screen: the screen replaces what it holds with what the database says now.
//
// The shape follows the Inbox's hook (features/inbox/use-inbox-realtime.ts): one channel per screen and business, the
// member's session set on the socket first (without it Realtime authorises an anonymous user and RLS sends nothing),
// a leftover channel from a previous mount removed first, a re-read after (re)subscribing to catch what was missed.

export type TableChangeState = "connecting" | "live" | "unavailable";

/**
 * Turns a burst of events into one re-read. The first event waits `waitMs` for company; if a read is running when it
 * fires, the next waits for it to finish; however many events arrive meanwhile, exactly one more read follows. `cancel`
 * drops anything pending (the screen left, or the business changed).
 */
export function createCoalescer(
  run: () => Promise<void> | void,
  waitMs: number,
  timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout },
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let again = false;
  let cancelled = false;

  const schedule = () => {
    if (cancelled || timer !== null) return;
    timer = timers.set(() => void fire(), waitMs);
  };

  const fire = async () => {
    timer = null;
    if (cancelled) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await run();
    } catch {
      // The screen shows its own error for a failed read; a failed re-read must not stop later ones.
    } finally {
      running = false;
    }
    if (again && !cancelled) {
      again = false;
      schedule();
    }
  };

  return {
    /** A change was seen. */
    notify() {
      if (running) again = true;
      else schedule();
    },
    cancel() {
      cancelled = true;
      if (timer !== null) timers.clear(timer);
      timer = null;
    },
  };
}

export interface SubscribeOptions {
  client: SupabaseClient;
  tenantId: string;
  /** What the screen wants to hear about. Only tables the database publishes are subscribed to. */
  tables: readonly string[];
  /** Names the channel: one per screen and business. */
  screen: string;
  /** Called (already coalesced) whenever the screen should read again. */
  onRefresh: () => Promise<void> | void;
  onState: (state: TableChangeState) => void;
  /** Sets the member's session on the socket; false when there is none. */
  ensureAuth?: (client: SupabaseClient) => Promise<boolean>;
  waitMs?: number;
}

export const REFRESH_WAIT_MS = 400;
/** After a dropped connection comes back, read again; but never more often than this, so a flapping socket can't flood the database. */
export const RESUBSCRIBE_MIN_GAP_MS = 10_000;

/** Subscribes, and returns the function that undoes it. Safe to call before the subscription has finished. */
export function subscribeToTableChanges(options: SubscribeOptions): () => void {
  const { client, tenantId, screen, onRefresh, onState, ensureAuth = ensureRealtimeAuth, waitMs = REFRESH_WAIT_MS } = options;
  const tables = watchableTables(options.tables);
  // Nothing published to listen to: say so, and do not pretend. The screen's Refresh button is its way to update.
  if (tables.length === 0) {
    onState("unavailable");
    return () => {};
  }

  const coalescer = createCoalescer(onRefresh, waitMs);
  const topic = `refresh:${screen}:${tenantId}`;
  let cancelled = false;
  let channel: RealtimeChannel | null = null;
  let subscribedBefore = false;
  let interrupted = false;
  let lastCatchUp = 0;

  onState("connecting");
  void (async () => {
    // client.channel() returns an existing channel with the same topic: make sure none is left from a previous mount.
    await Promise.all(
      client
        .getChannels()
        .filter((c) => c.topic === `realtime:${topic}`)
        .map((c) => client.removeChannel(c)),
    );
    if (cancelled) return;

    let signedIn = false;
    try {
      signedIn = await ensureAuth(client);
    } catch {
      signedIn = false;
    }
    if (cancelled) return;
    if (!signedIn) {
      onState("unavailable");
      return;
    }

    let next = client.channel(topic);
    for (const table of tables) {
      // Every kind of change, for this business only. Realtime applies the member's RLS as well.
      next = next.on("postgres_changes", { event: "*", schema: "public", table, filter: `tenant_id=eq.${tenantId}` }, (payload) => {
        // A change that names another business is ignored even if it somehow arrives.
        const row = (payload.new ?? payload.old) as { tenant_id?: unknown } | null | undefined;
        if (row && typeof row.tenant_id === "string" && row.tenant_id !== tenantId) return;
        coalescer.notify();
      });
    }
    channel = next.subscribe((status) => {
      if (cancelled) return;
      if (status === "SUBSCRIBED") {
        onState("live");
        // First subscribe, or back after a drop: read once to catch what happened meanwhile (rate limited).
        const now = Date.now();
        if ((!subscribedBefore || interrupted) && now - lastCatchUp >= RESUBSCRIBE_MIN_GAP_MS) {
          lastCatchUp = now;
          coalescer.notify();
        }
        subscribedBefore = true;
        interrupted = false;
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        interrupted = true;
        onState("unavailable");
      }
    });
  })();

  return () => {
    cancelled = true;
    coalescer.cancel();
    if (channel) void client.removeChannel(channel);
  };
}
