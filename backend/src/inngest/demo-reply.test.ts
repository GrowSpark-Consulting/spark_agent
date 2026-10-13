import { describe, expect, it, vi } from "vitest";
import type { MenuEntry } from "../channels/whatsapp/demo/text";
import type { SendOutcome } from "../notify/send";
import { DEMO_REPLY_EVENT, demoReply, handleDemoReply, type DemoReplyDeps } from "./demo-reply";
import { functions } from "./functions";

// demo-reply (Day 6, PR 1b): the answer a visitor to the shared demo number gets when nothing is routed (the menu, an invalid code, the daily limit, a used
// trial). One free system_notice through notify.send, in the visitor's language, named by the message so a repeat never sends it twice.

const FRONT_DESK = "e0000000-0000-4000-8000-00000000000a";
const CONV = "c0000000-0000-4000-8000-0000000000c1";
const MESSAGE = "a0000000-0000-4000-8000-0000000000a1";
const MENU: MenuEntry[] = [{ code: "DEMO-SALON", label: "Beauty parlour" }];
const SENT: SendOutcome = { status: "sent", messageId: "m", providerMsgId: "p", creditsCharged: 0, usedTemplate: false };
const data = (over: Record<string, unknown> = {}) => ({ tenantId: FRONT_DESK, conversationId: CONV, messageId: MESSAGE, kind: "menu", lang: "en", ...over });

const stepper = () => {
  const ran: string[] = [];
  return { ran, step: { run: async <T>(id: string, fn: () => Promise<T>) => (ran.push(id), JSON.parse(JSON.stringify((await fn()) ?? null)) as T) } };
};
const deps = (over: Partial<DemoReplyDeps> = {}) => {
  const send = vi.fn<DemoReplyDeps["send"]>(async () => SENT);
  const menu = vi.fn(async () => MENU);
  const d: DemoReplyDeps = { menu, appUrl: () => "https://app.example.test", send, ...over };
  return { d, send, menu };
};

describe("sending the answer", () => {
  it("sends one system_notice to the chat, with the text for the kind and language and a key named by the message", async () => {
    const { d, send } = deps();
    expect(await handleDemoReply({ event: { data: data() }, step: stepper().step }, d)).toEqual({ status: "sent" });
    expect(send).toHaveBeenCalledTimes(1);
    const [tenantId, kind, payload] = send.mock.calls[0];
    expect([tenantId, kind]).toEqual([FRONT_DESK, "system_notice"]);
    expect(payload).toMatchObject({ conversationId: CONV, idempotencyKey: `demo_reply:${MESSAGE}` });
    expect(payload.text).toContain("1. Beauty parlour: DEMO-SALON");
  });

  it("is in the language of the event", async () => {
    const ta = deps();
    await handleDemoReply({ event: { data: data({ lang: "ta" }) }, step: stepper().step }, ta.d);
    expect(ta.send.mock.calls[0][2].text).toMatch(/[஀-௿]/);
    const tanglish = deps();
    await handleDemoReply({ event: { data: data({ lang: "tanglish" }) }, step: stepper().step }, tanglish.d);
    expect(tanglish.send.mock.calls[0][2].text).toMatch(/Vanakkam/);
  });

  it("reads the menu only for the answers that show it, and the app's address only for those that link to it", async () => {
    for (const [kind, readsMenu] of [["menu", true], ["bad_code", true], ["limit", false], ["trial_taken", false]] as const) {
      const { d, menu, send } = deps();
      await handleDemoReply({ event: { data: data({ kind }) }, step: stepper().step }, d);
      expect(menu).toHaveBeenCalledTimes(readsMenu ? 1 : 0);
      if (!readsMenu) expect(send.mock.calls[0][2].text).toContain("https://app.example.test");
    }
  });

  it("with no demo businesses set up, still answers", async () => {
    const { d, send } = deps({ menu: vi.fn(async () => []) });
    expect(await handleDemoReply({ event: { data: data() }, step: stepper().step }, d)).toEqual({ status: "sent" });
    expect((send.mock.calls[0][2].text ?? "").length).toBeGreaterThan(20);
  });
});

describe("what the send says back", () => {
  it("a message that was skipped (outside the 24 hours, switched off) is reported, not retried", async () => {
    const { d } = deps({ send: vi.fn(async () => ({ status: "skipped", reason: "outside_window" }) as SendOutcome) });
    expect(await handleDemoReply({ event: { data: data() }, step: stepper().step }, d)).toEqual({ status: "skipped", reason: "outside_window" });
  });

  it("a failure that will not change is reported with its code and not retried", async () => {
    const { d } = deps({ send: vi.fn(async () => ({ status: "failed", error: { code: "whatsapp_not_connected", message: "x", retryable: false, outcomeUnknown: false } }) as SendOutcome) });
    expect(await handleDemoReply({ event: { data: data() }, step: stepper().step }, d)).toEqual({ status: "failed", code: "whatsapp_not_connected" });
  });

  it("a failure that may pass is thrown, so Inngest retries the step; the key makes the retry safe", async () => {
    const { d } = deps({ send: vi.fn(async () => ({ status: "failed", error: { code: "rate_limited", message: "x", retryable: true, outcomeUnknown: false } }) as SendOutcome) });
    await expect(handleDemoReply({ event: { data: data() }, step: stepper().step }, d)).rejects.toThrow("rate_limited");
  });

  it("an outcome nobody knows (a timeout) is never retried: the visitor could get it twice", async () => {
    const { d } = deps({ send: vi.fn(async () => ({ status: "failed", error: { code: "timeout", message: "x", retryable: true, outcomeUnknown: true } }) as SendOutcome) });
    expect(await handleDemoReply({ event: { data: data() }, step: stepper().step }, d)).toEqual({ status: "failed", code: "timeout" });
  });

  it("what it returns holds no text, number or id", async () => {
    const { d } = deps();
    const result = JSON.stringify(await handleDemoReply({ event: { data: data() }, step: stepper().step }, d));
    expect(result).not.toMatch(/Beauty|DEMO|e0000000|c0000000|a0000000/);
  });
});

describe("the event", () => {
  it("is refused unless it has the ids, a kind and a language", async () => {
    for (const bad of [{}, null, "x", data({ tenantId: "x" }), data({ conversationId: undefined }), data({ messageId: 5 }), data({ kind: "other" }), data({ lang: "fr" }), data({ lang: undefined })]) {
      const { d, send } = deps();
      await expect(handleDemoReply({ event: { data: bad }, step: stepper().step }, d)).rejects.toThrow();
      expect(send).not.toHaveBeenCalled();
    }
  });

  it("a failure to read the menu is thrown, so the step is retried", async () => {
    const { d } = deps({ menu: vi.fn(async () => Promise.reject(new Error("down"))) });
    await expect(handleDemoReply({ event: { data: data() }, step: stepper().step }, d)).rejects.toThrow("down");
  });
});

describe("registration", () => {
  it("is served on the whatsapp/demo.reply event, with a few retries", () => {
    expect(DEMO_REPLY_EVENT).toBe("whatsapp/demo.reply");
    expect(functions).toContain(demoReply);
    expect((demoReply as unknown as { opts: unknown }).opts).toMatchObject({ id: "demo-reply", triggers: [{ event: "whatsapp/demo.reply" }], retries: 3 });
  });
});
