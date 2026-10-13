import type { TenantContext } from "@pakka/types";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../../lib/errors";
import { fakeTables, type Row } from "../../../test-support/fake-tables";
import type { Check, Graph, GraphAnswer } from "./checks";
import type { MetaProbe } from "./manual";
import { disconnectConnection, recheckConnection, type RecheckDeps } from "./recheck";

// Recheck and disconnect (Day 5): who may, what the status does, what Meta is asked, and that a number never ends up stuck in `validating`.

const A = "e0000000-0000-4000-8000-00000000000a";
const B = "e0000000-0000-4000-8000-00000000000b";
const USER = "f1000000-0000-4000-8000-000000000001";
const CONN = "d4000000-0000-4000-8000-0000000000a1";
const NOW = new Date("2026-10-12T09:00:00.000Z");
const TOKEN = "EAAB-synthetic-access-token";
const BOTH = ["whatsapp_business_management", "whatsapp_business_messaging"];

const context = (role: "owner" | "admin" | "staff", tenantId = A): TenantContext =>
  ({ user: { id: USER, email: "o@example.test" }, tenant: { id: tenantId, name: "Sunrise Homes" }, role }) as unknown as TenantContext;

const answered = (body: unknown, ok = true, status = 200): GraphAnswer => ({ state: "answered", ok, status, body });
const healthy: Graph = async (method, path) => {
  if (method === "DELETE") return answered({ success: true });
  if (path.startsWith("debug_token")) return answered({ data: { is_valid: true, scopes: BOTH } });
  if (path.endsWith("/subscribed_apps")) return answered({ data: [{ id: "1" }] });
  return answered({ primary_funding_id: "1" });
};
const GOOD: MetaProbe = { state: "ok", numberInAccount: true, info: { displayPhone: "+91 98765 43210", verifiedName: "Skyline Homes", qualityRating: "GREEN", facts: { nameStatus: "APPROVED", platformType: "CLOUD_API" } } };
const SIXTH: Check = { key: "test_message_delivered", status: "pass", message: "sent", checked_at: NOW.toISOString() };

const row = (over: Row = {}): Row => ({
  id: CONN, tenant_id: A, method: "manual_byo", waba_id: "100", phone_number_id: "200", display_phone: null, verified_name: null, coexistence: false, status: "active",
  last_check: {}, quality_rating: null, messaging_limit: null, created_at: "2026-10-01T00:00:00Z", token_enc: "enc:token", ...over,
});

function world(rows: Row[] = [row()], over: { probe?: MetaProbe; graph?: Graph; webhookSeen?: boolean; webhookSeenLater?: boolean; decrypt?: () => string } = {}) {
  let seenCalls = 0;
  const t = fakeTables({ whatsapp_connections: rows });
  const audits: { action: string; diff: unknown; actor: string; tenantId: string | null }[] = [];
  const graph = vi.fn(over.graph ?? healthy);
  const deps: RecheckDeps = {
    db: t.db,
    probe: vi.fn(async () => over.probe ?? GOOD),
    graph,
    decrypt: (over.decrypt ?? (() => TOKEN)) as RecheckDeps["decrypt"],
    webhookSeen: async () => (++seenCalls === 1 ? (over.webhookSeen ?? true) : (over.webhookSeenLater ?? over.webhookSeen ?? true)),
    testMessage: vi.fn(async () => SIXTH),
    audit: vi.fn(async (entry) => {
      audits.push({ action: entry.action, diff: entry.diff, actor: entry.actor, tenantId: entry.tenantId });
    }),
    now: () => NOW,
  };
  return { ...t, deps, audits, graph, seenReads: () => seenCalls, conn: () => t.tables.whatsapp_connections[0] };
}
const codeOf = async (p: Promise<unknown>) => ((await p.then(() => null, (e: unknown) => e)) as AppError | null)?.code;

describe("recheck", () => {
  it("runs the checks again, saves them, and leaves an active number active", async () => {
    const w = world();
    const result = await recheckConnection(context("owner"), CONN, w.deps);
    expect(result.status).toBe("active");
    expect(w.conn()).toMatchObject({ status: "active", display_phone: "+91 98765 43210", verified_name: "Skyline Homes", quality_rating: "GREEN" });
    const last = w.conn().last_check as { ran_at: string; overall: string; checks: { key: string; status: string }[] };
    expect(last.ran_at).toBe(NOW.toISOString());
    expect(last.checks.map((c) => `${c.key}:${c.status}`)).toEqual([
      "token_permissions:pass", "number_registered:pass", "webhook_subscribed:pass", "display_name_approved:pass", "payment_method:pass", "test_message_delivered:pass",
    ]);
    expect(last.overall).toBe("pass");
  });

  it("an admin may too; staff may not, and nothing is read or changed for them", async () => {
    expect((await recheckConnection(context("admin"), CONN, world().deps)).id).toBe(CONN);
    const w = world();
    expect(await codeOf(recheckConnection(context("staff"), CONN, w.deps))).toBe("forbidden");
    expect(w.calls).toEqual([]);
  });

  it("a failing check makes the number `failed`, with the reason, and sends no test message", async () => {
    const w = world([row()], { probe: { state: "rejected" } });
    const result = await recheckConnection(context("owner"), CONN, w.deps);
    expect(result.status).toBe("failed");
    expect(w.conn().status).toBe("failed");
    expect((w.conn().last_check as { checks: { status: string }[] }).checks[0].status).toBe("fail");
    expect(w.deps.testMessage).not.toHaveBeenCalled();
  });

  it("a token that has expired makes the number `failed`, with the expired message, and sends no test message", async () => {
    const w = world([row()], { probe: { state: "rejected", reason: "token_expired" } });
    const result = await recheckConnection(context("owner"), CONN, w.deps);
    expect(result.status).toBe("failed");
    const first = (w.conn().last_check as { checks: { key: string; status: string; message: string }[] }).checks[0];
    expect(first).toMatchObject({ key: "token_permissions", status: "fail", message: expect.stringContaining("expired or is no longer valid") });
    expect(w.deps.testMessage).not.toHaveBeenCalled();
  });

  it("a webhook that arrives while the test message is sent is not lost: the saved webhook check is a pass", async () => {
    const w = world([row()], { webhookSeen: false, webhookSeenLater: true });
    await recheckConnection(context("owner"), CONN, w.deps);
    const last = w.conn().last_check as { overall: string; checks: { key: string; status: string }[] };
    expect(last.checks.find((c) => c.key === "webhook_subscribed")?.status).toBe("pass");
    expect(last.overall).toBe("pass");
  });

  it("does not read the webhook proof a second time when the first read already found it", async () => {
    const w = world([row()], { webhookSeen: true });
    await recheckConnection(context("owner"), CONN, w.deps);
    expect(w.seenReads()).toBe(1);
  });

  it("a failed number that is now right becomes active again", async () => {
    const w = world([row({ status: "failed" })]);
    expect((await recheckConnection(context("owner"), CONN, w.deps)).status).toBe("active");
  });

  it("a number whose test message could not be sent stays active with a note, never failed", async () => {
    const w = world();
    (w.deps.testMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ...SIXTH, status: "not_verified", message: "later" });
    const result = await recheckConnection(context("owner"), CONN, w.deps);
    expect(result.status).toBe("active");
    expect((w.conn().last_check as { overall: string }).overall).toBe("warn");
  });

  it("goes through `validating`, and never leaves it behind when Meta cannot be reached: the old status comes back", async () => {
    const seen: unknown[] = [];
    const w = world([row()], { probe: { state: "unreachable" } });
    w.deps.probe = vi.fn(async () => {
      seen.push(w.conn().status);
      return { state: "unreachable" } as MetaProbe;
    });
    expect(await codeOf(recheckConnection(context("owner"), CONN, w.deps))).toBe("upstream_failed");
    expect(seen).toEqual(["validating"]);
    expect(w.conn().status).toBe("active");
  });

  it("the old status also comes back when the saved token cannot be read, with a message that says to connect again", async () => {
    const w = world([row({ status: "failed" })], { decrypt: () => { throw new Error("bad key"); } });
    const error = (await recheckConnection(context("owner"), CONN, w.deps).then(() => null, (e: unknown) => e)) as AppError;
    expect(error.code).toBe("upstream_failed");
    expect(error.message).toContain("Connect the number again");
    expect(w.conn().status).toBe("failed");
  });

  it("a check already running is not started twice", async () => {
    const w = world([row({ status: "validating" })]);
    expect(await codeOf(recheckConnection(context("owner"), CONN, w.deps))).toBe("conflict");
    expect(w.deps.probe).not.toHaveBeenCalled();
  });

  it("a disconnected number is not rechecked", async () => {
    const w = world([row({ status: "disconnected" })]);
    expect(await codeOf(recheckConnection(context("owner"), CONN, w.deps))).toBe("conflict");
  });

  it("another business's connection, an unknown id and one of our own platform numbers are refused", async () => {
    expect(await codeOf(recheckConnection(context("owner", B), CONN, world().deps))).toBe("not_found");
    expect(await codeOf(recheckConnection(context("owner"), "d4000000-0000-4000-8000-0000000000ff", world().deps))).toBe("not_found");
    expect(await codeOf(recheckConnection(context("owner"), CONN, world([row({ method: "platform" })]).deps))).toBe("forbidden");
  });

  it("every query names the business, and the token and its secret never appear in the answer or the audit row", async () => {
    const w = world();
    const result = await recheckConnection(context("owner"), CONN, w.deps);
    expect(w.calls.every((c) => c.filters.some((f) => f.column === "tenant_id" && f.value === A))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/token_enc|enc:token|app_secret/);
    expect(JSON.stringify(w.audits)).not.toContain(TOKEN);
  });

  it("is audited with who and what changed", async () => {
    const w = world([row({ status: "failed" })]);
    await recheckConnection(context("owner"), CONN, w.deps);
    expect(w.audits).toEqual([{ action: "whatsapp_connection.rechecked", actor: USER, tenantId: A, diff: { from: "failed", to: "active", subscribed: true } }]);
  });

  const emptyAccount = (post: GraphAnswer): Graph => {
    let subscribed = false;
    return async (method, path, token) => {
      if (path.endsWith("/subscribed_apps") && method !== "DELETE") {
        if (method === "POST") {
          if (post.state === "answered" && post.ok) subscribed = true;
          return post;
        }
        return answered({ data: subscribed ? [{ id: "1" }] : [] });
      }
      return healthy(method, path, token);
    };
  };

  it("subscribes the app, with the connection's token, only when nothing is subscribed", async () => {
    const w = world([row()], { graph: emptyAccount(answered({ success: true })) });
    await recheckConnection(context("owner"), CONN, w.deps);
    const seen = w.graph.mock.calls.filter(([, path]) => path.endsWith("/subscribed_apps")).map(([method]) => method);
    expect(seen).toEqual(["GET", "POST", "GET"]);
    expect(w.graph).toHaveBeenCalledWith("POST", "100/subscribed_apps", TOKEN);
    expect(w.audits[0].diff).toMatchObject({ subscribed: true });
  });

  it("never posts to an account that has an app subscribed already", async () => {
    const w = world();
    await recheckConnection(context("owner"), CONN, w.deps);
    expect(w.graph.mock.calls.some(([method]) => method === "POST")).toBe(false);
  });

  it("a failed subscribe never blocks: the number stays active with a warning, and the audit says subscribed: false", async () => {
    const w = world([row()], { graph: emptyAccount(answered({ error: { code: 200 } }, false, 403)) });
    const result = await recheckConnection(context("owner"), CONN, w.deps);
    expect(result.status).toBe("active");
    expect((w.conn().last_check as { checks: { key: string; status: string }[] }).checks[2]).toMatchObject({ key: "webhook_subscribed", status: "warn" });
    expect(w.audits[0].diff).toMatchObject({ subscribed: false });
  });

  it("does not try when Meta rejected the token, and the audit says null: nothing was asked", async () => {
    const w = world([row()], { probe: { state: "rejected" } });
    await recheckConnection(context("owner"), CONN, w.deps);
    expect(w.graph).not.toHaveBeenCalled();
    expect(w.audits[0].diff).toMatchObject({ subscribed: null });
  });
});

describe("disconnect", () => {
  it("marks the number disconnected (which is what pauses the AI on it) and takes our app off the account's webhooks", async () => {
    const w = world();
    const result = await disconnectConnection(context("owner"), CONN, w.deps);
    expect(result.status).toBe("disconnected");
    expect(w.conn().status).toBe("disconnected");
    expect(w.graph).toHaveBeenCalledWith("DELETE", "100/subscribed_apps", TOKEN);
    expect(w.audits).toEqual([{ action: "whatsapp_connection.disconnected", actor: USER, tenantId: A, diff: { from: "active", to: "disconnected", unsubscribed: true } }]);
  });

  it("works from any live status", async () => {
    for (const status of ["pending", "validating", "failed"]) {
      expect((await disconnectConnection(context("owner"), CONN, world([row({ status })]).deps)).status).toBe("disconnected");
    }
  });

  it("stands even when the unsubscribe cannot be done (a revoked token, Meta down, a key that does not open)", async () => {
    for (const w of [
      world([row()], { graph: async () => answered({}, false, 401) }),
      world([row()], { graph: async () => ({ state: "unreachable" }) }),
      world([row()], { decrypt: () => { throw new Error("bad key"); } }),
    ]) {
      expect((await disconnectConnection(context("owner"), CONN, w.deps)).status).toBe("disconnected");
      expect(w.audits[0].diff).toMatchObject({ unsubscribed: false });
    }
  });

  it("done twice gives the same answer and does nothing the second time", async () => {
    const w = world([row({ status: "disconnected" })]);
    expect((await disconnectConnection(context("owner"), CONN, w.deps)).status).toBe("disconnected");
    expect(w.graph).not.toHaveBeenCalled();
    expect(w.audits).toEqual([]);
  });

  it("staff may not, another business's connection is not found, our own platform number is refused", async () => {
    expect(await codeOf(disconnectConnection(context("staff"), CONN, world().deps))).toBe("forbidden");
    expect(await codeOf(disconnectConnection(context("owner", B), CONN, world().deps))).toBe("not_found");
    expect(await codeOf(disconnectConnection(context("admin"), CONN, world([row({ method: "platform" })]).deps))).toBe("forbidden");
  });

  it("a number that is disconnected is no longer one a message goes to or comes from: both sides read status = active", async () => {
    // The proof is in the code that sends and receives, not here: this pins the value they compare with.
    const w = world();
    const result = await disconnectConnection(context("owner"), CONN, w.deps);
    expect(result.status).not.toBe("active");
  });
});

describe("recheck of a coexistence number", () => {
  const odd: MetaProbe = { ...GOOD, info: { ...GOOD.info, facts: { nameStatus: "APPROVED", platformType: "NOT_APPLICABLE" } } } as MetaProbe;
  const numberCheck = (r: Row) => (r.last_check as { checks: { key: string; status: string; message: string }[] }).checks.find((c) => c.key === "number_registered");

  it("is not failed on an odd platform_type: not_verified, and the connection stays active", async () => {
    const w = world([row({ method: "embedded_signup", coexistence: true })], { probe: odd });
    const result = await recheckConnection(context("owner"), CONN, w.deps);
    expect(result.status).toBe("active");
    expect(numberCheck(w.conn())?.status).toBe("not_verified");
  });

  it("reads the connection WITH its coexistence value (the fake database returns whole rows, so the select itself is checked)", async () => {
    const w = world([row({ method: "embedded_signup", coexistence: true })], { probe: odd });
    await recheckConnection(context("owner"), CONN, w.deps);
    const withToken = w.calls.filter((c) => c.op === "select" && c.select.includes("token_enc"));
    expect(withToken.length).toBeGreaterThan(0);
    expect(withToken.every((c) => c.select.split(",").map((x) => x.trim()).includes("coexistence"))).toBe(true);
  });

  it("a number that is not coexistence still fails on it", async () => {
    const w = world([row({ method: "embedded_signup", coexistence: false })], { probe: odd });
    const result = await recheckConnection(context("owner"), CONN, w.deps);
    expect(result.status).toBe("failed");
    expect(numberCheck(w.conn())?.status).toBe("fail");
  });
});
