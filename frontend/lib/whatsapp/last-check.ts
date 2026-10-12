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
