import { claimDeliveries, deliverDeps, deliverWebhook, hasPendingDeliveries, type DeliverDeps } from "../outbound-webhooks/deliver";
import { inngest } from "./client";

// outbound-webhooks (0050, backend/src/outbound-webhooks): every hour at :05, one run at a time, the due deliveries are claimed
// for this run (up to 50) and sent side by side, one step each. The claim is the replay guard: Inngest retrying a step
// records nothing twice (record_webhook_attempt takes only the run's own claim, once), and another run never takes a
// delivery this one holds. A step that fails after the POST is retried and may send again: receivers dedupe on the
// event id.

interface Step {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
}

export async function handleOutboundWebhooks({ runId, step }: { runId: string; step: Step }, deps: () => DeliverDeps = deliverDeps) {
  // The usual hour: nothing waiting, so the run ends before any step and costs Inngest one execution. While a run is
  // under way its claimed deliveries stay pending until each is recorded, so a replay never stops one half-way.
  if (!(await hasPendingDeliveries(deps()))) return { claimed: 0, delivered: 0, retrying: 0, failed: 0, dropped: 0 };
  const due = await step.run("claim", () => claimDeliveries(runId, deps()));
  const outcomes = await Promise.all(due.map((delivery) => step.run(`deliver-${delivery.id}`, () => deliverWebhook(delivery, runId, deps()))));
  const count = (status: string) => outcomes.filter((o) => o === status).length;
  return { claimed: due.length, delivered: count("delivered"), retrying: count("pending"), failed: count("failed"), dropped: count("dropped") };
}

const stepOf = (ctx: { step: { run: (id: string, fn: () => Promise<unknown>) => unknown } }): Step => ({
  run: <T>(id: string, fn: () => Promise<T>) => ctx.step.run(id, fn) as unknown as Promise<T>,
});

export const outboundWebhooks = inngest.createFunction(
  { id: "outbound-webhooks", triggers: [{ cron: "5 * * * *" }], concurrency: { limit: 1 } },
  (ctx) => handleOutboundWebhooks({ runId: ctx.runId, step: stepOf(ctx) }),
);
