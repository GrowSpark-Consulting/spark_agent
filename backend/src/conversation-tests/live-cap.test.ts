import { describe, expect, it } from "vitest";
import { LlmError, RETRY_DELAYS_MS } from "../agent/llm/anthropic";
import type { LlmClient, LlmRequest, LlmResult } from "../agent/llm";
import { capCalls, LIVE_DEFAULT_MAX_CALLS, LIVE_MAX_CALLS_LIMIT, parseLiveArgs } from "./live-cap";

const request = { role: "reply" } as LlmRequest;
const result = (attempts = 1, costUsd: number | null = 0.01): LlmResult => ({ text: "ok", model: "m", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd, latencyMs: 1, attempts, requestId: null }) as unknown as LlmResult;

describe("the --live arguments", () => {
  it("default to 40 calls, all chats, mock mode", () => {
    expect(parseLiveArgs([])).toEqual({ live: false, only: [], maxCalls: 40 });
    expect(LIVE_DEFAULT_MAX_CALLS).toBe(40);
    expect(LIVE_MAX_CALLS_LIMIT).toBe(60);
  });
  it("read --live, --only (several, comma separated) and --max-calls, in both spellings", () => {
    expect(parseLiveArgs(["--", "--live", "--only", "Inj-A, inj-b", "--max-calls", "25"])).toEqual({ live: true, only: ["inj-a", "inj-b"], maxCalls: 25 });
    expect(parseLiveArgs(["--only=x", "--max-calls=60"])).toMatchObject({ only: ["x"], maxCalls: 60 });
  });
  it.each([["--max-calls", "0"], ["--max-calls", "61"], ["--max-calls", "2.5"], ["--max-calls", "abc"], ["--max-calls", "-1"]])("refuses %s %s", (flag, v) => {
    expect(() => parseLiveArgs([flag, v])).toThrow(/whole number from 1 to 60/);
  });
  it("refuses a missing value and an unknown argument", () => {
    expect(() => parseLiveArgs(["--max-calls"])).toThrow();
    expect(() => parseLiveArgs(["--only"])).toThrow();
    expect(() => parseLiveArgs(["--only", ","])).toThrow(/--only needs/);
    expect(() => parseLiveArgs(["--only", "--live"])).toThrow(/not a flag/);
    expect(() => parseLiveArgs(["--turbo"])).toThrow(/Unknown argument/);
  });
});

describe("the call cap", () => {
  it("counts every try of every call and never lets the requests pass the cap", async () => {
    let made = 0;
    const llm: LlmClient = { complete: async () => { made += 1; return result(1); } };
    const { client, usage } = capCalls(llm, 10);
    // a call is refused unless its worst case (every try) still fits: it goes through while used + tries <= 10
    const tries = RETRY_DELAYS_MS.length + 1;
    const allowed = 10 - tries + 1;
    let refused = 0;
    for (let i = 0; i < 12; i++) await client.complete(request).catch(() => refused++);
    expect(made).toBe(allowed);
    expect(usage.used).toBe(allowed);
    expect(usage.used).toBeLessThanOrEqual(10);
    expect(refused).toBe(12 - allowed);
    expect(usage.capped).toBe(true);
  });
  it("counts the tries a retried call took, and a failed call too", async () => {
    let n = 0;
    const llm: LlmClient = { complete: async () => { n++; if (n === 2) throw new LlmError("timeout", undefined, 3); return result(2); } };
    const { client, usage } = capCalls(llm, 40);
    await client.complete(request);
    await client.complete(request).catch(() => undefined);
    expect(usage.used).toBe(5);
    expect(usage.capped).toBe(false);
  });
  it("counts an error that is not the client's own as every try it could have made", async () => {
    const { client, usage } = capCalls({ complete: async () => { throw new Error("socket"); } }, 40);
    await client.complete(request).catch(() => undefined);
    expect(usage.used).toBe(RETRY_DELAYS_MS.length + 1);
  });
  it("adds up the cost, and says unknown when a model has no price", async () => {
    const { client, usage } = capCalls({ complete: async () => result(1, 0.25) }, 40);
    await client.complete(request);
    await client.complete(request);
    expect(usage.costUsd).toBeCloseTo(0.5);
    const unknown = capCalls({ complete: async () => result(1, null) }, 40);
    await unknown.client.complete(request);
    expect(unknown.usage.costUsd).toBeNull();
  });
});
