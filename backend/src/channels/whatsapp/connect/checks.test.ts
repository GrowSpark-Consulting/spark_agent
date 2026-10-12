import { describe, expect, it, vi } from "vitest";
import { subscribeApp, withCheck, withWebhookConfirmed, checkDisplayName, checkNumber, checkPayment, checkToken, checkWebhook, isExpiredTokenAnswer, overallOf, runGraphChecks, SAFE, withTestMessage, type Check, type Graph, type GraphAnswer } from "./checks";

// The six validation checks (Day 5): what each one answers for each thing Meta can say, in fixed words. Nothing Meta says and no token is ever in a message.

const NOW = new Date("2026-10-12T09:00:00.000Z");
const TOKEN = "EAAB-synthetic-access-token";
const answered = (body: unknown, ok = true, status = 200): GraphAnswer => ({ state: "answered", ok, status, body });
const UNREACHABLE: GraphAnswer = { state: "unreachable" };
const graphOf = (answer: GraphAnswer): Graph => vi.fn(async () => answer);
const BOTH = ["whatsapp_business_management", "whatsapp_business_messaging"];

describe("1. token and permissions", () => {
  it("passes with a valid token that has both WhatsApp permissions", async () => {
    const c = await checkToken({ token: TOKEN, accepted: true }, graphOf(answered({ data: { is_valid: true, scopes: BOTH } })), NOW);
    expect(c).toMatchObject({ key: "token_permissions", status: "pass", message: SAFE.tokenPass, checked_at: NOW.toISOString() });
  });

  it.each([["management", ["whatsapp_business_messaging"]], ["messaging", ["whatsapp_business_management"]], ["both", ["email"]]])("fails when %s permission is missing", async (_name, scopes) => {
    const c = await checkToken({ token: TOKEN, accepted: true }, graphOf(answered({ data: { is_valid: true, scopes } })), NOW);
    expect(c).toMatchObject({ status: "fail", message: SAFE.tokenScopes });
  });

  it("fails when Meta says the token is not valid, and when the number's own read was refused", async () => {
    expect((await checkToken({ token: TOKEN, accepted: true }, graphOf(answered({ data: { is_valid: false } })), NOW)).status).toBe("fail");
    const refused = vi.fn();
    expect((await checkToken({ token: TOKEN, accepted: false }, refused, NOW)).status).toBe("fail");
    expect(refused).not.toHaveBeenCalled();
  });

  it("is 'not verified' when Meta does not say which permissions the token has", async () => {
    for (const answer of [UNREACHABLE, answered({}, false, 400), answered({ data: {} }), answered(null)]) {
      expect((await checkToken({ token: TOKEN, accepted: true }, graphOf(answer), NOW)).status).toBe("not_verified");
    }
  });

  it("asks Meta with the token itself and the pinned call, and puts it in no message", async () => {
    const call = vi.fn(async () => answered({ data: { is_valid: true, scopes: BOTH } }));
    const c = await checkToken({ token: TOKEN, accepted: true }, call, NOW);
    expect(call).toHaveBeenCalledWith("GET", `debug_token?input_token=${TOKEN}`, TOKEN);
    expect(JSON.stringify(c)).not.toContain(TOKEN);
  });
});

describe("2. the number is in the account and registered for the Cloud API", () => {
  const facts = (platformType: string | null) => ({ nameStatus: "APPROVED", platformType });
  it("passes for a number in the account on the Cloud API, or one Meta does not label", () => {
    expect(checkNumber({ accepted: true, inAccount: true, facts: facts("CLOUD_API") }, NOW).status).toBe("pass");
    expect(checkNumber({ accepted: true, inAccount: true, facts: facts(null) }, NOW).status).toBe("pass");
  });
  it("fails for a number that is in another account", () => {
    expect(checkNumber({ accepted: true, inAccount: false, facts: facts("CLOUD_API") }, NOW)).toMatchObject({ status: "fail", message: SAFE.numberNotInAccount });
  });
  it("fails for a number that is not on the Cloud API", () => {
    expect(checkNumber({ accepted: true, inAccount: true, facts: facts("NOT_APPLICABLE") }, NOW)).toMatchObject({ status: "fail", message: SAFE.numberNotCloud });
  });
  it("is skipped when Meta did not accept the token (the first check already says so)", () => {
    expect(checkNumber({ accepted: false, inAccount: false, facts: facts(null) }, NOW).status).toBe("skipped");
  });
});

describe("3. the webhook", () => {
  const args = (method: string, seen: boolean) => ({ wabaId: "100", token: TOKEN, method, webhookSeen: async () => seen });
  /** Meta: nothing subscribed until a POST subscribed_apps has been accepted, then one app. */
  const account = (post: GraphAnswer, calls: string[] = []): Graph => {
    let subscribed = false;
    return async (method) => {
      calls.push(method);
      if (method === "POST") {
        if (post.state === "answered" && post.ok) subscribed = true;
        return post;
      }
      return answered({ data: subscribed ? [{ id: "1" }] : [] });
    };
  };
  const ACCEPTED = answered({ success: true });
  const REFUSED = answered({ error: { code: 200 } }, false, 403);
  it("when nothing is subscribed it subscribes the app, reads again, and goes on with what it then sees", async () => {
    const calls: string[] = [];
    const seen: boolean[] = [];
    const c = await checkWebhook({ ...args("manual_byo", true), canSubscribe: true, onSubscribed: (s) => seen.push(s as boolean) }, account(ACCEPTED, calls), NOW);
    expect(calls).toEqual(["GET", "POST", "GET"]);
    expect(c).toMatchObject({ status: "pass", message: SAFE.webhookPass });
    expect(seen).toEqual([true]);
  });
  it("never posts when an app is subscribed already (a repeat could reset the subscription's callback)", async () => {
    const call = vi.fn<Graph>(async () => answered({ data: [{ id: "1" }] }));
    const seen: (boolean | null)[] = [];
    await checkWebhook({ ...args("manual_byo", true), canSubscribe: true, onSubscribed: (s) => seen.push(s) }, call, NOW);
    expect(call.mock.calls.map(([m]) => m)).toEqual(["GET"]);
    expect(seen).toEqual([true]);
  });
  it("never posts unless told it may (the number must be in the account first)", async () => {
    const calls: string[] = [];
    const seen: (boolean | null)[] = [];
    const c = await checkWebhook({ ...args("manual_byo", true), onSubscribed: (s) => seen.push(s) }, account(ACCEPTED, calls), NOW);
    expect(calls).toEqual(["GET"]);
    expect(c).toMatchObject({ status: "warn", message: SAFE.webhookNone });
    expect(seen).toEqual([false]);
  });
  it("warns, and never fails, when the attempt was refused and nothing is subscribed, in words that say so", async () => {
    const seen: (boolean | null)[] = [];
    const c = await checkWebhook({ ...args("manual_byo", true), canSubscribe: true, onSubscribed: (s) => seen.push(s) }, account(REFUSED), NOW);
    expect(c).toMatchObject({ status: "warn", message: SAFE.webhookCouldNotSubscribe });
    expect(seen).toEqual([false]);
  });
  it("an accepted attempt that Meta does not yet show is 'not subscribed yet', not 'could not subscribe'", async () => {
    const never: Graph = async (method) => (method === "POST" ? ACCEPTED : answered({ data: [] }));
    expect(await checkWebhook({ ...args("manual_byo", true), canSubscribe: true }, never, NOW)).toMatchObject({ status: "warn", message: SAFE.webhookNone });
  });
  it("an accepted attempt whose re-read Meta does not answer is 'not verified' and null, not 'not subscribed'", async () => {
    let reads = 0;
    const flaky: Graph = async (method) => {
      if (method === "POST") return ACCEPTED;
      return ++reads === 1 ? answered({ data: [] }) : UNREACHABLE;
    };
    const seen: (boolean | null)[] = [];
    const c = await checkWebhook({ ...args("manual_byo", true), canSubscribe: true, onSubscribed: (s) => seen.push(s) }, flaky, NOW);
    expect(c.status).toBe("not_verified");
    expect(seen).toEqual([null]);
  });
  it("reports nothing it could not find out: Meta not answering is 'not verified' and onSubscribed says null", async () => {
    const seen: (boolean | null)[] = [];
    const c = await checkWebhook({ ...args("manual_byo", true), canSubscribe: true, onSubscribed: (s) => seen.push(s) }, graphOf(UNREACHABLE), NOW);
    expect(c.status).toBe("not_verified");
    expect(seen).toEqual([null]);
  });
  it("for a manual_byo number passes only once a signed webhook from its own app has arrived, and waits until then", async () => {
    const subscribed = graphOf(answered({ data: [{ id: "1" }] }));
    expect(await checkWebhook(args("manual_byo", true), subscribed, NOW)).toMatchObject({ status: "pass", message: SAFE.webhookPass });
    expect(await checkWebhook(args("manual_byo", false), subscribed, NOW)).toMatchObject({ status: "not_verified", message: SAFE.webhookWaiting });
  });
  it("for any other method an app subscribed to the account is enough", async () => {
    expect(await checkWebhook(args("embedded_signup", false), graphOf(answered({ data: [{ id: "1" }] })), NOW)).toMatchObject({ status: "pass", message: SAFE.webhookPassPlatform });
  });
  it("is 'not verified' when Meta does not answer or answers something else", async () => {
    for (const answer of [UNREACHABLE, answered({}, false, 403), answered({ data: "x" })]) {
      expect((await checkWebhook(args("manual_byo", true), graphOf(answer), NOW)).status).toBe("not_verified");
    }
  });
});

describe("subscribing the app to the account's webhooks (best effort)", () => {
  it("POSTs to the account's subscribed_apps with the token, and is true when Meta says yes", async () => {
    const call = vi.fn(async () => answered({ success: true }));
    expect(await subscribeApp({ wabaId: "100", token: TOKEN }, call)).toBe(true);
    expect(call).toHaveBeenCalledWith("POST", "100/subscribed_apps", TOKEN);
  });
  it("is false, and throws nothing, when Meta refuses, does not answer, or does not say success is true", async () => {
    for (const answer of [answered({ error: { code: 200 } }, false, 403), UNREACHABLE, answered({ success: false }), answered(null), answered({})]) {
      expect(await subscribeApp({ wabaId: "100", token: TOKEN }, graphOf(answer))).toBe(false);
    }
  });
  it("is false when the call itself throws", async () => {
    const boom: Graph = async () => {
      throw new Error("boom");
    };
    expect(await subscribeApp({ wabaId: "100", token: TOKEN }, boom)).toBe(false);
  });
});

describe("4. the display name", () => {
  const status = (nameStatus: string | null) => checkDisplayName({ nameStatus, platformType: null }, NOW).status;
  it("passes when approved, warns while it is in review, fails when declined, and is 'not verified' when Meta does not say", () => {
    expect(status("APPROVED")).toBe("pass");
    expect(status("approved")).toBe("pass");
    expect(status("PENDING_REVIEW")).toBe("warn");
    expect(status("NONE")).toBe("warn");
    expect(status("DECLINED")).toBe("fail");
    expect(status(null)).toBe("not_verified");
  });
});

describe("5. the payment method", () => {
  it("passes with a funding source, warns without one (the number still connects), and is 'not verified' when Meta does not say", async () => {
    expect((await checkPayment({ wabaId: "100", token: TOKEN }, graphOf(answered({ primary_funding_id: "55" })), NOW)).status).toBe("pass");
    expect((await checkPayment({ wabaId: "100", token: TOKEN }, graphOf(answered({ id: "100" })), NOW)).status).toBe("warn");
    expect((await checkPayment({ wabaId: "100", token: TOKEN }, graphOf(answered({}, false, 403)), NOW)).status).toBe("not_verified");
    expect((await checkPayment({ wabaId: "100", token: TOKEN }, graphOf(UNREACHABLE), NOW)).status).toBe("not_verified");
  });
});

describe("overall", () => {
  const c = (status: Check["status"]): Check => ({ key: "payment_method", status, message: "", checked_at: "" });
  it("is fail if any check fails, warn if any warns or is not verified, otherwise pass; skipped counts for nothing", () => {
    expect(overallOf([c("pass"), c("fail"), c("warn")])).toBe("fail");
    expect(overallOf([c("pass"), c("warn")])).toBe("warn");
    expect(overallOf([c("pass"), c("not_verified")])).toBe("warn");
    expect(overallOf([c("pass"), c("skipped")])).toBe("pass");
  });
});

describe("all of them together", () => {
  const healthy: Graph = async (_m, path) => {
    if (path.startsWith("debug_token")) return answered({ data: { is_valid: true, scopes: BOTH } });
    if (path.endsWith("/subscribed_apps")) return answered({ data: [{ id: "1" }] });
    return answered({ primary_funding_id: "1" });
  };
  const input = { wabaId: "100", token: TOKEN, method: "manual_byo", accepted: true, inAccount: true, facts: { nameStatus: "APPROVED", platformType: "CLOUD_API" }, webhookSeen: async () => true };

  it("answers in the contract's order, with the sixth not checked yet", async () => {
    const last = await runGraphChecks(input, healthy, NOW);
    expect(last.checks.map((x) => x.key)).toEqual(["token_permissions", "number_registered", "webhook_subscribed", "display_name_approved", "payment_method", "test_message_delivered"]);
    expect(last.checks.map((x) => x.status)).toEqual(["pass", "pass", "pass", "pass", "pass", "not_verified"]);
    expect(last.ran_at).toBe(NOW.toISOString());
  });

  it("an account nothing could subscribe to is a warning on the webhook check, not a failure of the connection", async () => {
    const none: Graph = async (m, path) => (path.endsWith("/subscribed_apps") ? (m === "POST" ? answered({ error: { code: 200 } }, false, 403) : answered({ data: [] })) : healthy(m, path, ""));
    const seen: (boolean | null)[] = [];
    const last = await runGraphChecks({ ...input, onSubscribed: (s) => seen.push(s) }, none, NOW);
    expect(last.checks[2]).toMatchObject({ status: "warn", message: SAFE.webhookCouldNotSubscribe });
    expect(last.overall).toBe("warn");
    expect(seen).toEqual([false]);
  });

  it("does not subscribe while the token check does not pass (a token without both permissions is not written with)", async () => {
    const weak: Graph = async (m, path) => {
      if (path.startsWith("debug_token")) return answered({ data: { is_valid: true, scopes: ["whatsapp_business_messaging"] } });
      if (path.endsWith("/subscribed_apps")) return answered({ data: [] });
      return healthy(m, path, "");
    };
    const call = vi.fn(weak);
    await runGraphChecks(input, call, NOW);
    expect(call.mock.calls.some(([m]) => m === "POST")).toBe(false);
  });

  it("does not subscribe an account the number is not in, and reports nothing was asked when the token was not accepted", async () => {
    const call = vi.fn(async (m: string, path: string) => (path.endsWith("/subscribed_apps") ? answered({ data: [] }) : healthy(m as "GET", path, "")));
    await runGraphChecks({ ...input, inAccount: false }, call as unknown as Graph, NOW);
    expect(call.mock.calls.filter(([m]) => m === "POST")).toEqual([]);
    const seen: (boolean | null)[] = [];
    await runGraphChecks({ ...input, accepted: false, onSubscribed: (s) => seen.push(s) }, vi.fn(healthy), NOW);
    expect(seen).toEqual([]);
  });

  it("a wrong token fails the first check and skips what cannot be asked, without calling Meta again", async () => {
    const call = vi.fn(healthy);
    const last = await runGraphChecks({ ...input, accepted: false, inAccount: false }, call, NOW);
    expect(last.overall).toBe("fail");
    expect(last.checks.map((x) => x.status)).toEqual(["fail", "skipped", "skipped", "skipped", "skipped", "not_verified"]);
    expect(call).not.toHaveBeenCalled();
  });

  it("one check failing does not hide the others", async () => {
    const last = await runGraphChecks({ ...input, facts: { nameStatus: "DECLINED", platformType: "CLOUD_API" } }, healthy, NOW);
    expect(last.overall).toBe("fail");
    expect(last.checks.map((x) => x.status)).toEqual(["pass", "pass", "pass", "fail", "pass", "not_verified"]);
  });

  it("the sixth check, once known, replaces the placeholder and overall is worked out again", async () => {
    const last = await runGraphChecks(input, healthy, NOW);
    const sixth: Check = { key: "test_message_delivered", status: "pass", message: "ok", checked_at: NOW.toISOString() };
    const full = withTestMessage(last, sixth);
    expect(full.checks[5]).toEqual(sixth);
    expect(full.overall).toBe("pass");
    expect(last.overall).toBe("warn");
  });

  it("no message in any result holds the token", async () => {
    const last = await runGraphChecks(input, healthy, NOW);
    expect(JSON.stringify(last)).not.toContain(TOKEN);
  });
});

describe("swapping one check in a stored result", () => {
  const stored = (webhook: Check["status"], payment: Check["status"] = "pass") => {
    const checks: Check[] = [
      { key: "token_permissions", status: "pass", message: "m", checked_at: NOW.toISOString() },
      { key: "webhook_subscribed", status: webhook, message: SAFE.webhookWaiting, checked_at: NOW.toISOString() },
      { key: "payment_method", status: payment, message: "m", checked_at: NOW.toISOString() },
    ];
    return { ran_at: NOW.toISOString(), overall: overallOf(checks), checks };
  };
  it("withCheck replaces the check with that key and works overall out again", () => {
    const next = withCheck(stored("not_verified"), { key: "webhook_subscribed", status: "pass", message: "ok", checked_at: NOW.toISOString() });
    expect(next.checks[1]).toMatchObject({ status: "pass", message: "ok" });
    expect(next.overall).toBe("pass");
    expect(next.ran_at).toBe(NOW.toISOString());
  });
  it("withWebhookConfirmed turns a waiting webhook check into a pass and nothing else", () => {
    const later = new Date("2026-10-12T09:05:00.000Z");
    const next = withWebhookConfirmed(stored("not_verified", "warn"), later);
    expect(next.checks[1]).toMatchObject({ key: "webhook_subscribed", status: "pass", message: SAFE.webhookPass, checked_at: later.toISOString() });
    expect(next.overall).toBe("warn");
    expect(next.checks[0]).toEqual(stored("not_verified").checks[0]);
  });
  it("withWebhookConfirmed leaves every other state as it is, and returns the same object when there is nothing to change", () => {
    for (const status of ["pass", "warn", "fail", "skipped"] as const) {
      const last = stored(status);
      expect(withWebhookConfirmed(last, NOW)).toBe(last);
    }
  });
});

describe("1. token: one that has expired (Meta error 190 or HTTP 401)", () => {
  const expired = (text: string) => expect(text).toBe(SAFE.tokenExpired);

  it("says so, in fixed words, when the number's own read was refused as expired", async () => {
    const refused = vi.fn();
    const c = await checkToken({ token: TOKEN, accepted: false, expired: true }, refused, NOW);
    expect(c).toMatchObject({ key: "token_permissions", status: "fail" });
    expired(c.message);
    expect(refused).not.toHaveBeenCalled();
  });

  it("says so when debug_token answers with error 190, with HTTP 401, or with a token that is not valid and has run out", async () => {
    for (const answer of [answered({ error: { code: 190, type: "OAuthException" } }, false, 400), answered({}, false, 401), answered({ data: { is_valid: false, error: { code: 190 } } }), answered({ data: { is_valid: false, expires_at: 1 } })]) {
      const c = await checkToken({ token: TOKEN, accepted: true }, graphOf(answer), NOW);
      expect(c.status).toBe("fail");
      expired(c.message);
    }
  });

  it("keeps the general message for a token that is not valid for another reason", async () => {
    const c = await checkToken({ token: TOKEN, accepted: true }, graphOf(answered({ data: { is_valid: false } })), NOW);
    expect(c.message).toBe(SAFE.tokenFail);
  });

  it("tells an expired answer from the rest: code 190 or HTTP 401 only", () => {
    expect(isExpiredTokenAnswer(400, { error: { code: 190 } })).toBe(true);
    expect(isExpiredTokenAnswer(401, null)).toBe(true);
    expect(isExpiredTokenAnswer(400, { error: { code: 100 } })).toBe(false);
    expect(isExpiredTokenAnswer(403, { error: { code: 10 } })).toBe(false);
    expect(isExpiredTokenAnswer(200, { error: "190" })).toBe(false);
    expect(isExpiredTokenAnswer(400, undefined)).toBe(false);
  });

  it("the message names no token and nothing Meta said, and tells the person what to do", () => {
    expect(SAFE.tokenExpired).toBe("The access token has expired or is no longer valid. Create a new one in Meta and connect the number again.");
  });
});
