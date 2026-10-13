import { expiringConnections, warnExpiring, type ExpiringConnection } from "../channels/whatsapp/connect/token-expiry";
import type { AlertCounts } from "../channels/whatsapp/connect/health-alert";
import { serverEnv } from "../lib/env";
import { supabaseAdmin } from "../lib/supabase-admin";
import { send } from "../notify/send";
import { staffAlertRecipients } from "../notify/staff-alerts";
import { inngest } from "./client";

// token-expiry (docs/handover.md, module 10, "Jobs"): once a day, at 04:00 UTC (9:30 in India), the owners and admins of every active manual, Embedded Signup or assisted connection
// whose token runs out within 7 days are warned (a staff_alert through notify.send, free, behind the staff_alerts switch). One step per connection, so a
// retry repeats only what failed; the key `token_expiring:<connection>:<expiry date>:<person>` keeps it to one warning per expiry date, whatever retries
// or repeat runs do. The date comes from the daily health check (connection-health), which reads it from Meta.

export interface TokenExpiryDeps {
  due: () => Promise<ExpiringConnection[]>;
  warn: (connection: ExpiringConnection) => Promise<AlertCounts>;
}

const defaults = (): TokenExpiryDeps => ({
  due: () => expiringConnections({ db: supabaseAdmin(), now: () => new Date() }),
  warn: (connection) =>
    warnExpiring(connection, { appUrl: () => serverEnv().NEXT_PUBLIC_APP_URL, recipients: (id) => staffAlertRecipients(id), send: (id, kind, payload) => send(id, kind, payload) }),
});

interface Step {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

export async function handleTokenExpiry({ step }: { step: Step }, deps: TokenExpiryDeps = defaults()) {
  // A step's result is stored as JSON, so the date goes through the step as text.
  const due = await step.run("due", async () => (await deps.due()).map((c) => ({ ...c, expiresAt: c.expiresAt.toISOString() })));
  const total: AlertCounts = { recipients: 0, sent: 0, skipped: 0, failed: 0 };
  for (const connection of due) {
    const counts = await step.run(`warn-${connection.connectionId}`, () => deps.warn({ ...connection, expiresAt: new Date(connection.expiresAt) }));
    total.recipients += counts.recipients;
    total.sent += counts.sent;
    total.skipped += counts.skipped;
    total.failed += counts.failed;
  }
  return { due: due.length, warned: total };
}

export const tokenExpiry = inngest.createFunction({ id: "token-expiry", triggers: [{ cron: "0 4 * * *" }] }, (ctx) =>
  handleTokenExpiry({ step: { run: <T>(id: string, fn: () => Promise<T>) => ctx.step.run(id, fn) as unknown as Promise<T> } }),
);
