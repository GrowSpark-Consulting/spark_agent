import { describe, expect, it } from "vitest";
import { CHECK_KEYS, checkStatus, checkTitle, overallSummary, parseLastCheck, webhookUnconfirmed } from "./last-check";

const RAN = "2026-10-12T04:30:00.000Z";
const check = (key: string, status: string, message = `${key} message`) => ({ key, status, message, checked_at: RAN });
const all = (overrides: Record<string, string> = {}) => CHECK_KEYS.map((key) => check(key, overrides[key] ?? "pass"));
const lastCheck = (checks: unknown[], overall = "pass") => ({ ran_at: RAN, overall, checks });

describe("parseLastCheck", () => {
  it("reads `{}` as never checked", () => {
    expect(parseLastCheck({})).toEqual({ state: "never" });
  });

  it("reads the six checks in the contract's order, whatever order they arrive in", () => {
    const shuffled = [...all()].reverse();
    const parsed = parseLastCheck(lastCheck(shuffled));
    expect(parsed.state).toBe("checked");
    if (parsed.state !== "checked") return;
    expect(parsed.checks.map((c) => c.key)).toEqual([...CHECK_KEYS]);
    expect(parsed).toMatchObject({ ranAt: RAN, overall: "pass" });
  });

  it("keeps a check it doesn't know, last, and does not invent the missing ones", () => {
    const parsed = parseLastCheck(lastCheck([check("brand_new", "warn"), check("payment_method", "pass"), check("token_permissions", "pass")], "warn"));
    if (parsed.state !== "checked") throw new Error("expected a checked result");
    expect(parsed.checks.map((c) => c.key)).toEqual(["token_permissions", "payment_method", "brand_new"]);
  });

  it.each([
    ["the older free-form record", { token: { ok: true } }],
    ["null", null],
    ["a string", "pass"],
    ["an array", []],
    ["no checks", lastCheck([])],
    ["an overall outside the contract", lastCheck(all(), "great")],
    ["a status outside the contract", lastCheck([check("token_permissions", "ok")])],
    ["a check without a message", lastCheck([{ key: "token_permissions", status: "pass", checked_at: RAN }])],
    ["no run time", { overall: "pass", checks: all() }],
  ])("reads %s as unreadable, not as a pass", (_name, raw) => {
    expect(parseLastCheck(raw)).toEqual({ state: "unreadable" });
  });
});

describe("webhookUnconfirmed", () => {
  const parse = (overrides: Record<string, string>) => parseLastCheck(lastCheck(all(overrides), "warn"));

  it("is false only when the webhook check passed", () => {
    expect(webhookUnconfirmed(parse({}))).toBe(false);
  });

  it.each(["not_verified", "warn", "fail", "skipped"])("is true when the webhook check is %s", (status) => {
    expect(webhookUnconfirmed(parse({ webhook_subscribed: status }))).toBe(true);
  });

  it("is true when the result has no webhook check at all: nothing proves it", () => {
    expect(webhookUnconfirmed(parseLastCheck(lastCheck([check("token_permissions", "pass")])))).toBe(true);
  });

  it("claims nothing for a number never checked or an unreadable result", () => {
    expect(webhookUnconfirmed({ state: "never" })).toBe(false);
    expect(webhookUnconfirmed({ state: "unreadable" })).toBe(false);
  });
});

describe("words", () => {
  it("names each of the six checks, and any other plainly", () => {
    expect(CHECK_KEYS.map(checkTitle)).toEqual([
      "Access and permissions",
      "Number on the Cloud API",
      "Webhook delivery",
      "Display name",
      "Payment method",
      "Test message",
    ]);
    expect(checkTitle("brand_new")).toBe("Another check");
    expect(checkTitle("toString")).toBe("Another check");
  });

  it("labels every status, and only a pass reads as ok", () => {
    expect(checkStatus("pass")).toEqual({ label: "Passed", tone: "ok" });
    expect(checkStatus("warn").tone).toBe("warn");
    expect(checkStatus("fail")).toEqual({ label: "Failed", tone: "warn" });
    expect(checkStatus("not_verified")).toEqual({ label: "Not confirmed yet", tone: "off" });
    expect(checkStatus("skipped")).toEqual({ label: "Skipped", tone: "off" });
  });

  it("says all checks passed only for an overall pass", () => {
    expect(overallSummary("pass", 6)).toBe("All 6 checks passed.");
    expect(overallSummary("warn", 6)).not.toMatch(/passed/);
    expect(overallSummary("fail", 6)).toMatch(/failed/);
  });
});
