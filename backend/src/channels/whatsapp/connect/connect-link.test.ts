import type { WhatsAppConnectionPublic } from "@pakka/types";
import { describe, expect, it, vi } from "vitest";
import type { AuditEntry } from "../../../lib/audit";
import { hashConnectLinkToken, newConnectLinkToken } from "../../../lib/connect-link-token";
import { AppError } from "../../../lib/errors";
import { connectWithLink, createConnectLink, readConnectLink, type ConnectLinkDb, type ConnectLinkDeps } from "./connect-link";
import type { SignupCaller, SignupInput } from "./embedded-signup";

const A = "a0000000-0000-4000-8000-00000000000a";
const B = "b0000000-0000-4000-8000-00000000000b";
const ADMIN = "f0000000-0000-4000-8000-0000000000f1";
const NOW = new Date("2026-10-14T00:00:00Z");
const BODY = { code: "AQD-synthetic-code", wabaId: "100000000000001", phoneNumberId: "200000000000001", coexistence: false };
const ORIGIN = "https://app.pakkaagent.in";
const admin = { actor: `admin:${ADMIN}`, userId: ADMIN };

type Row = { tokenHash: string; tenantId: string; createdBy: string; expiresAt: Date; usedAt: string | null };

/** An in-memory connect_links. The claim checks and sets in one synchronous step, as the real conditional UPDATE does in one statement. */
function fakeDb(rows: Row[] = [], tenants: Record<string, string> = { [A]: "Sunrise Homes" }) {
  const log: string[] = [];
  const active = new Set<string>(); // `${tenantId}:${phoneNumberId}` of connections that are active
  const db: ConnectLinkDb = {
    async tenantExists(id) {
      log.push("tenantExists");
      return id in tenants;
    },
    async insert(row) {
      log.push("insert");
      rows.push({ ...row, usedAt: null });
    },
    async readLive(tokenHash, now) {
      log.push("readLive");
      const r = rows.find((x) => x.tokenHash === tokenHash && x.usedAt === null && x.expiresAt > now);
      return r && tenants[r.tenantId] ? { tenantName: tenants[r.tenantId], expiresAt: r.expiresAt } : null;
    },
    async claim(tokenHash, now) {
      log.push("claim");
      const r = rows.find((x) => x.tokenHash === tokenHash && x.usedAt === null && x.expiresAt > now);
      if (!r) return null;
      r.usedAt = now.toISOString();
      return { tenantId: r.tenantId, createdBy: r.createdBy, claimedAt: r.usedAt };
    },
    async activeConnectionExists(tenantId, phoneNumberId) {
      log.push("activeConnectionExists");
      return active.has(`${tenantId}:${phoneNumberId}`);
    },
    async release(tokenHash, claimedAt) {
      log.push("release");
      const r = rows.find((x) => x.tokenHash === tokenHash && x.usedAt === claimedAt);
      if (r) r.usedAt = null;
    },
  };
  return { db, rows, log, active };
}

const CONNECTION = (status: "active" | "failed"): WhatsAppConnectionPublic =>
  ({ id: "d0000000-0000-4000-8000-0000000000d1", tenant_id: A, method: "assisted", waba_id: "100000000000001", phone_number_id: "200000000000001", display_phone: null, verified_name: null, coexistence: false, status, last_check: {}, quality_rating: null, messaging_limit: null, created_at: "2026-10-14T00:00:00Z" }) as WhatsAppConnectionPublic;

function setup(over: { enabled?: boolean; limit?: boolean; connect?: ConnectLinkDeps["connect"]; audit?: () => Promise<void> } = {}) {
  const fake = fakeDb();
  const audits: AuditEntry[] = [];
  const connect = vi.fn<ConnectLinkDeps["connect"]>(over.connect ?? (async () => CONNECTION("active")));
  const limit = vi.fn<(key: string) => boolean>(() => over.limit ?? true);
  const deps: ConnectLinkDeps = {
    assertAvailable: () => {
      if (over.enabled === false) throw new AppError("not_available", "off");
    },
    db: fake.db,
    now: () => NOW,
    newToken: newConnectLinkToken,
    appOrigin: () => ORIGIN,
    audit: async (entry) => {
      await over.audit?.();
      audits.push(entry);
    },
    limit,
    connect,
  };
  const live = () => {
    const { token, tokenHash } = newConnectLinkToken();
    fake.rows.push({ tokenHash, tenantId: A, createdBy: ADMIN, expiresAt: new Date(NOW.getTime() + 3600_000), usedAt: null });
    return token;
  };
  return { ...fake, audits, connect, limit, deps, live };
}

const codeOf = (p: Promise<unknown>) => p.then(() => "no error", (e) => (e instanceof AppError ? e.code : "other"));
const errorOf = (p: Promise<unknown>) => p.then(() => null, (e) => e as AppError);

describe("createConnectLink", () => {
  it("answers not_available while off, before any database read", async () => {
    const s = setup({ enabled: false });
    expect(await codeOf(createConnectLink(admin, { tenantId: A }, s.deps))).toBe("not_available");
    expect(s.log).toEqual([]);
  });

  it("returns a url holding the raw token and its expiry, 24 hours on", async () => {
    const s = setup();
    const out = await createConnectLink(admin, { tenantId: A }, s.deps);
    expect(out.expiresAt).toBe("2026-10-15T00:00:00.000Z");
    expect(/^https:\/\/app\.pakkaagent\.in\/connect\/[A-Za-z0-9_-]{43}$/.test(out.url)).toBe(true);
    expect(Object.keys(out).sort()).toEqual(["expiresAt", "url"]);
  });

  it("stores only the hash of the token, for the business, the admin and the 24 hours", async () => {
    const s = setup();
    const out = await createConnectLink(admin, { tenantId: A }, s.deps);
    const token = out.url.split("/").pop() as string;
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toMatchObject({ tokenHash: hashConnectLinkToken(token), tenantId: A, createdBy: ADMIN, expiresAt: new Date("2026-10-15T00:00:00.000Z"), usedAt: null });
    expect(JSON.stringify(s.rows)).not.toContain(token);
  });

  it("the raw token appears in the response and nowhere else: not in the audit, not in the logs", async () => {
    const logs: string[] = [];
    const spies = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log")].map((x) => x.mockImplementation((...a: unknown[]) => void logs.push(a.join(" "))));
    const s = setup();
    const out = await createConnectLink(admin, { tenantId: A }, s.deps);
    const token = out.url.split("/").pop() as string;
    expect(JSON.stringify({ audits: s.audits, rows: s.rows, logs })).not.toContain(token);
    expect(s.audits).toHaveLength(1);
    expect(s.audits[0]).toMatchObject({ tenantId: A, actor: admin.actor, action: "whatsapp_connect_link.created" });
    spies.forEach((x) => x.mockRestore());
  });

  it("a failed audit write does not fail the link", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const s = setup({ audit: async () => Promise.reject(new Error("audit down")) });
    expect((await createConnectLink(admin, { tenantId: A }, s.deps)).url).toMatch(/\/connect\//);
  });

  it("refuses an unknown business with not_found and stores nothing", async () => {
    const s = setup();
    expect(await codeOf(createConnectLink(admin, { tenantId: B }, s.deps))).toBe("not_found");
    expect(s.rows).toHaveLength(0);
  });

  it.each([[{}], [{ tenantId: "not-a-uuid" }], [null], ["x"]])("refuses the body %j with validation_failed", async (body) => {
    const s = setup();
    expect(await codeOf(createConnectLink(admin, body, s.deps))).toBe("validation_failed");
    expect(s.rows).toHaveLength(0);
  });

  it("allows several live links for one business, each its own token", async () => {
    const s = setup();
    const one = await createConnectLink(admin, { tenantId: A }, s.deps);
    const two = await createConnectLink(admin, { tenantId: A }, s.deps);
    expect(one.url).not.toBe(two.url);
    expect(s.rows).toHaveLength(2);
  });
});

describe("readConnectLink", () => {
  it("answers not_available while off, before the limit, the shape check or any database read", async () => {
    const s = setup({ enabled: false });
    expect(await codeOf(readConnectLink("x", "1.2.3.4", s.deps))).toBe("not_available");
    expect(s.log).toEqual([]);
    expect(s.limit).not.toHaveBeenCalled();
  });

  it("returns the business name and expiry of a live link, and does not use it up", async () => {
    const s = setup();
    const token = s.live();
    expect(await readConnectLink(token, "1.2.3.4", s.deps)).toEqual({ tenantName: "Sunrise Homes", expiresAt: new Date(NOW.getTime() + 3600_000).toISOString() });
    expect(s.rows[0].usedAt).toBeNull();
    expect(await readConnectLink(token, "1.2.3.4", s.deps)).toMatchObject({ tenantName: "Sunrise Homes" });
  });

  it("gives a malformed, an unknown, a used and an expired token the very same answer", async () => {
    const s = setup();
    const used = s.live();
    s.rows[0].usedAt = NOW.toISOString();
    const expired = newConnectLinkToken();
    s.rows.push({ tokenHash: expired.tokenHash, tenantId: A, createdBy: ADMIN, expiresAt: new Date(NOW.getTime() - 1), usedAt: null });
    const unknown = newConnectLinkToken().token;
    const answers = await Promise.all(["short", `${"x".repeat(42)}!`, used, expired.token, unknown].map((t) => errorOf(readConnectLink(t, "1.2.3.4", s.deps))));
    for (const e of answers) expect(e).toBeInstanceOf(AppError);
    expect(new Set(answers.map((e) => JSON.stringify({ code: e?.code, message: e?.message, fields: e?.fields }))).size).toBe(1);
    expect(answers[0]?.code).toBe("not_found");
  });

  it("answers a malformed token without reading the database", async () => {
    const s = setup();
    await readConnectLink("nope", "1.2.3.4", s.deps).catch(() => {});
    expect(s.log).toEqual([]);
  });

  it("limits a caller, with rate_limited, and reads nothing for the refused call", async () => {
    const s = setup({ limit: false });
    expect(await codeOf(readConnectLink(s.live(), "1.2.3.4", s.deps))).toBe("rate_limited");
    expect(s.log).toEqual([]);
    expect(s.limit).toHaveBeenCalledWith("1.2.3.4");
  });
});

describe("connectWithLink", () => {
  it("answers not_available while off, before the limit, the claim or any database read", async () => {
    const s = setup({ enabled: false });
    expect(await codeOf(connectWithLink({ ...BODY, connectToken: s.live() }, "1.2.3.4", s.deps))).toBe("not_available");
    expect(s.log).toEqual([]);
    expect(s.limit).not.toHaveBeenCalled();
    expect(s.connect).not.toHaveBeenCalled();
    expect(s.rows[0].usedAt).toBeNull();
  });

  it("connects the business the link names, as assisted, and keeps the link used", async () => {
    const s = setup();
    const token = s.live();
    const result = await connectWithLink({ ...BODY, connectToken: token, tenantId: B }, "1.2.3.4", s.deps);
    expect(result.status).toBe("active");
    const [caller, input] = s.connect.mock.calls[0] as [SignupCaller, SignupInput];
    expect(caller).toEqual({ tenantId: A, actor: `assisted:${ADMIN}`, method: "assisted" });
    expect(input).toEqual(BODY);
    expect(s.rows[0].usedAt).not.toBeNull();
    expect(s.log).not.toContain("release");
  });

  it("a second use of the same link is refused with the neutral answer", async () => {
    const s = setup();
    const token = s.live();
    await connectWithLink({ ...BODY, connectToken: token }, "1.2.3.4", s.deps);
    const error = await errorOf(connectWithLink({ ...BODY, connectToken: token }, "1.2.3.4", s.deps));
    expect(error?.code).toBe("not_found");
    expect(s.connect).toHaveBeenCalledTimes(1);
  });

  it("two people using the link at once: exactly one connects, the others get the neutral answer", async () => {
    const s = setup();
    const token = s.live();
    const results = await Promise.allSettled([
      connectWithLink({ ...BODY, connectToken: token }, "1.1.1.1", s.deps),
      connectWithLink({ ...BODY, connectToken: token }, "2.2.2.2", s.deps),
      connectWithLink({ ...BODY, connectToken: token }, "3.3.3.3", s.deps),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(refused.map((r) => (r.reason as AppError).code)).toEqual(["not_found", "not_found"]);
    expect(s.connect).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an unknown", () => newConnectLinkToken().token],
    ["a malformed", () => "short"],
    ["a missing", () => undefined],
  ])("refuses %s token with the neutral answer and connects nothing", async (_n, make) => {
    const s = setup();
    s.live();
    const error = await errorOf(connectWithLink({ ...BODY, connectToken: make() }, "1.2.3.4", s.deps));
    expect(error?.code).toBe("not_found");
    expect(s.connect).not.toHaveBeenCalled();
  });

  it("refuses an expired link with the neutral answer", async () => {
    const s = setup();
    const { token, tokenHash } = newConnectLinkToken();
    s.rows.push({ tokenHash, tenantId: A, createdBy: ADMIN, expiresAt: new Date(NOW.getTime() - 1000), usedAt: null });
    expect(await codeOf(connectWithLink({ ...BODY, connectToken: token }, "1.2.3.4", s.deps))).toBe("not_found");
    expect(s.connect).not.toHaveBeenCalled();
  });

  it("an invalid body is validation_failed and does not touch the link", async () => {
    const s = setup();
    const token = s.live();
    expect(await codeOf(connectWithLink({ ...BODY, phoneNumberId: null, connectToken: token }, "1.2.3.4", s.deps))).toBe("validation_failed");
    expect(s.log).not.toContain("claim");
    expect(s.rows[0].usedAt).toBeNull();
  });

  it("limits a caller before it claims anything", async () => {
    const s = setup({ limit: false });
    const token = s.live();
    expect(await codeOf(connectWithLink({ ...BODY, connectToken: token }, "1.2.3.4", s.deps))).toBe("rate_limited");
    expect(s.rows[0].usedAt).toBeNull();
  });

  it("releases the claim when the connection throws, so the owner can open the popup again, and passes the error on", async () => {
    const s = setup({ connect: async () => Promise.reject(new AppError("upstream_failed", "Facebook did not accept that sign-in.")) });
    const token = s.live();
    expect(await codeOf(connectWithLink({ ...BODY, connectToken: token }, "1.2.3.4", s.deps))).toBe("upstream_failed");
    expect(s.rows[0].usedAt).toBeNull();
    s.connect.mockResolvedValueOnce(CONNECTION("active"));
    expect((await connectWithLink({ ...BODY, connectToken: token }, "1.2.3.4", s.deps)).status).toBe("active");
    expect(s.rows[0].usedAt).not.toBeNull();
  });

  it("does NOT release the claim when the flow throws after the number was saved and is now active for the business", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const s = setup({ connect: async () => Promise.reject(new AppError("upstream_failed", "We couldn't read the connection.")) });
    const token = s.live();
    s.active.add(`${A}:${BODY.phoneNumberId}`);
    expect(await codeOf(connectWithLink({ ...BODY, connectToken: token }, "1.2.3.4", s.deps))).toBe("upstream_failed");
    expect(s.rows[0].usedAt).not.toBeNull();
    expect(s.log).not.toContain("release");
    // so a second number cannot be connected with the same link
    expect(await codeOf(connectWithLink({ ...BODY, phoneNumberId: "200000000000002", connectToken: token }, "1.2.3.4", s.deps))).toBe("not_found");
  });

  it("releases the claim when the check for an active connection itself fails (the safe side for the owner is a retry)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const s = setup({ connect: async () => Promise.reject(new AppError("upstream_failed", "Facebook did not accept that sign-in.")) });
    s.db.activeConnectionExists = async () => Promise.reject(new Error("db down"));
    const token = s.live();
    expect(await codeOf(connectWithLink({ ...BODY, connectToken: token }, "1.2.3.4", s.deps))).toBe("upstream_failed");
    expect(s.rows[0].usedAt).toBeNull();
  });

  it("releases the claim when the connection was saved but failed", async () => {
    const s = setup({ connect: async () => CONNECTION("failed") });
    const token = s.live();
    expect((await connectWithLink({ ...BODY, connectToken: token }, "1.2.3.4", s.deps)).status).toBe("failed");
    expect(s.rows[0].usedAt).toBeNull();
  });

  it("a release that cannot be written does not hide the original error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const s = setup({ connect: async () => Promise.reject(new AppError("conflict", "This phone number is already connected.")) });
    s.db.release = async () => Promise.reject(new Error("db down"));
    expect(await codeOf(connectWithLink({ ...BODY, connectToken: s.live() }, "1.2.3.4", s.deps))).toBe("conflict");
  });

  it("only releases its own claim: a link claimed again by someone else is not freed by a stale release", async () => {
    const s = setup();
    const token = s.live();
    const hash = hashConnectLinkToken(token);
    expect(await s.db.claim(hash, NOW)).not.toBeNull();
    await s.db.release(hash, "2000-01-01T00:00:00.000Z");
    expect(s.rows[0].usedAt).toBe(NOW.toISOString());
  });
});
