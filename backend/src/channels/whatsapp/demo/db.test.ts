import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { WebhookDbError } from "../inbound-db";
import { demoDb } from "./db";

const A = "a0000000-0000-4000-8000-00000000000a";
const NOW = new Date("2026-10-13T10:00:00.000Z");

type Answer = { data?: unknown; error?: { code: string; message: string } | null };
function client(answers: { rpc?: Answer; select?: Answer; update?: Answer }) {
  const calls: { op: string; args: unknown[] }[] = [];
  const chain = (answer: Answer, op: string) => {
    const c: Record<string, unknown> = {};
    c.eq = (...args: unknown[]) => (calls.push({ op: `${op}.eq`, args }), c);
    c.maybeSingle = async () => ({ data: answer.data ?? null, error: answer.error ?? null });
    c.then = (resolve: (v: unknown) => unknown) => resolve({ data: answer.data ?? null, error: answer.error ?? null });
    return c;
  };
  const db = {
    rpc: vi.fn(async (name: string, args: unknown) => (calls.push({ op: "rpc", args: [name, args] }), { data: answers.rpc?.data ?? null, error: answers.rpc?.error ?? null })),
    from: (table: string) => ({
      select: (cols: string) => (calls.push({ op: "select", args: [table, cols] }), chain(answers.select ?? {}, "select")),
      update: (row: unknown) => (calls.push({ op: "update", args: [table, row] }), chain(answers.update ?? {}, "update")),
    }),
  };
  return { db: db as unknown as SupabaseClient, calls };
}
const row = (over = {}) => ({ allowed: true, notify_limit: false, replay: false, message_tenant_id: null, ...over });
const PHONE = "+919800000001";

describe("demo number database access", () => {
  it("counts a message through demo_admit, with the server's time and the business of a valid code", async () => {
    const c = client({ rpc: { data: [row({ message_tenant_id: A })] } });
    expect(await demoDb(c.db, () => NOW).admit({ phone: PHONE, wamid: "w1", limit: 30, routeTenantId: A })).toEqual({ allowed: true, replay: false, notifyLimit: false, tenantId: A });
    expect(c.calls[0]).toEqual({ op: "rpc", args: ["demo_admit", { p_phone: PHONE, p_wamid: "w1", p_limit: 30, p_now: NOW.toISOString(), p_route_tenant: A }] });
  });

  it("sends no route when the message had no valid code", async () => {
    const c = client({ rpc: { data: [row()] } });
    expect(await demoDb(c.db, () => NOW).admit({ phone: PHONE, wamid: "w1", limit: 30, routeTenantId: null })).toEqual({ allowed: true, replay: false, notifyLimit: false, tenantId: null });
    expect(c.calls[0]).toEqual({ op: "rpc", args: ["demo_admit", expect.objectContaining({ p_route_tenant: null })] });
  });

  it("reports a database error by its code only", async () => {
    const c = client({ rpc: { error: { code: "XX000", message: `contains ${PHONE}` } } });
    const err = await demoDb(c.db, () => NOW).admit({ phone: PHONE, wamid: "w1", limit: 30, routeTenantId: null }).catch((e) => e);
    expect(err).toBeInstanceOf(WebhookDbError);
    expect(err.code).toBe("XX000");
    expect(String(err.message)).not.toContain("9198");
  });

  it("refuses an answer that is not what demo_admit returns", async () => {
    const c = client({ rpc: { data: [{ allowed: "yes" }] } });
    await expect(demoDb(c.db, () => NOW).admit({ phone: PHONE, wamid: "w1", limit: 30, routeTenantId: null })).rejects.toThrow();
  });

  it("finds the business of a code that has not expired, and of one that never expires", async () => {
    expect(await demoDb(client({ select: { data: { tenant_id: A, kind: "trial", expires_at: "2026-10-14T00:00:00Z" } } }).db, () => NOW).findRoute("TRIAL-7F3K")).toEqual({ tenantId: A, kind: "trial" });
    expect(await demoDb(client({ select: { data: { tenant_id: A, kind: "demo", expires_at: null } } }).db, () => NOW).findRoute("DEMO-SALON")).toEqual({ tenantId: A, kind: "demo" });
  });

  it("finds nothing for an unknown code, an expired one or one with no business", async () => {
    expect(await demoDb(client({ select: { data: null } }).db, () => NOW).findRoute("DEMO-X")).toBeNull();
    expect(await demoDb(client({ select: { data: { tenant_id: A, kind: "trial", expires_at: "2026-10-13T09:59:59Z" } } }).db, () => NOW).findRoute("TRIAL-7F3K")).toBeNull();
    expect(await demoDb(client({ select: { data: { tenant_id: A, kind: "trial", expires_at: "2026-10-13T10:00:00Z" } } }).db, () => NOW).findRoute("TRIAL-7F3K")).toBeNull();
    expect(await demoDb(client({ select: { data: { tenant_id: null, kind: "demo", expires_at: null } } }).db, () => NOW).findRoute("DEMO-X")).toBeNull();
  });

  it("looks a code up by the code itself", async () => {
    const c = client({ select: { data: null } });
    await demoDb(c.db, () => NOW).findRoute("DEMO-SALON");
    expect(c.calls).toContainEqual({ op: "select.eq", args: ["code", "DEMO-SALON"] });
  });

  it("a business is live when it is on trial or active, and not when paused, cancelled or gone", async () => {
    for (const [status, live] of [["trial", true], ["active", true], ["paused", false], ["cancelled", false]] as const) {
      expect(await demoDb(client({ select: { data: { status } } }).db, () => NOW).isLive(A)).toBe(live);
    }
    expect(await demoDb(client({ select: { data: null } }).db, () => NOW).isLive(A)).toBe(false);
  });

  it("asks for a business's status by its own id", async () => {
    const c = client({ select: { data: { status: "trial" } } });
    await demoDb(c.db, () => NOW).isLive(A);
    expect(c.calls).toContainEqual({ op: "select", args: ["tenants", "status"] });
    expect(c.calls).toContainEqual({ op: "select.eq", args: ["id", A] });
  });

  it("reports a lookup error by its code only", async () => {
    await expect(demoDb(client({ select: { error: { code: "42P01", message: "x" } } }).db, () => NOW).findRoute("DEMO-X")).rejects.toMatchObject({ code: "42P01" });
    await expect(demoDb(client({ select: { error: { code: "42501", message: "x" } } }).db, () => NOW).isLive(A)).rejects.toMatchObject({ code: "42501" });
  });
});
