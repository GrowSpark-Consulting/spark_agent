import { describe, expect, it, vi } from "vitest";
import { fakeTables, type Row } from "../../../test-support/fake-tables";
import type { SendOutcome } from "../../../notify/send";
import { expiringConnections, warnExpiring, WARN_DAYS } from "./token-expiry";

// The warning a week before a token runs out (Day 6): which connections, how often, to whom. One warning per connection per expiry date.

const A = "e0000000-0000-4000-8000-00000000000a";
const NOW = new Date("2026-10-13T04:00:00.000Z");
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();
const row = (over: Row = {}): Row => ({
  id: "d4000000-0000-4000-8000-0000000000a1", tenant_id: A, method: "manual_byo", status: "active", display_phone: "+919876543210", token_expires_at: days(5), ...over,
});
const listed = async (rows: Row[]) => expiringConnections({ db: fakeTables({ whatsapp_connections: rows }).db, now: () => NOW });

describe("which tokens are about to run out", () => {
  it("those that expire within 7 days, in the order they run out, with the date", async () => {
    const result = await listed([row({ id: "c-6d", token_expires_at: days(6.9) }), row({ id: "c-1d", token_expires_at: days(1) })]);
    expect(WARN_DAYS).toBe(7);
    expect(result.map((c) => c.connectionId)).toEqual(["c-1d", "c-6d"]);
    expect(result[0]).toEqual({ tenantId: A, connectionId: "c-1d", phoneMasked: "+9198xxxxxx10", expiresAt: new Date(days(1)) });
  });

  it("not one that expires later than that", async () => {
    expect(await listed([row({ token_expires_at: days(7.1) }), row({ id: "c2", token_expires_at: days(30) })])).toEqual([]);
  });

  it("not one that has already expired (the daily check marks those failed and tells the owner), nor one that expires right now", async () => {
    expect(await listed([row({ token_expires_at: days(-1) }), row({ id: "c2", token_expires_at: NOW.toISOString() })])).toEqual([]);
  });

  it("not a token that never expires (no date)", async () => {
    expect(await listed([row({ token_expires_at: null })])).toEqual([]);
  });

  it.each(["manual_byo", "embedded_signup", "assisted"])("an active %s connection is warned about", async (method) => {
    const result = await listed([row({ id: "c1", method })]);
    expect(result.map((c) => c.connectionId)).toEqual(["c1"]);
  });

  it.each(["manual_byo", "embedded_signup", "assisted"])("not a failed, disconnected, validating or pending %s connection", async (method) => {
    const rows = ["failed", "disconnected", "validating", "pending"].map((status, i) => row({ id: `c${i}`, status, method }));
    expect(await listed(rows)).toEqual([]);
  });

  it("not our own platform numbers (even with a date), nor a method that is not listed", async () => {
    expect(await listed([row({ id: "cp", method: "platform" }), row({ id: "cf", method: "some_future_method" })])).toEqual([]);
  });

  it("not a row whose date is not a date", async () => {
    expect(await listed([row({ token_expires_at: "soon" })])).toEqual([]);
  });

  it("a database error is thrown, so the job's step is retried", async () => {
    await expect(expiringConnections({ db: fakeTables({ whatsapp_connections: { error: { code: "XX000" } } }).db, now: () => NOW })).rejects.toThrow();
  });
});

describe("warning the owners", () => {
  const SENT: SendOutcome = { status: "sent", messageId: "m", providerMsgId: "p", creditsCharged: 0, usedTemplate: false };
  const conn = { tenantId: A, connectionId: "c1", phoneMasked: "+9198xxxxxx10", expiresAt: new Date("2026-10-18T09:30:00.000Z") };
  const deps = (people = ["u1", "u2"]) => {
    const send = vi.fn<(tenant: string, kind: "staff_alert", payload: { idempotencyKey?: string; staffUserId?: string; text?: string }) => Promise<SendOutcome>>(async () => SENT);
    return { send, recipients: vi.fn(async () => people), appUrl: () => "https://app.example.test" };
  };

  it("sends the warning to each owner and admin with an alert number, with the date in it", async () => {
    const d = deps();
    expect(await warnExpiring(conn, d)).toEqual({ recipients: 2, sent: 2, skipped: 0, failed: 0 });
    expect(d.send).toHaveBeenCalledWith(A, "staff_alert", expect.objectContaining({ staffUserId: "u1", text: expect.stringContaining("18 Oct 2026") }));
  });

  it("names each warning by the connection, the expiry date and the person: the same date is never warned twice", async () => {
    const d = deps();
    await warnExpiring(conn, d);
    await warnExpiring(conn, d);
    const keys = d.send.mock.calls.map((c) => c[2].idempotencyKey);
    expect(keys).toEqual(["token_expiring:c1:2026-10-18:u1", "token_expiring:c1:2026-10-18:u2", "token_expiring:c1:2026-10-18:u1", "token_expiring:c1:2026-10-18:u2"]);
  });

  it("a renewed token has a new expiry date, so its warning has a new key", async () => {
    const d = deps(["u1"]);
    await warnExpiring({ ...conn, expiresAt: new Date("2027-01-10T09:30:00.000Z") }, d);
    expect(d.send.mock.calls[0][2].idempotencyKey).toBe("token_expiring:c1:2027-01-10:u1");
  });

  it("nobody with an alert number: nothing is sent", async () => {
    const d = deps([]);
    expect(await warnExpiring(conn, d)).toEqual({ recipients: 0, sent: 0, skipped: 0, failed: 0 });
    expect(d.send).not.toHaveBeenCalled();
  });

  it("a switch that is off or a send that fails is counted, never an error", async () => {
    const d = deps();
    d.send.mockResolvedValueOnce({ status: "skipped", reason: "feature_off" } as never).mockRejectedValueOnce(new Error("down"));
    expect(await warnExpiring(conn, d)).toEqual({ recipients: 2, sent: 0, skipped: 1, failed: 1 });
  });
});
