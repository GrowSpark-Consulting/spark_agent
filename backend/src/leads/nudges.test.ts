import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "../test-support/fake-supabase";

const writeAudit = vi.fn(async () => {});
vi.mock("../lib/audit", () => ({ writeAudit }));

const { DEFAULT_NUDGE_TIMING, loadNudgeState, moveToNurture, nudgeBlocker, nudgeMessage, nudgeTiming } = await import("./nudges");
type NudgeState = Awaited<ReturnType<typeof loadNudgeState>> & object;

const TENANT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const CONVERSATION = "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f601";
const MESSAGE = "8e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b";
const CONTACT = "6fa459ea-ee8a-4ca4-894e-db77e160355e";
const LEAD = "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f";

beforeEach(() => writeAudit.mockClear());

describe("nudgeTiming", () => {
  const settings = (value: unknown) => fakeSupabase({ tenant_features: { data: value === undefined ? [] : [{ settings: value }], error: null } }).client;

  it("is 2 h and 23 h, then nurture at 48 h, unless the business set its own (a test can use minutes)", async () => {
    await expect(nudgeTiming(TENANT, settings(undefined))).resolves.toEqual(DEFAULT_NUDGE_TIMING);
    expect(DEFAULT_NUDGE_TIMING).toEqual({ offsetMinutes: [120, 1380], nurtureAfterMinutes: 2880 });
    await expect(nudgeTiming(TENANT, settings({ offset_minutes: [2, 5], nurture_after_minutes: 10 }))).resolves.toEqual({
      offsetMinutes: [2, 5],
      nurtureAfterMinutes: 10,
    });
  });

  it.each([
    ["out of order", { offset_minutes: [5, 2], nurture_after_minutes: 10 }],
    ["nurture before the second nudge", { offset_minutes: [2, 5], nurture_after_minutes: 4 }],
    ["one offset", { offset_minutes: [2], nurture_after_minutes: 10 }],
    ["zero minutes", { offset_minutes: [0, 5], nurture_after_minutes: 10 }],
    ["text", { offset_minutes: ["2", "5"], nurture_after_minutes: 10 }],
  ])("ignores a setting that is %s", async (_why, value) => {
    await expect(nudgeTiming(TENANT, settings(value))).resolves.toEqual(DEFAULT_NUDGE_TIMING);
  });
});

describe("loadNudgeState", () => {
  const tables = (over: { answered?: unknown[]; later?: unknown[]; leads?: unknown[]; mode?: string } = {}) => ({
    messages: [
      { data: [{ created_at: "2026-10-09T10:00:00+00:00", conversations: { mode: over.mode ?? "ai", contact_id: CONTACT } }], error: null },
      { data: over.later ?? [], error: null },
    ],
    audit_logs: { data: over.answered ?? [{ id: "a1" }], error: null },
    leads: { data: over.leads ?? [{ id: LEAD, stage: "engaged" }], error: null },
    contacts: { data: [{ name: " Asha " }], error: null },
  });

  it("reads the message, its answer, later messages, the open lead and the name, for this business only", async () => {
    const db = fakeSupabase(tables());
    await expect(loadNudgeState(TENANT, CONVERSATION, MESSAGE, db.client)).resolves.toEqual({
      messageAt: "2026-10-09T10:00:00.000Z",
      answered: true,
      repliedSince: false,
      mode: "ai",
      lead: { id: LEAD, stage: "engaged" },
      customerName: "Asha",
    });
    for (const table of ["messages", "audit_logs", "leads", "contacts"]) {
      expect(db.calls).toContainEqual({ table, method: "eq", args: ["tenant_id", TENANT] });
    }
    expect(db.calls).toContainEqual({ table: "messages", method: "gt", args: ["created_at", "2026-10-09T10:00:00+00:00"] });
    expect(db.calls).toContainEqual({ table: "audit_logs", method: "eq", args: ["entity_id", MESSAGE] });
    expect(db.calls).toContainEqual({ table: "leads", method: "not", args: ["stage", "in", "(won,lost)"] });
  });

  it("is null for a message this business doesn't have", async () => {
    await expect(loadNudgeState(TENANT, CONVERSATION, MESSAGE, fakeSupabase({ messages: { data: [], error: null } }).client)).resolves.toBeNull();
  });
});

describe("nudgeBlocker", () => {
  const state = (over: Partial<NudgeState> = {}): NudgeState => ({
    messageAt: "2026-10-09T10:00:00.000Z",
    answered: true,
    repliedSince: false,
    mode: "ai",
    lead: { id: LEAD, stage: "engaged" },
    customerName: "Asha",
    ...over,
  });

  it("lets a nudge go to a quiet, open lead the assistant answered", () => {
    for (const stage of ["new", "engaged", "qualified"]) expect(nudgeBlocker(state({ lead: { id: LEAD, stage } }))).toBeNull();
  });

  it.each([
    ["customer_replied", { repliedSince: true }],
    ["not_answered", { answered: false }],
    ["not_with_assistant", { mode: "human" }],
    ["not_with_assistant", { mode: "external" }],
    ["lead_not_open", { lead: null }],
    ["lead_not_open", { lead: { id: LEAD, stage: "booked" } }],
    ["lead_not_open", { lead: { id: LEAD, stage: "nurture" } }],
  ] as const)("stops with %s", (reason, over) => {
    expect(nudgeBlocker(state(over as Partial<NudgeState>))).toBe(reason);
  });
});

describe("nudgeMessage", () => {
  it("greets by name, or 'there', with the template's variable", () => {
    expect(nudgeMessage(1, "Asha")).toEqual({ text: "Hi Asha, just checking in. Do you have any other questions? I'm happy to help.", templateParams: ["Asha"] });
    expect(nudgeMessage(2, null)).toEqual({ text: "Hi there, if you'd still like help, just reply here and we'll pick up where we left off.", templateParams: ["there"] });
  });
});

describe("moveToNurture", () => {
  it("moves an open lead to nurture, for this business, and audits it", async () => {
    const db = fakeSupabase({ leads: { data: [{ id: LEAD }], error: null } });
    await expect(moveToNurture(TENANT, LEAD, db.client)).resolves.toBe(true);
    expect(db.calls).toContainEqual({ table: "leads", method: "update", args: [expect.objectContaining({ stage: "nurture" })] });
    expect(db.calls).toContainEqual({ table: "leads", method: "eq", args: ["tenant_id", TENANT] });
    expect(db.calls).toContainEqual({ table: "leads", method: "in", args: ["stage", ["new", "engaged", "qualified"]] });
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, actor: "system", action: "lead.stage_changed", entityId: LEAD }));
  });

  it("leaves a lead that moved on meanwhile alone", async () => {
    await expect(moveToNurture(TENANT, LEAD, fakeSupabase({ leads: { data: [], error: null } }).client)).resolves.toBe(false);
    expect(writeAudit).not.toHaveBeenCalled();
  });
});
