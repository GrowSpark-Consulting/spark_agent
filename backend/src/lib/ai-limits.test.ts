import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmError, type LlmClient, type LlmRequest, type LlmResult } from "../agent/llm/anthropic";
import { fakeDb } from "../test-support/fake-db";
import {
  aiLimitFor,
  cachedOverCap,
  CONTACT_AI_REPLIES_PER_HOUR,
  isAiLimit,
  limitNotice,
  limitNoticeKey,
  TENANT_AI_REPLIES_PER_HOUR,
  tellOwnersAboutLimit,
  withSpendGuard,
  type SpendGuard,
} from "./ai-limits";

const TENANT = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const CONV = "3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f601";

afterEach(() => vi.restoreAllMocks());

describe("which limit a chat has reached", () => {
  const limits = (over: Partial<{ spend_today_usd: number | string; cap_usd: number | string; contact_replies_hour: number; tenant_replies_hour: number }> = {}) =>
    fakeDb({ "rpc:ai_limits": { data: [{ spend_today_usd: 0.4, cap_usd: 3, contact_replies_hour: 2, tenant_replies_hour: 40, ...over }], error: null } });

  it("none, under every limit; it asks for this business and chat", async () => {
    const db = limits();
    expect(await aiLimitFor(TENANT, CONV, db.client)).toBeNull();
    expect(db.calls[0].args[0]).toEqual({ p_tenant_id: TENANT, p_conversation_id: CONV });
  });

  it("each limit at its threshold, the business's spend first, then its pace, then the chat's", async () => {
    expect(await aiLimitFor(TENANT, CONV, limits({ spend_today_usd: "3.000000", cap_usd: "3.00" }).client)).toBe("ai_spend_cap");
    expect(await aiLimitFor(TENANT, CONV, limits({ tenant_replies_hour: TENANT_AI_REPLIES_PER_HOUR }).client)).toBe("tenant_rate_limit");
    expect(await aiLimitFor(TENANT, CONV, limits({ contact_replies_hour: CONTACT_AI_REPLIES_PER_HOUR }).client)).toBe("contact_rate_limit");
    expect(await aiLimitFor(TENANT, CONV, limits({ contact_replies_hour: CONTACT_AI_REPLIES_PER_HOUR - 1 }).client)).toBeNull();
    const all = limits({ spend_today_usd: 9, tenant_replies_hour: 999, contact_replies_hour: 99 });
    expect(await aiLimitFor(TENANT, CONV, all.client)).toBe("ai_spend_cap");
  });

  it("none for a business it can't find, and an error when the read fails (the gate step retries)", async () => {
    expect(await aiLimitFor(TENANT, CONV, fakeDb({ "rpc:ai_limits": { data: [], error: null } }).client)).toBeNull();
    await expect(aiLimitFor(TENANT, CONV, fakeDb({ "rpc:ai_limits": { data: null, error: { message: "timeout" } } }).client)).rejects.toThrow("ai_limits failed: timeout");
  });

  it("knows its own reasons", () => {
    expect(["ai_spend_cap", "tenant_rate_limit", "contact_rate_limit"].every(isAiLimit)).toBe(true);
    expect(isAiLimit("feature_off")).toBe(false);
  });
});

describe("the model client's spend guard", () => {
  const result: LlmResult = {
    text: "ok",
    model: "claude-sonnet-5-5",
    stopReason: "end_turn",
    usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: 0.0125,
    latencyMs: 900,
    attempts: 1,
    requestId: "req_1",
  };
  const request: LlmRequest = { role: "reply", prompt: { name: "reply", version: 1 }, tenantId: TENANT, system: [{ text: "rules" }], messages: [{ role: "user", content: "hi" }] };
  const model = () => {
    const complete = vi.fn<LlmClient["complete"]>(async () => result);
    return { client: { complete } satisfies LlmClient, complete };
  };
  const guard = (over: boolean): SpendGuard & { recorded: [string, number | null][] } => {
    const recorded: [string, number | null][] = [];
    return { recorded, overCap: async () => over, record: async (tenantId, cost) => void recorded.push([tenantId, cost]) };
  };

  it("lets a call through under the cap and records what it cost", async () => {
    const { client } = model();
    const g = guard(false);
    expect(await withSpendGuard(client, g).complete(request)).toBe(result);
    await Promise.resolve();
    expect(g.recorded).toEqual([[TENANT, 0.0125]]);
  });

  it("refuses a call past the cap without calling the model, as over_budget (not retryable)", async () => {
    const { client, complete } = model();
    const g = guard(true);
    const error = await withSpendGuard(client, g).complete(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ code: "over_budget", retryable: false, message: "The business reached its daily AI limit." });
    expect(complete).not.toHaveBeenCalled();
    expect(g.recorded).toEqual([]);
  });

  it("reads the cap at most once a minute per business, and counts a failed read as not over", async () => {
    let t = 0;
    const read = vi.fn(async (tenantId: string) => tenantId === TENANT);
    const overCap = cachedOverCap(read, 60_000, () => t);
    expect(await overCap(TENANT)).toBe(true);
    t = 59_000;
    expect(await overCap(TENANT)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    t = 61_000;
    await overCap(TENANT);
    expect(read).toHaveBeenCalledTimes(2);

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = cachedOverCap(async () => {
      throw new Error("db down");
    });
    expect(await broken(TENANT)).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("the spend cap could not be read"));
  });
});

describe("telling the owners", () => {
  const AT = new Date("2026-10-14T20:15:00Z"); // 01:45 on 15 Oct in India

  it("says what stopped and what happens next, with a link to the inbox (the chat, for one customer)", () => {
    const cap = limitNotice("ai_spend_cap", "https://app.spark.test/", null);
    expect(cap.templateParams).toEqual(["Spark Agent has paused AI replies for today: your business reached its daily AI limit.", "https://app.spark.test/dashboard/inbox"]);
    expect(cap.text).toContain("AI replies start again tomorrow");
    expect(limitNotice("tenant_rate_limit", "https://app.spark.test", null).templateParams[0]).toContain(`more than ${TENANT_AI_REPLIES_PER_HOUR}`);
    const chat = limitNotice("contact_rate_limit", "https://app.spark.test", CONV);
    expect(chat.templateParams[1]).toBe(`https://app.spark.test/dashboard/inbox?chat=${CONV}`);
    expect(chat.text).toContain("again within the hour");
  });

  it("once a day (India's) for the cap, once an hour for the business's pace or one chat", () => {
    expect(limitNoticeKey("ai_spend_cap", TENANT, CONV, AT)).toBe(`ai_limit:spend:${TENANT}:2026-10-15`);
    expect(limitNoticeKey("tenant_rate_limit", TENANT, CONV, AT)).toBe(`ai_limit:pace:${TENANT}:2026-10-14T20`);
    expect(limitNoticeKey("contact_rate_limit", TENANT, CONV, AT)).toBe(`ai_limit:chat:${TENANT}:${CONV}:2026-10-14T20`);
  });

  it("sends the notice under its key", async () => {
    const notify = vi.fn(async () => ({ recipients: 2, sent: 2, skipped: 0, failed: 0 }));
    expect(await tellOwnersAboutLimit(TENANT, "ai_spend_cap", CONV, { appUrl: "https://app.spark.test", now: () => AT, notify })).toMatchObject({ sent: 2 });
    expect(notify).toHaveBeenCalledWith(TENANT, expect.objectContaining({ templateParams: expect.any(Array) }), `ai_limit:spend:${TENANT}:2026-10-15`);
  });
});
