import { describe, expect, it, vi } from "vitest";

// connectLinkDb is the real database side of connect-link.ts. Atomicity itself is Postgres's (supabase/tests/connect_link_claim.test.sql); here the statements are
// recorded, so a refactor cannot quietly drop one of the conditions that make a link single use, and every query names the link by its hash.

vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "synthetic-anon-key");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-service-key");
vi.stubEnv("EMBEDDINGS_API_KEY", "synthetic-embeddings-key");
vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-anthropic-key");

type Step = [string, ...unknown[]];
const recorded = vi.hoisted(() => ({ steps: [] as unknown[][], answer: { data: null as unknown, error: null as unknown } }));

/** A query builder that records every call and, awaited, answers what the test set. */
function builder(): unknown {
  const proxy: unknown = new Proxy(() => {}, {
    get: (_t, prop) => {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve(recorded.answer);
      return (...args: unknown[]) => {
        recorded.steps.push([String(prop), ...args]);
        return proxy;
      };
    },
  });
  return proxy;
}
vi.mock("../../../lib/supabase-admin", () => ({ supabaseAdmin: () => ({ from: (table: string) => (recorded.steps.push(["from", table]), builder()) }) }));

const { connectLinkDb } = await import("./connect-link");

const HASH = "a".repeat(64);
const NOW = new Date("2026-10-14T00:00:00.123Z");
const reset = (data: unknown = null, error: unknown = null) => {
  recorded.steps.length = 0;
  recorded.answer = { data, error };
};
const has = (...step: Step) => recorded.steps.some((s) => s.length === step.length && s.every((v, i) => JSON.stringify(v) === JSON.stringify(step[i])));

describe("connectLinkDb", () => {
  it("claims with one UPDATE that is conditional on the hash, an unused link and an unexpired one, and asks for the row back", async () => {
    reset([{ tenant_id: "t1", created_by: "u1" }]);
    const claim = await connectLinkDb().claim(HASH, NOW);
    expect(claim).toEqual({ tenantId: "t1", createdBy: "u1", claimedAt: NOW.toISOString() });
    expect(has("from", "connect_links")).toBe(true);
    expect(has("update", { used_at: NOW.toISOString() })).toBe(true);
    expect(has("eq", "token_hash", HASH)).toBe(true);
    expect(has("is", "used_at", null)).toBe(true);
    expect(has("gt", "expires_at", NOW.toISOString())).toBe(true);
    expect(recorded.steps.some((s) => s[0] === "select")).toBe(true);
  });

  it("a claim that changes no row is null", async () => {
    reset([]);
    expect(await connectLinkDb().claim(HASH, NOW)).toBeNull();
  });

  it("a claim the database refuses is upstream_failed, not a link", async () => {
    reset(null, { message: "db down" });
    await expect(connectLinkDb().claim(HASH, NOW)).rejects.toMatchObject({ code: "upstream_failed" });
  });

  it("releases only the claim made at that very time", async () => {
    reset();
    await connectLinkDb().release(HASH, NOW.toISOString());
    expect(has("update", { used_at: null })).toBe(true);
    expect(has("eq", "token_hash", HASH)).toBe(true);
    expect(has("eq", "used_at", NOW.toISOString())).toBe(true);
  });

  it("reads a link only while it is unused and unexpired, and gives the business name", async () => {
    reset({ expires_at: "2026-10-15T00:00:00.000Z", tenants: { name: "Sunrise Homes" } });
    const link = await connectLinkDb().readLive(HASH, NOW);
    expect(link).toEqual({ tenantName: "Sunrise Homes", expiresAt: new Date("2026-10-15T00:00:00.000Z") });
    expect(has("eq", "token_hash", HASH)).toBe(true);
    expect(has("is", "used_at", null)).toBe(true);
    expect(has("gt", "expires_at", NOW.toISOString())).toBe(true);
  });

  it("a link whose business has no readable name is not live", async () => {
    reset({ expires_at: "2026-10-15T00:00:00.000Z", tenants: null });
    expect(await connectLinkDb().readLive(HASH, NOW)).toBeNull();
  });

  it("asks whether the business has the number ACTIVE, by business, number and status", async () => {
    reset({ id: "c1" });
    expect(await connectLinkDb().activeConnectionExists("t1", "200000000000001")).toBe(true);
    expect(has("from", "whatsapp_connections")).toBe(true);
    expect(has("eq", "tenant_id", "t1")).toBe(true);
    expect(has("eq", "phone_number_id", "200000000000001")).toBe(true);
    expect(has("eq", "status", "active")).toBe(true);
    reset(null);
    expect(await connectLinkDb().activeConnectionExists("t1", "200000000000001")).toBe(false);
  });

  it("stores the hash, never a token column", async () => {
    reset();
    await connectLinkDb().insert({ tokenHash: HASH, tenantId: "t1", createdBy: "u1", expiresAt: NOW });
    const insert = recorded.steps.find((s) => s[0] === "insert")?.[1] as Record<string, unknown>;
    expect(insert).toEqual({ token_hash: HASH, tenant_id: "t1", created_by: "u1", expires_at: NOW.toISOString() });
    expect(Object.keys(insert)).not.toContain("token");
  });
});
