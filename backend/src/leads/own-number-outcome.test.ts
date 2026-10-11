import { beforeEach, describe, expect, it, vi } from "vitest";
import { Interactive } from "../notify/interactive";
import { fakeDb } from "../test-support/fake-db";

const writeAudit = vi.fn(async () => {});
vi.mock("../lib/audit", () => ({ writeAudit }));

const { DEFAULT_OUTCOME_AFTER_MINUTES, loadOwnNumberHandoff, outcomeButtons, outcomeDelay, parseOutcomeButton, recordHandoffOutcome } = await import("./own-number-outcome");

const TENANT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const HANDOFF = "4a2b1b4c-5d6e-4f70-8a91-b2c3d4e5f602";
const CONVERSATION = "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f601";
const CONTACT = "6fa459ea-ee8a-4ca4-894e-db77e160355e";
const STAFF = "16fd2706-8baf-433b-82eb-8c7fada847da";

beforeEach(() => writeAudit.mockClear());

describe("outcomeDelay", () => {
  it("is 4 hours unless the business set minutes", async () => {
    await expect(outcomeDelay(TENANT, fakeDb({ tenant_features: { data: [], error: null } }).client)).resolves.toBe(DEFAULT_OUTCOME_AFTER_MINUTES);
    expect(DEFAULT_OUTCOME_AFTER_MINUTES).toBe(240);
    const db = fakeDb({ tenant_features: { data: [{ settings: { outcome_after_minutes: 2 } }], error: null } });
    await expect(outcomeDelay(TENANT, db.client)).resolves.toBe(2);
    expect(db.calls).toContainEqual({ table: "tenant_features", method: "eq", args: ["feature_key", "handoff_own_number"] });
    await expect(outcomeDelay(TENANT, fakeDb({ tenant_features: { data: [{ settings: { outcome_after_minutes: 0 } }], error: null } }).client)).resolves.toBe(240);
  });
});

describe("loadOwnNumberHandoff", () => {
  it("reads the handoff's chat, staff member and answer, for this business only", async () => {
    const db = fakeDb({ handoffs: { data: [{ conversation_id: CONVERSATION, assigned_user_id: STAFF, outcome: null }], error: null } });
    await expect(loadOwnNumberHandoff(TENANT, HANDOFF, db.client)).resolves.toEqual({ conversationId: CONVERSATION, staffUserId: STAFF, outcome: null });
    expect(db.calls).toContainEqual({ table: "handoffs", method: "eq", args: ["tenant_id", TENANT] });
    await expect(loadOwnNumberHandoff(TENANT, HANDOFF, fakeDb({ handoffs: { data: [], error: null } }).client)).resolves.toBeNull();
  });
});

describe("outcomeButtons and parseOutcomeButton", () => {
  it("asks with three buttons that name the handoff, and reads the tap back", () => {
    const message = outcomeButtons(HANDOFF, "How did your WhatsApp chat with Asha go? Update the lead.");
    expect(message).toEqual({
      type: "buttons",
      body: "How did your WhatsApp chat with Asha go? Update the lead.",
      buttons: [
        { id: `outcome:${HANDOFF}:booked`, title: "Booked" },
        { id: `outcome:${HANDOFF}:follow_up`, title: "Follow-up" },
        { id: `outcome:${HANDOFF}:lost`, title: "Lost" },
      ],
    });
    expect(Interactive.safeParse(message).success).toBe(true);
    expect(parseOutcomeButton(`outcome:${HANDOFF}:follow_up`)).toEqual({ handoffId: HANDOFF, outcome: "follow_up" });
    for (const id of [`outcome:${HANDOFF}:won`, `booking:${HANDOFF}:confirm`, "outcome:nope:booked", ""]) expect(parseOutcomeButton(id)).toBeNull();
  });
});

describe("recordHandoffOutcome", () => {
  const tables = (saved: unknown[] = [{ conversation_id: CONVERSATION }]) => ({
    handoffs: { data: saved, error: null },
    conversations: { data: [{ contact_id: CONTACT }], error: null },
    leads: { data: null, error: null },
  });

  it("saves the first answer, resolves the handoff, moves the lead to booked, and audits it", async () => {
    const db = fakeDb(tables());
    await expect(recordHandoffOutcome(TENANT, HANDOFF, "booked", STAFF, db.client)).resolves.toBe(true);
    expect(db.calls).toContainEqual({ table: "handoffs", method: "update", args: [expect.objectContaining({ outcome: "booked" })] });
    expect(db.calls).toContainEqual({ table: "handoffs", method: "is", args: ["outcome", null] });
    expect(db.calls).toContainEqual({ table: "leads", method: "update", args: [expect.objectContaining({ stage: "booked" })] });
    expect(db.calls).toContainEqual({ table: "leads", method: "eq", args: ["contact_id", CONTACT] });
    expect(db.calls).toContainEqual({ table: "leads", method: "not", args: ["stage", "in", "(won,lost)"] });
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, actor: STAFF, action: "handoff.outcome_recorded", entityId: HANDOFF, diff: { outcome: "booked" } }));
  });

  it("leaves the lead's stage for a follow-up", async () => {
    const db = fakeDb(tables());
    await expect(recordHandoffOutcome(TENANT, HANDOFF, "follow_up", STAFF, db.client)).resolves.toBe(true);
    expect(db.calls.some((c) => c.table === "leads")).toBe(false);
  });

  it("ignores a second answer or another business's handoff", async () => {
    const db = fakeDb(tables([]));
    await expect(recordHandoffOutcome(TENANT, HANDOFF, "lost", STAFF, db.client)).resolves.toBe(false);
    expect(writeAudit).not.toHaveBeenCalled();
    await expect(recordHandoffOutcome(TENANT, HANDOFF, "won" as never, STAFF, db.client)).rejects.toThrow("unknown outcome");
  });
});
