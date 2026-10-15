import Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLlmClient, LlmError, RETRY_AFTER_CAP_MS, RETRY_DELAYS_MS, type CreateMessage, type GenerationEvent, type LlmRequest, type Tracer } from "./anthropic";
import { MODELS } from "./models";

// The Anthropic client of the agent. The SDK call is replaced by a function the test controls, so what is
// sent, what comes back and what happens on each kind of failure can be checked without a network. The
// errors are the SDK's own classes, built the way the SDK builds them from an HTTP answer.

const TENANT = "e0000000-0000-0000-0000-00000000000a";
const SECRET_TEXT = "my number is 9812345621 and my budget is 80 lakh";

function reply(text: string, over: Record<string, unknown> = {}) {
  return {
    id: "msg_01",
    type: "message",
    role: "assistant",
    model: MODELS.reply,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_details: null,
    usage: { input_tokens: 800, output_tokens: 250, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 },
    _request_id: "req_01",
    ...over,
  } as unknown as Anthropic.Message;
}

const apiError = (status: number, headers: Record<string, string> = {}, message = "provider says no") =>
  Anthropic.APIError.generate(status, { type: "error", error: { type: "x", message } }, message, new Headers(headers));

const request = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  role: "reply",
  tenantId: TENANT,
  prompt: { name: "reply", version: 1 },
  system: [{ text: "RULES", cache: true }, { text: "BUSINESS", cache: true }, { text: "TAIL" }],
  messages: [{ role: "user", content: "How much is a 2BHK?" }],
  ...over,
});

function setup(create: CreateMessage, extra: { tracer?: Tracer; settings?: Parameters<typeof createLlmClient>[0]["settings"] } = {}) {
  const waits: number[] = [];
  const events: GenerationEvent[] = [];
  const tracer: Tracer = extra.tracer ?? { record: (event) => void events.push(event) };
  let clock = 1_000;
  const client = createLlmClient({
    create,
    tracer,
    sleep: async (ms) => void (waits.push(ms), (clock += ms)),
    now: () => clock,
    settings: extra.settings,
  });
  return { client, waits, events, advance: (ms: number) => (clock += ms) };
}

const fail = async (promise: Promise<unknown>): Promise<LlmError> => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(LlmError);
  return error as LlmError;
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("what is sent", () => {
  it("a reply goes to Sonnet 5.5 at low effort, with no sampling parameter, and the system prompt as blocks", async () => {
    const create = vi.fn<CreateMessage>(async () => reply("Hello"));
    await setup(create).client.complete(request());
    const [params, options] = create.mock.calls[0];
    expect(params.model).toBe("claude-sonnet-5-5");
    expect(params.max_tokens).toBe(2000);
    expect((params as unknown as Record<string, unknown>).output_config).toEqual({ effort: "low" });
    expect(params).not.toHaveProperty("temperature");
    expect(params.messages).toEqual([{ role: "user", content: "How much is a 2BHK?" }]);
    expect(options.timeout).toBe(15_000);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("an extraction goes to Haiku 4.5 at temperature 0, with no effort setting", async () => {
    const create = vi.fn<CreateMessage>(async () => reply("{}"));
    await setup(create).client.complete(request({ role: "extraction", prompt: { name: "extraction", version: 1 } }));
    const [params, options] = create.mock.calls[0];
    expect(params.model).toBe("claude-haiku-4-5-20251001");
    expect(params.temperature).toBe(0);
    expect(params.max_tokens).toBe(1024);
    expect(params).not.toHaveProperty("output_config");
    expect(options.timeout).toBe(8_000);
  });

  it("marks the fixed parts of the system prompt for caching, in order, and leaves the changing tail unmarked", async () => {
    const create = vi.fn<CreateMessage>(async () => reply("Hello"));
    await setup(create).client.complete(request());
    expect(create.mock.calls[0][0].system).toEqual([
      { type: "text", text: "RULES", cache_control: { type: "ephemeral" } },
      { type: "text", text: "BUSINESS", cache_control: { type: "ephemeral" } },
      { type: "text", text: "TAIL" },
    ]);
  });

  it("never marks more than four blocks (the API's limit)", async () => {
    const create = vi.fn<CreateMessage>(async () => reply("Hello"));
    const system = Array.from({ length: 6 }, (_, i) => ({ text: `block ${i}`, cache: true }));
    await setup(create).client.complete(request({ system }));
    const marked = (create.mock.calls[0][0].system as { cache_control?: unknown }[]).filter((b) => b.cache_control);
    expect(marked.length).toBeLessThanOrEqual(4);
  });

  it("lets a caller ask for fewer tokens", async () => {
    const create = vi.fn<CreateMessage>(async () => reply("Hello"));
    await setup(create).client.complete(request({ maxTokens: 300 }));
    expect(create.mock.calls[0][0].max_tokens).toBe(300);
  });

  it("removes characters that make a request invalid: NUL, other control characters and lone surrogates", async () => {
    const create = vi.fn<CreateMessage>(async () => reply("Hello"));
    await setup(create).client.complete(
      request({ system: [{ text: "RU\u0000LES\uD800" }], messages: [{ role: "user", content: "hi\u0007 there\uDC00" }] }),
    );
    const [params] = create.mock.calls[0];
    expect(JSON.stringify(params)).not.toMatch(/\\u0000|\\u0007|\\ud800|\\udc00/i);
    expect(params.messages[0].content).toBe("hi there");
  });
});

describe("what comes back", () => {
  it("the text, the model, the usage, an estimate of the cost, how long it took, and how many tries", async () => {
    const { client, advance } = setup(vi.fn<CreateMessage>(async () => (advance(1800), reply("The 2BHK starts at 78 lakh."))));
    const result = await client.complete(request());
    expect(result).toMatchObject({
      text: "The 2BHK starts at 78 lakh.",
      model: MODELS.reply,
      stopReason: "end_turn",
      attempts: 1,
      requestId: "req_01",
      usage: { inputTokens: 800, outputTokens: 250, cacheReadTokens: 3000, cacheWriteTokens: 0 },
    });
    expect(result.latencyMs).toBe(1800);
    expect(result.costUsd).toBeCloseTo((800 * 2 + 3000 * 0.1 + 250 * 10) / 1_000_000, 8); // Sonnet 5.5 cache reads are $0.10 per million
  });

  it("joins the text blocks and ignores thinking blocks", async () => {
    const message = reply("", { content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: "Part one. " }, { type: "text", text: "Part two." }] });
    const result = await setup(vi.fn<CreateMessage>(async () => message)).client.complete(request());
    expect(result.text).toBe("Part one. Part two.");
  });

  it("trims the text", async () => {
    const result = await setup(vi.fn<CreateMessage>(async () => reply("  \n Hello \n"))).client.complete(request());
    expect(result.text).toBe("Hello");
  });

  it("treats an answer with no text as a failure that is not retried", async () => {
    const create = vi.fn<CreateMessage>(async () => reply("   "));
    const error = await fail(setup(create).client.complete(request()));
    expect(error.code).toBe("empty");
    expect(create).toHaveBeenCalledOnce();
  });

  it("surfaces a refusal as its own error, never as text, and does not retry it", async () => {
    const create = vi.fn<CreateMessage>(async () => reply("I can't help with that.", { stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "x" } }));
    const error = await fail(setup(create).client.complete(request()));
    expect(error.code).toBe("refusal");
    expect(error.message).not.toContain("I can't help");
    expect(create).toHaveBeenCalledOnce();
  });

  it.each(["pause_turn", "model_context_window_exceeded", "some_new_reason"])("treats stop reason %s as an unfinished answer, never as text to use", async (stopReason) => {
    const create = vi.fn<CreateMessage>(async () => reply("The 2BHK starts at", { stop_reason: stopReason }));
    const error = await fail(setup(create).client.complete(request()));
    expect(error.code).toBe("truncated");
    expect(create).toHaveBeenCalledOnce();
  });

  it("accepts the two finished stop reasons", async () => {
    for (const stopReason of ["end_turn", "stop_sequence"]) {
      const result = await setup(vi.fn<CreateMessage>(async () => reply("Hello", { stop_reason: stopReason }))).client.complete(request());
      expect(result.text).toBe("Hello");
    }
  });

  it("surfaces an answer cut off by the token limit as its own error: a half sentence is never sent to a customer", async () => {
    const create = vi.fn<CreateMessage>(async () => reply("The 2BHK starts at 7", { stop_reason: "max_tokens" }));
    const error = await fail(setup(create).client.complete(request()));
    expect(error.code).toBe("truncated");
    expect(error.message).not.toContain("7");
    expect(create).toHaveBeenCalledOnce();
  });
});

describe("retries: only for what waiting can fix, with a cap", () => {
  it("waits 0.5 s and then 1.5 s, and tries three times in all", () => {
    expect(RETRY_DELAYS_MS).toEqual([500, 1500]);
  });

  it.each([
    ["a rate limit (429)", () => apiError(429)],
    ["an overloaded service (529)", () => apiError(529)],
    ["a server error (500)", () => apiError(500)],
    ["a bad gateway (502)", () => apiError(502)],
    ["a service that is down (503)", () => apiError(503)],
    ["a request timeout (408)", () => apiError(408)],
    ["a try that timed out", () => new Anthropic.APIConnectionTimeoutError()],
    ["a dropped connection", () => new Anthropic.APIConnectionError({ message: "socket hang up 10.0.0.5" })],
  ])("tries again after %s, and succeeds", async (_name, make) => {
    const create = vi.fn<CreateMessage>().mockRejectedValueOnce(make()).mockResolvedValueOnce(reply("Hello"));
    const { client, waits } = setup(create);
    const result = await client.complete(request());
    expect(result.text).toBe("Hello");
    expect(result.attempts).toBe(2);
    expect(waits).toEqual([500]);
  });

  it("gives up after three tries, with the code and the status the provider gave, and says how many it made", async () => {
    const create = vi.fn<CreateMessage>(async () => Promise.reject(apiError(503)));
    const { client, waits } = setup(create);
    const error = await fail(client.complete(request()));
    expect(create).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([500, 1500]);
    expect(error).toMatchObject({ code: "unavailable", status: 503, attempts: 3, retryable: true });
  });

  it("calls a rate limit that outlasts the tries rate_limited, keeping 429", async () => {
    const error = await fail(setup(vi.fn<CreateMessage>(async () => Promise.reject(apiError(429)))).client.complete(request()));
    expect(error).toMatchObject({ code: "rate_limited", status: 429 });
  });

  it("calls tries that keep timing out `timeout`", async () => {
    const error = await fail(setup(vi.fn<CreateMessage>(async () => Promise.reject(new Anthropic.APIConnectionTimeoutError()))).client.complete(request()));
    expect(error.code).toBe("timeout");
  });

  it("waits as long as the provider's Retry-After says when that is longer than the usual wait and within the cap", async () => {
    const create = vi.fn<CreateMessage>().mockRejectedValueOnce(apiError(429, { "retry-after": "1" })).mockResolvedValueOnce(reply("Hello"));
    const { client, waits } = setup(create);
    await client.complete(request());
    expect(waits).toEqual([1000]);
  });

  it("does not try into a limit that is certain to still be in force: a Retry-After beyond the cap fails at once as rate_limited", async () => {
    const create = vi.fn<CreateMessage>(async () => Promise.reject(apiError(429, { "retry-after": "60" })));
    const { client, waits } = setup(create);
    const error = await fail(client.complete(request()));
    expect(error).toMatchObject({ code: "rate_limited", status: 429, attempts: 1 });
    expect(create).toHaveBeenCalledOnce();
    expect(waits).toEqual([]);
    expect(RETRY_AFTER_CAP_MS).toBe(2000);
  });

  it.each([400, 401, 403, 404, 413, 422])("does not retry a %i: the request itself is wrong, and the status is kept", async (status) => {
    const create = vi.fn<CreateMessage>(async () => Promise.reject(apiError(status)));
    const { client, waits } = setup(create);
    const error = await fail(client.complete(request()));
    expect(error).toMatchObject({ code: "rejected", status, attempts: 1, retryable: false });
    expect(create).toHaveBeenCalledOnce();
    expect(waits).toEqual([]);
  });

  it("does not retry a failure it does not recognise, and does not pass its text on", async () => {
    const create = vi.fn<CreateMessage>(async () => Promise.reject(new TypeError("Cannot read properties of undefined (reading 'x') at /srv/app/secret.js")));
    const error = await fail(setup(create).client.complete(request()));
    expect(error.code).toBe("unavailable");
    expect(error.message).not.toMatch(/secret\.js|undefined/);
    expect(create).toHaveBeenCalledOnce();
  });
});

describe("deadlines", () => {
  it("stops at the overall deadline, as a timeout, and does not retry past it", async () => {
    // the call honours its abort signal, like the real SDK
    const create = vi.fn<CreateMessage>((_params, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Anthropic.APIUserAbortError()))));
    const { client } = setup(create, { settings: { reply: { totalTimeoutMs: 30 } } });
    const error = await fail(client.complete(request()));
    expect(error.code).toBe("timeout");
    expect(create).toHaveBeenCalledOnce();
  });

  it("stops when the caller's own deadline passes, as aborted, with no retry and nothing sent after", async () => {
    const controller = new AbortController();
    const create = vi.fn<CreateMessage>((_params, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Anthropic.APIUserAbortError()))));
    const { client } = setup(create);
    const pending = client.complete(request({ signal: controller.signal }));
    controller.abort();
    const error = await fail(pending);
    expect(error.code).toBe("aborted");
    expect(create).toHaveBeenCalledOnce();
  });

  it("does not even start when the caller's deadline has already passed", async () => {
    const create = vi.fn<CreateMessage>(async () => reply("Hello"));
    const error = await fail(setup(create).client.complete(request({ signal: AbortSignal.abort() })));
    expect(error.code).toBe("aborted");
    expect(create).not.toHaveBeenCalled();
  });

  it("does not sit out a wait that would use up what is left of the call's deadline: it says what went wrong now, with the real code and status", async () => {
    const create = vi.fn<CreateMessage>(async () => Promise.reject(apiError(503)));
    const { client, waits } = setup(create, { settings: { reply: { totalTimeoutMs: 400 } } }); // the first wait is 500 ms
    const error = await fail(client.complete(request()));
    expect(error).toMatchObject({ code: "unavailable", status: 503, attempts: 1 });
    expect(waits).toEqual([]);
    expect(create).toHaveBeenCalledOnce();
  });

  it("notices a caller's deadline that passes during a wait, and stops without another try", async () => {
    const controller = new AbortController();
    const create = vi.fn<CreateMessage>(async () => Promise.reject(apiError(503)));
    const { waits } = setup(create);
    const client = createLlmClient({
      create,
      tracer: { record: () => {} },
      sleep: async (ms) => {
        waits.push(ms);
        controller.abort(); // the deadline passes while waiting
      },
      now: () => 0,
    });
    const error = await fail(client.complete(request({ signal: controller.signal })));
    expect(error.code).toBe("aborted");
    expect(create).toHaveBeenCalledOnce();
  });
});

describe("what is never exposed", () => {
  it("fixed words in every error, never the provider's message", async () => {
    const create = vi.fn<CreateMessage>(async () => Promise.reject(apiError(401, {}, "invalid x-api-key sk-ant-SECRET at 10.0.0.5")));
    const error = await fail(setup(create).client.complete(request()));
    expect(error.message).not.toMatch(/sk-ant|SECRET|10\.0\.0\.5|x-api-key/);
  });

  it("nothing a customer wrote, and no key, in the log lines of a failure", async () => {
    const create = vi.fn<CreateMessage>(async () => Promise.reject(apiError(503, {}, `echoing ${SECRET_TEXT}`)));
    await fail(setup(create).client.complete(request({ messages: [{ role: "user", content: SECRET_TEXT }] })));
    const logged = [...vi.mocked(console.error).mock.calls, ...vi.mocked(console.warn).mock.calls].map((c) => c.join(" ")).join("\n");
    expect(logged).toContain("503");
    expect(logged).not.toMatch(/9812345621|80 lakh|echoing/);
  });
});

describe("the request is checked before anything is sent", () => {
  it.each<[string, Partial<LlmRequest>]>([
    ["a tenant id that is not an id", { tenantId: "not-an-id" }],
    ["no messages", { messages: [] }],
    ["a conversation that starts with the assistant", { messages: [{ role: "assistant", content: "Hi" }] }],
    ["an empty message", { messages: [{ role: "user", content: "   " }] }],
    ["no system prompt", { system: [] }],
    ["an empty system block", { system: [{ text: "  " }] }],
    ["a token limit of zero", { maxTokens: 0 }],
    ["a token limit above the cap", { maxTokens: 8_001 }],
    ["more than 50 messages", { messages: Array.from({ length: 51 }, (_, i) => ({ role: i % 2 ? ("assistant" as const) : ("user" as const), content: "x" })) }],
    ["more than 10 system blocks", { system: Array.from({ length: 11 }, (_, i) => ({ text: `block ${i}` })) }],
    ["a message of over 50,000 characters", { messages: [{ role: "user", content: "x".repeat(50_001) }] }],
  ])("refuses %s", async (_name, over) => {
    const create = vi.fn<CreateMessage>(async () => reply("Hello"));
    const error = await fail(setup(create).client.complete(request(over)));
    expect(error.code).toBe("invalid_request");
    expect(create).not.toHaveBeenCalled();
  });
});

describe("tracing", () => {
  it("records one generation per call, however many tries it took, with the tenant, model, prompt version, usage, cost and time", async () => {
    const create = vi.fn<CreateMessage>().mockRejectedValueOnce(apiError(503)).mockResolvedValueOnce(reply("Hello"));
    const { client, events } = setup(create);
    await client.complete(request({ conversationId: "c0000000-0000-0000-0000-00000000000c" }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: TENANT,
      conversationId: "c0000000-0000-0000-0000-00000000000c",
      role: "reply",
      model: MODELS.reply,
      prompt: { name: "reply", version: 1 },
      status: "ok",
      attempts: 2,
      usage: { inputTokens: 800, outputTokens: 250, cacheReadTokens: 3000, cacheWriteTokens: 0 },
      output: "Hello",
    });
    expect(events[0].costUsd).toBeGreaterThan(0);
  });

  it("hands the tracer the text, so that it alone decides what to keep (the client never decides to hide or reveal it)", async () => {
    const { client, events } = setup(vi.fn<CreateMessage>(async () => reply("Hello")));
    await client.complete(request({ messages: [{ role: "user", content: "How much is a 2BHK?" }] }));
    expect(events[0].input).toEqual({ system: ["RULES", "BUSINESS", "TAIL"], messages: [{ role: "user", content: "How much is a 2BHK?" }] });
  });

  it("records a failure with its code and status, and no output", async () => {
    const { client, events } = setup(vi.fn<CreateMessage>(async () => Promise.reject(apiError(401))));
    await fail(client.complete(request()));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "error", errorCode: "rejected", httpStatus: 401, attempts: 1 });
    expect(events[0].output).toBeUndefined();
  });

  it("records a refusal and a cut-off answer as errors, with the usage that was still spent", async () => {
    const { client, events } = setup(vi.fn<CreateMessage>(async () => reply("x", { stop_reason: "max_tokens" })));
    await fail(client.complete(request()));
    expect(events[0]).toMatchObject({ status: "error", errorCode: "truncated", usage: { outputTokens: 250 } });
  });

  it("never lets a tracing failure change the answer", async () => {
    const tracer: Tracer = {
      record: () => {
        throw new Error("langfuse is down");
      },
    };
    const result = await setup(vi.fn<CreateMessage>(async () => reply("Hello")), { tracer }).client.complete(request());
    expect(result.text).toBe("Hello");
    const error = await fail(setup(vi.fn<CreateMessage>(async () => Promise.reject(apiError(401))), { tracer }).client.complete(request()));
    expect(error.code).toBe("rejected");
  });

  it("does not trace a request that was refused before it was sent", async () => {
    const { client, events } = setup(vi.fn<CreateMessage>(async () => reply("Hello")));
    await fail(client.complete(request({ messages: [] })));
    expect(events).toHaveLength(0);
  });
});
