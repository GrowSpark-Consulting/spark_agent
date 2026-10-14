import { AdminConnection } from "@pakka/types";
import { describe, expect, it } from "vitest";
import { fakeDb } from "../test-support/fake-db";
import { checkView, listConnections } from "./connections";

const ADMIN = { actor: "admin:1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b" };
const row = (over: Record<string, unknown> = {}) => ({
  id: "d4000000-0000-4000-8000-0000000000a1",
  tenant_id: "e0000000-0000-4000-8000-00000000000a",
  method: "manual_byo",
  status: "active",
  display_phone: "+91 98400 12345",
  verified_name: "Skyline Homes",
  coexistence: false,
  quality_rating: "GREEN",
  messaging_limit: "TIER_1K",
  token_expires_at: "2026-11-30T00:00:00+00:00",
  last_check: {
    ran_at: "2026-10-14T01:30:00+00:00",
    overall: "warn",
    checks: [
      { key: "token_permissions", status: "pass", message: "Token has both WhatsApp permissions.", checked_at: "2026-10-14T01:30:00+00:00" },
      { key: "payment_method", status: "warn", message: "No payment method on the account." },
    ],
  },
  created_at: "2026-10-10T09:00:00+00:00",
  updated_at: "2026-10-14T01:30:00+00:00",
  tenants: { name: "Skyline Homes" },
  ...over,
});

describe("GET /api/admin/whatsapp/connections", () => {
  it("lists every business's connections, newest first, in the panel's shape", async () => {
    const db = fakeDb({ whatsapp_connections: { data: [row(), row({ id: "d4000000-0000-4000-8000-0000000000a2", method: "platform", last_check: {}, token_expires_at: null })], error: null } });
    const list = await listConnections(ADMIN, { db: db.client });
    expect(list.map((c) => AdminConnection.parse(c))).toHaveLength(2);
    expect(list[0]).toEqual({
      id: "d4000000-0000-4000-8000-0000000000a1",
      tenantId: "e0000000-0000-4000-8000-00000000000a",
      tenantName: "Skyline Homes",
      method: "manual_byo",
      status: "active",
      displayPhone: "+91 98400 12345",
      verifiedName: "Skyline Homes",
      coexistence: false,
      qualityRating: "GREEN",
      messagingLimit: "TIER_1K",
      tokenExpiresAt: "2026-11-30T00:00:00.000Z",
      lastCheck: {
        ranAt: "2026-10-14T01:30:00.000Z",
        overall: "warn",
        checks: [
          { key: "token_permissions", status: "pass", message: "Token has both WhatsApp permissions." },
          { key: "payment_method", status: "warn", message: "No payment method on the account." },
        ],
      },
      createdAt: "2026-10-10T09:00:00.000Z",
      updatedAt: "2026-10-14T01:30:00.000Z",
    });
    expect(list[1]).toMatchObject({ method: "platform", lastCheck: null, tokenExpiresAt: null });
    expect(db.calls).toContainEqual({ table: "whatsapp_connections", method: "order", args: ["created_at", { ascending: false }] });
  });

  it("never reads a token or a secret", async () => {
    const db = fakeDb({ whatsapp_connections: { data: [], error: null } });
    await listConnections(ADMIN, { db: db.client });
    const selected = String(db.calls.find((c) => c.method === "select")?.args[0]);
    expect(selected).not.toMatch(/token_enc|app_secret_enc|waba_id|phone_number_id|connected_by/);
  });

  it("reads a stored check only in the agreed shape: never checked, or an older shape, is null", () => {
    expect(checkView({})).toBeNull();
    expect(checkView(null)).toBeNull();
    expect(checkView({ token_permissions: true })).toBeNull();
    expect(checkView({ ran_at: "2026-10-14T01:30:00Z", overall: "fail", checks: [{ key: "number_registered", status: "fail" }] })).toEqual({
      ranAt: "2026-10-14T01:30:00.000Z",
      overall: "fail",
      checks: [{ key: "number_registered", status: "fail", message: null }],
    });
  });

  it("fails loudly when the list cannot be read", async () => {
    const db = fakeDb({ whatsapp_connections: { data: null, error: { message: "timeout" } } });
    await expect(listConnections(ADMIN, { db: db.client })).rejects.toThrow("admin connections: read failed: timeout");
  });
});
