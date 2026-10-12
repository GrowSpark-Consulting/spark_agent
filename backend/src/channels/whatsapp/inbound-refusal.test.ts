import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// Every 401 of the webhook leaves one line saying why (refusal-log.ts), without anything from the request in it.

const SECRET = "synthetic-meta-app-secret";
vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "synthetic-anon-key");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-service-key");
vi.stubEnv("EMBEDDINGS_API_KEY", "synthetic-embeddings-key");
vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-anthropic-key");
vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "synthetic-route-token");
vi.stubEnv("META_APP_SECRET", SECRET);

const { handleWhatsAppWebhook } = await import("./inbound");
const { createRefusalLog } = await import("./refusal-log");
type Deps = Parameters<typeof handleWhatsAppWebhook>[1] & object;

const body = readFileSync(new URL("./__fixtures__/synthetic-echo-text.json", import.meta.url));
const sign = (secret: string, raw: Uint8Array = body) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
const post = (headers: Record<string, string>, raw: Uint8Array = body) => new Request("http://localhost:4000/api/webhooks/whatsapp", { method: "POST", body: raw, headers });

function setup(byo: { secrets?: { connectionId: string; secret: string }[]; undecryptable?: number } = {}) {
  const lines: string[] = [];
  const found = Object.assign([...(byo.secrets ?? [])], { skipped: byo.undecryptable ?? 0 });
  const deps = {
    findConnections: vi.fn(async () => []),
    findConnectionsByWaba: vi.fn(async () => []),
    findByoSecrets: vi.fn(async () => found),
    storeInboundMessage: vi.fn(),
    applyMessageStatus: vi.fn(),
    templateBelongsToTenant: vi.fn(),
    setTemplateStatus: vi.fn(),
    updateConnectionHealth: vi.fn(),
    sendEvent: vi.fn(),
    refusalLog: createRefusalLog({ write: (line) => lines.push(line) }),
  };
  return { deps: deps as unknown as Deps, lines };
}
const refused = (deps: Deps, request: Request) => expect(handleWhatsAppWebhook(request, deps)).rejects.toMatchObject({ code: "unauthenticated" });

describe("why a webhook was refused", () => {
  it("no_signature_header: there is no signature header", async () => {
    const f = setup();
    await refused(f.deps, post({}));
    expect(f.lines).toEqual(["[whatsapp-webhook] refused reason=no_signature_header phone_ids=0 byo_rows=0 byo_undecryptable=0 suppressed=0"]);
  });

  it("bad_signature_format: the header is not sha256= and 64 hex characters", async () => {
    const f = setup();
    await refused(f.deps, post({ "x-hub-signature-256": "sha256=zz" }));
    expect(f.lines).toHaveLength(1);
    expect(f.lines[0]).toContain("reason=bad_signature_format");
  });

  it("body_not_json: the body cannot name a connection, so no secret could be tried", async () => {
    const f = setup();
    const raw = new TextEncoder().encode("not json");
    await refused(f.deps, post({ "x-hub-signature-256": sign("any-secret", raw) }, raw));
    expect(f.lines[0]).toContain("reason=body_not_json");
    expect(f.deps.findByoSecrets).not.toHaveBeenCalled();
  });

  it("no_byo_connection: the number in the body matches no manual_byo connection", async () => {
    const f = setup();
    await refused(f.deps, post({ "x-hub-signature-256": sign("byo-secret") }));
    expect(f.lines[0]).toBe("[whatsapp-webhook] refused reason=no_byo_connection phone_ids=1 byo_rows=0 byo_undecryptable=0 suppressed=0");
  });

  it("byo_signature_mismatch: a manual_byo connection was found and its saved secret did not sign the request", async () => {
    const f = setup({ secrets: [{ connectionId: "c1", secret: "the-saved-secret" }] });
    await refused(f.deps, post({ "x-hub-signature-256": sign("another-secret") }));
    expect(f.lines[0]).toBe("[whatsapp-webhook] refused reason=byo_signature_mismatch phone_ids=1 byo_rows=1 byo_undecryptable=0 suppressed=0");
  });

  it("counts a saved secret that could not be decrypted, and still calls it a mismatch", async () => {
    const f = setup({ undecryptable: 1 });
    await refused(f.deps, post({ "x-hub-signature-256": sign("any-secret") }));
    expect(f.lines[0]).toBe("[whatsapp-webhook] refused reason=byo_signature_mismatch phone_ids=1 byo_rows=1 byo_undecryptable=1 suppressed=0");
  });

  it("holds back repeats of the same reason", async () => {
    const f = setup();
    for (let i = 0; i < 4; i++) await refused(f.deps, post({}));
    expect(f.lines).toHaveLength(1);
  });

  it("puts nothing from the request or the secrets in the line", async () => {
    const f = setup({ secrets: [{ connectionId: "c0000000-0000-4000-8000-0000000000a1", secret: "the-saved-secret" }] });
    await refused(f.deps, post({ "x-hub-signature-256": sign("another-secret") }));
    const line = f.lines.join("\n");
    for (const secret of ["the-saved-secret", "another-secret", SECRET, "200000000000001", "c0000000", "sha256="]) expect(line).not.toContain(secret);
  });

  it("writes no refusal for a request that is accepted", async () => {
    const f = setup();
    const res = await handleWhatsAppWebhook(post({ "x-hub-signature-256": sign(SECRET) }), f.deps);
    expect(res.status).toBe(200);
    expect(f.lines).toEqual([]);
  });
});
