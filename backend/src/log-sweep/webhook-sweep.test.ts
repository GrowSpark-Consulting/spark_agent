import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SYNTHETIC_SECRETS } from "../test-support/whole-turn-world";
import { captureLogs, describeLeaks, poison, type Fixtures, type LogCapture } from "./detect";

// Day 7, PR B: the log sweep over the WhatsApp webhook (POST handler and the GET handshake), with the handler's own fixtures (the synthetic payloads of every
// kind: texts, a button reply, an image, a voice-less batch, echoes, statuses, template and account events, an unknown field) re-signed with the sweep's own
// secrets, the numbers and names changed to the sweep's own, and every dependency made to fail with an error whose message carries the poison.
// All values are synthetic. NOT PROVED: the real database functions behind the dependencies (inbound-db.ts), Meta, staging logs, and the route's error
// envelope: an error that escapes the handler is caught by the test, whereas in production lib/errors.ts logs it (KNOWN LEAK 2 in request-logger.test.ts).

const APP_SECRET = "synthetic-meta-app-secret"; // the value the environment below is stubbed with
const BYO_SECRET = "synthetic-byo-app-secret-0001";
const CUSTOMER = "919812345621";
const SECOND = "919876500102";
const BUSINESS = "914412345678";
const CANARY = { name: "Priya Canary", second: "Second Canary", text: "CANARY-TEXT-7QX", caption: "CANARY-CAPTION-5PL", echo: "CANARY-ECHO-1HV" };
const FX: Fixtures = {
  phones: [`+${CUSTOMER}`, `+${SECOND}`, `+${BUSINESS}`],
  secrets: [...SYNTHETIC_SECRETS, BYO_SECRET],
  texts: Object.values(CANARY),
};
const POISON = poison(FX);

const TENANT = "e0000000-0000-4000-8000-00000000000a";
const WABA = "100000000000001";
const PNID = "200000000000001";
const CONNECTION = "c0000000-0000-4000-8000-0000000000a1";

let capture: LogCapture | undefined;
afterEach(() => {
  capture?.stop();
  capture = undefined;
});

let handle: typeof import("../channels/whatsapp/inbound")["handleWhatsAppWebhook"];
let handshake: typeof import("../channels/whatsapp/verify-challenge")["handleWhatsAppHandshake"];
let verification: typeof import("../channels/whatsapp/verify-challenge")["handleWhatsAppVerification"];
let WebhookDbError: typeof import("../channels/whatsapp/inbound-db")["WebhookDbError"];
beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "synthetic-anon-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-service-key");
  vi.stubEnv("EMBEDDINGS_API_KEY", "synthetic-embeddings-key");
  vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-anthropic-key");
  vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "synthetic-route-token");
  vi.stubEnv("META_APP_SECRET", APP_SECRET);
  handle = (await import("../channels/whatsapp/inbound")).handleWhatsAppWebhook;
  const verify = await import("../channels/whatsapp/verify-challenge");
  handshake = verify.handleWhatsAppHandshake;
  verification = verify.handleWhatsAppVerification;
  WebhookDbError = (await import("../channels/whatsapp/inbound-db")).WebhookDbError;
});

const FIXTURES_DIR = fileURLToPath(new URL("../channels/whatsapp/__fixtures__/", import.meta.url));
const fixtureFiles = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));

/** A fixture with the sweep's own numbers, names and texts in it. */
function fixture(file: string): string {
  return readFileSync(`${FIXTURES_DIR}${file}`, "utf8")
    .replaceAll("910000000101", CUSTOMER)
    .replaceAll("910000000102", SECOND)
    .replaceAll("910000000001", BUSINESS)
    .replaceAll("Test Customer", CANARY.name)
    .replaceAll("Second Customer", CANARY.second)
    .replaceAll("Still parsed", `Still parsed ${CANARY.text}`)
    .replaceAll("Kitchen photo", CANARY.caption)
    .replaceAll("Sure, I will call you this evening.", CANARY.echo)
    .replaceAll("வணக்கம், 2BHK price என்ன?", `வணக்கம், 2BHK price என்ன? ${CANARY.text}`)
    .replaceAll('"Hi"', `"Hi ${CANARY.text}"`);
}

const sign = (raw: string, secret = APP_SECRET) => `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
const post = (raw: string, signature: string | null = sign(raw)) =>
  new Request("http://localhost:4000/api/webhooks/whatsapp", { method: "POST", body: raw, headers: { "content-type": "application/json", ...(signature ? { "x-hub-signature-256": signature } : {}) } });

type Method = "platform" | "manual_byo" | "embedded_signup" | "assisted" | "coexistence";
function deps(over: Record<string, unknown> = {}, method: Method = "platform") {
  const connection = { id: CONNECTION, tenantId: TENANT, channelId: "ch-1", phoneNumberId: PNID, wabaId: WABA, method, status: "active" };
  let n = 0;
  return {
    findConnections: async (ids: string[]) => (ids.includes(PNID) ? [connection] : []),
    findConnectionsByWaba: async (ids: string[]) => (ids.includes(WABA) ? [connection] : []),
    findByoSecrets: async () => (method === "manual_byo" ? [{ connectionId: CONNECTION, secret: BYO_SECRET }] : []),
    storeInboundMessage: async () => ({ conversationId: "c0000000-0000-4000-8000-00000000000c", messageId: `a0000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, inserted: true }),
    storeEchoedMessage: async () => ({ status: "stored", conversationId: "c0000000-0000-4000-8000-00000000000c", messageId: "a0000000-0000-4000-8000-0000000000e1", switched: false }),
    applyMessageStatus: async () => true,
    templateBelongsToTenant: async () => true,
    setTemplateStatus: async () => true,
    updateConnectionHealth: async () => undefined,
    noteWebhookSeen: async () => undefined,
    sendEvent: async () => undefined,
    ...over,
  } as unknown as Parameters<typeof handle>[1];
}

/** Runs the handler with every console line captured and fails on any leak. `lines` says how many lines it expects at least. */
async function sweep(run: () => Promise<unknown>, atLeast = 1): Promise<LogCapture> {
  capture = captureLogs();
  await run();
  const cap = capture;
  expect(cap.lines().length, "the scenario wrote no log line at all: the sweep proves nothing").toBeGreaterThanOrEqual(atLeast);
  expect(cap.leaks(FX), `\n${describeLeaks(cap.leaks(FX))}`).toEqual([]);
  return cap;
}

describe("every kind of payload, signed by the platform", () => {
  it.each(fixtureFiles)("%s", async (file) => {
    await sweep(async () => {
      const raw = fixture(file);
      expect((await handle(post(raw), deps())).status).toBe(200);
    });
  });

  it("a signed batch of everything at once, delivered twice", async () => {
    await sweep(async () => {
      for (const file of fixtureFiles) {
        const raw = fixture(file);
        await handle(post(raw), deps());
        await handle(post(raw), deps());
      }
    }, fixtureFiles.length);
  });
});

describe("a business's own app (manual_byo): signed with its own secret", () => {
  it.each(fixtureFiles)("%s", async (file) => {
    await sweep(async () => {
      const raw = fixture(file);
      const res = await handle(post(raw, sign(raw, BYO_SECRET)), deps({}, "manual_byo"));
      expect(res.status).toBe(200);
    });
  });
});

describe("requests that are refused", () => {
  it("no signature, a wrong signature, a signature in the wrong shape, a signature made with the BYO secret for a platform connection", async () => {
    await sweep(async () => {
      const raw = fixture("synthetic-text-message.json");
      for (const signature of [null, "sha256=" + "0".repeat(64), "md5=abc", sign(raw, "synthetic-wrong-secret"), sign(raw, BYO_SECRET)]) {
        try {
          await handle(post(raw, signature), deps());
        } catch {
          // the route's error envelope answers it
        }
      }
    }, 0);
  });

  it("a body that is not JSON, signed", async () => {
    await sweep(async () => {
      const raw = `this is not json ${CANARY.text} ${CUSTOMER}`;
      expect((await handle(post(raw), deps())).status).toBe(200);
    });
  });

  it("a body that is JSON but not a webhook, signed", async () => {
    await sweep(async () => {
      const raw = JSON.stringify({ hello: CANARY.text, phone: CUSTOMER });
      expect((await handle(post(raw), deps())).status).toBe(200);
    }, 0);
  });

  it("a message from a number no connection of ours has", async () => {
    await sweep(async () => {
      const raw = fixture("synthetic-text-message.json").replaceAll(PNID, "299999999999999");
      expect((await handle(post(raw), deps())).status).toBe(200);
    });
  });
});

describe("every dependency fails with a message carrying the poison", () => {
  const failures = ["findConnections", "findConnectionsByWaba", "findByoSecrets", "storeInboundMessage", "storeEchoedMessage", "applyMessageStatus", "templateBelongsToTenant", "setTemplateStatus", "updateConnectionHealth", "noteWebhookSeen", "sendEvent"] as const;
  const kinds: [string, () => Error][] = [
    ["an unexpected error", () => new Error(POISON)],
    ["a database error with a code", () => new (WebhookDbError as unknown as new (op: string, code?: string) => Error)("store_inbound_message", "XX000")],
  ];

  for (const [kind, make] of kinds) {
    for (const file of fixtureFiles) {
      it.each(failures)(`${kind}, in %s, on ${file}`, async (dependency) => {
        await sweep(async () => {
          const raw = fixture(file);
          const failing = deps({ [dependency]: async () => { throw make(); } }, "manual_byo");
          try {
            await handle(post(raw, sign(raw, BYO_SECRET)), failing);
          } catch {
            // an unauthenticated or failed request is answered by the route's error envelope
          }
          try {
            await handle(post(raw), deps({ [dependency]: async () => { throw make(); } }));
          } catch {
            // the same
          }
        }, 0);
      });
    }
  }
});

describe("the handshake (GET)", () => {
  const url = (query: Record<string, string>) => new Request(`http://localhost:4000/api/webhooks/whatsapp?${new URLSearchParams(query)}`);

  it("the platform's verify token, a business's own token, a wrong token, and a failing token lookup", async () => {
    await sweep(async () => {
      const good = { "hub.mode": "subscribe", "hub.verify_token": "synthetic-route-token", "hub.challenge": "1158201444" };
      expect(verification(url(good)).status).toBe(200);
      expect((await handshake(url({ ...good, "hub.verify_token": "synthetic-business-token-0001" }), async () => true)).status).toBe(200);
      expect((await handshake(url({ ...good, "hub.verify_token": "synthetic-wrong-token" }), async () => false)).status).toBe(403);
      expect((await handshake(url({ ...good, "hub.verify_token": "synthetic-business-token-0001" }), async () => { throw new Error(POISON); })).status).toBe(403);
    }, 1);
  });
});
