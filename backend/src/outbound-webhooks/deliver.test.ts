import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret, webhookEndpointSecretContext } from "../lib/crypto";
import { claimDeliveries, deliverWebhook, type ClaimedDelivery, type DeliverDeps } from "./deliver";
import { verifySignature } from "./signing";
import type { Post } from "./transport";

const ENV = { ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") };
const TENANT = "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f601";
const SECRET = "whsec_the-business-secret-000000000000000000000";
const URL_ = "https://hooks.zapier.com/hooks/catch/123/s3cr3tpath/";
const NOW = new Date("2026-10-15T05:00:30Z");
const RUN = "01JRUN";

const contact = { id: "c1", name: "Ravi", phone: "+919812345678" };
const LEAD = { id: "l1", stage: "qualified", score: 82, temperature: "hot", fields: { budget: "80L" }, created_at: "2026-10-15T04:00:00+00:00", contact };
const BOOKING = {
  id: "b1",
  status: "confirmed",
  start_at: "2026-10-17T05:30:00+00:00",
  end_at: "2026-10-17T06:30:00+00:00",
  lead_id: "l1",
  service: { name: "Site visit" },
  resource: { name: "Asha" },
  lead: { contact },
};
const HANDOFF = { id: "h1", trigger: "asked_human", priority: "high", conversation_id: "cv1", conversation: { contact } };

const delivery = (over: Partial<ClaimedDelivery> = {}): ClaimedDelivery => ({
  id: "d0000000-0000-4000-8000-000000000001",
  tenant_id: TENANT,
  event: "lead.qualified",
  entity_id: "l1",
  occurred_at: "2026-10-15T05:00:00+00:00",
  attempts: 0,
  ...over,
});

function fakeDb(tables: Record<string, unknown>, recorded: unknown = "delivered") {
  const reads: { table: string; filters: Record<string, unknown> }[] = [];
  type Rpc = (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
  const rpc = vi.fn<Rpc>(async () => ({ data: recorded, error: null }));
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    const chain = {
      select: () => chain,
      eq: (column: string, value: unknown) => ((filters[column] = value), chain),
      maybeSingle: async () => {
        reads.push({ table, filters });
        return { data: tables[table] ?? null, error: null };
      },
    };
    return chain;
  };
  return { db: { from, rpc } as unknown as SupabaseClient, rpc, reads };
}

const endpointRow = (over: Record<string, unknown> = {}) => ({
  url: URL_,
  secret_enc: encryptSecret(SECRET, webhookEndpointSecretContext(TENANT), ENV),
  active: true,
  ...over,
});

let post: ReturnType<typeof vi.fn<Post>>;
const depsFor = (db: SupabaseClient, enabled = true): DeliverDeps => ({ db, post, enabled: async () => enabled, now: () => NOW, env: ENV });
const recordArgs = (rpc: ReturnType<typeof fakeDb>["rpc"]) => rpc.mock.calls.find(([name]) => name === "record_webhook_attempt")?.[1];

beforeEach(() => {
  post = vi.fn<Post>(async () => ({ status: 200 }));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("deliverWebhook", () => {
  it("posts the event, signed with the business's secret, and records the delivery", async () => {
    const { db, rpc, reads } = fakeDb({ webhook_endpoints: endpointRow(), leads: LEAD });
    await expect(deliverWebhook(delivery(), RUN, depsFor(db))).resolves.toBe("delivered");

    const [url, raw, headers] = post.mock.calls[0];
    expect(url).toBe(URL_);
    expect(JSON.parse(raw)).toEqual({
      id: "d0000000-0000-4000-8000-000000000001",
      type: "lead.qualified",
      occurredAt: "2026-10-15T05:00:00.000Z",
      businessId: TENANT,
      data: {
        lead: { id: "l1", stage: "qualified", score: 82, temperature: "hot", fields: { budget: "80L" }, createdAt: "2026-10-15T04:00:00.000Z" },
        contact: { id: "c1", name: "Ravi", phone: "+919812345678" },
      },
    });
    expect(headers["x-pakka-event"]).toBe("lead.qualified");
    expect(headers["x-pakka-event-id"]).toBe("d0000000-0000-4000-8000-000000000001");
    expect(verifySignature(SECRET, raw, headers["x-pakka-signature"], Math.floor(NOW.getTime() / 1000))).toBe(true);
    expect(recordArgs(rpc)).toEqual({ p_id: "d0000000-0000-4000-8000-000000000001", p_run: RUN, p_outcome: "delivered", p_status: 200, p_error: null });
    expect(reads.every((r) => r.filters.tenant_id === TENANT)).toBe(true);
  });

  it("builds a booking's body", async () => {
    const { db } = fakeDb({ webhook_endpoints: endpointRow(), bookings: BOOKING });
    await deliverWebhook(delivery({ event: "booking.confirmed", entity_id: "b1" }), RUN, depsFor(db));
    expect(JSON.parse(post.mock.calls[0][1]).data).toEqual({
      booking: { id: "b1", status: "confirmed", startAt: "2026-10-17T05:30:00.000Z", endAt: "2026-10-17T06:30:00.000Z", service: "Site visit", resource: "Asha", leadId: "l1" },
      contact,
    });
  });

  it("builds a handoff's body, also when the database answers a relation as a one-row list", async () => {
    const { db } = fakeDb({ webhook_endpoints: endpointRow(), handoffs: { ...HANDOFF, conversation: [{ contact: [contact] }] } });
    await deliverWebhook(delivery({ event: "handoff.opened", entity_id: "h1" }), RUN, depsFor(db));
    expect(JSON.parse(post.mock.calls[0][1]).data).toEqual({ handoff: { id: "h1", reason: "asked_human", priority: "high", conversationId: "cv1" }, contact });
  });

  it("records a receiver's error answer as a failure to try again, and logs it without the URL", async () => {
    post.mockResolvedValue({ status: 500 });
    const { db, rpc } = fakeDb({ webhook_endpoints: endpointRow(), leads: LEAD }, "pending");
    await expect(deliverWebhook(delivery(), RUN, depsFor(db))).resolves.toBe("pending");
    expect(recordArgs(rpc)).toMatchObject({ p_outcome: "failed", p_status: 500, p_error: "http_500" });
    const logged = vi.mocked(console.error).mock.calls.flat().join(" ");
    expect(logged).toContain("http_500");
    expect(logged).not.toContain("zapier");
    expect(logged).not.toContain("s3cr3tpath");
  });

  it("records a request that got no answer by its reason", async () => {
    post.mockResolvedValue({ error: "timeout" });
    const { db, rpc } = fakeDb({ webhook_endpoints: endpointRow(), leads: LEAD }, "pending");
    await deliverWebhook(delivery(), RUN, depsFor(db));
    expect(recordArgs(rpc)).toMatchObject({ p_outcome: "failed", p_status: null, p_error: "timeout" });
  });

  it.each([
    ["the business may not send webhooks now (not Pro, switched off, paused)", { webhook_endpoints: endpointRow(), leads: LEAD }, false, "not_enabled"],
    ["the endpoint is switched off", { webhook_endpoints: endpointRow({ active: false }), leads: LEAD }, true, "endpoint_off"],
    ["the endpoint is gone", { leads: LEAD }, true, "endpoint_off"],
    ["the lead is gone (a customer's deletion request)", { webhook_endpoints: endpointRow() }, true, "gone"],
  ])("drops it, sending nothing, when %s", async (_name, tables, enabled, reason) => {
    const { db, rpc } = fakeDb(tables, "dropped");
    await expect(deliverWebhook(delivery(), RUN, depsFor(db, enabled))).resolves.toBe("dropped");
    expect(post).not.toHaveBeenCalled();
    expect(recordArgs(rpc)).toMatchObject({ p_outcome: "dropped", p_error: reason });
  });

  it("replay: a run that no longer holds the delivery records nothing (null)", async () => {
    const { db } = fakeDb({ webhook_endpoints: endpointRow(), leads: LEAD }, null);
    await expect(deliverWebhook(delivery(), RUN, depsFor(db))).resolves.toBeNull();
  });

  it("throws when the result cannot be recorded, so the step is retried", async () => {
    const { db, rpc } = fakeDb({ webhook_endpoints: endpointRow(), leads: LEAD });
    rpc.mockResolvedValue({ data: null, error: { message: "connection reset" } });
    await expect(deliverWebhook(delivery(), RUN, depsFor(db))).rejects.toThrow("record_webhook_attempt failed");
  });
});

describe("claimDeliveries", () => {
  it("claims up to 50 for the run", async () => {
    const { db, rpc } = fakeDb({}, [delivery()]);
    await expect(claimDeliveries(RUN, { db })).resolves.toEqual([delivery()]);
    expect(rpc).toHaveBeenCalledWith("claim_webhook_deliveries", { p_run: RUN, p_limit: 50 });
  });
});
