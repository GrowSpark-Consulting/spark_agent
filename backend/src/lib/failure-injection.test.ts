import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmError, type LlmClient, type LlmRequest, type LlmResult } from "../agent/llm/anthropic";
import { parseJsonObject } from "../agent/llm/json";
import { SendError, type MessageSender, type SenderFactory } from "../notify/sender";
import { failureInjection, failureInjectionFromEnv, INJECTED_BAD_JSON, withLlmFailures, withSendFailures } from "./failure-injection";

const TEST_BUSINESS = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const OTHER_BUSINESS = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";

const answer: LlmResult = {
  text: '{"intent":"question"}',
  model: "claude-haiku-4-5-20251001",
  stopReason: "end_turn",
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
  costUsd: 0.0001,
  latencyMs: 300,
  attempts: 1,
  requestId: "req_1",
};
const request = (role: LlmRequest["role"], tenantId = TEST_BUSINESS): LlmRequest => ({
  role,
  prompt: { name: "test", version: 1 },
  tenantId,
  system: [{ text: "rules" }],
  messages: [{ role: "user", content: "2BHK price?" }],
});
const realModel = () => {
  const complete = vi.fn<LlmClient["complete"]>(async () => answer);
  return { client: { complete } satisfies LlmClient, complete };
};

describe("which businesses it breaks", () => {
  it("breaks only the failures it lists, only for the businesses it names (any letter case)", () => {
    const injection = failureInjection(["llm_timeout"], [TEST_BUSINESS.toUpperCase()]);
    expect(injection.breaks(TEST_BUSINESS, "llm_timeout")).toBe(true);
    expect(injection.breaks(TEST_BUSINESS, "whatsapp_send_error")).toBe(false);
    expect(injection.breaks(OTHER_BUSINESS, "llm_timeout")).toBe(false);
  });

  describe("from the environment", () => {
    afterEach(() => vi.restoreAllMocks());

    it("is off unless both settings are there, and says in the log when it is on", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(failureInjectionFromEnv({})).toBeNull();
      expect(failureInjectionFromEnv({ FAILURE_INJECTION: "llm_timeout" })).toBeNull();
      const on = failureInjectionFromEnv({ FAILURE_INJECTION: "llm_timeout, llm_bad_json", FAILURE_INJECTION_TENANTS: TEST_BUSINESS });
      expect(on?.breaks(TEST_BUSINESS, "llm_bad_json")).toBe(true);
      expect(warn).toHaveBeenCalledWith("[failure-injection] ON for 1 test business(es): llm_timeout, llm_bad_json");
    });

    it("breaks nothing for a value the server would refuse at startup", () => {
      expect(failureInjectionFromEnv({ FAILURE_INJECTION: "db_down", FAILURE_INJECTION_TENANTS: TEST_BUSINESS })).toBeNull();
      expect(failureInjectionFromEnv({ FAILURE_INJECTION: "llm_timeout", FAILURE_INJECTION_TENANTS: "everyone" })).toBeNull();
    });
  });
});

describe("the language model", () => {
  it("is the client itself when nothing is injected", () => {
    const { client } = realModel();
    expect(withLlmFailures(client, null)).toBe(client);
  });

  it("llm_timeout: every call times out, as a real one does, and the model is never asked", async () => {
    const { client, complete } = realModel();
    const broken = withLlmFailures(client, failureInjection(["llm_timeout"], [TEST_BUSINESS]));
    for (const role of ["extraction", "reply", "summary"] as const) {
      await expect(broken.complete(request(role))).rejects.toMatchObject({ name: "LlmError", code: "timeout", retryable: true });
    }
    await expect(broken.complete(request("reply"))).rejects.toBeInstanceOf(LlmError);
    expect(complete).not.toHaveBeenCalled();
  });

  it("llm_bad_json: the JSON models answer a cut-off object every time; the reply model is untouched", async () => {
    const { client, complete } = realModel();
    const broken = withLlmFailures(client, failureInjection(["llm_bad_json"], [TEST_BUSINESS]));
    for (const role of ["extraction", "summary"] as const) {
      const first = await broken.complete(request(role));
      const second = await broken.complete(request(role));
      expect([first.text, second.text]).toEqual([INJECTED_BAD_JSON, INJECTED_BAD_JSON]);
      expect(first.costUsd).toBe(0);
    }
    expect(parseJsonObject(INJECTED_BAD_JSON)).toMatchObject({ ok: false });
    expect((await broken.complete(request("reply"))).text).toBe(answer.text);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("leaves every other business alone", async () => {
    const { client, complete } = realModel();
    const broken = withLlmFailures(client, failureInjection(["llm_timeout", "llm_bad_json"], [TEST_BUSINESS]));
    expect(await broken.complete(request("extraction", OTHER_BUSINESS))).toBe(answer);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe("WhatsApp", () => {
  const ids = (tenantId = TEST_BUSINESS) => ({ tenantId, connectionId: "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f601" });
  const realSender = (): { factory: SenderFactory; made: ReturnType<typeof vi.fn> } => {
    const sender: MessageSender = { sendText: vi.fn(), sendTemplate: vi.fn(), sendInteractive: vi.fn() };
    const made = vi.fn(async () => sender);
    return { factory: made as unknown as SenderFactory, made };
  };

  it("is the factory itself when nothing is injected", () => {
    const { factory } = realSender();
    expect(withSendFailures(factory, null)).toBe(factory);
  });

  it("whatsapp_send_error: every kind of message is refused, retryable, and no connection is loaded", async () => {
    const { factory, made } = realSender();
    const sender = await withSendFailures(factory, failureInjection(["whatsapp_send_error"], [TEST_BUSINESS]))(ids());
    for (const attempt of [() => sender.sendText("+919840012345", "Hi"), () => sender.sendTemplate("+919840012345", "t", "en", []), () => sender.sendInteractive("+919840012345", { type: "buttons", body: "b", buttons: [{ id: "a", title: "A" }] })]) {
      await expect(attempt()).rejects.toMatchObject({ name: "SendError", code: "upstream_failed", retryable: true, outcomeUnknown: false });
    }
    expect(made).not.toHaveBeenCalled();
  });

  it("whatsapp_send_timeout: an unknown outcome, so nothing may resend it", async () => {
    const { factory } = realSender();
    const sender = await withSendFailures(factory, failureInjection(["whatsapp_send_timeout"], [TEST_BUSINESS]))(ids());
    const error = await sender.sendText("+919840012345", "Hi").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SendError);
    expect(error).toMatchObject({ code: "upstream_failed", outcomeUnknown: true });
  });

  it("leaves every other business alone", async () => {
    const { factory, made } = realSender();
    await withSendFailures(factory, failureInjection(["whatsapp_send_error"], [TEST_BUSINESS]))(ids(OTHER_BUSINESS));
    expect(made).toHaveBeenCalledWith(ids(OTHER_BUSINESS));
  });
});
