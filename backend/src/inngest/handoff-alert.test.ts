import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SendOutcome } from "../notify/send";
import { alertKindFor, handleHandoffOpened, type HandoffAlertDeps } from "./handoff-alert";

const TENANT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const HANDOFF = "4a2b1b4c-5d6e-4f70-8a91-b2c3d4e5f602";
const CONVERSATION = "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f601";
const event = { data: { tenantId: TENANT, handoffId: HANDOFF, conversationId: CONVERSATION } };

let handoff: { trigger: string; priority?: string; resolved_at: string | null } | null;
const stepIds: string[] = [];
const step = { run: async <T>(id: string, fn: () => Promise<T>) => (stepIds.push(id), fn()) };
const alert = vi.fn<HandoffAlertDeps["alert"]>();
const sent: SendOutcome = { status: "sent", messageId: "m", providerMsgId: "wamid", creditsCharged: 0, usedTemplate: false };

function deps(): HandoffAlertDeps {
  const b: Record<string, unknown> = {};
  for (const op of ["select", "eq"]) b[op] = () => b;
  b.maybeSingle = async () => ({ data: handoff, error: null });
  return { db: { from: () => b } as unknown as SupabaseClient, recipients: async () => ["owner-1", "admin-2"], alert };
}

beforeEach(() => {
  handoff = { trigger: "asked_human", priority: "normal", resolved_at: null };
  stepIds.length = 0;
  alert.mockReset().mockResolvedValue(sent);
});

describe("alertKindFor", () => {
  it("maps the handoff trigger to the alert", () => {
    expect(alertKindFor("credits_exhausted")).toBe("credits_exhausted");
    expect(alertKindFor("stuck")).toBe("setup_problem");
    expect(alertKindFor("opt_out")).toBe("opted_out");
    for (const trigger of ["kb_gap", "asked_human", "complaint"]) expect(alertKindFor(trigger)).toBe("handoff_opened");
  });
});

describe("handleHandoffOpened", () => {
  it("alerts every recipient, one step each", async () => {
    await expect(handleHandoffOpened({ event, step }, deps())).resolves.toEqual({
      kind: "handoff_opened",
      results: [
        { userId: "owner-1", status: "sent" },
        { userId: "admin-2", status: "sent" },
      ],
    });
    expect(alert).toHaveBeenCalledWith(TENANT, "owner-1", { kind: "handoff_opened", conversationId: CONVERSATION, handoffId: HANDOFF, priority: "normal" });
    expect(stepIds).toEqual(["load-handoff", "recipients", "alert-owner-1", "alert-admin-2"]);
  });

  it("sends the credits alert for a credits handoff", async () => {
    handoff = { trigger: "credits_exhausted", priority: "high", resolved_at: null };
    await handleHandoffOpened({ event, step }, deps());
    expect(alert).toHaveBeenCalledWith(TENANT, "owner-1", { kind: "credits_exhausted", conversationId: CONVERSATION, handoffId: HANDOFF, priority: "high" });
  });

  it("passes the handoff and its priority, so each alert carries the member's take-over links and says when it is urgent", async () => {
    handoff = { trigger: "negotiation", priority: "high", resolved_at: null };
    await handleHandoffOpened({ event, step }, deps());
    expect(alert).toHaveBeenCalledWith(TENANT, "admin-2", { kind: "handoff_opened", conversationId: CONVERSATION, handoffId: HANDOFF, priority: "high" });
  });

  it("does nothing for a handoff that is gone or already resolved", async () => {
    handoff = null;
    await expect(handleHandoffOpened({ event, step }, deps())).resolves.toEqual({ skipped: "handoff_not_found" });
    handoff = { trigger: "kb_gap", resolved_at: "2026-10-09T05:00:00Z" };
    await expect(handleHandoffOpened({ event, step }, deps())).resolves.toEqual({ skipped: "already_resolved" });
    expect(alert).not.toHaveBeenCalled();
  });

  it("retries a retryable failure, but never one WhatsApp may have delivered", async () => {
    alert.mockResolvedValueOnce({ status: "failed", error: { code: "rate_limited", message: "", retryable: true, outcomeUnknown: false } });
    await expect(handleHandoffOpened({ event, step }, deps())).rejects.toThrow("will retry");
    alert.mockReset().mockResolvedValue({ status: "failed", error: { code: "upstream_failed", message: "", retryable: true, outcomeUnknown: true } });
    await expect(handleHandoffOpened({ event, step }, deps())).resolves.toMatchObject({
      results: [{ userId: "owner-1", status: "failed", code: "upstream_failed" }, { userId: "admin-2", status: "failed" }],
    });
  });

  it("refuses an event without ids", async () => {
    await expect(handleHandoffOpened({ event: { data: { tenantId: TENANT } }, step }, deps())).rejects.toMatchObject({ name: "ZodError" });
  });
});
