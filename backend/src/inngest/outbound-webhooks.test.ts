import { beforeEach, describe, expect, it, vi } from "vitest";

const claimDeliveries = vi.fn();
const deliverWebhook = vi.fn();
const hasPendingDeliveries = vi.fn();
vi.mock("../outbound-webhooks/deliver", () => ({
  claimDeliveries: (...args: unknown[]) => claimDeliveries(...args),
  deliverWebhook: (...args: unknown[]) => deliverWebhook(...args),
  hasPendingDeliveries: (...args: unknown[]) => hasPendingDeliveries(...args),
  deliverDeps: () => ({ fake: true }),
}));

const { handleOutboundWebhooks } = await import("./outbound-webhooks");

const RUN = "01JRUNOUTBOUND";
const delivery = (id: string) => ({ id, tenant_id: "t1", event: "lead.created", entity_id: "l1", occurred_at: "2026-10-15T05:00:00Z", attempts: 0 });

// Inngest's step: each id runs once per run; a replayed step answers what it answered the first time.
function memoStep() {
  const done = new Map<string, unknown>();
  const ids: string[] = [];
  return {
    ids,
    run: async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
      ids.push(id);
      if (!done.has(id)) done.set(id, await fn());
      return done.get(id) as T;
    },
  };
}

beforeEach(() => {
  hasPendingDeliveries.mockReset().mockResolvedValue(true);
  claimDeliveries.mockReset().mockResolvedValue([delivery("d1"), delivery("d2"), delivery("d3")]);
  deliverWebhook.mockReset().mockImplementation(async (d: { id: string }) => ({ d1: "delivered", d2: "pending", d3: "dropped" })[d.id]);
});

describe("outbound-webhooks", () => {
  it("claims for this run, then delivers each claimed event in its own step, with the run id", async () => {
    const step = memoStep();
    await expect(handleOutboundWebhooks({ runId: RUN, step })).resolves.toEqual({ claimed: 3, delivered: 1, retrying: 1, failed: 0, dropped: 1 });
    expect(step.ids).toEqual(["claim", "deliver-d1", "deliver-d2", "deliver-d3"]);
    expect(claimDeliveries).toHaveBeenCalledWith(RUN, { fake: true });
    expect(deliverWebhook.mock.calls.map(([d, run]) => [d.id, run])).toEqual([["d1", RUN], ["d2", RUN], ["d3", RUN]]);
  });

  it("an hour with nothing pending ends before any step: one Inngest execution", async () => {
    hasPendingDeliveries.mockResolvedValue(false);
    const step = memoStep();
    await expect(handleOutboundWebhooks({ runId: RUN, step })).resolves.toEqual({ claimed: 0, delivered: 0, retrying: 0, failed: 0, dropped: 0 });
    expect(step.ids).toEqual([]);
    expect(claimDeliveries).not.toHaveBeenCalled();
  });

  it("does nothing more when nothing is due", async () => {
    claimDeliveries.mockResolvedValue([]);
    const step = memoStep();
    await expect(handleOutboundWebhooks({ runId: RUN, step })).resolves.toEqual({ claimed: 0, delivered: 0, retrying: 0, failed: 0, dropped: 0 });
    expect(step.ids).toEqual(["claim"]);
  });

  it("replay: the same run replayed claims nothing new and sends nothing again", async () => {
    const step = memoStep();
    await handleOutboundWebhooks({ runId: RUN, step });
    await handleOutboundWebhooks({ runId: RUN, step });
    expect(claimDeliveries).toHaveBeenCalledTimes(1);
    expect(deliverWebhook).toHaveBeenCalledTimes(3);
  });
});
