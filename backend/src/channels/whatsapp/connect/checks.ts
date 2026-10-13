import { serverEnv } from "../../../lib/env";

// The six validation checks of a WhatsApp connection (docs/whatsapp-connection-contract.md, `last_check`). Each one is a small function that answers with a
// `Check`; `runGraphChecks` runs the five that need only Meta's answers (the sixth, the test message, goes through notify.send and is in test-message-check.ts).
//
// UNVERIFIED against a live Meta account: the Graph paths and field names below follow Meta's documentation as we understand it and must be confirmed with a
// real number. A check that cannot be answered (Meta did not say, or the field is missing) is `not_verified`, never a guess and never a block (Day 5 fallback).
// Every message is fixed text: nothing Meta said, and no token, is ever put in a message.

export type CheckStatus = "pass" | "warn" | "fail" | "not_verified" | "skipped";
export type CheckKey = "token_permissions" | "number_registered" | "webhook_subscribed" | "display_name_approved" | "payment_method" | "test_message_delivered";
export type Check = { key: CheckKey; status: CheckStatus; message: string; checked_at: string };
export type LastCheck = { ran_at: string; overall: "pass" | "warn" | "fail"; checks: Check[] };

/** Meta's answer to one Graph call: a status and a body, or nothing at all when it could not be reached. */
export type GraphAnswer = { state: "answered"; ok: boolean; status: number; body: unknown } | { state: "unreachable" };
export type Graph = (method: "GET" | "POST" | "DELETE", path: string, token: string, body?: unknown) => Promise<GraphAnswer>;

/** The real Graph client: the pinned version, the client's own token, ten seconds at most. */
export const graph: Graph = async (method, path, token, body) => {
  try {
    const res = await fetch(`https://graph.facebook.com/${serverEnv().META_GRAPH_API_VERSION}/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    const answer: GraphAnswer = { state: "answered", ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
    return answer.status >= 500 || answer.status === 429 ? { state: "unreachable" } : answer;
  } catch {
    return { state: "unreachable" };
  }
};

export const REQUIRED_SCOPES = ["whatsapp_business_management", "whatsapp_business_messaging"] as const;

export const SAFE = {
  tokenPass: "Meta accepted the access token for this number.",
  tokenFail: "Meta did not accept the access token or the Phone number ID. Check both, and that the token can manage this WhatsApp account.",
  tokenScopes: "The access token is missing a WhatsApp permission. It needs both whatsapp_business_management and whatsapp_business_messaging.",
  tokenExpired: "The access token has expired or is no longer valid. Create a new one in Meta and connect the number again.",
  tokenUnknown: "Meta accepted the token, but we could not confirm which permissions it has.",
  numberPass: "The number belongs to this WhatsApp Business Account and is set up for the Cloud API.",
  numberNotInAccount: "This number isn't in that WhatsApp Business Account. Check the Account ID and the Phone number ID.",
  numberNotCloud: "This number is not registered for the WhatsApp Cloud API yet. Register it in Meta's WhatsApp Manager, then check again.",
  webhookNone: "Your Meta app is not subscribed to this account's webhooks yet. Subscribe it in your app's WhatsApp settings, then check again.",
  webhookCouldNotSubscribe: "We couldn't subscribe your Meta app to this account's webhooks automatically. Subscribe it in your app's WhatsApp settings, then check again.",
  webhookWaiting: "Your app is subscribed. This is confirmed when a webhook from your app arrives: send a message to this number from a phone, or use Test in Meta's webhook settings, then check again.",
  webhookPass: "Your app is subscribed, and a signed webhook from it has arrived.",
  webhookPassPlatform: "Spark Agent's app is subscribed to this account's webhooks.",
  webhookUnknown: "We could not read this account's webhook subscriptions.",
  namePass: "The display name is approved.",
  namePending: "The display name is waiting for Meta's review. Messages can still be sent while it is reviewed.",
  nameFail: "Meta declined the display name. Change it in WhatsApp Manager and submit it again.",
  nameUnknown: "We could not read the display name's approval status.",
  paymentPass: "A payment method is on this WhatsApp Business Account.",
  paymentWarn: "No payment method is on this WhatsApp Business Account. The number is connected, but template messages will not send until one is added in Meta's billing settings.",
  paymentUnknown: "We could not read this account's payment method.",
  later: "Not checked yet.",
} as const;

const asRecord = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const at = (now: Date) => now.toISOString();
const make = (key: CheckKey, status: CheckStatus, message: string, now: Date): Check => ({ key, status, message, checked_at: at(now) });

/** What the number's own record says (one Graph read, made by `probeMeta` in manual.ts). */
export interface NumberFacts {
  nameStatus: string | null;
  platformType: string | null;
}

/** Meta's way of saying a token has expired or is no longer valid: OAuth error code 190 in the body, or HTTP 401. Nothing else counts. */
export function isExpiredTokenAnswer(status: number, body: unknown): boolean {
  return status === 401 || asRecord(asRecord(body).error).code === 190;
}

/** 1. The token is valid and carries both WhatsApp permissions (`debug_token`, asked with the token itself). `expired` is set when the number's own read was refused as an expired token. */
export async function checkToken(
  args: { token: string; accepted: boolean; expired?: boolean; onExpiry?: (expiresAt: Date | null) => void },
  call: Graph,
  now: Date,
): Promise<Check> {
  if (!args.accepted) return make("token_permissions", "fail", args.expired ? SAFE.tokenExpired : SAFE.tokenFail, now);
  const answer = await call("GET", `debug_token?input_token=${encodeURIComponent(args.token)}`, args.token);
  if (answer.state === "answered" && !answer.ok && isExpiredTokenAnswer(answer.status, answer.body)) return make("token_permissions", "fail", SAFE.tokenExpired, now);
  if (answer.state !== "answered" || !answer.ok) return make("token_permissions", "not_verified", SAFE.tokenUnknown, now);
  const data = asRecord(asRecord(answer.body).data);
  // When the token runs out, if Meta says: `expires_at` in seconds, 0 for a token that never expires. Told even when the token is no longer valid.
  if (typeof data.expires_at === "number" && Number.isFinite(data.expires_at) && data.expires_at >= 0) {
    const expiresAt = new Date(data.expires_at * 1000);
    // A date that is not one (a huge number) is "Meta did not say", never an exception later.
    if (data.expires_at === 0) args.onExpiry?.(null);
    else if (!Number.isNaN(expiresAt.getTime()) && expiresAt.getUTCFullYear() <= 2200) args.onExpiry?.(expiresAt);
  }
  if (data.is_valid === false) {
    const ranOut = typeof data.expires_at === "number" && data.expires_at > 0 && data.expires_at * 1000 <= now.getTime();
    return make("token_permissions", "fail", ranOut || asRecord(data.error).code === 190 ? SAFE.tokenExpired : SAFE.tokenFail, now);
  }
  if (!Array.isArray(data.scopes)) return make("token_permissions", "not_verified", SAFE.tokenUnknown, now);
  const scopes = new Set(data.scopes.map(String));
  return REQUIRED_SCOPES.every((s) => scopes.has(s)) ? make("token_permissions", "pass", SAFE.tokenPass, now) : make("token_permissions", "fail", SAFE.tokenScopes, now);
}

/** 2. The number is in the account and is registered for the Cloud API (`platform_type` of the number, when Meta says it). */
export function checkNumber(args: { accepted: boolean; inAccount: boolean; facts: NumberFacts }, now: Date): Check {
  if (!args.accepted) return make("number_registered", "skipped", SAFE.later, now);
  if (!args.inAccount) return make("number_registered", "fail", SAFE.numberNotInAccount, now);
  if (args.facts.platformType !== null && args.facts.platformType !== "CLOUD_API") return make("number_registered", "fail", SAFE.numberNotCloud, now);
  return make("number_registered", "pass", SAFE.numberPass, now);
}

/**
 * Subscribes the app that owns the token to the account's webhooks (`POST subscribed_apps`). Call it only when none is subscribed (`checkWebhook` does): a repeat
 * on an account that has one is not known to leave its callback alone. Best effort: false when Meta refuses, does not answer, does not say `success: true` or the
 * call throws, and nothing here ever stops a connection.
 */
export async function subscribeApp(args: { wabaId: string; token: string }, call: Graph): Promise<boolean> {
  try {
    const answer = await call("POST", `${args.wabaId}/subscribed_apps`, args.token);
    return answer.state === "answered" && answer.ok && asRecord(answer.body).success === true;
  } catch {
    return false;
  }
}

/** The apps Meta lists as subscribed to the account, or null when it did not say. */
async function subscribedApps(args: { wabaId: string; token: string }, call: Graph): Promise<unknown[] | null> {
  const answer = await call("GET", `${args.wabaId}/subscribed_apps`, args.token);
  if (answer.state !== "answered" || !answer.ok) return null;
  const apps = asRecord(answer.body).data;
  return Array.isArray(apps) ? apps : null;
}

/**
 * 3. An app is subscribed to the account's webhooks (`subscribed_apps`). Only when none is, and `canSubscribe` says the number is in this account, the app that owns
 * the token is subscribed (`subscribeApp`, best effort) and the list is read again; an account that already has an app is never posted to. Nothing subscribed
 * after that is a warning, never a failure. `onSubscribed` is told the outcome for the audit: true when an app is subscribed, false when none is, null when Meta
 * did not say. For `manual_byo` the client's own app is the one subscribed, so a signed webhook from it must also have arrived (`webhookSeen`); until then the
 * check waits instead of failing.
 */
export async function checkWebhook(
  args: { wabaId: string; token: string; method: string; webhookSeen: () => Promise<boolean>; canSubscribe?: boolean; onSubscribed?: (subscribed: boolean | null) => void },
  call: Graph,
  now: Date,
): Promise<Check> {
  let apps = await subscribedApps(args, call);
  if (apps === null) {
    args.onSubscribed?.(null);
    return make("webhook_subscribed", "not_verified", SAFE.webhookUnknown, now);
  }
  let attemptFailed = false;
  if (apps.length === 0 && args.canSubscribe === true) {
    if (await subscribeApp(args, call)) {
      apps = await subscribedApps(args, call);
      if (apps === null) {
        args.onSubscribed?.(null);
        return make("webhook_subscribed", "not_verified", SAFE.webhookUnknown, now);
      }
    } else attemptFailed = true;
  }
  args.onSubscribed?.(apps.length > 0);
  if (apps.length === 0) return make("webhook_subscribed", "warn", attemptFailed ? SAFE.webhookCouldNotSubscribe : SAFE.webhookNone, now);
  if (args.method !== "manual_byo") return make("webhook_subscribed", "pass", SAFE.webhookPassPlatform, now);
  return (await args.webhookSeen()) ? make("webhook_subscribed", "pass", SAFE.webhookPass, now) : make("webhook_subscribed", "not_verified", SAFE.webhookWaiting, now);
}

/** 4. The display name is approved (`name_status` of the number). Waiting for review is a warning; a decline fails. */
export function checkDisplayName(facts: NumberFacts, now: Date): Check {
  const status = facts.nameStatus?.toUpperCase() ?? null;
  if (status === null) return make("display_name_approved", "not_verified", SAFE.nameUnknown, now);
  if (status === "APPROVED" || status === "AVAILABLE_WITHOUT_REVIEW") return make("display_name_approved", "pass", SAFE.namePass, now);
  if (status === "DECLINED" || status === "REJECTED") return make("display_name_approved", "fail", SAFE.nameFail, now);
  return make("display_name_approved", "warn", SAFE.namePending, now);
}

/** 5. A payment method is on the account (`primary_funding_id`). Missing is only a warning: the number still connects. */
export async function checkPayment(args: { wabaId: string; token: string }, call: Graph, now: Date): Promise<Check> {
  const answer = await call("GET", `${args.wabaId}?fields=primary_funding_id`, args.token);
  if (answer.state !== "answered" || !answer.ok) return make("payment_method", "not_verified", SAFE.paymentUnknown, now);
  return text(asRecord(answer.body).primary_funding_id) !== null ? make("payment_method", "pass", SAFE.paymentPass, now) : make("payment_method", "warn", SAFE.paymentWarn, now);
}

/** `fail` if any check fails; `warn` if none fail but any warns or is not verified; otherwise `pass`. */
export function overallOf(checks: readonly Check[]): LastCheck["overall"] {
  if (checks.some((c) => c.status === "fail")) return "fail";
  return checks.some((c) => c.status === "warn" || c.status === "not_verified") ? "warn" : "pass";
}

/** The sixth check as it stands before the test message is tried. */
export const testMessageNotYet = (now: Date): Check => make("test_message_delivered", "not_verified", SAFE.later, now);

/** Puts a new check in place of the one with its key and works out `overall` again. `ran_at` is left as it was. */
export function withCheck(last: LastCheck, check: Check): LastCheck {
  const checks = last.checks.map((c) => (c.key === check.key ? check : c));
  return { ...last, checks, overall: overallOf(checks) };
}

/** Puts a new sixth check into a result and works out `overall` again. */
export function withTestMessage(last: LastCheck, check: Check): LastCheck {
  return withCheck(last, check);
}

/**
 * A signed webhook from the business's own app has arrived: a webhook check that was only waiting for it (`not_verified`) becomes a pass. Anything else, including a
 * warning that Meta lists no subscription, is left as it is, and the same object comes back when nothing changes.
 */
export function withWebhookConfirmed(last: LastCheck, now: Date): LastCheck {
  const waiting = last.checks.find((c) => c.key === "webhook_subscribed" && c.status === "not_verified");
  return waiting ? withCheck(last, make("webhook_subscribed", "pass", SAFE.webhookPass, now)) : last;
}

export interface GraphChecksInput {
  wabaId: string;
  token: string;
  method: string;
  /** The Graph answered for the number and the account (manual.ts `probeMeta`). */
  accepted: boolean;
  /** Meta refused the number's read because the token has expired (only meaningful when `accepted` is false). */
  tokenExpired?: boolean;
  /** Told whether an app is subscribed to the account after the webhook check (true, false, or null when Meta did not say). Not called when the check is skipped. */
  onSubscribed?: (subscribed: boolean | null) => void;
  /** False: never ask Meta to subscribe the app (the daily health check only looks). Default true. */
  allowSubscribe?: boolean;
  /** Told when the token runs out (a date), that it never does (null), and not at all when Meta did not say or the token was not looked at. */
  onTokenExpiry?: (expiresAt: Date | null) => void;
  inAccount: boolean;
  facts: NumberFacts;
  webhookSeen: () => Promise<boolean>;
}

/** The first five checks, in the contract's order, and the sixth as "not checked yet". The checks are independent: one failing never hides another. */
export async function runGraphChecks(input: GraphChecksInput, call: Graph, now: Date): Promise<LastCheck> {
  // The token is checked first: the app is only subscribed (a write to the client's account) with a token that has both WhatsApp permissions.
  const token = await checkToken({ token: input.token, accepted: input.accepted, expired: input.tokenExpired === true, ...(input.onTokenExpiry ? { onExpiry: input.onTokenExpiry } : {}) }, call, now);
  const [webhook, payment] = await Promise.all([
    input.accepted ? checkWebhook({ wabaId: input.wabaId, token: input.token, method: input.method, webhookSeen: input.webhookSeen, canSubscribe: input.allowSubscribe !== false && input.inAccount && token.status === "pass", ...(input.onSubscribed && { onSubscribed: input.onSubscribed }) }, call, now) : Promise.resolve(make("webhook_subscribed", "skipped", SAFE.later, now)),
    input.accepted ? checkPayment({ wabaId: input.wabaId, token: input.token }, call, now) : Promise.resolve(make("payment_method", "skipped", SAFE.later, now)),
  ]);
  const checks: Check[] = [
    token,
    checkNumber({ accepted: input.accepted, inAccount: input.inAccount, facts: input.facts }, now),
    webhook,
    input.accepted ? checkDisplayName(input.facts, now) : make("display_name_approved", "skipped", SAFE.later, now),
    payment,
    testMessageNotYet(now),
  ];
  return { ran_at: at(now), overall: overallOf(checks), checks };
}
