import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeTables, type Row } from "../../../test-support/fake-tables";
import { overallOf, SAFE } from "./checks";
import { forgetNotedWebhooks, noteWebhookSeen, webhookWasSeen, WEBHOOK_SEEN_ACTION } from "./webhook-seen";

// Proof that a manual_byo connection's own app delivers signed webhooks: one audit row per connection, written the first time, never on every webhook.

const A = "e0000000-0000-4000-8000-00000000000a";
const B = "e0000000-0000-4000-8000-00000000000b";
const CONN = "d4000000-0000-4000-8000-0000000000a1";

beforeEach(() => forgetNotedWebhooks());
afterEach(() => vi.useRealTimers());
const minutesLater = (n: number) => vi.setSystemTime(Date.now() + n * 60_000);

describe("a webhook was seen", () => {
  it("is not known before any webhook arrived, and is known after the first", async () => {
    const t = fakeTables({ audit_logs: [] });
    expect(await webhookWasSeen(t.db, A, CONN)).toBe(false);
    await noteWebhookSeen(A, CONN, t.db);
    expect(await webhookWasSeen(t.db, A, CONN)).toBe(true);
    expect(t.tables.audit_logs).toEqual([expect.objectContaining({ tenant_id: A, action: WEBHOOK_SEEN_ACTION, entity_id: CONN, actor: "system" })]);
  });

  it("writes one row however many webhooks come, and reads the log only once while the server runs", async () => {
    const t = fakeTables({ audit_logs: [] });
    for (let i = 0; i < 5; i++) await noteWebhookSeen(A, CONN, t.db);
    expect(t.tables.audit_logs).toHaveLength(1);
    expect(t.calls.filter((c) => c.op === "select" && c.table === "audit_logs")).toHaveLength(1);
  });

  it("does not write again after a restart when the row is already there", async () => {
    const t = fakeTables({ audit_logs: [{ id: "x", tenant_id: A, action: WEBHOOK_SEEN_ACTION, entity_id: CONN }] });
    await noteWebhookSeen(A, CONN, t.db);
    expect(t.tables.audit_logs).toHaveLength(1);
  });

  it("another business's row proves nothing", async () => {
    const t = fakeTables({ audit_logs: [{ id: "x", tenant_id: B, action: WEBHOOK_SEEN_ACTION, entity_id: CONN }] });
    expect(await webhookWasSeen(t.db, A, CONN)).toBe(false);
  });

  it("never throws, and tries again with the next webhook after a failure", async () => {
    const broken = fakeTables({ audit_logs: { error: { code: "XX000" } } });
    await expect(noteWebhookSeen(A, CONN, broken.db)).resolves.toBeUndefined();
    const t = fakeTables({ audit_logs: [] });
    await noteWebhookSeen(A, CONN, t.db);
    expect(t.tables.audit_logs).toHaveLength(1);
  });
});

// The warning "webhook not confirmed" clears by itself: the first signed webhook from the business's own app turns the stored webhook check to pass.

const RAN = "2026-10-12T09:00:00.000Z";
const check = (key: string, status: string, message = "m") => ({ key, status, message, checked_at: RAN });
const checksOf = (webhook: string, payment = "pass") => [
  check("token_permissions", "pass"),
  check("number_registered", "pass"),
  check("webhook_subscribed", webhook, SAFE.webhookWaiting),
  check("display_name_approved", "pass"),
  check("payment_method", payment),
  check("test_message_delivered", "pass"),
];
const lastCheck = (webhook: string, payment = "pass") => {
  const checks = checksOf(webhook, payment);
  return { ran_at: RAN, overall: overallOf(checks as Parameters<typeof overallOf>[0]), checks };
};
const UPDATED = "2026-10-12T09:00:01.123456+00:00";
const connection = (over: Row = {}): Row => ({ id: CONN, tenant_id: A, method: "manual_byo", status: "active", display_phone: "+91 98765 43210", last_check: lastCheck("not_verified"), updated_at: UPDATED, ...over });
const webhookOf = (row: Row) => (row.last_check as { checks: { key: string; status: string; message: string }[] }).checks.find((c) => c.key === "webhook_subscribed");

describe("the webhook check clears when the first signed webhook arrives", () => {
  it("turns a waiting webhook check into a pass, in fixed words, and works overall out again", async () => {
    const t = fakeTables({ audit_logs: [], whatsapp_connections: [connection()] });
    await noteWebhookSeen(A, CONN, t.db);
    const row = t.tables.whatsapp_connections[0];
    expect(webhookOf(row)).toMatchObject({ status: "pass", message: SAFE.webhookPass });
    expect((row.last_check as { overall: string }).overall).toBe("pass");
  });

  it("keeps the status active and changes nothing else in the row or in the other checks", async () => {
    const before = connection();
    const t = fakeTables({ audit_logs: [], whatsapp_connections: [structuredClone(before)] });
    await noteWebhookSeen(A, CONN, t.db);
    const row = t.tables.whatsapp_connections[0];
    expect(row).toMatchObject({ status: "active", method: "manual_byo", display_phone: "+91 98765 43210" });
    const last = row.last_check as { ran_at: string; checks: { key: string }[] };
    expect(last.ran_at).toBe(RAN);
    expect(last.checks.map((c) => c.key)).toEqual(["token_permissions", "number_registered", "webhook_subscribed", "display_name_approved", "payment_method", "test_message_delivered"]);
    expect(last.checks.filter((c) => c.key !== "webhook_subscribed")).toEqual((before.last_check as { checks: { key: string }[] }).checks.filter((c) => c.key !== "webhook_subscribed"));
    const update = t.calls.find((c) => c.table === "whatsapp_connections" && c.op === "update");
    expect(Object.keys(update?.payload as object)).toEqual(["last_check"]);
  });

  it("overall stays a warning while another check still warns", async () => {
    const t = fakeTables({ audit_logs: [], whatsapp_connections: [connection({ last_check: lastCheck("not_verified", "warn") })] });
    await noteWebhookSeen(A, CONN, t.db);
    expect((t.tables.whatsapp_connections[0].last_check as { overall: string }).overall).toBe("warn");
    expect(webhookOf(t.tables.whatsapp_connections[0])?.status).toBe("pass");
  });

  it("leaves the 'could not subscribe' warning alone: Meta's own list said nothing is subscribed, and a recheck decides", async () => {
    const t = fakeTables({ audit_logs: [], whatsapp_connections: [connection({ last_check: lastCheck("warn") })] });
    await noteWebhookSeen(A, CONN, t.db);
    expect(webhookOf(t.tables.whatsapp_connections[0])?.status).toBe("warn");
    expect(t.calls.some((c) => c.table === "whatsapp_connections" && c.op === "update")).toBe(false);
  });

  it("is idempotent: a repeat, even after a restart, writes nothing more", async () => {
    const t = fakeTables({ audit_logs: [], whatsapp_connections: [connection()] });
    await noteWebhookSeen(A, CONN, t.db);
    const after = structuredClone(t.tables.whatsapp_connections[0]);
    forgetNotedWebhooks();
    await noteWebhookSeen(A, CONN, t.db);
    expect(t.tables.whatsapp_connections[0]).toEqual(after);
    expect(t.calls.filter((c) => c.table === "whatsapp_connections" && c.op === "update")).toHaveLength(1);
  });

  it("leaves a check that already passes, has failed or was skipped alone", async () => {
    for (const status of ["pass", "fail", "skipped"]) {
      const t = fakeTables({ audit_logs: [], whatsapp_connections: [connection({ last_check: lastCheck(status) })] });
      await noteWebhookSeen(A, CONN, t.db);
      expect(webhookOf(t.tables.whatsapp_connections[0])?.status).toBe(status);
      expect(t.calls.some((c) => c.table === "whatsapp_connections" && c.op === "update")).toBe(false);
      forgetNotedWebhooks();
    }
  });

  it("every query names the business and the connection, and only an active manual_byo connection is touched", async () => {
    const t = fakeTables({ audit_logs: [], whatsapp_connections: [connection()] });
    await noteWebhookSeen(A, CONN, t.db);
    for (const call of t.calls.filter((c) => c.table === "whatsapp_connections")) {
      expect(call.filters).toEqual(expect.arrayContaining([{ column: "tenant_id", op: "eq", value: A }, { column: "id", op: "eq", value: CONN }]));
    }
    const update = t.calls.find((c) => c.table === "whatsapp_connections" && c.op === "update");
    expect(update?.filters).toEqual(expect.arrayContaining([{ column: "status", op: "eq", value: "active" }, { column: "method", op: "eq", value: "manual_byo" }]));
  });

  it("another business's connection is never changed", async () => {
    const t = fakeTables({ audit_logs: [], whatsapp_connections: [connection({ tenant_id: B })] });
    await noteWebhookSeen(A, CONN, t.db);
    expect(webhookOf(t.tables.whatsapp_connections[0])?.status).toBe("not_verified");
  });

  it("a number that is not active is left as it is (a recheck reads the webhook proof itself), and is looked at again later, not never", async () => {
    for (const status of ["failed", "validating", "pending", "disconnected"]) {
      vi.useFakeTimers();
      const t = fakeTables({ audit_logs: [], whatsapp_connections: [connection({ status })] });
      await noteWebhookSeen(A, CONN, t.db);
      expect(webhookOf(t.tables.whatsapp_connections[0])?.status).toBe("not_verified");
      expect(t.tables.whatsapp_connections[0].status).toBe(status);
      t.tables.whatsapp_connections[0].status = "active"; // a recheck made it active
      minutesLater(2);
      await noteWebhookSeen(A, CONN, t.db);
      expect(webhookOf(t.tables.whatsapp_connections[0])?.status).toBe("pass");
      forgetNotedWebhooks();
      vi.useRealTimers();
    }
  });

  it("does not ask the database about a connection again within a minute when it was not ready, so a busy number costs nothing", async () => {
    vi.useFakeTimers();
    const t = fakeTables({ audit_logs: [], whatsapp_connections: [connection({ status: "validating" })] });
    for (let i = 0; i < 5; i++) await noteWebhookSeen(A, CONN, t.db);
    expect(t.calls.filter((c) => c.table === "whatsapp_connections")).toHaveLength(1);
    expect(t.calls.filter((c) => c.table === "audit_logs" && c.op === "select")).toHaveLength(1);
  });

  it("a connection of another method is left as it is", async () => {
    const t = fakeTables({ audit_logs: [], whatsapp_connections: [connection({ method: "embedded_signup" })] });
    await noteWebhookSeen(A, CONN, t.db);
    expect(webhookOf(t.tables.whatsapp_connections[0])?.status).toBe("not_verified");
  });

  it("anything saved in between (a recheck, or the sixth check of a connect) is not overwritten with an older copy, even one with the same ran_at", async () => {
    const t = fakeTables({ audit_logs: [], whatsapp_connections: [connection()] });
    const row = t.tables.whatsapp_connections[0];
    let touches = 0;
    const db = {
      from(table: string) {
        if (table === "whatsapp_connections" && ++touches === 2) {
          // the sixth check is written, keeping ran_at, and the row's updated_at moves
          row.last_check = { ...lastCheck("not_verified"), checks: checksOf("not_verified").map((c) => (c.key === "test_message_delivered" ? { ...c, message: "sent to the owner" } : c)) };
          row.updated_at = "2026-10-12T09:00:05.000000+00:00";
        }
        return t.db.from(table);
      },
    } as unknown as SupabaseClient;
    vi.useFakeTimers();
    await noteWebhookSeen(A, CONN, db);
    expect((row.last_check as { checks: { key: string; message: string }[] }).checks.find((c) => c.key === "test_message_delivered")?.message).toBe("sent to the owner");
    expect(webhookOf(row)?.status).toBe("not_verified");
    // the miss is not counted as done: the next webhook (after the pause) reads the new result and clears it, keeping the sixth check
    minutesLater(2);
    await noteWebhookSeen(A, CONN, t.db);
    expect(webhookOf(row)?.status).toBe("pass");
    expect((row.last_check as { checks: { key: string; message: string }[] }).checks.find((c) => c.key === "test_message_delivered")?.message).toBe("sent to the owner");
  });

  it("the update is guarded by the row's updated_at as it was read", async () => {
    const t = fakeTables({ audit_logs: [], whatsapp_connections: [connection()] });
    await noteWebhookSeen(A, CONN, t.db);
    const update = t.calls.find((c) => c.table === "whatsapp_connections" && c.op === "update");
    expect(update?.filters).toEqual(expect.arrayContaining([{ column: "updated_at", op: "eq", value: UPDATED }]));
  });

  it("a retry does not read the audit log again, only the connection", async () => {
    vi.useFakeTimers();
    const t = fakeTables({ audit_logs: [], whatsapp_connections: [connection({ status: "validating" })] });
    await noteWebhookSeen(A, CONN, t.db);
    minutesLater(2);
    await noteWebhookSeen(A, CONN, t.db);
    expect(t.calls.filter((c) => c.table === "audit_logs" && c.op === "select")).toHaveLength(1);
    expect(t.calls.filter((c) => c.table === "whatsapp_connections" && c.op === "select")).toHaveLength(2);
    expect(t.tables.audit_logs).toHaveLength(1);
  });

  it("a stored result with a check key or status this code does not know yet is still cleared, and its extra fields are kept", async () => {
    const stored = { ...lastCheck("not_verified"), extra: "kept", checks: [...checksOf("not_verified"), { key: "new_check", status: "brand_new", message: "m", checked_at: RAN, detail: 1 }] };
    const t = fakeTables({ audit_logs: [], whatsapp_connections: [connection({ last_check: stored })] });
    await noteWebhookSeen(A, CONN, t.db);
    const last = t.tables.whatsapp_connections[0].last_check as { extra: string; checks: { key: string; status: string; detail?: number }[] };
    expect(last.checks.find((c) => c.key === "webhook_subscribed")?.status).toBe("pass");
    expect(last.checks.find((c) => c.key === "new_check")).toMatchObject({ status: "brand_new", detail: 1 });
    expect(last.extra).toBe("kept");
  });

  it("a connection that was never checked, or whose last check is not in the expected shape, is left alone without a fuss", async () => {
    for (const last of [{}, null, "x", { checks: "nope" }, { ran_at: RAN, overall: "warn", checks: [{ key: "webhook_subscribed" }] }]) {
      const t = fakeTables({ audit_logs: [], whatsapp_connections: [connection({ last_check: last })] });
      await expect(noteWebhookSeen(A, CONN, t.db)).resolves.toBeUndefined();
      expect(t.calls.some((c) => c.table === "whatsapp_connections" && c.op === "update")).toBe(false);
      forgetNotedWebhooks();
    }
  });

  it("never throws, changes nothing, and tries again with the next webhook when the connection cannot be read or written", async () => {
    vi.useFakeTimers();
    const unreadable = fakeTables({ audit_logs: [], whatsapp_connections: { error: { code: "XX000" } } });
    await expect(noteWebhookSeen(A, CONN, unreadable.db)).resolves.toBeUndefined();
    const t = fakeTables({ audit_logs: [], whatsapp_connections: [connection()] });
    minutesLater(2);
    await noteWebhookSeen(A, CONN, t.db);
    expect(webhookOf(t.tables.whatsapp_connections[0])?.status).toBe("pass");
  });

  it("the audit proof is still written when the check cannot be updated", async () => {
    const t = fakeTables({ audit_logs: [], whatsapp_connections: { error: { code: "XX000" } } });
    await noteWebhookSeen(A, CONN, t.db);
    expect(t.tables.audit_logs).toHaveLength(1);
  });
});
