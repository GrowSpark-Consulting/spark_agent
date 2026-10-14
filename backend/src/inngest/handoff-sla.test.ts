import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SendOutcome } from "../notify/send";
import { fakeSupabase } from "../test-support/fake-supabase";
import { DEFAULT_SLA_MINUTES, handleHandoffSla, isPickedUp, slaMinutes, type HandoffSlaDeps } from "./handoff-sla";

const TENANT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const HANDOFF = "4a2b1b4c-5d6e-4f70-8a91-b2c3d4e5f602";
const CONVERSATION = "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f601";
const STAFF = "16fd2706-8baf-433b-82eb-8c7fada847da";
const event = { data: { tenantId: TENANT, handoffId: HANDOFF, conversationId: CONVERSATION } };

describe("slaMinutes", () => {
  it("is 15 minutes unless the business set its own, read for this business's handoff settings", async () => {
    const db = fakeSupabase({ tenant_features: { data: [], error: null } });
    await expect(slaMinutes(TENANT, db.client)).resolves.toBe(DEFAULT_SLA_MINUTES);
    expect(db.calls).toContainEqual({ table: "tenant_features", method: "eq", args: ["tenant_id", TENANT] });
    expect(db.calls).toContainEqual({ table: "tenant_features", method: "eq", args: ["feature_key", "handoff_triggers"] });
    await expect(slaMinutes(TENANT, fakeSupabase({ tenant_features: { data: [{ settings: { sla_minutes: 5 } }], error: null } }).client)).resolves.toBe(5);
    for (const bad of [{ sla_minutes: 0 }, { sla_minutes: 1441 }, { sla_minutes: 2.5 }, { sla_minutes: "5" }, {}, null]) {
      await expect(slaMinutes(TENANT, fakeSupabase({ tenant_features: { data: [{ settings: bad }], error: null } }).client)).resolves.toBe(DEFAULT_SLA_MINUTES);
    }
  });
});

describe("isPickedUp", () => {
  const handoff = (over: Record<string, unknown> = {}) => ({ picked_at: null, resolved_at: null, assigned_user_id: null, ...over });
  const chat = (over: Record<string, unknown> = {}) => ({ mode: "human", assigned_user_id: null, ...over });
  const check = (h: unknown[], c: unknown[]) =>
    isPickedUp(TENANT, HANDOFF, CONVERSATION, fakeSupabase({ handoffs: { data: h, error: null }, conversations: { data: c, error: null } }).client);

  it("is false while the chat waits for a person and nobody has it", async () => {
    await expect(check([handoff()], [chat()])).resolves.toBe(false);
  });

  it.each([
    ["the handoff was picked up", [handoff({ picked_at: "2026-10-09T10:00:00Z" })], [chat()]],
    ["the handoff was resolved", [handoff({ resolved_at: "2026-10-09T10:00:00Z" })], [chat()]],
    ["the handoff has a person", [handoff({ assigned_user_id: STAFF })], [chat()]],
    ["a staff member took the chat over", [handoff()], [chat({ assigned_user_id: STAFF })]],
    ["the chat went back to the AI", [handoff()], [chat({ mode: "ai" })]],
    ["the chat is handled from the business's own number", [handoff()], [chat({ mode: "external" })]],
  ])("is true when %s", async (_why, h, c) => {
    await expect(check(h, c)).resolves.toBe(true);
  });

  it("is null when the handoff or the chat is gone, and reads both for this business only", async () => {
    await expect(check([], [chat()])).resolves.toBeNull();
    await expect(check([handoff()], [])).resolves.toBeNull();
    const db = fakeSupabase({ handoffs: { data: [handoff()], error: null }, conversations: { data: [chat()], error: null } });
    await isPickedUp(TENANT, HANDOFF, CONVERSATION, db.client);
    expect(db.calls).toContainEqual({ table: "handoffs", method: "eq", args: ["tenant_id", TENANT] });
    expect(db.calls).toContainEqual({ table: "conversations", method: "eq", args: ["tenant_id", TENANT] });
  });
});

describe("handleHandoffSla", () => {
  let journal: string[];
  let pickedUp: boolean | null;
  const alert = vi.fn<HandoffSlaDeps["alert"]>();
  const sent: SendOutcome = { status: "sent", messageId: "m", providerMsgId: "wamid", creditsCharged: 0, usedTemplate: false };
  const step = {
    run: async <T>(id: string, fn: () => Promise<T>) => (journal.push(id), fn()),
    sleep: async (id: string, duration: string) => {
      journal.push(`${id}:${duration}`);
    },
  };
  const deps = (): HandoffSlaDeps => ({
    slaMinutes: async () => 15,
    pickedUp: async () => pickedUp,
    owners: async () => ["owner-1", "owner-2"],
    alert,
  });

  beforeEach(() => {
    journal = [];
    pickedUp = false;
    alert.mockReset().mockResolvedValue(sent);
  });

  it("waits the SLA, then alerts each owner that the customer is still waiting", async () => {
    await expect(handleHandoffSla({ event, step }, deps())).resolves.toEqual({
      minutes: 15,
      results: [
        { userId: "owner-1", status: "sent" },
        { userId: "owner-2", status: "sent" },
      ],
    });
    expect(journal).toEqual(["sla", "wait-sla:15m", "check", "owners", "escalate-owner-1", "escalate-owner-2"]);
    expect(alert).toHaveBeenCalledWith(TENANT, "owner-1", { kind: "handoff_waiting", conversationId: CONVERSATION, waitedMinutes: 15 }, `handoff_sla:${HANDOFF}:owner-1`);
  });

  // Exit test 1 (Day 7; inngest/replay-coverage.test.ts): notify.send keeps one message per key (notify/send.test.ts).
  it("replay: the same event twice escalates to each owner under the same key, so each hears once", async () => {
    await handleHandoffSla({ event, step }, deps());
    const first = alert.mock.calls.map((c) => c[3]);
    alert.mockClear();
    await handleHandoffSla({ event, step }, deps());
    expect(alert.mock.calls.map((c) => c[3])).toEqual(first);
    expect(first).toEqual([`handoff_sla:${HANDOFF}:owner-1`, `handoff_sla:${HANDOFF}:owner-2`]);
  });

  it("does nothing once someone has the chat, or when it is gone", async () => {
    pickedUp = true;
    await expect(handleHandoffSla({ event, step }, deps())).resolves.toEqual({ skipped: "picked_up" });
    pickedUp = null;
    await expect(handleHandoffSla({ event, step }, deps())).resolves.toEqual({ skipped: "handoff_not_found" });
    expect(alert).not.toHaveBeenCalled();
  });

  it("retries a retryable failure, but never one WhatsApp may have delivered", async () => {
    alert.mockResolvedValueOnce({ status: "failed", error: { code: "rate_limited", message: "", retryable: true, outcomeUnknown: false } });
    await expect(handleHandoffSla({ event, step }, deps())).rejects.toThrow("will retry");
    alert.mockReset().mockResolvedValue({ status: "failed", error: { code: "upstream_failed", message: "", retryable: true, outcomeUnknown: true } });
    await expect(handleHandoffSla({ event, step }, deps())).resolves.toMatchObject({ results: [{ status: "failed", code: "upstream_failed" }, { status: "failed" }] });
  });

  it("refuses an event without ids", async () => {
    await expect(handleHandoffSla({ event: { data: { tenantId: TENANT } }, step }, deps())).rejects.toMatchObject({ name: "ZodError" });
  });
});
