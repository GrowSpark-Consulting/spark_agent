import { chargeDueRenewals, grantAnnualMonths, lapseOverdue, renewalDeps, resolvePendingRenewals, sendRenewalNotices, type RenewalDeps } from "../billing/renewals";
import { inngest } from "./client";

// billing-renewals (decision 20; billing/renewals.ts): once a day at 06:00 in India, outside NPCI's busy hours for UPI
// debits. Each step is its own Inngest step, so a retry repeats only the step that failed, and every step is safe to
// repeat: the database decides what is due, and each payment applies once.

interface Step {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

export async function handleBillingRenewals({ step }: { step: Step }, deps: () => RenewalDeps = renewalDeps) {
  const notices = await step.run("notices", () => sendRenewalNotices(deps()));
  const charges = await step.run("charges", () => chargeDueRenewals(deps()));
  const pending = await step.run("pending", () => resolvePendingRenewals(deps()));
  const annual = await step.run("annual-months", () => grantAnnualMonths(deps()));
  const lapsed = await step.run("lapse", () => lapseOverdue(deps()));
  return { notices, charges, pending, annual, lapsed };
}

export const billingRenewals = inngest.createFunction({ id: "billing-renewals", triggers: [{ cron: "TZ=Asia/Kolkata 0 6 * * *" }] }, (ctx) =>
  handleBillingRenewals({ step: { run: <T>(id: string, fn: () => Promise<T>) => ctx.step.run(id, fn) as unknown as Promise<T> } }),
);
