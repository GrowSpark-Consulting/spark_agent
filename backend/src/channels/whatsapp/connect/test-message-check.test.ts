import { describe, expect, it, vi } from "vitest";
import type { SendOutcome } from "../../../notify/send";
import { fakeTables, type Row } from "../../../test-support/fake-tables";
import { checkTestMessage, TEST_TEXT, type TestMessageDeps } from "./test-message-check";

// The sixth check: a test message to the owner's number, through notify.send (0 credits, free text). It never changes whether a number is active.

const A = "e0000000-0000-4000-8000-00000000000a";
const OWNER = "f1000000-0000-4000-8000-000000000001";
const ADMIN = "f1000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-10-12T09:00:00.000Z");
const SENT: SendOutcome = { status: "sent", messageId: "m", providerMsgId: "w", creditsCharged: 0, usedTemplate: false };

function world(memberships: Row[], outcome: SendOutcome | Error = SENT) {
  const t = fakeTables({ memberships });
  const sent: { tenantId: string; kind: string; payload: Record<string, unknown> }[] = [];
  const deps: TestMessageDeps = {
    db: t.db,
    now: () => NOW,
    send: vi.fn(async (tenantId, kind, payload) => {
      sent.push({ tenantId, kind, payload: { ...payload } });
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }),
  };
  return { ...t, deps, sent };
}
const owner = (phone: string | null): Row => ({ tenant_id: A, user_id: OWNER, role: "owner", whatsapp_phone: phone });
const admin = (phone: string | null): Row => ({ tenant_id: A, user_id: ADMIN, role: "admin", whatsapp_phone: phone });

describe("the test message check", () => {
  it("sends one test_message to the owner's number and passes when WhatsApp accepts it", async () => {
    const w = world([owner("+919812300001")]);
    const check = await checkTestMessage(A, ADMIN, w.deps);
    expect(check).toMatchObject({ key: "test_message_delivered", status: "pass", checked_at: NOW.toISOString() });
    expect(w.sent).toEqual([{ tenantId: A, kind: "test_message", payload: { to: "+919812300001", text: TEST_TEXT, actorId: ADMIN } }]);
  });

  it("uses the person connecting when the owner has no number saved", async () => {
    const w = world([owner(null), admin("+919812300002")]);
    await checkTestMessage(A, ADMIN, w.deps);
    expect(w.sent[0].payload.to).toBe("+919812300002");
  });

  it("for the platform team (admin:<id>) tries the owner's number only, and records no staff actor", async () => {
    const w = world([owner("+919812300001")]);
    await checkTestMessage(A, `admin:${ADMIN}`, w.deps);
    expect(w.sent[0].payload).toEqual({ to: "+919812300001", text: TEST_TEXT });
  });

  it("is skipped, and sends nothing, when nobody has a number saved", async () => {
    const w = world([owner(null)]);
    const check = await checkTestMessage(A, `admin:${ADMIN}`, w.deps);
    expect(check.status).toBe("skipped");
    expect(check.message).toContain("Team settings");
    expect(w.sent).toEqual([]);
  });

  it("is 'not verified' with what to do when WhatsApp only allows a template (the owner has not written in 24 hours)", async () => {
    const w = world([owner("+919812300001")], { status: "skipped", reason: "outside_window" });
    const check = await checkTestMessage(A, OWNER, w.deps);
    expect(check.status).toBe("not_verified");
    expect(check.message).toContain("24 hours");
  });

  it("a failure to send is a warning, never a fail, and says nothing the provider said", async () => {
    for (const outcome of [{ status: "failed", error: { code: "x", message: "secret provider text", retryable: true, outcomeUnknown: false } } as SendOutcome, new Error("boom secret")]) {
      const check = await checkTestMessage(A, OWNER, world([owner("+919812300001")], outcome).deps);
      expect(check.status).toBe("warn");
      expect(JSON.stringify(check)).not.toContain("secret");
    }
  });

  it("reads the business's own members only", async () => {
    const w = world([{ tenant_id: "other", user_id: "u", role: "owner", whatsapp_phone: "+919800000000" }]);
    await checkTestMessage(A, OWNER, w.deps);
    expect(w.calls.every((c) => c.filters.some((f) => f.column === "tenant_id" && f.value === A))).toBe(true);
  });
});
