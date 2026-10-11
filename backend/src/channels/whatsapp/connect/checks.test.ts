import { describe, expect, it, vi } from "vitest";
import { checkDisplayName, checkNumber, checkPayment, checkToken, checkWebhook, overallOf, runGraphChecks, SAFE, withTestMessage, type Check, type Graph, type GraphAnswer } from "./checks";

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
  it("fails when no app is subscribed to the account", async () => {
    expect(await checkWebhook(args("manual_byo", true), graphOf(answered({ data: [] })), NOW)).toMatchObject({ status: "fail", message: SAFE.webhookNone });
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
