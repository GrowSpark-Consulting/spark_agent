import { describe, expect, it, vi } from "vitest";
import type { SendOutcome } from "../../../notify/send";
import { SAFE } from "./checks";
import { expiryMessage, failureMessage, sendToAdmins } from "./health-alert";

// What an owner reads when their WhatsApp number stops working or its token is about to run out, and how it is sent: through notify.send as a
// staff_alert to each owner and admin with an alert number, once per exact alert, and never failing the job.

const A = "e0000000-0000-4000-8000-00000000000a";
const APP = "https://app.example.test";
const SENT: SendOutcome = { status: "sent", messageId: "m", providerMsgId: "p", creditsCharged: 0, usedTemplate: false };

describe("the failure alert", () => {
  const message = failureMessage({ phoneMasked: "+9198xxxxxx10", detail: SAFE.tokenExpired }, APP);

  it("says which number, what is wrong and where to fix it", () => {
    expect(message.text).toContain("stopped working");
    expect(message.text).toContain(SAFE.tokenExpired);
    expect(message.text).toContain(`${APP}/dashboard/whatsapp`);
    expect(message.templateParams[1]).toBe(`${APP}/dashboard/whatsapp`);
  });

  it("shows the number as it was given, already masked: the full number is never in it", () => {
    expect(message.text).not.toContain("919876543210");
    expect(message.text).toContain("+9198xxxxxx10");
  });

  it("keeps the first template variable to one plain line, as Meta requires", () => {
    const [headline] = message.templateParams;
    expect(headline).not.toMatch(/[\n\t]| {2}/);
    expect(headline.length).toBeLessThanOrEqual(400);
    expect(headline).toContain(SAFE.tokenExpired);
  });

  it("copes with a number we do not know", () => {
    expect(failureMessage({ phoneMasked: null, detail: SAFE.tokenFail }, APP).text).toContain("Your WhatsApp number");
  });

  it("holds no token or secret, whatever the detail is (the detail is fixed text from checks.ts)", () => {
    expect(JSON.stringify(message)).not.toMatch(/EAA|secret|token_enc/i);
  });
});

describe("the token-expiry warning", () => {
  const message = expiryMessage({ phoneMasked: "+9198xxxxxx10", expiresAt: new Date("2026-10-19T11:00:00.000Z") }, APP);

  it("gives the date in India's calendar and what to do", () => {
    expect(message.text).toContain("19 Oct 2026");
    expect(message.text).toContain("expires");
    expect(message.text).toContain("connect the number again");
    expect(message.text).toContain(`${APP}/dashboard/whatsapp`);
  });

  it("uses the India date near midnight UTC", () => {
    expect(expiryMessage({ phoneMasked: null, expiresAt: new Date("2026-10-19T20:00:00.000Z") }, APP).text).toContain("20 Oct 2026");
  });

  it("is one plain line in the template variable, with the number masked", () => {
    expect(message.templateParams[0]).not.toMatch(/[\n\t]| {2}/);
    expect(message.text).not.toContain("919876543210");
  });
});

describe("sending to owners and admins", () => {
  const msg = { text: "t", templateParams: ["h", "l"] as [string, string] };
  const deps = (over: { people?: string[]; outcomes?: Record<string, SendOutcome | Error> } = {}) => {
    const send = vi.fn(async (_tenant: string, _kind: "staff_alert", payload: { staffUserId?: string }) => {
      const outcome = over.outcomes?.[payload.staffUserId ?? ""] ?? SENT;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    });
    return { send, recipients: vi.fn(async () => over.people ?? ["u1", "u2"]) };
  };

  it("sends one staff_alert to each person with the exact text, template variables and a key of its own", async () => {
    const d = deps();
    expect(await sendToAdmins(A, msg, "connection_failed:c1:never", d)).toEqual({ recipients: 2, sent: 2, skipped: 0, failed: 0 });
    expect(d.send).toHaveBeenCalledWith(A, "staff_alert", { staffUserId: "u1", text: "t", templateParams: ["h", "l"], idempotencyKey: "connection_failed:c1:never:u1" });
    expect(d.send).toHaveBeenCalledWith(A, "staff_alert", expect.objectContaining({ staffUserId: "u2", idempotencyKey: "connection_failed:c1:never:u2" }));
    expect(d.recipients).toHaveBeenCalledWith(A);
  });

  it("counts a skipped alert (switch off, no connection to send from) and a failed one, and goes on", async () => {
    const d = deps({
      people: ["u1", "u2", "u3"],
      outcomes: {
        u1: { status: "skipped", reason: "feature_off" },
        u2: { status: "failed", error: { code: "whatsapp_not_connected", message: "x", retryable: false, outcomeUnknown: false } },
      },
    });
    expect(await sendToAdmins(A, msg, "k", d)).toEqual({ recipients: 3, sent: 1, skipped: 1, failed: 1 });
  });

  it("a send that throws is a failed alert, never an error of the job", async () => {
    const d = deps({ outcomes: { u1: new Error("down") } });
    expect(await sendToAdmins(A, msg, "k", d)).toEqual({ recipients: 2, sent: 1, skipped: 0, failed: 1 });
  });

  it("nobody with an alert number: nothing is sent", async () => {
    const d = deps({ people: [] });
    expect(await sendToAdmins(A, msg, "k", d)).toEqual({ recipients: 0, sent: 0, skipped: 0, failed: 0 });
    expect(d.send).not.toHaveBeenCalled();
  });

  it("a failure to find the recipients is a failed alert too, counted as no one reached", async () => {
    const d = deps();
    d.recipients.mockRejectedValueOnce(new Error("down"));
    expect(await sendToAdmins(A, msg, "k", d)).toEqual({ recipients: 0, sent: 0, skipped: 0, failed: 1 });
  });
});
