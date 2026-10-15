import type { TenantContext } from "@pakka/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret, webhookEndpointSecretContext } from "../lib/crypto";
import { deleteWebhookEndpoint, getWebhookSettings, rotateWebhookSecret, saveWebhookEndpoint, testWebhook, type EndpointDeps } from "./endpoint";
import { verifySignature } from "./signing";
import type { Post } from "./transport";

const ENV = { ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") };
const TENANT = "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f601";
const USER = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const NOW = new Date("2026-10-15T05:00:00Z");
const SAVED_SECRET = "whsec_saved-secret-0000000000000000000000000000";

const context = (role: TenantContext["role"] = "owner"): TenantContext => ({
  user: { id: USER, email: "owner@skyline.test" },
  role,
  tenant: { id: TENANT, name: "Skyline Homes", vertical: "real-estate", timezone: "Asia/Kolkata", status: "active", planKey: "pro", trialEndsAt: null },
});

const ROW = {
  url: "https://crm.example.in/in",
  events: ["lead.created", "booking.confirmed"],
  secret_enc: encryptSecret(SAVED_SECRET, webhookEndpointSecretContext(TENANT), ENV),
  secret_hint: SAVED_SECRET.slice(-4),
  active: true,
  created_at: "2026-10-15T04:00:00+00:00",
  last_success_at: null,
  last_failure_at: "2026-10-15T04:30:00+00:00",
  last_failure: "http_500",
};
const ENDPOINT = {
  url: "https://crm.example.in/in",
  events: ["lead.created", "booking.confirmed"],
  secretHint: SAVED_SECRET.slice(-4),
  active: true,
  createdAt: "2026-10-15T04:00:00.000Z",
  lastSuccessAt: null,
  lastFailureAt: "2026-10-15T04:30:00.000Z",
  lastFailure: "http_500",
};

let row: typeof ROW | null;
let rpcAnswers: Record<string, unknown>;
let post: ReturnType<typeof vi.fn<Post>>;
let feature: { key: string; inPlan: boolean; enabled: boolean };
const rpc = vi.fn<(name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: null }>>(async (name) => ({ data: rpcAnswers[name] ?? null, error: null }));
const db = {
  from: () => {
    const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: row, error: null }) };
    return chain;
  },
  rpc,
} as unknown as SupabaseClient;
const deps = (): EndpointDeps => ({ db, post, features: async () => [feature], now: () => NOW, env: ENV });
const argsOf = (name: string) => rpc.mock.calls.find(([n]) => n === name)?.[1] as Record<string, string>;
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: { code: string; message: string; fields?: Record<string, string> }) => e);

beforeEach(() => {
  row = ROW;
  rpcAnswers = {};
  rpc.mockClear();
  post = vi.fn<Post>(async () => ({ status: 200 }));
  feature = { key: "outbound_webhooks", inPlan: true, enabled: true };
});

describe("who may manage the webhook", () => {
  it("staff may not, and nothing is read or written", async () => {
    for (const call of [getWebhookSettings, rotateWebhookSecret, deleteWebhookEndpoint, testWebhook]) {
      expect(await refusal(call(context("staff"), deps()))).toMatchObject({ code: "forbidden" });
    }
    expect(await refusal(saveWebhookEndpoint(context("staff"), { url: ROW.url, events: ["lead.created"] }, deps()))).toMatchObject({ code: "forbidden" });
    expect(rpc).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});

describe("getWebhookSettings", () => {
  it("shows the endpoint (never its secret) and whether events are being sent", async () => {
    const settings = await getWebhookSettings(context("admin"), deps());
    expect(settings).toEqual({ inPlan: true, sending: true, endpoint: ENDPOINT });
    expect(JSON.stringify(settings)).not.toContain("v1:");
  });

  it("is not sending while the switch is off, or with no endpoint", async () => {
    feature = { ...feature, enabled: false };
    expect((await getWebhookSettings(context(), deps())).sending).toBe(false);
    feature = { ...feature, enabled: true };
    row = null;
    expect(await getWebhookSettings(context(), deps())).toEqual({ inPlan: true, sending: false, endpoint: null });
  });
});

describe("saveWebhookEndpoint", () => {
  it("creates it: the secret is shown once, stored encrypted for this business, and the owner is the actor", async () => {
    rpcAnswers.save_webhook_endpoint = [{ created: true }];
    const saved = await saveWebhookEndpoint(context(), { url: " https://crm.example.in/in ", events: ["booking.confirmed", "lead.created", "lead.created"] }, deps());
    const args = argsOf("save_webhook_endpoint");
    expect(args).toMatchObject({ p_tenant_id: TENANT, p_url: "https://crm.example.in/in", p_events: ["lead.created", "booking.confirmed"], p_actor: USER });
    expect(saved.secret).toMatch(/^whsec_/);
    expect(decryptSecret(args.p_secret_enc, webhookEndpointSecretContext(TENANT), ENV)).toBe(saved.secret);
    expect(args.p_secret_hint).toBe(saved.secret!.slice(-4));
    expect(saved.endpoint).toEqual(ENDPOINT);
  });

  it("changing it shows no secret: the receiver keeps the one it has", async () => {
    rpcAnswers.save_webhook_endpoint = [{ created: false }];
    expect((await saveWebhookEndpoint(context(), { url: ROW.url, events: ["lead.created"] }, deps())).secret).toBeNull();
  });

  it.each([
    [{ url: ROW.url, events: [] }, "events"],
    [{ url: ROW.url, events: ["lead.deleted"] }, "events"],
    [{ events: ["lead.created"] }, "url"],
    [{ url: "http://crm.example.in/in", events: ["lead.created"] }, "url"],
    [{ url: "https://192.168.1.20/hook", events: ["lead.created"] }, "url"],
  ])("refuses %j with the field to fix", async (body, field) => {
    const e = await refusal(saveWebhookEndpoint(context(), body, deps()));
    expect(e).toMatchObject({ code: "validation_failed" });
    expect(Object.keys(e!.fields ?? {})).toContain(field);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("needs the Pro plan", async () => {
    feature = { ...feature, inPlan: false, enabled: false };
    expect(await refusal(saveWebhookEndpoint(context(), { url: ROW.url, events: ["lead.created"] }, deps()))).toMatchObject({
      code: "plan_required",
      message: "Outbound webhooks needs the Pro plan.",
    });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("rotateWebhookSecret and deleteWebhookEndpoint", () => {
  it("a new secret, stored encrypted, shown once", async () => {
    rpcAnswers.rotate_webhook_secret = true;
    const rotated = await rotateWebhookSecret(context(), deps());
    expect(decryptSecret(argsOf("rotate_webhook_secret").p_secret_enc, webhookEndpointSecretContext(TENANT), ENV)).toBe(rotated.secret);
    expect(rotated.secretHint).toBe(rotated.secret.slice(-4));
    expect(argsOf("rotate_webhook_secret").p_actor).toBe(USER);
  });

  it("no endpoint, nothing to rotate", async () => {
    rpcAnswers.rotate_webhook_secret = false;
    expect(await refusal(rotateWebhookSecret(context(), deps()))).toMatchObject({ code: "not_found" });
  });

  it("deleting names the business and the actor", async () => {
    await expect(deleteWebhookEndpoint(context(), deps())).resolves.toBeUndefined();
    expect(argsOf("delete_webhook_endpoint")).toEqual({ p_tenant_id: TENANT, p_actor: USER });
  });
});

describe("testWebhook", () => {
  it("sends a signed ping with the saved secret, and says it arrived", async () => {
    await expect(testWebhook(context(), deps())).resolves.toEqual({ delivered: true, status: 200, error: null });
    const [url, raw, headers] = post.mock.calls[0];
    expect(url).toBe(ROW.url);
    expect(JSON.parse(raw)).toMatchObject({ type: "ping", businessId: TENANT, data: {} });
    expect(verifySignature(SAVED_SECRET, raw, headers["x-pakka-signature"], NOW.getTime() / 1000)).toBe(true);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("says why it did not arrive", async () => {
    post.mockResolvedValueOnce({ status: 401 }).mockResolvedValueOnce({ error: "refused_address" });
    expect(await testWebhook(context(), deps())).toEqual({ delivered: false, status: 401, error: "http_401" });
    expect(await testWebhook(context(), deps())).toEqual({ delivered: false, status: null, error: "refused_address" });
  });

  it("needs the plan and a saved endpoint", async () => {
    row = null;
    expect(await refusal(testWebhook(context(), deps()))).toMatchObject({ code: "not_found" });
    feature = { ...feature, inPlan: false };
    expect(await refusal(testWebhook(context(), deps()))).toMatchObject({ code: "plan_required" });
    expect(post).not.toHaveBeenCalled();
  });
});
