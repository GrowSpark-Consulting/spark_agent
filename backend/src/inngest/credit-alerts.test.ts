import { describe, expect, it, vi } from "vitest";
import type { CreditState } from "../billing/credit-alerts";
import type { SendOutcome } from "../notify/send";
import type { StaffAlert } from "../notify/staff-alerts";
import { handleCreditsSpent, type CreditAlertDeps } from "./credit-alerts";

const TENANT = "4b5c6d7e-8f90-4a1b-8c2d-3e4f5a6b7c8d";
const OWNER_A = "1a1a1a1a-2b2b-4c3c-8d4d-5e5e5e5e5e5e";
const OWNER_B = "6f6f6f6f-7a7a-4b8b-9c9c-0d0d0d0d0d0d";

const step = { run: <T>(_id: string, fn: () => Promise<T>) => fn() };
const event = { data: { tenantId: TENANT, amount: 1, reason: "ai_reply", messageId: "m-1" } };

function deps(state: CreditState | null, outcome: SendOutcome = { status: "sent", messageId: "m", providerMsgId: "w", creditsCharged: 0, usedTemplate: false }) {
  const alert = vi.fn<(tenantId: string, userId: string, alert: StaffAlert, key: string) => Promise<SendOutcome>>(async () => outcome);
  const owners = vi.fn(async () => [OWNER_A, OWNER_B]);
  const d: CreditAlertDeps = { state: async () => state, owners, alert };
  return { d, alert, owners };
}

describe("credit-alerts", () => {
  it("says nothing while the balance is above a fifth of the plan's credits", async () => {
    const { d, alert, owners } = deps({ balance: 900, monthlyCredits: 1500, grantId: 7 });
    expect(await handleCreditsSpent({ event, step }, d)).toEqual({ balance: 900, level: null });
    expect(owners).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it("tells each owner when 80% is used, once per grant", async () => {
    const { d, alert } = deps({ balance: 280, monthlyCredits: 1500, grantId: 7 });
    const result = await handleCreditsSpent({ event, step }, d);
    expect(result).toMatchObject({ level: "low", results: [{ userId: OWNER_A, status: "sent" }, { userId: OWNER_B, status: "sent" }] });
    expect(alert).toHaveBeenCalledWith(TENANT, OWNER_A, { kind: "credits_low", credits: { left: 280, monthly: 1500 } }, `credit_alert:low:7:${OWNER_A}`);
    expect(alert).toHaveBeenCalledWith(TENANT, OWNER_B, { kind: "credits_low", credits: { left: 280, monthly: 1500 } }, `credit_alert:low:7:${OWNER_B}`);
  });

  // Exit test 1 (Day 7; inngest/replay-coverage.test.ts): notify.send keeps one message per key (notify/send.test.ts).
  it("replay: the same event twice alerts each owner under the same key (level, grant, owner), so each hears once", async () => {
    const { d, alert } = deps({ balance: 280, monthlyCredits: 1500, grantId: 7 });
    await handleCreditsSpent({ event, step }, d);
    await handleCreditsSpent({ event, step }, d);
    expect(alert.mock.calls.map((x) => x[3])).toEqual([`credit_alert:low:7:${OWNER_A}`, `credit_alert:low:7:${OWNER_B}`, `credit_alert:low:7:${OWNER_A}`, `credit_alert:low:7:${OWNER_B}`]);
  });

  it("tells them the credits are gone at 100%", async () => {
    const { d, alert } = deps({ balance: 0, monthlyCredits: 1500, grantId: 9 });
    await handleCreditsSpent({ event, step }, d);
    expect(alert).toHaveBeenCalledWith(TENANT, OWNER_A, { kind: "credits_exhausted" }, `credit_alert:used_up:9:${OWNER_A}`);
  });

  it("does nothing for a business that never had credits, or no longer exists", async () => {
    expect(await handleCreditsSpent({ event, step }, deps({ balance: 0, monthlyCredits: 300, grantId: null }).d)).toMatchObject({ level: null });
    expect(await handleCreditsSpent({ event, step }, deps(null).d)).toEqual({ skipped: "business_not_found" });
  });

  it("retries a send that may work later, never one WhatsApp may have delivered", async () => {
    const retryable = deps({ balance: 10, monthlyCredits: 300, grantId: 1 }, { status: "failed", error: { code: "rate_limited", message: "", retryable: true, outcomeUnknown: false } });
    await expect(handleCreditsSpent({ event, step }, retryable.d)).rejects.toThrow("credit alert not sent (rate_limited), will retry");
    const unknown = deps({ balance: 10, monthlyCredits: 300, grantId: 1 }, { status: "failed", error: { code: "upstream_failed", message: "", retryable: true, outcomeUnknown: true } });
    expect(await handleCreditsSpent({ event, step }, unknown.d)).toMatchObject({ results: [{ status: "failed", code: "upstream_failed" }, { status: "failed" }] });
  });

  it("keeps a skipped alert's reason (alerts switched off, no alert number)", async () => {
    const { d } = deps({ balance: 10, monthlyCredits: 300, grantId: 1 }, { status: "skipped", reason: "feature_off" });
    expect(await handleCreditsSpent({ event, step }, d)).toMatchObject({ results: [{ status: "skipped", reason: "feature_off" }, { status: "skipped" }] });
  });
});
