import { z } from "zod";
import { alertLevel, loadCreditState, type CreditState } from "../billing/credit-alerts";
import { supabaseAdmin } from "../lib/supabase-admin";
import type { SendOutcome } from "../notify/send";
import { sendStaffAlert, staffAlertRecipients, type StaffAlert } from "../notify/staff-alerts";
import { inngest } from "./client";

// credits.spent (notify.send, after a charged message) → the owners hear when the business is down to a fifth of its
// plan's monthly credits, and again when it has none left (billing/credit-alerts.ts). A burst of spends is one check:
// the run waits for a minute of quiet (at most ten), then reads the balance as it is. Each alert is keyed by its level,
// the newest grant and the owner, so it goes once per grant whatever the retries and repeat runs. Owners with an alert
// number only; free (staff_alert, behind the staff_alerts switch). Auto top-up waits for Razorpay (Day 6).

const CreditsSpent = z.object({ tenantId: z.guid() });

type StepResult = { status: "sent" } | { status: "skipped"; reason: string } | { status: "failed"; code: string };

export interface CreditAlertDeps {
  state: (tenantId: string) => Promise<CreditState | null>;
  owners: (tenantId: string) => Promise<string[]>;
  alert: (tenantId: string, userId: string, alert: StaffAlert, idempotencyKey: string) => Promise<SendOutcome>;
}

const defaults = (): CreditAlertDeps => ({
  state: (tenantId) => loadCreditState(tenantId, supabaseAdmin()),
  owners: (tenantId) => staffAlertRecipients(tenantId, undefined, ["owner"]),
  alert: (tenantId, userId, alert, idempotencyKey) => sendStaffAlert(tenantId, userId, alert, undefined, { idempotencyKey }),
});

interface Step {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

export async function handleCreditsSpent({ event, step }: { event: { data: unknown }; step: Step }, deps: CreditAlertDeps = defaults()) {
  const { tenantId } = CreditsSpent.parse(event.data);
  const state = await step.run("balance", () => deps.state(tenantId));
  if (!state) return { skipped: "business_not_found" as const };
  const level = alertLevel(state.balance, state.monthlyCredits);
  if (!level || state.grantId === null) return { balance: state.balance, level: null };

  const alert: StaffAlert =
    level === "used_up" ? { kind: "credits_exhausted" } : { kind: "credits_low", credits: { left: state.balance, monthly: state.monthlyCredits } };
  const owners = await step.run("owners", () => deps.owners(tenantId));
  const results: ({ userId: string } & StepResult)[] = [];
  for (const userId of owners) {
    const result = await step.run(`alert-${userId}`, async (): Promise<StepResult> => {
      const outcome = await deps.alert(tenantId, userId, alert, `credit_alert:${level}:${state.grantId}:${userId}`);
      if (outcome.status === "sent") return { status: "sent" };
      if (outcome.status === "skipped") return { status: "skipped", reason: outcome.reason };
      // Throwing makes Inngest retry this step; never when WhatsApp may already have delivered it.
      if (outcome.error.retryable && !outcome.error.outcomeUnknown) throw new Error(`credit alert not sent (${outcome.error.code}), will retry`);
      return { status: "failed", code: outcome.error.code };
    });
    results.push({ userId, ...result });
  }
  return { balance: state.balance, level, results };
}

export const creditAlerts = inngest.createFunction(
  {
    id: "credit-alerts",
    triggers: [{ event: "credits.spent" }],
    debounce: { key: "event.data.tenantId", period: "1m", timeout: "10m" },
  },
  (ctx) =>
    handleCreditsSpent({
      event: ctx.event,
      step: { run: <T>(id: string, fn: () => Promise<T>) => ctx.step.run(id, fn) as unknown as Promise<T> },
    }),
);
