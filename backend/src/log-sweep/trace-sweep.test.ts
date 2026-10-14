import Anthropic from "@anthropic-ai/sdk";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { createLlmClient, type LlmRequest } from "../agent/llm/anthropic";
import { MODELS } from "../agent/llm/models";
import { createLangfuseTracer, type TracerHandle } from "../agent/llm/tracing";
import { captureLogs, findLeaks, phoneForms, poison, type Fixtures, type LogCapture } from "./detect";

// Day 7, PR B: what leaves for the tracing service (Langfuse), through the REAL client and the REAL exporter into a local HTTP server that records what arrives
// (the only way to know what leaves the process). Two settings: text capture OFF (the default: lengths only) and ON (LANGFUSE_CAPTURE_TEXT=true: the customer's
// words and the reply, masked by agent/llm/mask.ts and cut short).
//
// What mask.ts CLAIMS to mask is tested as a requirement: the shapes it lists (a number with or without + and country code, with single spaces or dashes
// between digits, 10 to 15 digits) and email addresses. A claimed shape that leaks would be a real leak.
// What it does NOT claim (brackets, dots, double separators, digits in other scripts, spelled-out digits; names, addresses, budgets, anything that is not a
// phone number or an email) is recorded below as KNOWN LIMITS: those tests pass while the limit exists. Nothing in mask.ts was changed.
// NOT PROVED: whether LANGFUSE_CAPTURE_TEXT is on in staging or production (can't tell from code), Langfuse's own storage, the real Anthropic API.

const TENANT = "e0000000-0000-4000-8000-00000000000a";
const CONVERSATION = "c0000000-0000-4000-8000-00000000000c";
const PHONE = "+919812345621";
const CANARY = { customer: "CANARY-CUSTOMER-7QX", reply: "CANARY-REPLY-9ZK", system: "CANARY-SYSTEM-PROMPT-2WD", name: "Priya Canary" };
const FX: Fixtures = { phones: [PHONE], secrets: ["sk-lf-synthetic-secret-key", "pk-lf-synthetic-public-key", "synthetic-anthropic-key"], texts: [] };

const servers: Server[] = [];
const handles: TracerHandle[] = [];
let capture: LogCapture | undefined;
afterEach(async () => {
  capture?.stop();
  capture = undefined;
  await Promise.all(handles.splice(0).map((h) => h.shutdown().catch(() => undefined)));
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => (s.closeAllConnections(), s.close(resolve)))));
});

async function collector() {
  const received: string[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      received.push((req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { received, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const message = (text: string, over: Record<string, unknown> = {}) =>
  ({ id: "msg_01", type: "message", role: "assistant", model: MODELS.reply, content: [{ type: "text", text }], stop_reason: "end_turn", stop_details: null, usage: { input_tokens: 800, output_tokens: 250, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, _request_id: "req_01", ...over }) as unknown as Anthropic.Message;

const request = (customerText: string): LlmRequest => ({
  role: "reply",
  tenantId: TENANT,
  conversationId: CONVERSATION,
  prompt: { name: "reply", version: 1 },
  system: [{ text: `You are the assistant of Skyline Homes. ${CANARY.system}`, cache: true }],
  messages: [{ role: "user", content: customerText }],
});

/** One model call through the real client and the real exporter; returns everything the tracing service received, as text, and the console lines. */
async function traced(opts: { captureText: boolean; customerText: string; replyText?: string; fail?: Error }): Promise<{ body: string; lines: string[]; leaks: ReturnType<typeof findLeaks> }> {
  capture = captureLogs();
  const { received, baseUrl } = await collector();
  const handle = createLangfuseTracer({ publicKey: "pk-lf-synthetic-public-key", secretKey: "sk-lf-synthetic-secret-key", baseUrl, compression: "none", captureText: opts.captureText });
  handles.push(handle);
  const client = createLlmClient({
    create: async () => {
      if (opts.fail) throw opts.fail;
      return message(opts.replyText ?? "ok");
    },
    tracer: handle.tracer,
    sleep: async () => undefined,
  });
  try {
    await client.complete(request(opts.customerText));
  } catch {
    // an error is traced with its code and status only
  }
  await handle.flush();
  const body = received.join("\n");
  const lines = capture.lines();
  return { body, lines, leaks: findLeaks([...lines], FX) };
}

/** The text the exporter sent, decoded from its JSON (so an escaped character is what it was). */
const decoded = (body: string) => body.split("\n").map((part) => (part ? JSON.stringify(JSON.parse(part)) : "")).join("\n") + body;

describe("text capture OFF (the default): lengths and ids only", () => {
  const customerText = `Hi, I am ${CANARY.name}, call me on ${PHONE} or 9812345621, mail priya@example.test. ${CANARY.customer}`;

  it("nothing of the customer's message, the reply, the system prompt, or any number reaches the tracing service", async () => {
    const { body } = await traced({ captureText: false, customerText, replyText: `Sure, calling ${PHONE}. ${CANARY.reply}` });
    expect(body.length).toBeGreaterThan(100); // something was sent
    for (const secret of [CANARY.name, CANARY.customer, CANARY.reply, CANARY.system, "priya@example.test", ...phoneForms(PHONE)]) expect(decoded(body), secret).not.toContain(secret);
    // (no generic phone-shape check on the exported body: it holds timestamps and random ids whose digit runs can look like a number; the exact numbers above are the check)
  });

  it("what is sent: the business's id (as an attribute and a tag), the conversation id, the model, tokens, cost and lengths", async () => {
    const { body } = await traced({ captureText: false, customerText, replyText: "ok" });
    for (const expected of [TENANT, CONVERSATION, "input_chars", "output_chars", MODELS.reply]) expect(body).toContain(expected);
  });

  it("a failed call: the code and the status, never the provider's message", async () => {
    const failure = Anthropic.APIError.generate(500, { type: "error", error: { type: "x", message: poison({ phones: [PHONE], secrets: ["synthetic-anthropic-key"], texts: [CANARY.customer] }) } }, "boom", new Headers());
    const { body, lines } = await traced({ captureText: false, customerText, fail: failure });
    // (the exported body holds OpenTelemetry's 32-hex trace id, which the token-shape detector would flag: the exact checks are used on it, the full sweep on the console lines)
    const sent = decoded(body);
    for (const secret of [CANARY.customer, CANARY.name, "synthetic-anthropic-key", ...phoneForms(PHONE)]) expect(sent, secret).not.toContain(secret);
    expect(findLeaks(lines, { phones: [PHONE], secrets: ["synthetic-anthropic-key"], texts: [CANARY.customer, CANARY.name] })).toEqual([]);
  });

  it("the client's own console lines for a failing call carry the code and the status, nothing else", async () => {
    const failure = Anthropic.APIError.generate(500, { type: "error", error: { type: "x", message: `provider says ${PHONE} ${CANARY.customer}` } }, "boom", new Headers());
    const { lines } = await traced({ captureText: false, customerText, fail: failure });
    expect(lines.length).toBeGreaterThan(0);
    expect(findLeaks(lines, { phones: [PHONE], secrets: [], texts: [CANARY.customer, CANARY.name] })).toEqual([]);
  });
});

describe("text capture ON: what mask.ts CLAIMS to mask must not reach the tracing service", () => {
  // The shapes mask.test.ts lists, and the others the pattern is built for: 10 to 15 digits, an optional +, single spaces or dashes between digits.
  const CLAIMED: [string, string][] = [
    ["E.164", "+919812345621"],
    ["without the plus", "919812345621"],
    ["ten digits", "9812345621"],
    ["with the country code and spaces", "+91 98123 45621"],
    ["with the country code and dashes", "+91-98123-45621"],
    ["with a leading zero", "098123 45621"],
    ["in two groups of five", "98123 45621"],
    ["in two groups of five with a dash", "98123-45621"],
    ["in groups of three and four", "981 234 5621"],
    ["a US number", "+14155552671"],
    ["a number with a single space between every digit", "9 8 1 2 3 4 5 6 2 1"],
  ];

  it.each(CLAIMED)("%s: %s, in the customer's message and in the reply", async (_name, shape) => {
    const { body } = await traced({ captureText: true, customerText: `my number is ${shape}, thanks`, replyText: `We will call ${shape} today.` });
    const digits = shape.replace(/\D/g, "");
    const sent = decoded(body);
    expect(sent, `a captured trace of text capture ON still carries the shape ${shape}`).not.toContain(shape);
    expect(sent.includes(digits.slice(-10)), `the ten digits of ${shape}`).toBe(false);
  });

  it("an email address is masked too", async () => {
    const { body } = await traced({ captureText: true, customerText: "write to priya.k@example.test please", replyText: "Noted priya.k@example.test" });
    expect(decoded(body)).not.toContain("priya.k@example.test");
  });

  it("the system prompt (the business's name, its persona, its rules) is never sent, with capture on either", async () => {
    const { body } = await traced({ captureText: true, customerText: "hello", replyText: "hi" });
    expect(decoded(body)).not.toContain(CANARY.system);
    expect(decoded(body)).not.toContain("Skyline Homes");
  });

  it("a number as the exact fixture, in a long message, is masked and the rest of the message is kept (capture is on: that is what it is for)", async () => {
    const { body } = await traced({ captureText: true, customerText: `${CANARY.customer} please call ${PHONE} about the 2BHK`, replyText: "ok" });
    const sent = decoded(body);
    expect(sent).toContain(CANARY.customer);
    for (const form of phoneForms(PHONE)) expect(sent, form).not.toContain(form);
  });
});

describe("KNOWN LIMITS of text capture ON (mask.ts masks phone numbers and emails by pattern and nothing else; unchanged here: recommendation in the task note)", () => {
  // Shapes the pattern does not claim. Each is recorded as it is today: the digits reach the tracing service. If mask.ts is improved one of these fails: flip it.
  const NOT_CLAIMED: [string, string, string][] = [
    ["round brackets around a group", "+91 (98123) 45621", "98123"],
    ["a dot between the groups", "98123.45621", "98123.45621"],
    ["two spaces between the groups", "98123  45621", "98123  45621"],
    ["a space and a dash between the groups", "98123 - 45621", "98123 - 45621"],
    ["Tamil digits", "௯௮௧௨௩௪௫௬௨௧", "௯௮௧௨௩௪௫௬௨௧"],
    ["Devanagari digits", "९८१२३४५६२१", "९८१२३४५६२१"],
    ["full-width digits", "９８１２３４５６２１", "９８１２３４５６２１"],
    ["spelled out", "nine eight one two three four five six two one", "nine eight one two three four five six two one"],
  ];

  it.each(NOT_CLAIMED)("%s: %s reaches the tracing service", async (_name, shape, visible) => {
    const { body } = await traced({ captureText: true, customerText: `my number is ${shape}, thanks`, replyText: "ok" });
    expect(decoded(body)).toContain(visible); // THE LIMIT. Flip: expect(...).not.toContain(visible)
  });

  it("a customer's name, a budget, an address and anything else that is not a phone number or an email reaches the tracing service as typed", async () => {
    const { body } = await traced({ captureText: true, customerText: `I am ${CANARY.name}, budget 80 lakh, flat 4B, Velachery main road`, replyText: "ok" });
    const sent = decoded(body);
    for (const kept of [CANARY.name, "80 lakh", "Velachery main road"]) expect(sent, kept).toContain(kept);
  });
});
