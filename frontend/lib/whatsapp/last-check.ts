import { z } from "zod";

// `last_check` of a WhatsApp connection, as the recheck, connect and webhook code write it (backend/src/channels/whatsapp/connect/checks.ts,
// docs/whatsapp-connection-contract.md "last_check"):
//   { ran_at, overall: "pass" | "warn" | "fail", checks: [{ key, status, message, checked_at }] }
// The connection view (`whatsapp_connections_public`) types it as a free record (packages/types connection.ts), and a number connected
// before the checks existed has `{}` ("never checked"). So it is read here, not trusted: a shape that doesn't match is "unreadable",
// shown as such and never half-drawn. Each `message` is written by the API to be shown as it is (no token, no secret, nothing Meta said).

export const CHECK_KEYS = [
  "token_permissions",
  "number_registered",
  "webhook_subscribed",
  "display_name_approved",
  "payment_method",
  "test_message_delivered",
] as const;
export type CheckKey = (typeof CHECK_KEYS)[number];

const CheckStatus = z.enum(["pass", "warn", "fail", "not_verified", "skipped"]);
export type CheckStatus = z.infer<typeof CheckStatus>;

const Check = z.object({ key: z.string().min(1), status: CheckStatus, message: z.string(), checked_at: z.string() });
export type Check = z.infer<typeof Check>;

const LastCheck = z.object({ ran_at: z.string(), overall: z.enum(["pass", "warn", "fail"]), checks: z.array(Check) });

export type ParsedLastCheck =
  /** `{}`: the number has never been checked. Nothing is claimed about it. */
  | { state: "never" }
  /** Something is stored, but not in the contract's shape (an older format, say). Nothing is claimed about it either. */
  | { state: "unreadable" }
  | { state: "checked"; ranAt: string; overall: "pass" | "warn" | "fail"; checks: Check[] };

const orderOf = (key: string) => {
  const index = (CHECK_KEYS as readonly string[]).indexOf(key);
  return index === -1 ? CHECK_KEYS.length : index;
};

export function parseLastCheck(raw: unknown): ParsedLastCheck {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw) && Object.keys(raw).length === 0) return { state: "never" };
  const parsed = LastCheck.safeParse(raw);
  if (!parsed.success || parsed.data.checks.length === 0) return { state: "unreadable" };
  const { ran_at, overall, checks } = parsed.data;
  // The contract's order, whatever order they arrived in; a key we don't know goes last, in arrival order.
  const ordered = checks.map((check, index) => ({ check, index })).sort((a, b) => orderOf(a.check.key) - orderOf(b.check.key) || a.index - b.index);
  return { state: "checked", ranAt: ran_at, overall, checks: ordered.map((o) => o.check) };
}

const TITLE: Record<CheckKey, string> = {
  token_permissions: "Access and permissions",
  number_registered: "Number on the Cloud API",
  webhook_subscribed: "Webhook delivery",
  display_name_approved: "Display name",
  payment_method: "Payment method",
  test_message_delivered: "Test message",
};

export function checkTitle(key: string): string {
  return Object.hasOwn(TITLE, key) ? TITLE[key as CheckKey] : "Another check";
}

export type Tone = "ok" | "warn" | "off";

const STATUS: Record<CheckStatus, { label: string; tone: Tone }> = {
  pass: { label: "Passed", tone: "ok" },
  warn: { label: "Warning", tone: "warn" },
  fail: { label: "Failed", tone: "warn" },
  not_verified: { label: "Not confirmed yet", tone: "off" },
  skipped: { label: "Skipped", tone: "off" },
};

export const checkStatus = (status: CheckStatus) => STATUS[status];

/** One sentence for the whole run, claiming only what `overall` proves. */
export function overallSummary(overall: "pass" | "warn" | "fail", count: number): string {
  if (overall === "pass") return `All ${count} checks passed.`;
  if (overall === "warn") return "No check failed, but some are still waiting or have a warning.";
  return "At least one check failed, so messages aren't being sent.";
}

/**
 * Whether the number is connected but nothing proves that customers' messages reach the assistant: the
 * `webhook_subscribed` check is missing or anything other than `pass`. false when the number was never checked or
 * its result is unreadable (nothing is known either way, so nothing extra is said).
 */
export function webhookUnconfirmed(last: ParsedLastCheck): boolean {
  if (last.state !== "checked") return false;
  return last.checks.find((c) => c.key === "webhook_subscribed")?.status !== "pass";
}

export interface WebhookBanner {
  /** `blocked`: the check says delivery isn't working. `unconfirmed`: nothing has proved it works yet. */
  kind: "blocked" | "unconfirmed";
  message: string;
  /** The API's own sentence for the check, when it wrote one. */
  detail: string | null;
}

/**
 * What an ACTIVE number's card says loudly about webhook delivery. Found by key (`webhook_subscribed`), never by position. A `warn` or `fail`
 * means the business's Meta app is not subscribed, so customers' messages cannot arrive: say so plainly. A check that never ran, never got a
 * webhook (`not_verified`) or is missing proves nothing either way: say that, and do not call it healthy. `pass` and a number that was never
 * checked (or whose result is unreadable) get no banner; a `skipped` check belongs to a failed earlier check that the card already shows.
 */
export function webhookBanner(last: ParsedLastCheck): WebhookBanner | null {
  if (last.state !== "checked") return null;
  const webhook = last.checks.find((c) => c.key === "webhook_subscribed");
  if (webhook?.status === "pass" || webhook?.status === "skipped") return null;
  if (webhook?.status === "warn" || webhook?.status === "fail") {
    return { kind: "blocked", message: "Messages can't arrive until your Meta app is subscribed.", detail: webhook.message || null };
  }
  return { kind: "unconfirmed", message: "We haven't confirmed that your Meta app is subscribed, so customers' messages may not arrive yet.", detail: webhook?.message || null };
}
