import { agendaMessage, isAgendaTime, liveTenants, todaysBookings, type AgendaItem, type AgendaTenant } from "../booking/daily-agenda";
import { isEnabled } from "../features/is-enabled";
import { serverEnv } from "../lib/env";
import { supabaseAdmin } from "../lib/supabase-admin";
import { send, type NotifyPayload, type SendOutcome } from "../notify/send";
import { staffAlertRecipients } from "../notify/staff-alerts";
import { inngest } from "./client";

// Every 15 minutes: the businesses where it is now the quarter hour after 8:00 get their day's bookings, sent to each
// owner with an alert number (daily_agenda: free; the daily_agenda toggle and plan, Growth and Pro, are checked first).
// A day without bookings sends nothing. The key `daily_agenda:<business>:<owner>:<local date>` keeps it to one a day,
// whatever retries or overlapping runs do.

type StepResult = { status: "sent" } | { status: "skipped"; reason: string } | { status: "failed"; code: string };

export interface DailyAgendaDeps {
  tenants: () => Promise<AgendaTenant[]>;
  enabled: (tenantId: string) => Promise<boolean>;
  bookings: (tenant: AgendaTenant, now: Date) => Promise<{ date: string; items: AgendaItem[] }>;
  owners: (tenantId: string) => Promise<string[]>;
  send: (tenantId: string, kind: "daily_agenda", payload: NotifyPayload) => Promise<SendOutcome>;
  appUrl: () => string;
  now: () => Date;
}

const defaults = (): DailyAgendaDeps => ({
  tenants: () => liveTenants(supabaseAdmin()),
  enabled: (tenantId) => isEnabled(tenantId, "daily_agenda"),
  bookings: (tenant, now) => todaysBookings(tenant, now, supabaseAdmin()),
  owners: (tenantId) => staffAlertRecipients(tenantId, undefined, ["owner"]),
  send: (tenantId, kind, payload) => send(tenantId, kind, payload),
  appUrl: () => serverEnv().NEXT_PUBLIC_APP_URL,
  now: () => new Date(),
});

interface Step {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

function settle(outcome: SendOutcome): StepResult {
  if (outcome.status === "sent") return { status: "sent" };
  if (outcome.status === "skipped") return { status: "skipped", reason: outcome.reason };
  if (outcome.error.retryable && !outcome.error.outcomeUnknown) throw new Error(`agenda not sent (${outcome.error.code}), will retry`);
  return { status: "failed", code: outcome.error.code };
}

export async function handleDailyAgenda({ step }: { step: Step }, deps: DailyAgendaDeps = defaults()) {
  const due = await step.run("due", async () => {
    const now = deps.now();
    return { at: now.toISOString(), tenants: (await deps.tenants()).filter((t) => isAgendaTime(t.timeZone, now)) };
  });

  const results: { tenantId: string; sent?: ({ userId: string } & StepResult)[]; skipped?: string }[] = [];
  for (const tenant of due.tenants) {
    // One step per business, so a retry re-sends only to what failed; the key stops repeats.
    const result = await step.run(`agenda-${tenant.id}`, async () => {
      if (!(await deps.enabled(tenant.id))) return { skipped: "feature_off" };
      const { date, items } = await deps.bookings(tenant, new Date(due.at));
      if (items.length === 0) return { skipped: "no_bookings" };
      const message = agendaMessage(tenant.name, items, deps.appUrl());
      const sent: ({ userId: string } & StepResult)[] = [];
      for (const userId of await deps.owners(tenant.id)) {
        const outcome = await deps.send(tenant.id, "daily_agenda", { staffUserId: userId, ...message, idempotencyKey: `daily_agenda:${tenant.id}:${userId}:${date}` });
        sent.push({ userId, ...settle(outcome) });
      }
      return { sent };
    });
    results.push({ tenantId: tenant.id, ...result });
  }
  return { due: due.tenants.length, results };
}

export const dailyAgenda = inngest.createFunction({ id: "daily-agenda", triggers: [{ cron: "*/15 * * * *" }] }, (ctx) =>
  handleDailyAgenda({ step: { run: <T>(id: string, fn: () => Promise<T>) => ctx.step.run(id, fn) as unknown as Promise<T> } }),
);
