import { describe, expect, it, vi } from "vitest";

// Building the real database client fails here (no settings): the step must still end as a skip.
vi.mock("../../lib/supabase-admin", () => ({
  supabaseAdmin: () => {
    throw new Error("no settings, call 9812345621");
  },
}));
import { fakeTables, type Row } from "../../test-support/fake-tables";
import type { markRead } from "./adapter";
import { MARK_READ_MIN_LEFT_MS, MARK_READ_TIMEOUT_MS, markCustomerMessageRead, markReadStep, type MarkReadDeps } from "./mark-read";

// The blue ticks: when the assistant will handle a customer's message, it is marked read through the Cloud API. Best effort, and never a reason to
// stop, delay or change a reply.

const A = "e0000000-0000-4000-8000-00000000000a";
const B = "e0000000-0000-4000-8000-00000000000b";
const CONV = "c0000000-0000-4000-8000-0000000000c1";
const CHANNEL = "ca000000-0000-4000-8000-0000000000c1";
const CONN = "d4000000-0000-4000-8000-0000000000a1";
const M1 = "a0000000-0000-4000-8000-0000000000a1";
const M2 = "a0000000-0000-4000-8000-0000000000a2";
const TURN = { tenantId: A, conversationId: CONV, messageIds: [M1, M2] };

const message = (id: string, wamid: string, at: string, over: Row = {}): Row => ({ id, tenant_id: A, conversation_id: CONV, direction: "in", sender: "customer", provider_msg_id: wamid, created_at: at, ...over });
const tables = (over: Record<string, Row[]> = {}) => ({
  messages: [message(M1, "wamid.FIRST", "2026-10-12T09:00:00Z"), message(M2, "wamid.SECOND", "2026-10-12T09:00:02Z")],
  conversations: [{ id: CONV, tenant_id: A, channel_id: CHANNEL }],
  whatsapp_connections: [{ id: CONN, tenant_id: A, channel_id: CHANNEL, status: "active", phone_number_id: "200", token_enc: "enc:token", created_at: "2026-10-01T00:00:00Z" }],
  ...over,
});

function setup(rows = tables(), read: ReturnType<typeof vi.fn> = vi.fn(async () => ({ ok: true, value: { success: true } }))) {
  const t = fakeTables(rows);
  const deps: MarkReadDeps = { db: t.db, markRead: read as unknown as typeof markRead, now: () => 1_000_000 };
  return { t, read, deps };
}

describe("markCustomerMessageRead", () => {
  it("marks the newest message of the turn read, through the business's active connection, with a short timeout", async () => {
    const s = setup();
    expect(await markCustomerMessageRead(TURN, s.deps)).toEqual({ status: "marked" });
    expect(s.read).toHaveBeenCalledOnce();
    const [connection, wamid, adapterDeps] = s.read.mock.calls[0] as unknown as [Record<string, string>, string, { timeoutMs: number }];
    expect(wamid).toBe("wamid.SECOND");
    expect(connection).toMatchObject({ tenantId: A, connectionId: CONN, phoneNumberId: "200", tokenEnc: "enc:token" });
    expect(adapterDeps.timeoutMs).toBe(MARK_READ_TIMEOUT_MS);
    expect(MARK_READ_TIMEOUT_MS).toBeLessThanOrEqual(3000);
  });

  it("every query names the business", async () => {
    const s = setup();
    await markCustomerMessageRead(TURN, s.deps);
    expect(s.t.calls.length).toBe(3);
    for (const call of s.t.calls) expect(call.filters).toEqual(expect.arrayContaining([{ column: "tenant_id", op: "eq", value: A }]));
  });

  it("looks only at the customer's inbound messages of that conversation and turn", async () => {
    const s = setup(
      tables({
        messages: [
          message(M1, "wamid.FIRST", "2026-10-12T09:00:00Z"),
          message("a0000000-0000-4000-8000-0000000000a3", "wamid.OUTBOUND", "2026-10-12T09:00:05Z", { direction: "out", sender: "ai" }),
          message("a0000000-0000-4000-8000-0000000000a4", "wamid.OTHER_CHAT", "2026-10-12T09:00:06Z", { conversation_id: "c0000000-0000-4000-8000-0000000000c2" }),
          message("a0000000-0000-4000-8000-0000000000a5", "wamid.OTHER_TENANT", "2026-10-12T09:00:07Z", { tenant_id: B }),
        ],
      }),
    );
    await markCustomerMessageRead({ ...TURN, messageIds: [M1, "a0000000-0000-4000-8000-0000000000a3", "a0000000-0000-4000-8000-0000000000a4", "a0000000-0000-4000-8000-0000000000a5"] }, s.deps);
    expect(s.read.mock.calls[0][1]).toBe("wamid.FIRST");
  });

  it("skips, calling nothing, when there is no inbound message with a provider id", async () => {
    for (const messages of [[], [message(M1, null as unknown as string, "2026-10-12T09:00:00Z")]]) {
      const s = setup(tables({ messages }));
      expect(await markCustomerMessageRead(TURN, s.deps)).toEqual({ status: "skipped", reason: "no_message" });
      expect(s.read).not.toHaveBeenCalled();
    }
  });

  it("skips when the business has no active connection on that channel (a disconnected number is never used)", async () => {
    for (const connections of [[], [{ id: CONN, tenant_id: A, channel_id: CHANNEL, status: "disconnected", phone_number_id: "200", token_enc: "x", created_at: "2026-10-01T00:00:00Z" }], [{ id: CONN, tenant_id: B, channel_id: CHANNEL, status: "active", phone_number_id: "200", token_enc: "x", created_at: "2026-10-01T00:00:00Z" }]]) {
      const s = setup(tables({ whatsapp_connections: connections }));
      expect(await markCustomerMessageRead(TURN, s.deps)).toEqual({ status: "skipped", reason: "no_connection" });
      expect(s.read).not.toHaveBeenCalled();
    }
  });

  it("uses the oldest active connection of the channel, as notify.send does", async () => {
    const newer = { id: "d4000000-0000-4000-8000-0000000000a2", tenant_id: A, channel_id: CHANNEL, status: "active", phone_number_id: "300", token_enc: "enc:other", created_at: "2026-10-05T00:00:00Z" };
    const s = setup(tables({ whatsapp_connections: [newer, ...tables().whatsapp_connections] }));
    await markCustomerMessageRead(TURN, s.deps);
    expect((s.read.mock.calls[0] as unknown as [Record<string, string>])[0].connectionId).toBe(CONN);
  });

  it("is a skip, never an error, when Meta refuses, does not answer, or the call throws", async () => {
    const refused = vi.fn(async () => ({ ok: false, error: { code: "whatsapp_not_connected", message: "Meta said: call 9812345621", retryable: false, outcomeUnknown: false } }));
    expect(await markCustomerMessageRead(TURN, setup(tables(), refused).deps)).toEqual({ status: "skipped", reason: "refused" });
    const throws = vi.fn(async () => {
      throw new Error("boom 9812345621");
    });
    expect(await markCustomerMessageRead(TURN, setup(tables(), throws).deps)).toEqual({ status: "skipped", reason: "error" });
  });

  it("is a skip, never an error, when the database fails", async () => {
    const s = setup({ messages: { error: { code: "XX000" } } } as unknown as ReturnType<typeof tables>);
    expect(await markCustomerMessageRead(TURN, s.deps)).toEqual({ status: "skipped", reason: "error" });
    expect(s.read).not.toHaveBeenCalled();
  });

  it("a repeat is harmless: it marks the same message again and changes nothing else", async () => {
    const s = setup();
    await markCustomerMessageRead(TURN, s.deps);
    await markCustomerMessageRead(TURN, s.deps);
    expect(s.read.mock.calls.map((c) => c[1])).toEqual(["wamid.SECOND", "wamid.SECOND"]);
    expect(s.t.calls.every((c) => c.op === "select")).toBe(true);
  });

  it("an empty turn marks nothing", async () => {
    const s = setup();
    expect(await markCustomerMessageRead({ ...TURN, messageIds: [] }, s.deps)).toEqual({ status: "skipped", reason: "no_message" });
    expect(s.read).not.toHaveBeenCalled();
  });
});

describe("markReadStep", () => {
  const steps = () => {
    const ids: string[] = [];
    return { ids, run: async <T>(id: string, fn: () => Promise<T>): Promise<T> => (ids.push(id), fn()) };
  };
  const STARTED = 1_000_000;

  it("runs as one named step, marks, and logs only the fixed status line", async () => {
    const s = setup();
    const st = steps();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await markReadStep(st, TURN, STARTED, { ...s.deps, now: () => STARTED + 300 });
    const lines = log.mock.calls.flat().join("\n");
    log.mockRestore();
    expect(result).toEqual({ status: "marked" });
    expect(st.ids).toEqual(["mark-read"]);
    expect(lines).toBe("[pipeline] mark read: marked");
  });

  it("skips, without asking the database or Meta, when less than 8 seconds of the 10-second target remain", async () => {
    expect(MARK_READ_MIN_LEFT_MS).toBe(8000);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    for (const elapsed of [2_001, 5_000, 9_000, 30_000]) {
      const s = setup();
      const result = await markReadStep(steps(), TURN, STARTED, { ...s.deps, now: () => STARTED + elapsed });
      expect(result).toEqual({ status: "skipped", reason: "late" });
      expect(s.read).not.toHaveBeenCalled();
      expect(s.t.calls).toEqual([]);
    }
    expect(log.mock.calls.flat()).toEqual(Array(4).fill("[pipeline] mark read: skipped (late)"));
    log.mockRestore();
  });

  it("still marks when exactly 8 seconds remain", async () => {
    const s = setup();
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await markReadStep(steps(), TURN, STARTED, { ...s.deps, now: () => STARTED + 2_000 })).toEqual({ status: "marked" });
    vi.restoreAllMocks();
  });

  it("the late decision is made inside the step, so a replay keeps the first answer", async () => {
    const s = setup();
    const st = { run: async <T>(): Promise<T> => ({ status: "marked" }) as unknown as T };
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await markReadStep(st, TURN, STARTED, { ...s.deps, now: () => STARTED + 60_000 })).toEqual({ status: "marked" });
    vi.restoreAllMocks();
  });

  it("markCustomerMessageRead without its dependencies is a skip when the client cannot be made, not a thrown error", async () => {
    await expect(markCustomerMessageRead(TURN)).resolves.toEqual({ status: "skipped", reason: "error" });
  });

  it("is a skip, not an error, when even the database client cannot be made", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await markReadStep(steps(), TURN, Date.now());
    const lines = log.mock.calls.flat().join("\n");
    log.mockRestore();
    expect(result).toEqual({ status: "skipped", reason: "error" });
    expect(lines).toBe("[pipeline] mark read: skipped (error)");
  });

  it("logs nothing from the customer: no ids, no phone numbers, no text, whatever happens", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const refused = vi.fn(async () => ({ ok: false, error: { code: "x", message: "call 9812345621", retryable: false, outcomeUnknown: false } }));
    await markReadStep(steps(), TURN, STARTED, { ...setup(tables(), refused).deps, now: () => STARTED });
    await markReadStep(steps(), TURN, STARTED, { ...setup({ messages: { error: { code: "XX000", message: "9812345621" } } } as unknown as ReturnType<typeof tables>).deps, now: () => STARTED });
    const everything = [...log.mock.calls, ...err.mock.calls].flat().join("\n");
    log.mockRestore();
    err.mockRestore();
    expect(everything).not.toMatch(/9812345621|wamid|enc:token|e0000000|c0000000|a0000000|d4000000/);
    expect(everything.split("\n").every((line) => /^\[pipeline\] mark read: (marked|skipped \((late|no_message|no_connection|refused|error)\))$/.test(line))).toBe(true);
  });
});
