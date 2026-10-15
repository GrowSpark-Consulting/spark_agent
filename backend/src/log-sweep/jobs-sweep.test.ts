import { afterEach, describe, expect, it } from "vitest";
import { checkConnectionHealth, dueConnections, type HealthDeps } from "../channels/whatsapp/connect/health";
import { failureMessage, sendToAdmins } from "../channels/whatsapp/connect/health-alert";
import type { Graph, GraphAnswer } from "../channels/whatsapp/connect/checks";
import type { MetaProbe } from "../channels/whatsapp/connect/manual";
import { expiringConnections, warnExpiring } from "../channels/whatsapp/connect/token-expiry";
import { handleHealthCheck, handleHealthSweep, type HealthJobDeps } from "../inngest/connection-health";
import { handleTokenExpiry, type TokenExpiryDeps } from "../inngest/token-expiry";
import { fakeTables, type Row } from "../test-support/fake-tables";
import { captureLogs, describeLeaks, poison, type Fixtures, type LogCapture } from "./detect";

// Day 7, PR B: the log sweep over the connection-health and token-expiry jobs (Day 6). The real checks run on a fake database and a fake Graph API whose
// answers and failures carry the poison; the Inngest handlers run with dependencies that fail with the poison. The connection's token and number are
// synthetic. NOT PROVED: the real Meta, the real database, the real notify.send behind the alert (a fake `send` is used), Dev 2's staffAlertRecipients, staging logs.

const A = "e0000000-0000-4000-8000-00000000000a";
const CONN = "d4000000-0000-4000-8000-0000000000a1";
const NOW = new Date("2026-10-13T02:00:00.000Z");
const TOKEN = "EAABsyntheticAccessTokenForTheLogSweep000111222333";
const PHONE = "+919812345621";
const FX: Fixtures = { phones: [PHONE, "+91 98123 45621"], secrets: [TOKEN, "synthetic-encryption-key-0123456789abcdef", "enc:synthetic-ciphertext-0001"], texts: ["CANARY-NAME-8TZ"] };
const POISON = poison(FX);
const BOTH = ["whatsapp_business_management", "whatsapp_business_messaging"];

let capture: LogCapture | undefined;
afterEach(() => {
  capture?.stop();
  capture = undefined;
});

/** `atLeast`: how many log lines the scenario must write (0 for a path that logs nothing: the poison is then shown not to have been printed anywhere). */
async function sweep(run: () => Promise<unknown>, atLeast = 0): Promise<LogCapture> {
  capture = captureLogs();
  try {
    await run();
  } catch {
    // a job that throws leaves the error to Inngest (its own log): what matters here is what OUR code wrote to the console
  }
  const cap = capture;
  expect(cap.lines().length, "the scenario wrote fewer log lines than it should: the sweep proves nothing").toBeGreaterThanOrEqual(atLeast);
  expect(cap.leaks(FX), `\n${describeLeaks(cap.leaks(FX))}`).toEqual([]);
  return cap;
}

const answered = (body: unknown, ok = true, status = 200): GraphAnswer => ({ state: "answered", ok, status, body });
const healthy: Graph = async (_m, path) => {
  if (path.startsWith("debug_token")) return answered({ data: { is_valid: true, scopes: BOTH, expires_at: 0 } });
  if (path.endsWith("/subscribed_apps")) return answered({ data: [{ id: "1" }] });
  return answered({ primary_funding_id: "1" });
};
const refused: Graph = async () => answered({ error: { message: POISON, code: 190 } }, false, 400);
const throwing: Graph = async () => {
  throw new Error(POISON);
};
const GOOD: MetaProbe = { state: "ok", numberInAccount: true, info: { displayPhone: "+91 98123 45621", verifiedName: "CANARY-NAME-8TZ", qualityRating: "GREEN", facts: { nameStatus: "APPROVED", platformType: "CLOUD_API" } } } as MetaProbe;

const row = (over: Row = {}): Row => ({
  id: CONN, tenant_id: A, method: "manual_byo", waba_id: "100", phone_number_id: "200", display_phone: PHONE, verified_name: "CANARY-NAME-8TZ", status: "active",
  token_enc: "enc:synthetic-ciphertext-0001", last_check: null, quality_rating: "GREEN", messaging_limit: "TIER_1K", token_expires_at: null, updated_at: "2026-10-11T02:00:00Z", ...over,
});

function health(over: { graph?: Graph; probe?: () => Promise<MetaProbe>; decrypt?: () => string; limit?: () => Promise<string | null>; audit?: () => Promise<void> } = {}, rows: Row[] = [row()]) {
  const t = fakeTables({ whatsapp_connections: rows });
  const deps: HealthDeps = {
    db: t.db,
    decrypt: (over.decrypt ?? (() => TOKEN)) as HealthDeps["decrypt"],
    probe: over.probe ?? (async () => GOOD),
    graph: over.graph ?? healthy,
    webhookSeen: async () => true,
    messagingLimit: over.limit ?? (async () => "TIER_10K"),
    audit: over.audit ?? (async () => undefined),
    now: () => NOW,
  };
  return { deps, t };
}
const ids = { tenantId: A, connectionId: CONN };

describe("the daily check of a connection (the real checks, a fake Graph and database)", () => {
  it("a healthy connection", async () => void (await sweep(() => checkConnectionHealth(ids, health().deps))));
  it("Meta refuses every question with a message carrying the poison", async () => void (await sweep(() => checkConnectionHealth(ids, health({ graph: refused }).deps))));
  it("the Graph client throws the poison", async () => void (await sweep(() => checkConnectionHealth(ids, health({ graph: throwing }).deps))));
  it("the probe throws the poison", async () => void (await sweep(() => checkConnectionHealth(ids, health({ probe: async () => { throw new Error(POISON); } }).deps))));
  it("the token cannot be decrypted (the error carries the ciphertext and the key)", async () => void (await sweep(() => checkConnectionHealth(ids, health({ decrypt: () => { throw new Error(POISON); } }).deps))));
  it("the messaging-limit read throws the poison", async () => void (await sweep(() => checkConnectionHealth(ids, health({ limit: async () => { throw new Error(POISON); } }).deps))));
  it("the audit write throws the poison: one fixed line is logged, without the message", async () => {
    const ok = GOOD as Extract<MetaProbe, { state: "ok" }>;
    const lowQuality = { ...ok, info: { ...ok.info, qualityRating: "RED" } } as MetaProbe;
    const cap = await sweep(() => checkConnectionHealth(ids, health({ probe: async () => lowQuality, audit: async () => { throw new Error(POISON); } }).deps), 1);
    expect(cap.lines()).toContain("[connection-health] audit write failed");
  });
  it("the token is expired (a failing connection is reported, the connection is marked failed)", async () => {
    const expired: Graph = async (_m, path) => (path.startsWith("debug_token") ? answered({ data: { is_valid: false, expires_at: 1 } }) : healthy("GET", path, TOKEN));
    await sweep(() => checkConnectionHealth(ids, health({ graph: expired }).deps));
  });
  it("the connection is not there, is not active, or is another method", async () => {
    await sweep(async () => {
      await checkConnectionHealth(ids, health({}, []).deps);
      await checkConnectionHealth(ids, health({}, [row({ status: "failed" })]).deps);
      await checkConnectionHealth(ids, health({}, [row({ method: "platform" })]).deps);
    });
  });
  it("the database refuses the read, with a message carrying the poison", async () => {
    const failing = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ limit: async () => ({ data: null, error: { message: POISON, code: "XX000" } }) }) }) }) }) };
    const deps = { ...health().deps, db: failing as unknown as HealthDeps["db"] };
    await sweep(() => checkConnectionHealth(ids, deps));
  });
  it("lists the connections that are due", async () => {
    await sweep(() => dueConnections({ db: fakeTables({ whatsapp_connections: [row()] }).db, now: () => NOW }));
  });
});

describe("the alert to the owners", () => {
  it("is built from a masked number and the check's own words, and sent through a send that fails with the poison", async () => {
    await sweep(async () => {
      const message = failureMessage({ phoneMasked: "+9198xxxxxx21", detail: "The token has expired." }, "https://app.example.test");
      const counts = await sendToAdmins(A, message, `health_failed:${CONN}`, {
        recipients: async () => ["u1", "u2"],
        send: async () => {
          throw new Error(POISON);
        },
      });
      expect(counts.failed).toBe(2);
    });
  });

  it("the recipients cannot be read (an error carrying the poison)", async () => {
    await sweep(async () => {
      await sendToAdmins(A, failureMessage({ phoneMasked: null, detail: "x" }, "https://app.example.test"), "k", {
        recipients: async () => {
          throw new Error(POISON);
        },
        send: async () => ({ status: "sent", messageId: "m", providerMsgId: "w", creditsCharged: 0, usedTemplate: false }),
      });
    });
  });
});

describe("the Inngest handlers of connection-health", () => {
  const step = () => ({
    run: async <T>(_id: string, fn: () => Promise<T>) => JSON.parse(JSON.stringify((await fn()) ?? null)) as T,
    sendEvent: async () => undefined,
  });
  const okDeps = (over: Partial<HealthJobDeps> = {}): HealthJobDeps => ({
    due: async () => [{ tenantId: A, connectionId: CONN }],
    check: async () => ({ status: "checked" as const, overall: "pass" as const, failed: false as const }),
    alert: async () => ({ recipients: 1, sent: 1, skipped: 0, failed: 0 }),
    report: async () => true,
    now: () => NOW,
    ...over,
  });
  const failing = (): never => {
    throw new Error(POISON);
  };

  it("the sweep, and a sweep whose list fails", async () => {
    await sweep(async () => {
      await handleHealthSweep({ step: step() }, okDeps());
      await handleHealthSweep({ step: step() }, okDeps({ due: failing as never }));
    });
  });

  it("a check, a check that fails with the poison, a failed connection whose alert fails with the poison", async () => {
    await sweep(async () => {
      const event = { data: { tenantId: A, connectionId: CONN } };
      await handleHealthCheck({ event, step: step() }, okDeps());
      await handleHealthCheck({ event, step: step() }, okDeps({ check: failing as never })).catch(() => undefined);
      const failedResult = { status: "checked" as const, overall: "fail" as const, failed: true as const, alert: { reason: "token" as const, detail: "The token has expired.", phoneMasked: "+9198xxxxxx21", key: "k" } };
      await handleHealthCheck({ event, step: step() }, okDeps({ check: async () => failedResult as never, alert: failing as never })).catch(() => undefined);
    });
  });
});

describe("the token-expiry job", () => {
  const step = { run: async <T>(_id: string, fn: () => Promise<T>) => JSON.parse(JSON.stringify((await fn()) ?? null)) as T };
  const soon = new Date(NOW.getTime() + 3 * 86_400_000);

  it("lists the connections whose token runs out within seven days (the number is masked on the way out)", async () => {
    await sweep(async () => {
      const found = await expiringConnections({ db: fakeTables({ whatsapp_connections: [row({ token_expires_at: soon.toISOString() })] }).db, now: () => NOW });
      expect(found[0].phoneMasked).not.toContain("98123");
    });
  });

  it("warns the owners (a send that works, a send that fails with the poison)", async () => {
    await sweep(async () => {
      const connection = { tenantId: A, connectionId: CONN, phoneMasked: "+9198xxxxxx21", expiresAt: soon };
      await warnExpiring(connection, { appUrl: () => "https://app.example.test", recipients: async () => ["u1"], send: async () => ({ status: "sent", messageId: "m", providerMsgId: "w", creditsCharged: 0, usedTemplate: false }) });
      await warnExpiring(connection, { appUrl: () => "https://app.example.test", recipients: async () => ["u1"], send: async () => { throw new Error(POISON); } });
    });
  });

  it("the handler, with a list that fails and a warning that fails, each with the poison", async () => {
    await sweep(async () => {
      const ok: TokenExpiryDeps = { due: async () => [{ tenantId: A, connectionId: CONN, phoneMasked: "+9198xxxxxx21", expiresAt: soon }], warn: async () => ({ recipients: 1, sent: 1, skipped: 0, failed: 0 }) };
      await handleTokenExpiry({ step }, ok);
      await handleTokenExpiry({ step }, { ...ok, due: async () => { throw new Error(POISON); } }).catch(() => undefined);
      await handleTokenExpiry({ step }, { ...ok, warn: async () => { throw new Error(POISON); } }).catch(() => undefined);
    });
  });
});
