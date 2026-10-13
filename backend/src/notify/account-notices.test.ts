import { describe, expect, it, vi } from "vitest";
import { sendAccountNotice, type NoticeDeps } from "./account-notices";

const TENANT = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const message = { text: "Skyline Homes: your trial ends tomorrow.\nhttps://app.test/dashboard/billing", templateParams: ["Skyline Homes: your trial ends tomorrow.", "https://app.test/dashboard/billing"] as [string, string] };

function deps(people: string[], outcomes: Array<"sent" | "skipped" | "failed" | "throw"> = []) {
  const recipients = vi.fn<NoticeDeps["recipients"]>(async () => people);
  let i = 0;
  const send = vi.fn<NoticeDeps["send"]>(async () => {
    const o = outcomes[i++] ?? "sent";
    if (o === "throw") throw new Error("boom");
    if (o === "sent") return { status: "sent", messageId: "m", providerMsgId: "p", creditsCharged: 0, usedTemplate: false };
    if (o === "skipped") return { status: "skipped", reason: "feature_off" };
    return { status: "failed", error: { code: "upstream_failed", message: "x", retryable: true, outcomeUnknown: false } };
  });
  return { recipients, send };
}

describe("sendAccountNotice", () => {
  it("sends one account_notice to each owner, keyed per notice and person, so a repeat sends nothing twice", async () => {
    const d = deps(["owner-a", "owner-b"]);
    expect(await sendAccountNotice(TENANT, message, "trial_notice:t:6", { deps: d })).toEqual({ recipients: 2, sent: 2, skipped: 0, failed: 0 });
    expect(d.recipients).toHaveBeenCalledWith(TENANT, ["owner"]);
    expect(d.send).toHaveBeenCalledWith(TENANT, "account_notice", { staffUserId: "owner-a", text: message.text, templateParams: message.templateParams, idempotencyKey: "trial_notice:t:6:owner-a" });
    expect(d.send.mock.calls[1][2]).toMatchObject({ staffUserId: "owner-b", idempotencyKey: "trial_notice:t:6:owner-b" });
  });

  it("goes to admins too when asked, and counts what did not go without throwing", async () => {
    const d = deps(["a", "b", "c"], ["skipped", "failed", "throw"]);
    expect(await sendAccountNotice(TENANT, message, "k", { roles: ["owner", "admin"], deps: d })).toEqual({ recipients: 3, sent: 0, skipped: 1, failed: 2 });
    expect(d.recipients).toHaveBeenCalledWith(TENANT, ["owner", "admin"]);
    const broken = { recipients: vi.fn<NoticeDeps["recipients"]>(async () => Promise.reject(new Error("db down"))), send: vi.fn<NoticeDeps["send"]>() };
    expect(await sendAccountNotice(TENANT, message, "k", { deps: broken })).toEqual({ recipients: 0, sent: 0, skipped: 0, failed: 1 });
    expect(broken.send).not.toHaveBeenCalled();
  });
});
