import { randomBytes } from "node:crypto";
import type { TenantContext } from "@pakka/types";
import type { WhatsAppConnectionPublic } from "@pakka/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashConnectLinkToken, newConnectLinkToken } from "../lib/connect-link-token";
import { encryptSecret } from "../lib/crypto";
import { AppError } from "../lib/errors";
import type { Check, Graph, GraphAnswer } from "../channels/whatsapp/connect/checks";
import { connectWithLink, createConnectLink, readConnectLink, type ConnectLinkDb, type ConnectLinkDeps } from "../channels/whatsapp/connect/connect-link";
import { connectEmbeddedSignup, exchangeCode, type EmbeddedSignupDeps, type ExchangeResult } from "../channels/whatsapp/connect/embedded-signup";
import type { ConnectionRecord, ManualConnectDb, MetaProbe } from "../channels/whatsapp/connect/manual";
import { captureLogs, describeLeaks, poison, type Fixtures, type LogCapture } from "./detect";

// Day 7, PR B: the log sweep over the Embedded Signup flow and the assisted connect link (Day 6; both flagged off in production, mocked Meta only). The REAL
// flows run on fake dependencies: Meta (the Graph client, the code exchange, the probe), the database and the audit; every failure carries the poison. The
// business token, the one-time code, our app secret and the connect-link token are synthetic. The link's token must never be logged, and neither the code
// exchange's URL (it holds our app secret). NOT PROVED: the real Meta, the real database, the router's access log for these paths (request-logger.test.ts has
// it), the real notify.send behind the test message, staging.

vi.stubEnv("ENCRYPTION_KEY", randomBytes(32).toString("base64"));
vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "synthetic-anon-key");
vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "synthetic-service-key");
vi.stubEnv("EMBEDDINGS_API_KEY", "synthetic-embeddings-key");
vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-anthropic-key");

const A = "a0000000-0000-4000-8000-00000000000a";
const NEW_ID = "d0000000-0000-4000-8000-0000000000d1";
const CODE = "AQD-synthetic-es-code-0001";
const BUSINESS_TOKEN = "EAABsyntheticBusinessTokenForTheLogSweep0001112223";
const APP_SECRET = "synthetic0platform0app0secret";
const PIN = "246810";
const PHONE = "+919812345621";
const NOW = new Date("2026-10-14T00:00:00Z");
const BODY = { code: CODE, wabaId: "100000000000001", phoneNumberId: "200000000000001", coexistence: false };
const LINK_TOKEN = newConnectLinkToken().token;
const FX: Fixtures = {
  phones: [PHONE, "+91 98123 45621"],
  secrets: [CODE, BUSINESS_TOKEN, APP_SECRET, PIN, LINK_TOKEN, "synthetic-encryption-key-0123456789abcdef"],
  texts: ["CANARY-NAME-8TZ"],
};
const POISON = poison(FX);

let capture: LogCapture | undefined;
afterEach(() => {
  capture?.stop();
  capture = undefined;
});

async function sweep(run: () => Promise<unknown>): Promise<LogCapture> {
  capture = captureLogs();
  try {
    await run();
  } catch {
    // the route answers a failure with its error envelope; what matters here is what OUR code wrote to the console
  }
  const cap = capture;
  expect(cap.leaks(FX), `\n${describeLeaks(cap.leaks(FX))}`).toEqual([]);
  return cap;
}

const answered = (body: unknown, ok = true, status = 200): GraphAnswer => ({ state: "answered", ok, status, body });
const GOOD: MetaProbe = { state: "ok", numberInAccount: true, info: { displayPhone: "+91 98123 45621", verifiedName: "CANARY-NAME-8TZ", qualityRating: "GREEN", facts: { nameStatus: "APPROVED", platformType: "CLOUD_API" } } } as MetaProbe;
const SIXTH_OK: Check = { key: "test_message_delivered", status: "pass", message: "A test message was sent to the owner's number.", checked_at: "2026-10-14T00:00:00.000Z" };
const context = (): TenantContext => ({ user: { id: "user-1", email: "o@example.test" }, tenant: { id: A, name: "Sunrise Homes" }, role: "owner" }) as unknown as TenantContext;
const boom = (): never => {
  throw new Error(POISON);
};

interface Over {
  exchange?: () => Promise<ExchangeResult>;
  graph?: Graph;
  probe?: () => Promise<MetaProbe>;
  save?: () => never;
  audit?: () => Promise<void>;
  sendEvent?: () => Promise<void>;
  testMessage?: () => Promise<Check>;
  numberLimit?: () => Promise<void>;
  limit?: () => Promise<string | null>;
  existing?: { id: string; tenantId: string; channelId: string; method: string; status: string } | null;
}

function signup(over: Over = {}) {
  const healthy: Graph = async (method, path) => {
    if (path.startsWith("debug_token")) return answered({ data: { is_valid: true, scopes: ["whatsapp_business_management", "whatsapp_business_messaging"] } });
    if (path.endsWith("/subscribed_apps") && method === "POST") return answered({ success: true });
    if (path.endsWith("/subscribed_apps")) return answered({ data: [{ id: "1" }] });
    if (path.endsWith("/register")) return answered({ success: true });
    return answered({ primary_funding_id: "123" });
  };
  const db: ManualConnectDb = {
    async tenantExists() {
      return true;
    },
    async findByPhoneNumberId() {
      return over.existing ?? null;
    },
    async channelIdFor() {
      return "c0000000-0000-4000-8000-0000000000c1";
    },
    async save(record: ConnectionRecord) {
      if (over.save) return over.save();
      return {
        id: record.id, tenant_id: record.tenantId, method: record.method ?? "embedded_signup", waba_id: record.wabaId, phone_number_id: record.phoneNumberId,
        display_phone: record.displayPhone, verified_name: record.verifiedName, coexistence: record.coexistence ?? false, status: record.status,
        last_check: record.lastCheck, quality_rating: record.qualityRating, messaging_limit: record.messagingLimit ?? null, created_at: "2026-10-14T00:00:00Z",
      };
    },
    async updateLastCheck() {
      return undefined;
    },
  } as unknown as ManualConnectDb;
  const deps: EmbeddedSignupDeps = {
    config: () => ({ enabled: true, appId: "111222333444555", appSecret: APP_SECRET, registerPin: PIN }),
    db,
    exchange: over.exchange ?? (async () => ({ state: "ok", token: BUSINESS_TOKEN })),
    graph: over.graph ?? healthy,
    probe: over.probe ?? (async () => GOOD),
    messagingLimit: over.limit ?? (async () => "TIER_1K"),
    webhookSeen: async () => false,
    testMessage: over.testMessage ?? (async () => SIXTH_OK),
    encrypt: encryptSecret,
    now: () => NOW,
    newId: () => NEW_ID,
    audit: over.audit ?? (async () => undefined),
    numberLimit: over.numberLimit,
    sendEvent: over.sendEvent ?? (async () => undefined),
  };
  return () => connectEmbeddedSignup(context(), BODY, deps);
}

describe("Embedded Signup (the real flow)", () => {
  it("connects a number", async () => void (await sweep(signup())));
  it("the code exchange is rejected, or Meta cannot be reached", async () => {
    await sweep(signup({ exchange: async () => ({ state: "rejected" }) }));
    await sweep(signup({ exchange: async () => ({ state: "unreachable" }) }));
  });
  it("the code exchange throws the poison", async () => void (await sweep(signup({ exchange: async () => boom() }))));
  it("Meta refuses every Graph question with a message carrying the poison", async () => void (await sweep(signup({ graph: async () => answered({ error: { message: POISON } }, false, 400) }))));
  it("the Graph client throws the poison", async () => void (await sweep(signup({ graph: async () => boom() }))));
  it("the probe throws the poison", async () => void (await sweep(signup({ probe: async () => boom() }))));
  it("the database refuses the save with the poison", async () => void (await sweep(signup({ save: boom }))));
  it("the audit write throws the poison: one fixed line, without the message", async () => {
    const cap = await sweep(signup({ audit: async () => boom() }));
    expect(cap.lines().some((l) => l.startsWith("[whatsapp-connect] "))).toBe(true);
  });
  it("the connected event cannot be sent (the send throws the poison)", async () => void (await sweep(signup({ sendEvent: async () => boom() }))));
  it("the test message check throws the poison", async () => void (await sweep(signup({ testMessage: async () => boom() }))));
  it("the plan's number limit refuses", async () => void (await sweep(signup({ numberLimit: async () => { throw new AppError("conflict", POISON); } }))));
  it("the number is already connected to another business", async () => void (await sweep(signup({ existing: { id: "x", tenantId: "b0000000-0000-4000-8000-00000000000b", channelId: "c", method: "manual_byo", status: "active" } }))));
  it("the messaging-limit read throws the poison", async () => void (await sweep(signup({ limit: async () => boom() }))));
});

describe("the code exchange (our app secret is in the request's address)", () => {
  const exchange = (fetchFn: typeof fetch) => () => exchangeCode(CODE, { appId: "111222333444555", appSecret: APP_SECRET }, fetchFn);

  it("Meta answers with the token (as JSON, and as the bare token)", async () => {
    await sweep(exchange((async () => Response.json({ access_token: BUSINESS_TOKEN })) as typeof fetch));
    await sweep(exchange((async () => new Response(BUSINESS_TOKEN)) as typeof fetch));
  });
  it("Meta answers with an error whose message carries the poison", async () => {
    await sweep(exchange((async () => Response.json({ error: { message: POISON } }, { status: 400 })) as typeof fetch));
  });
  it("the request fails with an error whose message carries the address (and so our app secret) and the poison", async () => {
    await sweep(exchange((async (url: unknown) => { throw new TypeError(`fetch failed: ${String(url)} ${POISON}`); }) as typeof fetch));
  });
});

describe("the assisted connect link", () => {
  type Row = { tokenHash: string; tenantId: string; createdBy: string; expiresAt: Date; usedAt: string | null };
  const CONNECTION = (status: "active" | "failed"): WhatsAppConnectionPublic =>
    ({ id: NEW_ID, tenant_id: A, method: "assisted", waba_id: "100000000000001", phone_number_id: "200000000000001", display_phone: PHONE, verified_name: "CANARY-NAME-8TZ", coexistence: false, status, last_check: {}, quality_rating: null, messaging_limit: null, created_at: "2026-10-14T00:00:00Z" }) as unknown as WhatsAppConnectionPublic;

  function link(over: { connect?: ConnectLinkDeps["connect"]; audit?: () => Promise<void>; insert?: () => Promise<void>; release?: () => Promise<void>; limit?: boolean; token?: string } = {}) {
    const rows: Row[] = [];
    const db: ConnectLinkDb = {
      async tenantExists() {
        return true;
      },
      async insert(row) {
        if (over.insert) return over.insert();
        rows.push({ ...row, usedAt: null });
      },
      async readLive(hash, now) {
        const r = rows.find((x) => x.tokenHash === hash && x.usedAt === null && x.expiresAt > now);
        return r ? { tenantName: "Sunrise Homes", expiresAt: r.expiresAt } : null;
      },
      async claim(hash, now) {
        const r = rows.find((x) => x.tokenHash === hash && x.usedAt === null && x.expiresAt > now);
        if (!r) return null;
        r.usedAt = now.toISOString();
        return { tenantId: r.tenantId, createdBy: r.createdBy, claimedAt: r.usedAt };
      },
      async activeConnectionExists() {
        return false;
      },
      async release(hash, claimedAt) {
        if (over.release) return over.release();
        const r = rows.find((x) => x.tokenHash === hash && x.usedAt === claimedAt);
        if (r) r.usedAt = null;
      },
    };
    const issued = newConnectLinkToken();
    const deps: ConnectLinkDeps = {
      assertAvailable: () => undefined,
      db,
      now: () => NOW,
      newToken: () => ({ token: over.token ?? LINK_TOKEN, tokenHash: hashConnectLinkToken(over.token ?? LINK_TOKEN) }),
      appOrigin: () => "https://app.example.test",
      audit: over.audit ?? (async () => undefined),
      limit: () => over.limit ?? true,
      connect: over.connect ?? (async () => CONNECTION("active")),
    };
    void issued;
    return { deps, rows, admin: { actor: "admin:f0000000-0000-4000-8000-0000000000f1", userId: "f0000000-0000-4000-8000-0000000000f1" } };
  }
  const body = { connectToken: LINK_TOKEN, ...BODY };

  it("makes a link, reads it, claims it and connects (the token is never logged)", async () => {
    await sweep(async () => {
      const s = link();
      const made = await createConnectLink(s.admin, { tenantId: A }, s.deps);
      expect(made.url).toContain(LINK_TOKEN); // the link itself is the answer, not a log line
      await readConnectLink(LINK_TOKEN, "203.0.113.9", s.deps);
      await connectWithLink(body, "203.0.113.9", s.deps);
    });
  });

  it("an unknown, used or malformed token, and a caller over the limit", async () => {
    await sweep(async () => {
      const s = link();
      await readConnectLink(LINK_TOKEN, "203.0.113.9", s.deps).catch(() => undefined);
      await readConnectLink("not-a-token", "203.0.113.9", s.deps).catch(() => undefined);
      await connectWithLink({ ...body, connectToken: "short" }, "203.0.113.9", s.deps).catch(() => undefined);
      await connectWithLink(body, "203.0.113.9", link({ limit: false }).deps).catch(() => undefined);
    });
  });

  it("the audit write fails with the poison after the link was made: one fixed line", async () => {
    const cap = await sweep(async () => {
      const s = link({ audit: async () => boom() });
      await createConnectLink(s.admin, { tenantId: A }, s.deps);
    });
    expect(cap.lines()).toContain("[whatsapp-connect] connect link audit write failed");
  });

  it("the flow fails with the poison, so the claim is released (and the release fails with the poison too)", async () => {
    await sweep(async () => {
      const s = link({ connect: async () => boom() });
      await createConnectLink(s.admin, { tenantId: A }, s.deps);
      await connectWithLink(body, "203.0.113.9", s.deps).catch(() => undefined);
      const t = link({ connect: async () => boom(), release: async () => boom() });
      await createConnectLink(t.admin, { tenantId: A }, t.deps);
      await connectWithLink(body, "203.0.113.9", t.deps).catch(() => undefined);
    });
  });

  it("the flow saves the connection as failed, so the claim is released", async () => {
    await sweep(async () => {
      const s = link({ connect: async () => CONNECTION("failed") });
      await createConnectLink(s.admin, { tenantId: A }, s.deps);
      await connectWithLink(body, "203.0.113.9", s.deps).catch(() => undefined);
    });
  });

  it("the database refuses the insert with the poison", async () => {
    await sweep(async () => {
      const s = link({ insert: async () => boom() });
      await createConnectLink(s.admin, { tenantId: A }, s.deps).catch(() => undefined);
    });
  });
});
