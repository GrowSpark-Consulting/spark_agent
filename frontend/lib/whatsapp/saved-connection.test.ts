import type { WhatsAppConnectionPublic } from "@pakka/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { BrowserTenant } from "@/lib/api/tenant";
import { loadSavedConnection, pickSaved } from "./saved-connection";

const TENANT = "10000000-0000-0000-0000-000000000004";
const RAN = "2026-10-12T04:30:00.000Z";
const checks = (webhook: string) => ({
  ran_at: RAN,
  overall: webhook === "pass" ? "pass" : "warn",
  checks: [{ key: "webhook_subscribed", status: webhook, message: "m", checked_at: RAN }],
});
const connection = (over: Partial<WhatsAppConnectionPublic> = {}): WhatsAppConnectionPublic => ({
  id: "30000000-0000-0000-0000-000000000001",
  tenant_id: TENANT,
  method: "embedded_signup",
  waba_id: "1",
  phone_number_id: "2",
  display_phone: "+91 98400 12345",
  verified_name: "Bright",
  coexistence: false,
  status: "active",
  last_check: checks("pass"),
  quality_rating: null,
  messaging_limit: null,
  created_at: "2026-10-01T00:00:00Z",
  ...over,
});

/** A Supabase client whose one query (from -> select -> eq -> order -> returns) answers `answer`. */
const client = (answer: { data: unknown; error: { code: string } | null }) =>
  ({ from: () => ({ select: () => ({ eq: () => ({ order: () => ({ returns: async () => answer }) }) }) }) }) as unknown as SupabaseClient;
const ok: BrowserTenant = { status: "ok", tenantId: TENANT, role: "owner" };

describe("pickSaved", () => {
  it("is active only when the database returns an active connection, and says whether messages are known to arrive", () => {
    expect(pickSaved([connection()])).toEqual({ state: "active", number: { status: "active", displayPhone: "+91 98400 12345", messagesReach: true } });
    expect(pickSaved([connection({ last_check: checks("not_verified") })])).toMatchObject({ state: "active", number: { messagesReach: false } });
    expect(pickSaved([connection({ last_check: {} })])).toMatchObject({ state: "active", number: { messagesReach: true } });
  });
  it("never calls a pending, validating or failed number connected", () => {
    for (const status of ["pending", "validating", "failed"] as const) expect(pickSaved([connection({ status })])).toMatchObject({ state: "inactive", number: { status } });
  });
  it("prefers an active number over a newer failed one, and the newest otherwise", () => {
    const active = connection({ id: "a", created_at: "2026-10-01T00:00:00Z" });
    const failed = connection({ id: "b", status: "failed", created_at: "2026-10-02T00:00:00Z" });
    expect(pickSaved([active, failed])).toMatchObject({ state: "active" });
    expect(pickSaved([connection({ status: "pending", display_phone: "+91 1" }), connection({ status: "failed", display_phone: "+91 2" })])).toMatchObject({ state: "inactive", number: { displayPhone: "+91 2" } });
  });
  it("treats nothing, or only a disconnected number, as none", () => {
    expect(pickSaved([])).toEqual({ state: "none" });
    expect(pickSaved([connection({ status: "disconnected" })])).toEqual({ state: "none" });
  });
});

describe("loadSavedConnection", () => {
  it("reads the signed-in member's connections from the database", async () => {
    expect(await loadSavedConnection(client({ data: [connection()], error: null }), async () => ok)).toMatchObject({ state: "active" });
  });
  it("says the view is unavailable when it does not exist yet (not 'nothing saved')", async () => {
    expect(await loadSavedConnection(client({ data: null, error: { code: "PGRST205" } }), async () => ok)).toEqual({ state: "unavailable" });
  });
  it("reports a failed read as an error, retryable, never as empty", async () => {
    const r = await loadSavedConnection(client({ data: null, error: { code: "XX000" } }), async () => ok);
    expect(r).toMatchObject({ state: "error", retryable: true });
    expect(JSON.stringify(r)).not.toMatch(/XX000/);
  });
  it("has nothing saved before the business exists, but says why when it can't tell which business", async () => {
    const never = client({ data: [connection()], error: null });
    expect(await loadSavedConnection(never, async () => ({ status: "no_business" }))).toEqual({ state: "none" });
    expect(await loadSavedConnection(never, async () => ({ status: "choose", businesses: [] }))).toMatchObject({ state: "error", retryable: false });
    expect(await loadSavedConnection(never, async () => ({ status: "signed_out" }))).toMatchObject({ state: "error", retryable: false });
    expect(await loadSavedConnection(never, async () => ({ status: "error" }))).toMatchObject({ state: "error", retryable: true });
  });
});
