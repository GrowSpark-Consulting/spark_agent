import { z } from "zod";
import { checkConnectionHealth, dueConnections, healthDefaults, type DueConnection, type FailureAlert, type HealthResult } from "../channels/whatsapp/connect/health";
import { failureMessage, sendToAdmins, type AlertCounts } from "../channels/whatsapp/connect/health-alert";
import { serverEnv } from "../lib/env";
import { reportProblem } from "../lib/report";
import { send } from "../notify/send";
import { staffAlertRecipients } from "../notify/staff-alerts";
import { inngest } from "./client";

// connection-health (docs/handover.md, module 10, "Jobs"): once a day, at 01:30 UTC (7:00 in India), every active manual, Embedded Signup or assisted connection that has not been
// checked for 20 hours is checked again (channels/whatsapp/connect/health.ts): its token, quality rating and messaging limit. The sweep only lists
// them and starts one check each as an event, named by the connection and the India day, so a repeat sweep starts nothing twice; the checks run five
// at a time. A connection that has just failed is reported to the business's owners and admins (a staff_alert through notify.send) in a step of its
// own, keyed by the failure, so a retry never sends it twice. Reports hold counts and words; the number in a step's stored result is masked, and no token or secret is ever in one.

export const HEALTH_CHECK_EVENT = "whatsapp/connection.health_check";

const HealthCheckEvent = z.object({ tenantId: z.guid(), connectionId: z.guid() });

export interface HealthJobDeps {
  due: () => Promise<DueConnection[]>;
  check: (ids: DueConnection) => Promise<HealthResult>;
  alert: (tenantId: string, alert: FailureAlert) => Promise<AlertCounts>;
  /** Sends the failure to Sentry (lib/report.ts): ids and the reason only. */
  report: (ids: { tenantId: string; connectionId: string }, reason: FailureAlert["reason"]) => Promise<boolean>;
  now: () => Date;
}

const defaults = (): HealthJobDeps => ({
  due: () => dueConnections(healthDefaults()),
  check: (ids) => checkConnectionHealth(ids),
  alert: (tenantId, alert) =>
    sendToAdmins(tenantId, failureMessage({ phoneMasked: alert.phoneMasked, detail: alert.detail }, serverEnv().NEXT_PUBLIC_APP_URL), alert.key, {
      recipients: (id) => staffAlertRecipients(id),
      send: (id, kind, payload) => send(id, kind, payload),
    }),
  report: (ids, reason) =>
    reportProblem(`A WhatsApp number failed its health check (${reason})`, {
      kind: "connection_health",
      level: "warning",
      tags: { tenant: ids.tenantId, connection: ids.connectionId, reason },
      fingerprint: ["connection_health", reason],
      eventKey: `connection_health:${ids.connectionId}:${indiaDay(new Date())}`,
    }),
  now: () => new Date(),
});

interface Step {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
  sendEvent(id: string, payload: { id?: string; name: string; data: unknown }[]): Promise<unknown>;
}

/** The India calendar day, `2026-10-13`: what names a connection's check for the day. */
const indiaDay = (at: Date) => new Date(at.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);

export async function handleHealthSweep({ step }: { step: Pick<Step, "run" | "sendEvent"> }, deps: HealthJobDeps = defaults()) {
  const due = await step.run("due", () => deps.due());
  if (due.length === 0) return { due: 0 };
  const day = indiaDay(deps.now());
  await step.sendEvent(
    "fan-out",
    due.map((c) => ({ id: `connection_health:${c.connectionId}:${day}`, name: HEALTH_CHECK_EVENT, data: { tenantId: c.tenantId, connectionId: c.connectionId } })),
  );
  return { due: due.length };
}

export async function handleHealthCheck({ event, step }: { event: { data: unknown }; step: Pick<Step, "run"> }, deps: HealthJobDeps = defaults()) {
  const ids = HealthCheckEvent.parse(event.data);
  const result = await step.run("check", () => deps.check({ tenantId: ids.tenantId, connectionId: ids.connectionId }));
  if (result.status === "skipped") return { status: "skipped" as const, reason: result.reason };
  if (!result.failed) return { status: "checked" as const, overall: result.overall, failed: false as const };
  const alerts = await step.run("alert", () => deps.alert(ids.tenantId, result.alert));
  await step.run("report", () => deps.report(ids, result.alert.reason));
  return { status: "checked" as const, overall: result.overall, failed: true as const, alerts };
}

export const connectionHealth = inngest.createFunction({ id: "connection-health", triggers: [{ cron: "30 1 * * *" }] }, (ctx) =>
  handleHealthSweep({
    step: {
      run: <T>(id: string, fn: () => Promise<T>) => ctx.step.run(id, fn) as unknown as Promise<T>,
      sendEvent: (id, payload) => ctx.step.sendEvent(id, payload as never),
    },
  }),
);

export const connectionHealthCheck = inngest.createFunction(
  { id: "connection-health-check", triggers: [{ event: HEALTH_CHECK_EVENT }], concurrency: { limit: 5 }, retries: 2 },
  (ctx) => handleHealthCheck({ event: ctx.event, step: { run: <T>(id: string, fn: () => Promise<T>) => ctx.step.run(id, fn) as unknown as Promise<T> } }),
);
