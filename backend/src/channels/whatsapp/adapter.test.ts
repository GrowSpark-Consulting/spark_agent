import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionSecretContext, encryptSecret } from "../../lib/crypto";
import {
  ADAPTER_MESSAGES,
  markRead,
  sendInteractive,
  sendTemplate,
  sendText,
  type AdapterDeps,
  type AdapterResult,
  type SendConnection,
  type TemplateMessage,
} from "./adapter";

// Synthetic values only: nothing here is a real token, number or Meta response.
const KEY = randomBytes(32).toString("base64");
const env = { ENCRYPTION_KEY: KEY, META_GRAPH_API_VERSION: "v26.0" };
const TENANT = "d0000000-0000-0000-0000-0000000000a1";
const CONNECTION = "d4000000-0000-0000-0000-0000000000a1";
const PHONE_NUMBER_ID = "200000000000001";
const TOKEN = "EAAB-synthetic-token-never-leak-0001";
const URL_EXPECTED = `https://graph.facebook.com/v26.0/${PHONE_NUMBER_ID}/messages`;

const context = (over: Partial<Parameters<typeof connectionSecretContext>[0]> = {}) =>
  connectionSecretContext({ column: "token_enc", tenantId: TENANT, connectionId: CONNECTION, ...over });
const connection = (over: Partial<SendConnection> = {}): SendConnection => ({
  tenantId: TENANT,
  connectionId: CONNECTION,
  phoneNumberId: PHONE_NUMBER_ID,
  tokenEnc: encryptSecret(TOKEN, context(), env),
  ...over,
});

const reply = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
const okSend = () => reply(200, { messaging_product: "whatsapp", contacts: [{ input: "+910000000101", wa_id: "910000000101" }], messages: [{ id: "wamid.SYNTHETIC_OUT_0001" }] });
const metaError = (code: number, extra: Record<string, unknown> = {}) => ({
  error: {
    message: "MARKER-meta-message",
    type: "OAuthException",
    code,
    error_subcode: 2388024,
    error_data: { messaging_product: "whatsapp", details: "MARKER-meta-details" },
    fbtrace_id: "MARKER-trace",
    ...extra,
  },
});

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;
const fakeFetch = (handler: Parameters<typeof vi.fn<typeof fetch>>[0]): FetchMock => vi.fn<typeof fetch>(handler);
const deps = (f: FetchMock, over: Partial<AdapterDeps> = {}): AdapterDeps => ({ fetch: f, env, timeoutMs: 1000, ...over });

let logs: unknown[][];
beforeEach(() => {
  logs = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args);
    });
  }
});
afterEach(() => vi.restoreAllMocks());

const FIXED_MESSAGES = Object.values(ADAPTER_MESSAGES);
function expectFailure<T>(result: AdapterResult<T>) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a failure");
  return result.error;
}

describe("sendText", () => {
  it("sends the exact request and returns the wamid", async () => {
    const f = fakeFetch(async () => okSend());
    const result = await sendText(connection(), "+910000000101", "Hello", deps(f));

    expect(result).toEqual({ ok: true, value: { providerMsgId: "wamid.SYNTHETIC_OUT_0001" } });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(URL_EXPECTED);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" });
    expect(JSON.parse(init?.body as string)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "+910000000101",
      type: "text",
      text: { body: "Hello", preview_url: false },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses the Graph API version from the environment", async () => {
    const f = fakeFetch(async () => okSend());
    await sendText(connection(), "+910000000101", "Hi", deps(f, { env: { ...env, META_GRAPH_API_VERSION: "v27.0" } }));
    expect(f.mock.calls[0][0]).toBe(`https://graph.facebook.com/v27.0/${PHONE_NUMBER_ID}/messages`);
  });

  it.each(["910000000101", "+910000000101", "+91 00000-00101"])("sends %s as E.164 with the +", async (to) => {
    const f = fakeFetch(async () => okSend());
    await sendText(connection(), to, "Hi", deps(f));
    expect(JSON.parse(f.mock.calls[0][1]?.body as string).to).toBe("+910000000101");
  });

  it("keeps unicode text intact and allows exactly 4096 characters", async () => {
    const f = fakeFetch(async () => okSend());
    await sendText(connection(), "+910000000101", "வணக்கம் 🙏 ₹1,499", deps(f));
    expect(JSON.parse(f.mock.calls[0][1]?.body as string).text.body).toBe("வணக்கம் 🙏 ₹1,499");
    expect((await sendText(connection(), "+910000000101", "x".repeat(4096), deps(f))).ok).toBe(true);
  });

  describe("checks before any network call", () => {
    it.each([
      ["a number that is not E.164", "abc", "hello"],
      ["an empty number", "", "hello"],
      ["a too short number", "12345", "hello"],
      ["a group id", "120363025246125486@g.us", "hello"],
      ["an empty body", "+910000000101", ""],
      ["a blank body", "+910000000101", "   "],
      ["a body over 4096 characters", "+910000000101", "x".repeat(4097)],
    ])("rejects %s", async (_why, to, body) => {
      const f = fakeFetch(async () => okSend());
      const error = expectFailure(await sendText(connection(), to, body, deps(f)));
      expect(error).toMatchObject({ code: "validation_failed", retryable: false, outcomeUnknown: false });
      expect(f).not.toHaveBeenCalled();
    });

    it.each(["", "abc", "123/../456", "123 456", "123?x=1", "123#"])("rejects the phone number id %j", async (phoneNumberId) => {
      const f = fakeFetch(async () => okSend());
      const error = expectFailure(await sendText(connection({ phoneNumberId }), "+910000000101", "Hi", deps(f)));
      expect(error.code).toBe("validation_failed");
      expect(f).not.toHaveBeenCalled();
    });

    it("rejects an environment with a bad Graph API version", async () => {
      const f = fakeFetch(async () => okSend());
      const error = expectFailure(await sendText(connection(), "+910000000101", "Hi", deps(f, { env: { ...env, META_GRAPH_API_VERSION: "latest" } })));
      expect(error.code).toBe("internal");
      expect(f).not.toHaveBeenCalled();
    });
  });

  describe("Meta errors", () => {
    it.each([
      [131047, 400, "outside_window", false],
      [130429, 429, "rate_limited", true],
      [131056, 400, "rate_limited", true],
      [190, 401, "whatsapp_not_connected", false],
      [131026, 400, "validation_failed", false],
      [131009, 400, "validation_failed", false],
      [131000, 500, "upstream_failed", true],
      [131042, 400, "upstream_failed", false],
      [999999, 400, "upstream_failed", false],
    ] as const)("maps Meta code %i (HTTP %i) to %s", async (metaCode, status, code, retryable) => {
      const f = fakeFetch(async () => reply(status, metaError(metaCode)));
      const error = expectFailure(await sendText(connection(), "+910000000101", "Hi", deps(f)));
      expect(error).toMatchObject({ code, retryable, outcomeUnknown: false });
      expect(error.meta).toEqual({ code: metaCode, subcode: 2388024, httpStatus: status });
    });

    it.each([
      ["429 with no body", 429, "", "rate_limited", true],
      ["401 with an empty object", 401, "{}", "whatsapp_not_connected", false],
      ["500 with an HTML page", 500, "<html>Bad gateway</html>", "upstream_failed", true],
      ["404 with JSON but no error", 404, '{"hello":"world"}', "upstream_failed", false],
      ["400 with an array", 400, "[]", "upstream_failed", false],
    ] as const)("falls back to the HTTP status for %s", async (_why, status, body, code, retryable) => {
      const f = fakeFetch(async () => reply(status, body));
      const error = expectFailure(await sendText(connection(), "+910000000101", "Hi", deps(f)));
      expect(error).toMatchObject({ code, retryable });
      expect(error.meta).toEqual({ httpStatus: status });
    });

    it("never repeats Meta's own text: every message is one of our fixed strings", async () => {
      const results = await Promise.all(
        [131047, 130429, 190, 131026, 131000, 999999].map((code) =>
          sendText(connection(), "+910000000101", "Hi", deps(fakeFetch(async () => reply(400, metaError(code))))),
        ),
      );
      for (const result of results) {
        const error = expectFailure(result);
        expect(FIXED_MESSAGES).toContain(error.message);
        expect(JSON.stringify(result)).not.toMatch(/MARKER|OAuthException|2388024-details/);
      }
    });

    it("keeps only numbers in meta, and drops values that are not integers", async () => {
      const body = metaError(190, { code: "190", error_subcode: 1.5, extra: "text" });
      const f = fakeFetch(async () => reply(401, body));
      const error = expectFailure(await sendText(connection(), "+910000000101", "Hi", deps(f)));
      expect(Object.keys(error.meta ?? {}).every((k) => ["code", "subcode", "httpStatus"].includes(k))).toBe(true);
      expect(Object.values(error.meta ?? {}).every((v) => typeof v === "number" && Number.isInteger(v))).toBe(true);
      expect(error.meta).toEqual({ httpStatus: 401 });
      expect(error.code).toBe("whatsapp_not_connected"); // from the HTTP status, since "190" is not a number
    });

    it.each([
      ["non-JSON", 200, "<html>hello</html>"],
      ["empty", 200, ""],
      ["a JSON array", 200, "[]"],
      ["an object without messages", 200, '{"messaging_product":"whatsapp"}'],
      ["an empty messages list", 200, '{"messages":[]}'],
      ["a message without an id", 200, '{"messages":[{}]}'],
      ["an empty id", 200, '{"messages":[{"id":""}]}'],
    ])("treats a 200 answer that is %s as an unknown outcome", async (_why, status, body) => {
      const f = fakeFetch(async () => reply(status, body));
      const error = expectFailure(await sendText(connection(), "+910000000101", "Hi", deps(f)));
      expect(error).toMatchObject({ code: "upstream_failed", retryable: false, outcomeUnknown: true });
      expect(FIXED_MESSAGES).toContain(error.message);
    });

    it("does not throw when reading the response fails", async () => {
      const broken = { ok: true, status: 200, text: () => Promise.reject(new Error(`boom ${TOKEN}`)), json: () => Promise.reject(new Error("boom")) } as unknown as Response;
      const result = await sendText(connection(), "+910000000101", "Hi", deps(fakeFetch(async () => broken)));
      expect(expectFailure(result).outcomeUnknown).toBe(true);
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    });

    it("does not retry: one fetch on a 500 and on a 429", async () => {
      for (const status of [500, 429]) {
        const f = fakeFetch(async () => reply(status, metaError(status === 500 ? 131000 : 130429)));
        await sendText(connection(), "+910000000101", "Hi", deps(f));
        expect(f).toHaveBeenCalledTimes(1);
      }
    });
  });

  describe("timeouts and network failures", () => {
    it("times out when fetch honours the abort signal", async () => {
      const f = fakeFetch((_url, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))));
      const error = expectFailure(await sendText(connection(), "+910000000101", "Hi", deps(f, { timeoutMs: 20 })));
      expect(error).toMatchObject({ code: "upstream_failed", retryable: true, outcomeUnknown: true });
      expect(FIXED_MESSAGES).toContain(error.message);
    });

    it("times out even when fetch ignores the abort signal", async () => {
      const f = fakeFetch(() => new Promise<Response>(() => {}));
      const error = expectFailure(await sendText(connection(), "+910000000101", "Hi", deps(f, { timeoutMs: 20 })));
      expect(error).toMatchObject({ code: "upstream_failed", retryable: true, outcomeUnknown: true });
    });

    it("turns a network failure into a typed error that does not repeat the thrown message", async () => {
      const f = fakeFetch(async () => {
        throw new TypeError(`fetch failed: Authorization: Bearer ${TOKEN} to +910000000101`);
      });
      const result = await sendText(connection(), "+910000000101", "Hi", deps(f));
      expect(expectFailure(result)).toMatchObject({ code: "upstream_failed", retryable: true, outcomeUnknown: true });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      expect(JSON.stringify(result)).not.toContain("910000000101");
    });
  });

  describe("the token", () => {
    it("is decrypted per call, appears only in the Authorization header, and is in no result or log", async () => {
      const calls: FetchMock[] = [];
      const results: unknown[] = [];
      const run = async (handler: Parameters<typeof fakeFetch>[0]) => {
        const f = fakeFetch(handler);
        calls.push(f);
        results.push(await sendText(connection(), "+910000000101", "Hi", deps(f)));
      };
      await run(async () => okSend());
      await run(async () => reply(400, metaError(131047)));
      await run(async () => reply(200, "not json"));
      await run(async () => {
        throw new Error(`network down ${TOKEN}`);
      });

      for (const f of calls) {
        for (const [url, init] of f.mock.calls) {
          expect(String(url)).not.toContain(TOKEN);
          expect(String(init?.body)).not.toContain(TOKEN);
          expect(JSON.stringify({ ...(init?.headers as object), Authorization: undefined })).not.toContain(TOKEN);
          expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
        }
      }
      expect(JSON.stringify(results)).not.toContain(TOKEN);
      expect(JSON.stringify(logs)).not.toContain(TOKEN);
      expect(logs).toEqual([]);
    });

    it.each([
      ["a flipped byte in the ciphertext", () => {
        const parts = connection().tokenEnc.split(":");
        const bytes = Buffer.from(parts[3], "base64url");
        bytes[0] ^= 1;
        parts[3] = bytes.toString("base64url");
        return connection({ tokenEnc: parts.join(":") });
      }],
      ["garbage", () => connection({ tokenEnc: "not-an-encrypted-value" })],
      ["an empty value", () => connection({ tokenEnc: "" })],
      ["a token encrypted for another tenant", () => connection({ tokenEnc: encryptSecret(TOKEN, context({ tenantId: "d0000000-0000-0000-0000-0000000000b1" }), env) })],
      ["a token encrypted for another connection", () => connection({ tokenEnc: encryptSecret(TOKEN, context({ connectionId: "d4000000-0000-0000-0000-0000000000b1" }), env) })],
      ["a token from the other column", () => connection({ tokenEnc: encryptSecret(TOKEN, context({ column: "app_secret_enc" }), env) })],
    ])("gives whatsapp_not_connected and never calls fetch for %s", async (_why, make) => {
      const f = fakeFetch(async () => okSend());
      const result = await sendText(make(), "+910000000101", "Hi", deps(f));
      expect(expectFailure(result)).toMatchObject({ code: "whatsapp_not_connected", retryable: false, outcomeUnknown: false });
      expect(f).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    });

    it("gives whatsapp_not_connected for a token encrypted with another key", async () => {
      const f = fakeFetch(async () => okSend());
      const other = { ENCRYPTION_KEY: randomBytes(32).toString("base64"), META_GRAPH_API_VERSION: "v26.0" };
      const result = await sendText(connection(), "+910000000101", "Hi", deps(f, { env: other }));
      expect(expectFailure(result).code).toBe("whatsapp_not_connected");
      expect(f).not.toHaveBeenCalled();
    });

    it("gives internal when ENCRYPTION_KEY is not set, without calling fetch", async () => {
      const f = fakeFetch(async () => okSend());
      const result = await sendText(connection(), "+910000000101", "Hi", deps(f, { env: { META_GRAPH_API_VERSION: "v26.0" } }));
      expect(expectFailure(result)).toMatchObject({ code: "internal", retryable: false });
      expect(f).not.toHaveBeenCalled();
    });
  });

  it("never throws on junk input and returns a failure", async () => {
    const f = fakeFetch(async () => okSend());
    for (const bad of [undefined, null, {}, [], "text", 42]) {
      const run = () => sendText(bad as never, bad as never, bad as never, deps(f));
      await expect(run()).resolves.toMatchObject({ ok: false });
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("only ever returns our fixed messages, across every failure above", async () => {
    expect(FIXED_MESSAGES.length).toBeGreaterThanOrEqual(6);
    expect(new Set(FIXED_MESSAGES).size).toBe(FIXED_MESSAGES.length);
    for (const message of FIXED_MESSAGES) {
      expect(message).not.toMatch(/MARKER|EAA|Bearer|wamid|\+?\d{8,}/);
    }
  });
});

describe("sendTemplate", () => {
  const template = (over: Partial<TemplateMessage> = {}): TemplateMessage => ({
    name: "reminder_24h_v2",
    language: "en",
    params: ["Karthik", "4 pm"],
    ...over,
  });

  it("sends the exact request, with the body variables in order, and returns the wamid", async () => {
    const f = fakeFetch(async () => okSend());
    const result = await sendTemplate(connection(), "+910000000101", template(), deps(f));

    expect(result).toEqual({ ok: true, value: { providerMsgId: "wamid.SYNTHETIC_OUT_0001" } });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(URL_EXPECTED);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" });
    expect(JSON.parse(init?.body as string)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "+910000000101",
      type: "template",
      template: {
        name: "reminder_24h_v2",
        language: { code: "en" },
        components: [{ type: "body", parameters: [{ type: "text", text: "Karthik" }, { type: "text", text: "4 pm" }] }],
      },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends the payload of each quick-reply button, in order, so a tap comes back with our id", async () => {
    const f = fakeFetch(async () => okSend());
    const buttons = ["booking:9b2f0a4e-1c3d-4e5f-8a6b-7c8d9e0f1a2b:confirm", "booking:9b2f0a4e-1c3d-4e5f-8a6b-7c8d9e0f1a2b:cancel"];
    await sendTemplate(connection(), "+910000000101", template({ buttons }), deps(f));
    expect(JSON.parse(f.mock.calls[0][1]?.body as string).template.components).toEqual([
      { type: "body", parameters: [{ type: "text", text: "Karthik" }, { type: "text", text: "4 pm" }] },
      { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: buttons[0] }] },
      { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: buttons[1] }] },
    ]);
  });

  it("refuses button payloads Meta would reject, without calling it", async () => {
    const f = fakeFetch(async () => okSend());
    for (const buttons of [[""], ["x".repeat(257)], Array.from({ length: 11 }, (_, i) => `b${i}`)]) {
      await expect(sendTemplate(connection(), "+910000000101", template({ buttons }), deps(f))).resolves.toMatchObject({ ok: false, error: { code: "validation_failed" } });
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("leaves out components for a template without variables", async () => {
    const f = fakeFetch(async () => okSend());
    await sendTemplate(connection(), "+910000000101", template({ params: [] }), deps(f));
    expect(JSON.parse(f.mock.calls[0][1]?.body as string).template).toEqual({ name: "reminder_24h_v2", language: { code: "en" } });
  });

  it("keeps Tamil text intact, accepts locale codes, four spaces and exactly 1024 characters", async () => {
    const f = fakeFetch(async () => okSend());
    await sendTemplate(connection(), "910000000101", template({ language: "ta", params: ["கார்த்திக்", "₹1,499"] }), deps(f));
    const sent = JSON.parse(f.mock.calls[0][1]?.body as string);
    expect(sent.to).toBe("+910000000101");
    expect(sent.template.language).toEqual({ code: "ta" });
    expect(sent.template.components[0].parameters).toEqual([{ type: "text", text: "கார்த்திக்" }, { type: "text", text: "₹1,499" }]);
    for (const over of [{ language: "en_US" }, { params: ["a    b"] }, { params: ["x".repeat(1024)] }]) {
      expect((await sendTemplate(connection(), "+910000000101", template(over), deps(f))).ok).toBe(true);
    }
  });

  describe("checks before any network call", () => {
    it.each([
      ["a number that is not E.164", "abc", template()],
      ["an upper-case name", "+910000000101", template({ name: "Reminder_24h_v2" })],
      ["a name with a space", "+910000000101", template({ name: "reminder 24h" })],
      ["an empty name", "+910000000101", template({ name: "" })],
      ["a language that is not a code", "+910000000101", template({ language: "english" })],
      ["an empty language", "+910000000101", template({ language: "" })],
      ["an empty variable", "+910000000101", template({ params: ["Karthik", ""] })],
      ["a blank variable", "+910000000101", template({ params: ["   "] })],
      ["a variable with a newline", "+910000000101", template({ params: ["line one\nline two"] })],
      ["a variable with a tab", "+910000000101", template({ params: ["a\tb"] })],
      ["a variable with five spaces in a row", "+910000000101", template({ params: ["a     b"] })],
      ["a variable over 1024 characters", "+910000000101", template({ params: ["x".repeat(1025)] })],
      ["variables that are not a list", "+910000000101", template({ params: "Karthik" as never })],
      ["a variable that is not text", "+910000000101", template({ params: [42 as never] })],
    ])("rejects %s", async (_why, to, message) => {
      const f = fakeFetch(async () => okSend());
      const error = expectFailure(await sendTemplate(connection(), to, message, deps(f)));
      expect(error).toMatchObject({ code: "validation_failed", retryable: false, outcomeUnknown: false });
      expect(FIXED_MESSAGES).toContain(error.message);
      expect(f).not.toHaveBeenCalled();
    });
  });

  it.each([
    [131047, 400, "outside_window", false],
    [132000, 400, "validation_failed", false],
    [132001, 404, "upstream_failed", false],
    [132015, 400, "upstream_failed", false],
    [130429, 429, "rate_limited", true],
    [190, 401, "whatsapp_not_connected", false],
  ] as const)("maps Meta code %i (HTTP %i) to %s", async (metaCode, status, code, retryable) => {
    const f = fakeFetch(async () => reply(status, metaError(metaCode)));
    const error = expectFailure(await sendTemplate(connection(), "+910000000101", template(), deps(f)));
    expect(error).toMatchObject({ code, retryable, outcomeUnknown: false });
    expect(FIXED_MESSAGES).toContain(error.message);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("treats a timeout and an unreadable 200 as unknown outcomes", async () => {
    const slow = fakeFetch(() => new Promise<Response>(() => {}));
    expect(expectFailure(await sendTemplate(connection(), "+910000000101", template(), deps(slow, { timeoutMs: 20 })))).toMatchObject({
      code: "upstream_failed",
      retryable: true,
      outcomeUnknown: true,
    });
    const unclear = fakeFetch(async () => reply(200, "<html></html>"));
    expect(expectFailure(await sendTemplate(connection(), "+910000000101", template(), deps(unclear)))).toMatchObject({
      code: "upstream_failed",
      outcomeUnknown: true,
    });
  });

  it("keeps the token in the Authorization header only, and logs nothing", async () => {
    const f = fakeFetch(async () => okSend());
    const result = await sendTemplate(connection(), "+910000000101", template(), deps(f));
    const [url, init] = f.mock.calls[0];
    expect(String(url) + String(init?.body)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(logs).toEqual([]);
  });

  it("gives whatsapp_not_connected for a tampered token without calling fetch", async () => {
    const f = fakeFetch(async () => okSend());
    const result = await sendTemplate(connection({ tokenEnc: "not-an-encrypted-value" }), "+910000000101", template(), deps(f));
    expect(expectFailure(result).code).toBe("whatsapp_not_connected");
    expect(f).not.toHaveBeenCalled();
  });

  it("never throws on junk input and returns a failure", async () => {
    const f = fakeFetch(async () => okSend());
    for (const bad of [undefined, null, {}, [], "text", 42]) {
      await expect(sendTemplate(bad as never, bad as never, bad as never, deps(f))).resolves.toMatchObject({ ok: false });
    }
    expect(f).not.toHaveBeenCalled();
  });
});

describe("sendInteractive", () => {
  const buttons = {
    type: "buttons" as const,
    header: "Site visit",
    body: "Your visit is tomorrow at 5:00 pm.",
    footer: "Skyline Homes",
    buttons: [
      { id: "booking:b1:confirm", title: "Confirm" },
      { id: "booking:b1:cancel", title: "Cancel" },
    ],
  };
  const list = {
    type: "list" as const,
    body: "Which time suits you?",
    button: "See times",
    sections: [
      { title: "Friday", rows: [{ id: "slot:1", title: "Fri 9 Oct, 5:00 pm", description: "With Priya" }] },
      { title: "Saturday", rows: [{ id: "slot:2", title: "Sat 10 Oct, 11:00 am" }] },
    ],
  };

  it("sends reply buttons as Meta's interactive button message and returns the wamid", async () => {
    const f = fakeFetch(async () => okSend());
    const result = await sendInteractive(connection(), "+910000000101", buttons, deps(f));

    expect(result).toEqual({ ok: true, value: { providerMsgId: "wamid.SYNTHETIC_OUT_0001" } });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(URL_EXPECTED);
    expect(init?.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" });
    expect(JSON.parse(init?.body as string)).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "+910000000101",
      type: "interactive",
      interactive: {
        type: "button",
        header: { type: "text", text: "Site visit" },
        body: { text: "Your visit is tomorrow at 5:00 pm." },
        footer: { text: "Skyline Homes" },
        action: {
          buttons: [
            { type: "reply", reply: { id: "booking:b1:confirm", title: "Confirm" } },
            { type: "reply", reply: { id: "booking:b1:cancel", title: "Cancel" } },
          ],
        },
      },
    });
  });

  it("sends a list with its sections, leaving out what was not given", async () => {
    const f = fakeFetch(async () => okSend());
    expect((await sendInteractive(connection(), "910000000101", list, deps(f))).ok).toBe(true);
    const sent = JSON.parse(f.mock.calls[0][1]?.body as string);
    expect(sent.to).toBe("+910000000101");
    expect(sent.interactive).toEqual({
      type: "list",
      body: { text: "Which time suits you?" },
      action: {
        button: "See times",
        sections: [
          { title: "Friday", rows: [{ id: "slot:1", title: "Fri 9 Oct, 5:00 pm", description: "With Priya" }] },
          { title: "Saturday", rows: [{ id: "slot:2", title: "Sat 10 Oct, 11:00 am" }] },
        ],
      },
    });
  });

  it.each([
    ["a number that is not E.164", "abc", buttons],
    ["four buttons", "+910000000101", { ...buttons, buttons: [1, 2, 3, 4].map((i) => ({ id: `b${i}`, title: `B${i}` })) }],
    ["a button title over 20 characters", "+910000000101", { ...buttons, buttons: [{ id: "b", title: "t".repeat(21) }] }],
    ["eleven list rows", "+910000000101", { ...list, sections: [{ rows: Array.from({ length: 11 }, (_, i) => ({ id: `r${i}`, title: `Row ${i}` })) }] }],
    ["an empty body", "+910000000101", { ...buttons, body: "" }],
  ])("rejects %s before any network call", async (_why, to, message) => {
    const f = fakeFetch(async () => okSend());
    const error = expectFailure(await sendInteractive(connection(), to, message as never, deps(f)));
    expect(error).toMatchObject({ code: "validation_failed", retryable: false, outcomeUnknown: false });
    expect(f).not.toHaveBeenCalled();
  });

  it("maps Meta's 131047 (window closed) to outside_window, like free text", async () => {
    const f = fakeFetch(async () => reply(400, metaError(131047)));
    expect(expectFailure(await sendInteractive(connection(), "+910000000101", buttons, deps(f)))).toMatchObject({ code: "outside_window" });
  });

  it("keeps the token in the Authorization header only, logs nothing and never throws on junk", async () => {
    const f = fakeFetch(async () => okSend());
    const result = await sendInteractive(connection(), "+910000000101", list, deps(f));
    expect(String(f.mock.calls[0][1]?.body)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    for (const bad of [undefined, null, {}, [], "text", 42]) {
      await expect(sendInteractive(bad as never, bad as never, bad as never, deps(f))).resolves.toMatchObject({ ok: false });
    }
    expect(logs).toEqual([]);
  });
});

describe("markRead", () => {
  it("sends the exact request and returns success", async () => {
    const f = fakeFetch(async () => reply(200, { success: true }));
    const result = await markRead(connection(), "wamid.SYNTHETIC_IN_0001", deps(f));

    expect(result).toEqual({ ok: true, value: { success: true } });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(URL_EXPECTED);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" });
    expect(JSON.parse(init?.body as string)).toEqual({ messaging_product: "whatsapp", status: "read", message_id: "wamid.SYNTHETIC_IN_0001" });
  });

  it.each([
    ["success false", 200, '{"success":false}', "upstream_failed", false],
    ["no body", 200, "", "upstream_failed", false],
    ["Meta 131009 (invalid message id)", 400, JSON.stringify(metaError(131009)), "validation_failed", false],
    ["an expired token", 401, JSON.stringify(metaError(190)), "whatsapp_not_connected", false],
    ["a rate limit", 429, JSON.stringify(metaError(130429)), "rate_limited", true],
    ["a server error", 500, "<html></html>", "upstream_failed", true],
  ] as const)("fails with a typed error for %s", async (_why, status, body, code, retryable) => {
    const f = fakeFetch(async () => reply(status, body));
    const result = await markRead(connection(), "wamid.SYNTHETIC_IN_0001", deps(f));
    const error = expectFailure(result);
    expect(error).toMatchObject({ code, retryable });
    expect(FIXED_MESSAGES).toContain(error.message);
    expect(JSON.stringify(result)).not.toMatch(/MARKER|wamid\.SYNTHETIC_IN/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it.each([["an empty id", ""], ["a very long id", "w".repeat(300)], ["a number", 42], ["undefined", undefined]])("rejects %s without calling fetch", async (_why, wamid) => {
    const f = fakeFetch(async () => reply(200, { success: true }));
    expect(expectFailure(await markRead(connection(), wamid as never, deps(f))).code).toBe("validation_failed");
    expect(f).not.toHaveBeenCalled();
  });

  it("keeps the token in the Authorization header only, and logs nothing", async () => {
    const f = fakeFetch(async () => reply(200, { success: true }));
    const result = await markRead(connection(), "wamid.SYNTHETIC_IN_0001", deps(f));
    const [url, init] = f.mock.calls[0];
    expect(String(url) + String(init?.body)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(logs).toEqual([]);
  });

  it("gives whatsapp_not_connected for a tampered token without calling fetch", async () => {
    const f = fakeFetch(async () => reply(200, { success: true }));
    const result = await markRead(connection({ tokenEnc: "v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:AAAA" }), "wamid.X", deps(f));
    expect(expectFailure(result).code).toBe("whatsapp_not_connected");
    expect(f).not.toHaveBeenCalled();
  });

  it("times out and survives a network failure with typed errors", async () => {
    const slow = fakeFetch(() => new Promise<Response>(() => {}));
    expect(expectFailure(await markRead(connection(), "wamid.X", deps(slow, { timeoutMs: 20 })))).toMatchObject({ code: "upstream_failed", retryable: true, outcomeUnknown: true });
    const down = fakeFetch(async () => {
      throw new TypeError("fetch failed");
    });
    expect(expectFailure(await markRead(connection(), "wamid.X", deps(down)))).toMatchObject({ code: "upstream_failed", retryable: true, outcomeUnknown: true });
  });

  it("never throws on junk input", async () => {
    const f = fakeFetch(async () => reply(200, { success: true }));
    for (const bad of [undefined, null, {}, 42]) {
      await expect(markRead(bad as never, bad as never, deps(f))).resolves.toMatchObject({ ok: false });
    }
  });
});
