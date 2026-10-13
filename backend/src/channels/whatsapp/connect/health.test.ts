import { describe, expect, it, vi } from "vitest";
import { fakeTables, type Row } from "../../../test-support/fake-tables";
import { SAFE, type Check, type Graph, type GraphAnswer } from "./checks";
import { checkConnectionHealth, dueConnections, HEALTH_METHODS, readMessagingLimit, RECHECK_AFTER_MS, type HealthDeps } from "./health";
import type { MetaProbe } from "./manual";

// The daily check of a manual connection (Day 6): the same five Graph checks as a recheck, without the test message and without ever
// putting the number in `validating`. What changes the status, what is only written down, and what is never touched.

const A = "e0000000-0000-4000-8000-00000000000a";
const B = "e0000000-0000-4000-8000-00000000000b";
const CONN = "d4000000-0000-4000-8000-0000000000a1";
const NOW = new Date("2026-10-13T02:00:00.000Z");
const TOKEN = "EAAB-synthetic-access-token";
const BOTH = ["whatsapp_business_management", "whatsapp_business_messaging"];

const answered = (body: unknown, ok = true, status = 200): GraphAnswer => ({ state: "answered", ok, status, body });
const healthy: Graph = async (_method, path) => {
  if (path.startsWith("debug_token")) return answered({ data: { is_valid: true, scopes: BOTH, expires_at: 0 } });
  if (path.endsWith("/subscribed_apps")) return answered({ data: [{ id: "1" }] });
  return answered({ primary_funding_id: "1" });
};
const GOOD: MetaProbe = { state: "ok", numberInAccount: true, info: { displayPhone: "+91 98765 43210", verifiedName: "Skyline Homes", qualityRating: "GREEN", facts: { nameStatus: "APPROVED", platformType: "CLOUD_API" } } };
const withName = (nameStatus: string): MetaProbe => ({ ...GOOD, info: { ...GOOD.info, facts: { nameStatus, platformType: "CLOUD_API" } } });

const SIXTH: Check = { key: "test_message_delivered", status: "pass", message: "A test message was delivered.", checked_at: "2026-10-01T00:00:00.000Z" };
const stored = (overall: "pass" | "warn" | "fail" = "pass", ranAt = "2026-10-11T02:00:00.000Z", sixth: Check | null = SIXTH) => ({
  ran_at: ranAt,
  overall,
  checks: [
    { key: "token_permissions", status: "pass", message: "ok", checked_at: ranAt },
    { key: "number_registered", status: "pass", message: "ok", checked_at: ranAt },
    { key: "webhook_subscribed", status: "pass", message: "ok", checked_at: ranAt },
    { key: "display_name_approved", status: "pass", message: "ok", checked_at: ranAt },
    { key: "payment_method", status: "pass", message: "ok", checked_at: ranAt },
    ...(sixth ? [sixth] : []),
  ],
});

const row = (over: Row = {}): Row => ({
  id: CONN, tenant_id: A, method: "manual_byo", waba_id: "100", phone_number_id: "200", display_phone: "+919876543210", verified_name: "Skyline Homes", status: "active",
  token_enc: "enc:token", last_check: stored(), quality_rating: "GREEN", messaging_limit: "TIER_1K", token_expires_at: null, updated_at: "2026-10-11T02:00:00Z", ...over,
});

function world(rows: Row[] = [row()], over: { probe?: MetaProbe; graph?: Graph; webhookSeen?: boolean; decrypt?: () => string; limit?: string | null | Error } = {}) {
  const t = fakeTables({ whatsapp_connections: rows });
  const audits: { action: string; diff: unknown; actor: string; tenantId: string | null; entityId?: string }[] = [];
  const graph = vi.fn(over.graph ?? healthy);
  const probe = vi.fn(async () => over.probe ?? GOOD);
  const deps: HealthDeps = {
    db: t.db,
    decrypt: (over.decrypt ?? (() => TOKEN)) as HealthDeps["decrypt"],
    probe,
    graph,
    webhookSeen: async () => over.webhookSeen ?? true,
    messagingLimit: vi.fn(async () => {
      if (over.limit instanceof Error) throw over.limit;
      return over.limit === undefined ? "TIER_10K" : over.limit;
    }),
    audit: vi.fn(async (entry) => {
      audits.push({ action: entry.action, diff: entry.diff, actor: entry.actor, tenantId: entry.tenantId, entityId: entry.entityId });
    }),
    now: () => NOW,
  };
  return { ...t, deps, audits, graph, probe, conn: () => t.tables.whatsapp_connections[0], writes: () => t.calls.filter((c) => c.op === "update") };
}
const ids = { tenantId: A, connectionId: CONN };
const lastOf = (r: Row) => r.last_check as { ran_at: string; overall: string; checks: { key: string; status: string; message: string; checked_at: string }[] };

describe("a healthy connection", () => {
  it("is checked again: the checks, the quality rating, the messaging limit and the display fields are refreshed, and it stays active", async () => {
    const w = world();
    expect(await checkConnectionHealth(ids, w.deps)).toEqual({ status: "checked", overall: "pass", failed: false });
    expect(w.conn()).toMatchObject({ status: "active", quality_rating: "GREEN", messaging_limit: "TIER_10K", display_phone: "+91 98765 43210", verified_name: "Skyline Homes" });
    expect(lastOf(w.conn()).ran_at).toBe(NOW.toISOString());
    expect(lastOf(w.conn()).checks.map((c) => `${c.key}:${c.status}`)).toEqual([
      "token_permissions:pass", "number_registered:pass", "webhook_subscribed:pass", "display_name_approved:pass", "payment_method:pass", "test_message_delivered:pass",
    ]);
  });

  it("keeps the sixth check as it was stored: no test message is sent every day", async () => {
    const w = world();
    await checkConnectionHealth(ids, w.deps);
    expect(lastOf(w.conn()).checks[5]).toEqual(SIXTH);
  });

  it("works without a stored sixth check (a connection that was never tested)", async () => {
    const w = world([row({ last_check: {} })]);
    expect((await checkConnectionHealth(ids, w.deps)).status).toBe("checked");
    expect(lastOf(w.conn()).checks.at(-1)).toMatchObject({ key: "test_message_delivered", status: "not_verified" });
  });

  it("does not write an audit row when nothing changed", async () => {
    const w = world([row({ messaging_limit: "TIER_10K" })]);
    await checkConnectionHealth(ids, w.deps);
    expect(w.audits).toEqual([]);
  });

  it("writes one audit row, by the system, when the quality rating or the messaging limit changed, with only what changed", async () => {
    const w = world([row({ quality_rating: "YELLOW" })]);
    await checkConnectionHealth(ids, w.deps);
    expect(w.audits).toEqual([
      { action: "whatsapp_connection.health_changed", actor: "system", tenantId: A, entityId: CONN, diff: { quality_rating: { from: "YELLOW", to: "GREEN" }, messaging_limit: { from: "TIER_1K", to: "TIER_10K" } } },
    ]);
  });

  it("a messaging limit Meta does not give, or that cannot be read, leaves the stored one alone and is not a failure", async () => {
    for (const limit of [null, new Error("down")]) {
      const w = world([row()], { limit });
      expect((await checkConnectionHealth(ids, w.deps)).status).toBe("checked");
      expect(w.conn().messaging_limit).toBe("TIER_1K");
    }
  });

  it("asks for the messaging limit with the connection's own number and token, and only when Meta answered for the number", async () => {
    const w = world();
    await checkConnectionHealth(ids, w.deps);
    expect(w.deps.messagingLimit).toHaveBeenCalledWith({ phoneNumberId: "200", token: TOKEN });
    const rejected = world([row()], { probe: { state: "rejected" } });
    await checkConnectionHealth(ids, rejected.deps);
    expect(rejected.deps.messagingLimit).not.toHaveBeenCalled();
  });

  it("a warning (no payment method) or a webhook still waiting is only written down: the number stays active and nobody is alerted", async () => {
    const noPayment: Graph = async (_m, path) => (path.includes("primary_funding_id") ? answered({}) : healthy("GET", path, TOKEN));
    const w = world([row()], { graph: noPayment, webhookSeen: false });
    expect(await checkConnectionHealth(ids, w.deps)).toEqual({ status: "checked", overall: "warn", failed: false });
    expect(w.conn().status).toBe("active");
  });
});

describe("when the token has expired or is no longer valid", () => {
  it("the number becomes failed at once, with the expired message, and the answer carries what the alert needs", async () => {
    const w = world([row()], { probe: { state: "rejected", reason: "token_expired" } });
    const result = await checkConnectionHealth(ids, w.deps);
    expect(w.conn().status).toBe("failed");
    expect(lastOf(w.conn()).checks[0]).toMatchObject({ key: "token_permissions", status: "fail", message: SAFE.tokenExpired });
    expect(result).toEqual({
      status: "checked",
      overall: "fail",
      failed: true,
      alert: { reason: "token", detail: SAFE.tokenExpired, phoneMasked: "+9198xxxxxx10", key: "connection_failed:d4000000-0000-4000-8000-0000000000a1:2026-10-11T02:00:00.000Z" },
    });
  });

  it("is audited as a status change by the system", async () => {
    const w = world([row()], { probe: { state: "rejected", reason: "token_expired" } });
    await checkConnectionHealth(ids, w.deps);
    expect(w.audits).toEqual([expect.objectContaining({ action: "whatsapp_connection.health_failed", actor: "system", tenantId: A, entityId: CONN, diff: { from: "active", to: "failed", reason: "token" } })]);
  });

  it("a token that is valid but missing a WhatsApp permission fails at once too", async () => {
    const noScopes: Graph = async (_m, path) => (path.startsWith("debug_token") ? answered({ data: { is_valid: true, scopes: ["whatsapp_business_management"] } }) : healthy("GET", path, TOKEN));
    const w = world([row()], { graph: noScopes });
    const result = await checkConnectionHealth(ids, w.deps);
    expect(result).toMatchObject({ failed: true, alert: { reason: "token", detail: SAFE.tokenScopes } });
    expect(w.conn().status).toBe("failed");
  });

  it("a saved token that cannot be read is written down and Meta is not asked at all, but one night does not fail the number (a changed key would fail every number)", async () => {
    const w = world([row()], {
      decrypt: () => {
        throw new Error("bad key");
      },
    });
    expect(await checkConnectionHealth(ids, w.deps)).toEqual({ status: "checked", overall: "fail", failed: false });
    expect(w.probe).not.toHaveBeenCalled();
    expect(w.graph).not.toHaveBeenCalled();
    expect(w.conn().status).toBe("active");
    expect(lastOf(w.conn()).checks[0]).toMatchObject({ key: "token_permissions", status: "fail", message: SAFE.tokenFail });
  });

  it("and the next day, still unreadable, it fails with the token's words", async () => {
    const w = world([row()], {
      decrypt: () => {
        throw new Error("bad key");
      },
    });
    await checkConnectionHealth(ids, w.deps);
    w.conn().last_check = { ...lastOf(w.conn()), ran_at: "2026-10-12T02:00:00.000Z" };
    expect(await checkConnectionHealth(ids, w.deps)).toMatchObject({ failed: true, alert: { reason: "token", detail: SAFE.tokenFail } });
    expect(w.conn().status).toBe("failed");
  });

  it("Meta refusing the token without saying it has expired (a rate limit, a 403) is not an expired token: one night does not fail the number", async () => {
    const w = world([row()], { probe: { state: "rejected" } });
    expect(await checkConnectionHealth(ids, w.deps)).toEqual({ status: "checked", overall: "fail", failed: false });
    expect(w.conn().status).toBe("active");
    expect(lastOf(w.conn()).checks[0]).toMatchObject({ status: "fail", message: SAFE.tokenFail });
    expect(w.audits.filter((a) => a.action === "whatsapp_connection.health_failed")).toEqual([]);
  });

  it("but on the next day, refused again, it fails", async () => {
    const w = world([row()], { probe: { state: "rejected" } });
    await checkConnectionHealth(ids, w.deps);
    w.conn().last_check = { ...lastOf(w.conn()), ran_at: "2026-10-12T02:00:00.000Z" };
    expect(await checkConnectionHealth(ids, w.deps)).toMatchObject({ failed: true, alert: { reason: "token", detail: SAFE.tokenFail } });
  });

  it("a check that is retried within the same day (a step whose answer was lost) is not a second day", async () => {
    const w = world([row()], { probe: { state: "rejected" } });
    await checkConnectionHealth(ids, w.deps);
    const again = await checkConnectionHealth(ids, w.deps);
    expect(again).toEqual({ status: "checked", overall: "fail", failed: false });
    expect(w.conn().status).toBe("active");
  });

  it("the alert key follows the stored result's time, so a retry of the same failure is the same alert; a number never checked has its own", async () => {
    const w = world([row({ last_check: {} })], { probe: { state: "rejected", reason: "token_expired" } });
    expect(await checkConnectionHealth(ids, w.deps)).toMatchObject({ alert: { key: "connection_failed:d4000000-0000-4000-8000-0000000000a1:never" } });
  });
});

describe("a failure that is not the token", () => {
  it("the first time is only written down: the number stays active and nobody is alerted", async () => {
    const w = world([row({ messaging_limit: "TIER_10K" })], { probe: withName("DECLINED") });
    expect(await checkConnectionHealth(ids, w.deps)).toEqual({ status: "checked", overall: "fail", failed: false });
    expect(w.conn().status).toBe("active");
    expect(lastOf(w.conn()).overall).toBe("fail");
    expect(w.audits).toEqual([]);
  });

  it("the next day, still failing, it becomes failed with the failing check's words", async () => {
    const w = world([row({ messaging_limit: "TIER_10K" })], { probe: withName("DECLINED") });
    await checkConnectionHealth(ids, w.deps);
    w.conn().last_check = { ...lastOf(w.conn()), ran_at: "2026-10-12T02:00:00.000Z" };
    const result = await checkConnectionHealth(ids, w.deps);
    expect(result).toMatchObject({ failed: true, alert: { reason: "checks", detail: SAFE.nameFail } });
    expect(w.conn().status).toBe("failed");
    expect(w.audits).toEqual([expect.objectContaining({ action: "whatsapp_connection.health_failed", diff: { from: "active", to: "failed", reason: "checks" } })]);
  });

  it("a repeat less than 12 hours later is not a second day", async () => {
    const w = world([row({ messaging_limit: "TIER_10K" })], { probe: withName("DECLINED") });
    await checkConnectionHealth(ids, w.deps);
    w.conn().last_check = { ...lastOf(w.conn()), ran_at: new Date(NOW.getTime() - 11 * 3_600_000).toISOString() };
    expect(await checkConnectionHealth(ids, w.deps)).toMatchObject({ failed: false });
    expect(w.conn().status).toBe("active");
  });

  it("a day in between that was fine starts the count again", async () => {
    const w = world([row({ messaging_limit: "TIER_10K" })], { probe: withName("DECLINED") });
    await checkConnectionHealth(ids, w.deps);
    const fine = { ...w, deps: { ...w.deps, probe: vi.fn(async () => GOOD) } };
    await checkConnectionHealth(ids, fine.deps);
    expect(w.conn().status).toBe("active");
    expect(lastOf(w.conn()).overall).toBe("pass");
    await checkConnectionHealth(ids, { ...w.deps, probe: vi.fn(async () => withName("DECLINED")) });
    expect(w.conn().status).toBe("active");
  });

  it("a stale failed sixth check does not make a healthy number fail: only the five Graph checks decide", async () => {
    const sixthFailed: Check = { ...SIXTH, status: "fail", message: "not delivered" };
    const w = world([row({ last_check: stored("fail", "2026-10-12T02:00:00.000Z", sixthFailed) })]);
    expect(await checkConnectionHealth(ids, w.deps)).toMatchObject({ failed: false });
    expect(w.conn().status).toBe("active");
  });
});

describe("when Meta cannot be asked", () => {
  it("nothing is written, nothing is audited and nobody is alerted: it is tried again tomorrow", async () => {
    const w = world([row()], { probe: { state: "unreachable" } });
    expect(await checkConnectionHealth(ids, w.deps)).toEqual({ status: "skipped", reason: "unreachable" });
    expect(w.writes()).toEqual([]);
    expect(w.audits).toEqual([]);
    expect(w.graph).not.toHaveBeenCalled();
    expect(w.conn()).toMatchObject({ status: "active", last_check: stored() });
  });
});

describe("what is never touched", () => {
  const skipped = async (r: Row, reason: string) => {
    const w = world([r]);
    expect(await checkConnectionHealth(ids, w.deps)).toEqual({ status: "skipped", reason });
    expect(w.probe).not.toHaveBeenCalled();
    expect(w.writes()).toEqual([]);
  };

  it("a number that is not active (failed, disconnected, validating, pending)", async () => {
    for (const status of ["failed", "disconnected", "validating", "pending"]) await skipped(row({ status }), "not_active");
  });

  it("a connection of another kind: our own platform numbers, and any method that is not listed", async () => {
    await skipped(row({ method: "platform" }), "not_active");
    await skipped(row({ method: "embedded_signup" }), "not_active");
    expect(HEALTH_METHODS).toEqual(["manual_byo"]);
  });

  it("an unknown connection, and another business's", async () => {
    const w = world([row({ tenant_id: B })]);
    expect(await checkConnectionHealth(ids, w.deps)).toEqual({ status: "skipped", reason: "not_found" });
    expect(w.probe).not.toHaveBeenCalled();
    expect(await checkConnectionHealth({ tenantId: A, connectionId: "d4000000-0000-4000-8000-0000000000ff" }, world().deps)).toEqual({ status: "skipped", reason: "not_found" });
  });

  it("a number the owner started rechecking or disconnected while this one ran: the write finds it no longer active and changes nothing", async () => {
    const w = world();
    const racing: Graph = async (m, p, t) => {
      w.conn().status = "validating";
      return healthy(m, p, t);
    };
    const deps = { ...w.deps, graph: racing };
    expect(await checkConnectionHealth(ids, deps)).toEqual({ status: "skipped", reason: "changed" });
    expect(w.conn()).toMatchObject({ status: "validating", last_check: stored() });
    expect(w.audits).toEqual([]);
  });
});

describe("a recheck, a connect or a disconnect that lands while the job is asking Meta", () => {
  it("a recheck that finished meanwhile (the row was written again, still active) is not overwritten with this older result", async () => {
    const w = world();
    const racing: Graph = async (m, p, t) => {
      w.conn().updated_at = "2026-10-13T01:59:00Z";
      w.conn().last_check = stored("pass", "2026-10-13T01:59:00.000Z", { ...SIXTH, message: "fresher test message" });
      return healthy(m, p, t);
    };
    expect(await checkConnectionHealth(ids, { ...w.deps, graph: racing })).toEqual({ status: "skipped", reason: "changed" });
    expect(lastOf(w.conn()).ran_at).toBe("2026-10-13T01:59:00.000Z");
    expect(w.audits).toEqual([]);
  });

  it("writes only when the row is as it was read: its status, its business and the time it was last written", async () => {
    const w = world();
    await checkConnectionHealth(ids, w.deps);
    expect(w.writes()[0].filters).toEqual(
      expect.arrayContaining([
        { column: "tenant_id", op: "eq", value: A },
        { column: "id", op: "eq", value: CONN },
        { column: "status", op: "eq", value: "active" },
        { column: "updated_at", op: "eq", value: "2026-10-11T02:00:00Z" },
      ]),
    );
  });

  it("never asks Meta to subscribe the app: an account with none subscribed is only a warning, and nothing is posted (a disconnect may have just taken it off)", async () => {
    const noApps: Graph = async (m, p, t) => (p.endsWith("/subscribed_apps") ? answered({ data: [] }) : healthy(m, p, t));
    const w = world([row()], { graph: noApps });
    const result = await checkConnectionHealth(ids, w.deps);
    expect(result).toMatchObject({ failed: false });
    expect(w.graph.mock.calls.filter(([method]) => method === "POST")).toEqual([]);
    expect(lastOf(w.conn()).checks.find((c) => c.key === "webhook_subscribed")).toMatchObject({ status: "warn" });
  });
});

describe("the token's expiry date", () => {
  const expiring = (expiresAt: number): Graph => async (m, p, t) => (p.startsWith("debug_token") ? answered({ data: { is_valid: true, scopes: BOTH, expires_at: expiresAt } }) : healthy(m, p, t));

  it("is stored when Meta says it", async () => {
    const w = world([row()], { graph: expiring(1792000000) });
    await checkConnectionHealth(ids, w.deps);
    expect(w.conn().token_expires_at).toBe(new Date(1792000000 * 1000).toISOString());
  });

  it("is cleared when the token never expires (0)", async () => {
    const w = world([row({ token_expires_at: "2026-10-20T00:00:00.000Z" })]);
    await checkConnectionHealth(ids, w.deps);
    expect(w.conn().token_expires_at).toBeNull();
  });

  it("is left as it is when Meta does not say", async () => {
    const quiet: Graph = async (m, p, t) => (p.startsWith("debug_token") ? answered({ data: { is_valid: true, scopes: BOTH } }) : healthy(m, p, t));
    const w = world([row({ token_expires_at: "2026-10-20T00:00:00.000Z" })], { graph: quiet });
    await checkConnectionHealth(ids, w.deps);
    expect(w.conn().token_expires_at).toBe("2026-10-20T00:00:00.000Z");
  });
});

describe("safety", () => {
  it("every query for the connection names the business, and the write is also limited to the connection and to `active`", async () => {
    const w = world([row({ messaging_limit: "TIER_1K" })]);
    await checkConnectionHealth(ids, w.deps);
    for (const call of w.calls) {
      expect(call.filters).toContainEqual({ column: "tenant_id", op: "eq", value: A });
      expect(call.filters).toContainEqual({ column: "id", op: "eq", value: CONN });
    }
    expect(w.writes()[0].filters).toContainEqual({ column: "status", op: "eq", value: "active" });
  });

  it("the token, its encrypted form and the app secret are never in the saved result or the audit rows", async () => {
    const w = world([row({ quality_rating: "YELLOW" })], { probe: { state: "rejected", reason: "token_expired" } });
    const result = await checkConnectionHealth(ids, w.deps);
    const everything = JSON.stringify([result, w.audits, lastOf(w.conn())]);
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain("enc:token");
  });

  it("a database error is thrown, so the job's step is retried", async () => {
    const t = fakeTables({ whatsapp_connections: { error: { code: "XX000" } } });
    const w = world();
    await expect(checkConnectionHealth(ids, { ...w.deps, db: t.db })).rejects.toThrow();
  });
});

describe("which connections are due", () => {
  const due = async (rows: Row[]) => dueConnections({ db: fakeTables({ whatsapp_connections: rows }).db, now: () => NOW });
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

  it("an active manual connection not checked for 20 hours, and one never checked", async () => {
    const result = await due([
      row({ id: "c-old", last_check: stored("pass", hoursAgo(26)) }),
      row({ id: "c-never", last_check: {} }),
      row({ id: "c-edge", last_check: stored("pass", hoursAgo(RECHECK_AFTER_MS / 3_600_000)) }),
    ]);
    expect(result.map((c) => c.connectionId).sort()).toEqual(["c-edge", "c-never", "c-old"]);
    expect(result[0]).toEqual(expect.objectContaining({ tenantId: A }));
  });

  it("not one checked within the last 20 hours (so a repeat run, or a manual recheck this morning, is not done twice)", async () => {
    expect(await due([row({ last_check: stored("pass", hoursAgo(1)) }), row({ id: "c2", last_check: stored("pass", hoursAgo(19)) })])).toEqual([]);
  });

  it("not a number that is failed, disconnected, validating or pending, nor one of our own platform numbers", async () => {
    const rows = ["failed", "disconnected", "validating", "pending"].map((status, i) => row({ id: `c${i}`, status, last_check: {} }));
    expect(await due([...rows, row({ id: "cp", method: "platform", last_check: {} })])).toEqual([]);
  });

  it("a stored result that is not the usual shape counts as never checked", async () => {
    expect((await due([row({ last_check: "garbage" }), row({ id: "c2", last_check: { ran_at: 5 } })])).map((c) => c.connectionId).sort()).toEqual([CONN, "c2"].sort());
  });

  it("is capped at 500, the longest-waiting first, and the ones never checked before any that were", async () => {
    const rows = [
      row({ id: "c-recent", last_check: stored("pass", hoursAgo(21)) }),
      row({ id: "c-older", last_check: stored("pass", hoursAgo(90)) }),
      ...Array.from({ length: 600 }, (_, i) => row({ id: `n${String(i).padStart(3, "0")}`, last_check: {} })),
    ];
    const result = await due(rows);
    expect(result).toHaveLength(500);
    expect(result.every((c) => c.connectionId.startsWith("n"))).toBe(true);
    const few = await due(rows.slice(0, 2));
    expect(few.map((c) => c.connectionId)).toEqual(["c-older", "c-recent"]);
  });

  it("a database error is thrown", async () => {
    await expect(dueConnections({ db: fakeTables({ whatsapp_connections: { error: { code: "XX000" } } }).db, now: () => NOW })).rejects.toThrow();
  });
});

describe("reading the messaging limit", () => {
  const read = (answer: GraphAnswer | Error) => {
    const call = vi.fn<Graph>(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    return { call, result: readMessagingLimit({ phoneNumberId: "200", token: TOKEN }, call) };
  };

  it("asks for the number's tier, with the connection's own token, and gives it back", async () => {
    const r = read(answered({ messaging_limit_tier: "TIER_10K", id: "200" }));
    expect(await r.result).toBe("TIER_10K");
    expect(r.call).toHaveBeenCalledWith("GET", "200?fields=messaging_limit_tier", TOKEN);
  });

  it("gives null when Meta does not say, refuses the call, cannot be reached, or sends something that is not a tier", async () => {
    expect(await read(answered({})).result).toBeNull();
    expect(await read(answered({ error: { code: 100 } }, false, 400)).result).toBeNull();
    expect(await read({ state: "unreachable" }).result).toBeNull();
    expect(await read(new Error("down")).result).toBeNull();
    expect(await read(answered({ messaging_limit_tier: 1000 })).result).toBeNull();
    expect(await read(answered({ messaging_limit_tier: "tier 1k <script>" })).result).toBeNull();
    expect(await read(answered(null)).result).toBeNull();
  });
});
