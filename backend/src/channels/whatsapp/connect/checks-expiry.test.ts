import { describe, expect, it, vi } from "vitest";
import { checkToken, runGraphChecks, SAFE, type Graph, type GraphAnswer } from "./checks";

// When the access token runs out (token-expiry job): the token check reads `expires_at` from debug_token, which is the one place Meta says it.
// 0 means the token never expires. Nothing else about the check changes.

const NOW = new Date("2026-10-13T02:00:00.000Z");
const BOTH = ["whatsapp_business_management", "whatsapp_business_messaging"];
const answered = (body: unknown, ok = true, status = 200): GraphAnswer => ({ state: "answered", ok, status, body });
const debug = (data: unknown, ok = true, status = 200): Graph => async () => answered({ data }, ok, status);

describe("the token's expiry, read from debug_token", () => {
  it("is told when a token expires", async () => {
    const onExpiry = vi.fn();
    const check = await checkToken({ token: "t", accepted: true, onExpiry }, debug({ is_valid: true, scopes: BOTH, expires_at: 1792000000 }), NOW);
    expect(onExpiry).toHaveBeenCalledWith(new Date(1792000000 * 1000));
    expect(check.status).toBe("pass");
  });

  it("is told null for a token that never expires (expires_at 0)", async () => {
    const onExpiry = vi.fn();
    await checkToken({ token: "t", accepted: true, onExpiry }, debug({ is_valid: true, scopes: BOTH, expires_at: 0 }), NOW);
    expect(onExpiry).toHaveBeenCalledWith(null);
  });

  it("is not told anything when Meta does not say", async () => {
    const onExpiry = vi.fn();
    await checkToken({ token: "t", accepted: true, onExpiry }, debug({ is_valid: true, scopes: BOTH }), NOW);
    await checkToken({ token: "t", accepted: true, onExpiry }, debug({ is_valid: true, scopes: BOTH, expires_at: "soon" }), NOW);
    await checkToken({ token: "t", accepted: true, onExpiry }, debug({ error: { code: 1 } }, false, 400), NOW);
    await checkToken({ token: "t", accepted: true, onExpiry }, async () => ({ state: "unreachable" }), NOW);
    expect(onExpiry).not.toHaveBeenCalled();
  });

  it("is not told a date that is not one (a number too big to be a date), and nothing throws", async () => {
    const onExpiry = vi.fn();
    for (const expires_at of [1e15, 1e300, 9007199254740991, 99999999999]) {
      const check = await checkToken({ token: "t", accepted: true, onExpiry }, debug({ is_valid: true, scopes: BOTH, expires_at }), NOW);
      expect(check.status).toBe("pass");
    }
    expect(onExpiry).not.toHaveBeenCalled();
  });

  it("is not told anything when the number was not accepted, and debug_token is not even asked", async () => {
    const onExpiry = vi.fn();
    const graph = vi.fn<Graph>();
    await checkToken({ token: "t", accepted: false, onExpiry }, graph, NOW);
    expect(onExpiry).not.toHaveBeenCalled();
    expect(graph).not.toHaveBeenCalled();
  });

  it("an expired token still fails with the expired message, and its expiry is reported", async () => {
    const onExpiry = vi.fn();
    const check = await checkToken({ token: "t", accepted: true, onExpiry }, debug({ is_valid: false, expires_at: 1700000000 }), NOW);
    expect(check).toMatchObject({ status: "fail", message: SAFE.tokenExpired });
    expect(onExpiry).toHaveBeenCalledWith(new Date(1700000000 * 1000));
  });

  it("runGraphChecks passes the callback on and works without it", async () => {
    const onTokenExpiry = vi.fn();
    const graph: Graph = async (_method, path) => (path.startsWith("debug_token") ? answered({ data: { is_valid: true, scopes: BOTH, expires_at: 1792000000 } }) : answered({ data: [{ id: "1" }], primary_funding_id: "1" }));
    const input = { wabaId: "100", token: "t", method: "manual_byo", accepted: true, inAccount: true, facts: { nameStatus: "APPROVED", platformType: "CLOUD_API" }, webhookSeen: async () => true };
    const last = await runGraphChecks({ ...input, onTokenExpiry }, graph, NOW);
    expect(onTokenExpiry).toHaveBeenCalledWith(new Date(1792000000 * 1000));
    expect((await runGraphChecks(input, graph, NOW)).checks[0]).toEqual(last.checks[0]);
  });
});
