import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { fakeTables, type Row } from "../../../test-support/fake-tables";
import { demoDb } from "./db";

// The demo number's reads for PR 1b: the menu, a visitor's route, which business a delivery status is for, and Dev 2's trial-phone claim.

const A = "a0000000-0000-4000-8000-00000000000a";
const B = "b0000000-0000-4000-8000-00000000000b";
const C = "c0000000-0000-4000-8000-00000000000c";
const NOW = new Date("2026-10-13T10:00:00.000Z");
const PHONE = "+919800000001";

const code = (c: string, tenant: string | null, over: Row = {}): Row => ({ code: c, kind: "demo", tenant_id: tenant, expires_at: null, ...over });
const tenant = (id: string, vertical: string, over: Row = {}): Row => ({ id, name: `Tenant ${vertical}`, vertical, status: "active", ...over });
const pack = (key: string, version: number, label: unknown, over: Row = {}): Row => ({ key, version, active: true, definition: { key, version, label }, ...over });

describe("the menu", () => {
  const world = (over: Record<string, Row[]> = {}) =>
    fakeTables({
      route_codes: [code("DEMO-SALON", A), code("DEMO-INTERIORS", B), code("TRIAL-7F3K", C, { kind: "trial" })],
      tenants: [tenant(A, "salon"), tenant(B, "interiors"), tenant(C, "salon", { status: "trial" })],
      vertical_packs: [pack("salon", 1, "Beauty parlour"), pack("interiors", 1, "Interior design")],
      ...over,
    });

  it("lists the demo businesses by code, labelled with their pack's label, and never a trial's code", async () => {
    expect(await demoDb(world().db, () => NOW).menu()).toEqual([
      { code: "DEMO-INTERIORS", label: "Interior design" },
      { code: "DEMO-SALON", label: "Beauty parlour" },
    ]);
  });

  it("asks only for demo codes", async () => {
    const w = world();
    await demoDb(w.db, () => NOW).menu();
    expect(w.calls[0].filters).toContainEqual({ column: "kind", op: "eq", value: "demo" });
  });

  it("uses the newest version of a pack, and the business's own name when its pack or label is missing", async () => {
    const w = world({ vertical_packs: [pack("salon", 1, "Old label"), pack("salon", 2, "New label"), pack("interiors", 1, "")] });
    expect(await demoDb(w.db, () => NOW).menu()).toEqual([
      { code: "DEMO-INTERIORS", label: "Tenant interiors" },
      { code: "DEMO-SALON", label: "New label" },
    ]);
  });

  it("leaves out an expired code, a code with no business, and a business that is paused or cancelled", async () => {
    const w = world({
      route_codes: [
        code("DEMO-SALON", A, { expires_at: "2026-10-13T09:59:59Z" }),
        code("DEMO-INTERIORS", null),
        code("DEMO-OTHER", B),
        code("DEMO-GONE", C),
      ],
      tenants: [tenant(A, "salon"), tenant(B, "interiors", { status: "paused" }), tenant(C, "salon", { status: "cancelled" })],
    });
    expect(await demoDb(w.db, () => NOW).menu()).toEqual([]);
  });

  it("lists a business once, with its first code, however many codes it has", async () => {
    const w = world({ route_codes: [code("DEMO-SALON", A), code("DEMO-SALON-2", A), code("DEMO-INTERIORS", B)] });
    expect((await demoDb(w.db, () => NOW).menu()).map((e) => e.code)).toEqual(["DEMO-INTERIORS", "DEMO-SALON"]);
  });

  it("finds the live businesses even when more than 20 expired codes sort before them", async () => {
    const expired = Array.from({ length: 30 }, (_, i) => code(`DEMO-A${String(i).padStart(2, "0")}`, C, { expires_at: "2026-10-01T00:00:00Z" }));
    const w = world({ route_codes: [...expired, code("DEMO-SALON", A)], tenants: [tenant(A, "salon"), tenant(C, "salon")] });
    expect((await demoDb(w.db, () => NOW).menu()).map((e) => e.code)).toEqual(["DEMO-SALON"]);
  });

  it("is capped, so a table full of demo codes cannot make an enormous message", async () => {
    const ids = Array.from({ length: 40 }, (_, i) => `a1000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`);
    const many = ids.map((id, i) => code(`DEMO-X${String(i).padStart(2, "0")}`, id));
    const w = world({ route_codes: many, tenants: ids.map((id) => tenant(id, "salon")) });
    expect((await demoDb(w.db, () => NOW).menu()).length).toBeLessThanOrEqual(9);
  });

  it("an error is thrown, by its code only", async () => {
    await expect(demoDb(fakeTables({ route_codes: { error: { code: "42P01" } } }).db, () => NOW).menu()).rejects.toMatchObject({ code: "42P01" });
    await expect(demoDb(world({ tenants: { error: { code: "42501" } } as never }).db, () => NOW).menu()).rejects.toMatchObject({ code: "42501" });
    await expect(demoDb(world({ vertical_packs: { error: { code: "XX000" } } as never }).db, () => NOW).menu()).rejects.toMatchObject({ code: "XX000" });
  });
});

describe("whether a visitor has a route", () => {
  const visitor = (over: Row = {}): Row => ({ phone: PHONE, tenant_id: A, routed_at: "2026-10-13T09:00:00Z", ...over });
  const has = async (rows: Row[], status = "active") => demoDb(fakeTables({ demo_visitors: rows, tenants: [{ id: A, status }] }).db, () => NOW).hasRoute(PHONE);

  it("is false when the business of the route has been paused or cancelled: the visitor can pick a new one", async () => {
    expect(await has([visitor()], "paused")).toBe(false);
    expect(await has([visitor()], "cancelled")).toBe(false);
    expect(await has([visitor()], "trial")).toBe(true);
    expect(await demoDb(fakeTables({ demo_visitors: [visitor()], tenants: [] }).db, () => NOW).hasRoute(PHONE)).toBe(false);
  });

  it("is true for a route under 24 hours old", async () => {
    expect(await has([visitor()])).toBe(true);
    expect(await has([visitor({ routed_at: "2026-10-12T10:00:01Z" })])).toBe(true);
  });

  it("is false for an old route, no route, or no visitor", async () => {
    expect(await has([visitor({ routed_at: "2026-10-12T10:00:00Z" })])).toBe(false);
    expect(await has([visitor({ tenant_id: null, routed_at: null })])).toBe(false);
    expect(await has([])).toBe(false);
    expect(await has([visitor({ phone: "+919800000002" })])).toBe(false);
  });

  it("asks about that phone only, and an error is thrown by its code", async () => {
    const w = fakeTables({ demo_visitors: [visitor()] });
    await demoDb(w.db, () => NOW).hasRoute(PHONE);
    expect(w.calls[0].filters).toContainEqual({ column: "phone", op: "eq", value: PHONE });
    await expect(demoDb(fakeTables({ demo_visitors: { error: { code: "42501" } } }).db, () => NOW).hasRoute(PHONE)).rejects.toMatchObject({ code: "42501" });
  });
});

describe("which business a delivery status is for", () => {
  const CONV = "d0000000-0000-4000-8000-0000000000d1";
  const CHANNEL = "ca000000-0000-4000-8000-0000000000c1";
  const world = (over: Record<string, Row[]> = {}) =>
    fakeTables({
      messages: [{ id: "m1", tenant_id: B, conversation_id: CONV, provider_msg_id: "wamid.OUT1", direction: "out" }],
      conversations: [{ id: CONV, tenant_id: B, channel_id: CHANNEL }],
      ...over,
    });

  it("is the business whose conversation holds that message, on that channel", async () => {
    expect(await demoDb(world().db, () => NOW).messageTenant({ providerMsgId: "wamid.OUT1", channelId: CHANNEL })).toBe(B);
  });

  it("is nobody when the message is unknown, or its chat is on another channel", async () => {
    expect(await demoDb(world().db, () => NOW).messageTenant({ providerMsgId: "wamid.NOPE", channelId: CHANNEL })).toBeNull();
    expect(await demoDb(world().db, () => NOW).messageTenant({ providerMsgId: "wamid.OUT1", channelId: "ca000000-0000-4000-8000-0000000000c9" })).toBeNull();
  });

  it("checks the chat against the business the message says, so another business's chat with the same id proves nothing", async () => {
    const w = world({ conversations: [{ id: CONV, tenant_id: A, channel_id: CHANNEL }] });
    expect(await demoDb(w.db, () => NOW).messageTenant({ providerMsgId: "wamid.OUT1", channelId: CHANNEL })).toBeNull();
  });

  it("names the business and the channel when it reads the chat, and an error is thrown by its code", async () => {
    const w = world();
    await demoDb(w.db, () => NOW).messageTenant({ providerMsgId: "wamid.OUT1", channelId: CHANNEL });
    expect(w.calls[1].filters).toEqual(expect.arrayContaining([{ column: "tenant_id", op: "eq", value: B }, { column: "channel_id", op: "eq", value: CHANNEL }]));
    await expect(demoDb(world({ messages: { error: { code: "XX000" } } as never }).db, () => NOW).messageTenant({ providerMsgId: "w", channelId: CHANNEL })).rejects.toMatchObject({ code: "XX000" });
  });
});

describe("the trial phone", () => {
  const client = (answer: { data?: unknown; error?: { code?: string; message: string } }) => {
    const rpc = vi.fn(async () => ({ data: answer.data ?? null, error: answer.error ?? null }));
    return { db: { rpc } as unknown as SupabaseClient, rpc };
  };

  it("is claimed through Dev 2's claim_trial_phone with the business and the sender, and its answer is passed on", async () => {
    for (const answer of ["claimed", "other_sender", "taken"] as const) {
      const c = client({ data: answer });
      expect(await demoDb(c.db, () => NOW).claimTrialPhone(B, PHONE)).toBe(answer);
      expect(c.rpc).toHaveBeenCalledWith("claim_trial_phone", { p_tenant_id: B, p_phone: PHONE });
    }
  });

  it("an error or an answer that is not one of the three is thrown", async () => {
    await expect(demoDb(client({ error: { message: "boom" } }).db, () => NOW).claimTrialPhone(B, PHONE)).rejects.toThrow();
    await expect(demoDb(client({ data: "maybe" }).db, () => NOW).claimTrialPhone(B, PHONE)).rejects.toThrow();
  });
});
