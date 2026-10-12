import type { Page, WebSocketRoute } from "@playwright/test";

// A stand-in for Supabase Realtime, so the app's real subscription code runs in a browser test. It speaks the Phoenix protocol
// realtime-js uses (page.routeWebSocket): a join succeeds (or fails), heartbeats are answered, and a test can push row changes.
// It is NOT Supabase: it applies no RLS and publishes nothing; it only shows how the screen reacts to what it is sent.

export interface RealtimeJoin {
  topic: string;
  joinRef: string;
  accessToken: string;
  /** The postgres_changes filters the page asked for, with the ids the server would give them. */
  changes: { id: number; event: string; schema: string; table: string; filter?: string }[];
}

export interface RealtimeStub {
  joins: RealtimeJoin[];
  /** Sends one change on the latest join to every subscription for `table` (any event). */
  push: (table: string, type: "INSERT" | "UPDATE" | "DELETE", record: Record<string, unknown>) => void;
}

/** Answers every Realtime socket the page opens. With `fail`, joins are refused, as when a table isn't in the publication. */
export async function mockRealtime(page: Page, { fail = false } = {}): Promise<RealtimeStub> {
  const joins: RealtimeJoin[] = [];
  let socket: WebSocketRoute | undefined;
  await page.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => {
    socket = ws;
    ws.onMessage((raw) => {
      const [joinRef, ref, topic, event, payload] = JSON.parse(String(raw));
      const reply = (status: string, response: unknown) => ws.send(JSON.stringify([joinRef, ref, topic, "phx_reply", { status, response }]));
      if (event === "heartbeat" || event === "phx_leave") reply("ok", {});
      else if (event === "phx_join") {
        if (fail) return reply("error", { reason: "Unable to subscribe to changes with given parameters" });
        const changes = payload.config.postgres_changes.map((f: Omit<RealtimeJoin["changes"][number], "id">, i: number) => ({ ...f, id: i + 1 }));
        joins.push({ topic, joinRef, accessToken: payload.access_token, changes });
        reply("ok", { postgres_changes: changes });
      }
    });
  });
  return {
    joins,
    push(table, type, record) {
      const join = joins[joins.length - 1];
      if (!join) throw new Error("no Realtime join to push on yet");
      const ids = join.changes.filter((c) => c.table === table).map((c) => c.id);
      socket!.send(
        JSON.stringify([
          null,
          null,
          join.topic,
          "postgres_changes",
          { ids, data: { type, schema: "public", table, commit_timestamp: new Date().toISOString(), columns: [], record, errors: null } },
        ]),
      );
    },
  };
}
