import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { LlmClient, LlmRequest, LlmResult } from "../agent/llm";
import { LlmError } from "../agent/llm/anthropic";
import { TURN_HARD_STOP_MS, TURN_TARGET_MS } from "../agent/pipeline/turn-deadline";
import { loadChats } from "./load";
import { configRows, LIVE_DEFAULT_MAX_CALLS, LIVE_MAX_CALLS_LIMIT, LIVE_TURNS, measureLive, measureMocked, parseLatencyArgs, postcheckTiming } from "./latency";
import { formatReport } from "./latency-report";

// The latency harness (pnpm latency:chats): the arguments, the mocked and live runs, the 15-request cap, and the limits it reports. It runs on the
// scripted chats in tests/conversations; the models are mocked here, and the live runner is given a fake client.

const chats = loadChats();
const some = chats.filter((c) => ["real-estate/01-", "real-estate/06-", "real-estate/51-"].some((p) => c.file.startsWith(p)));

describe("the arguments", () => {
  it("default to a mocked run, and to 15 requests when it is live", () => {
    expect(parseLatencyArgs([])).toEqual({ live: false, maxCalls: LIVE_DEFAULT_MAX_CALLS, rounds: 5 });
    expect(LIVE_DEFAULT_MAX_CALLS).toBe(15);
    expect(parseLatencyArgs(["--live"]).live).toBe(true);
  });

  it("take --max-calls up to a hard limit, and --rounds", () => {
    expect(parseLatencyArgs(["--live", "--max-calls", "10"]).maxCalls).toBe(10);
    expect(parseLatencyArgs(["--max-calls=20"]).maxCalls).toBe(20);
    expect(parseLatencyArgs(["--rounds", "3"]).rounds).toBe(3);
    expect(LIVE_MAX_CALLS_LIMIT).toBe(20);
  });

  it("refuse what they do not understand, or a cap above the limit", () => {
    for (const bad of [["--max-calls", "21"], ["--max-calls", "0"], ["--max-calls", "x"], ["--max-calls"], ["--rounds", "0"], ["--rounds", "101"], ["--nope"], ["file"]]) {
      expect(() => parseLatencyArgs(bad)).toThrow();
    }
  });
});

describe("a mocked run", () => {
  it("times every step and call of the turns it runs, with no model or database", async () => {
    const run = await measureMocked(some, 2);
    expect(run.turns).toBeGreaterThan(0);
    expect(run.rounds).toBe(2);
    expect(run.chats).toBe(some.length);
    const stages = [...run.recorder.samples.keys()];
    for (const wanted of ["step:extract", "step:reply", "llm:extraction", "llm:reply", "send", "step:stop-check"]) expect(stages).toContain(wanted);
    expect(run.recorder.turns).toHaveLength(run.turns);
  });

  it("measures each turn once per round", async () => {
    const one = await measureMocked(some, 1);
    const three = await measureMocked(some, 3);
    expect(three.recorder.turns.length).toBe(one.recorder.turns.length * 3);
  });

  it("counts the steps of a turn and the regenerations of a reply, and times the post-check on the replies it produced", async () => {
    const run = await measureMocked(some, 1);
    expect(run.stepsPerTurn).toBeGreaterThan(1);
    expect(run.postcheck?.n).toBeGreaterThan(0);
    expect(run.postcheck?.p50Us).toBeGreaterThanOrEqual(0);
  });

  it("counts the replies that were written again after the post-check refused the first (a scripted chat has one)", async () => {
    expect((await measureMocked(chats, 1)).regenerations).toBeGreaterThan(0);
  });

  it("is labelled mocked in every table, and holds no message text", async () => {
    const run = await measureMocked(some, 1);
    const report = formatReport({ ...run, mode: "mocked", calls: null, capped: false, config: configRows() }).join("\n");
    expect(report).toMatch(/^MOCKED/);
    expect(report).not.toMatch(/LIVE/);
    expect((report.match(/\[MOCKED\]/g) ?? []).length).toBeGreaterThanOrEqual(3);
    const words = chats.flatMap((c) => c.chat.turns.map((t) => t.customer)).filter((w) => w.length > 8);
    expect(words.length).toBeGreaterThan(10);
    for (const w of words) expect(report).not.toContain(w);
  });

  it("changes nothing about a chat: a run with the probe and a run without it give the same transcript and the same failures, chat by chat", async () => {
    const { runChat } = await import("./run-chat");
    const { Recorder } = await import("./latency-report");
    for (const { chat } of chats) {
      const plain = await runChat(chat, { mode: "mock" });
      const probed = await runChat(chat, { mode: "mock", probe: new Recorder() });
      expect(probed).toEqual(plain);
      expect(plain.failures).toEqual([]);
    }
  });

  it("a probe that throws changes nothing either", async () => {
    const { runChat } = await import("./run-chat");
    const broken = {
      record: () => {
        throw new Error("probe broke");
      },
      turn: () => {
        throw new Error("probe broke");
      },
    };
    for (const { chat } of some) expect(await runChat(chat, { mode: "mock", probe: broken })).toEqual(await runChat(chat, { mode: "mock" }));
  });
});

describe("a live run", () => {
  const reply = (text: string): LlmResult => ({ text, model: "m", requestId: "r", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.001, latencyMs: 1, attempts: 1 });
  const QUIET = JSON.stringify({ language: "en", intent: "question", fields: {}, question: "price?", preferredTime: null, sentiment: "neutral", asksIfHuman: false, confidence: 0.9 });
  const fakeClient = () => {
    const complete = vi.fn<(request: LlmRequest) => Promise<LlmResult>>(async (request) => reply(request.role === "extraction" ? QUIET : "Happy to help."));
    return { complete, client: { complete } as LlmClient };
  };

  it("picks single turns of scripted chats, enough to fit the cap", () => {
    expect(LIVE_TURNS.length).toBeGreaterThanOrEqual(5);
    expect(LIVE_TURNS.length * 2).toBeLessThanOrEqual(LIVE_DEFAULT_MAX_CALLS + 4);
    const known = new Set(chats.map((c) => c.file));
    for (const file of LIVE_TURNS) expect(known.has(file)).toBe(true);
  });

  it("never makes more requests than the cap, counts them by role, and stops running chats once it is reached", async () => {
    const f = fakeClient();
    const run = await measureLive(chats, f.client, 4);
    expect(f.complete.mock.calls.length).toBeLessThanOrEqual(4);
    expect(run.calls.used).toBeLessThanOrEqual(4);
    expect(run.calls.max).toBe(4);
    expect(run.capped).toBe(true);
    expect(Object.values(run.calls.byRole).reduce((a, b) => a + b, 0)).toBe(run.calls.used);
  });

  it("counts a request the client retried as every request it made, and never goes past the cap", async () => {
    const complete = vi.fn<(request: LlmRequest) => Promise<LlmResult>>(async (request) => ({ ...reply(request.role === "extraction" ? QUIET : "ok"), attempts: 2 }));
    const run = await measureLive(chats, { complete } as LlmClient, 6);
    expect(run.calls.used).toBe(2 * complete.mock.calls.length);
    expect(run.calls.used).toBeLessThanOrEqual(6);
  });

  it("never goes past the cap, even when every call needs its three tries: a call is only made if its worst case still fits", async () => {
    for (const max of [4, 7, 15, 20]) {
      const complete = vi.fn<(request: LlmRequest) => Promise<LlmResult>>(async (request) => ({ ...reply(request.role === "extraction" ? QUIET : "ok"), attempts: 3 }));
      const run = await measureLive(chats, { complete } as LlmClient, max);
      expect(run.calls.used).toBe(3 * complete.mock.calls.length);
      expect(run.calls.used).toBeLessThanOrEqual(max);
    }
  });

  it("counts a call that failed by the tries it took: a failed request is billed too", async () => {
    const complete = vi.fn<(request: LlmRequest) => Promise<LlmResult>>(async () => {
      throw new LlmError("unavailable", 503, 3);
    });
    const run = await measureLive(chats, { complete } as LlmClient, 15);
    expect(complete.mock.calls.length).toBeGreaterThan(0);
    expect(run.calls.used).toBe(3 * complete.mock.calls.length);
    expect(run.calls.used).toBeLessThanOrEqual(15);
    expect(run.capped).toBe(true);
  });

  it("a call refused by the cap is not recorded as a timed call, and the turn it stopped is left out of the whole-turn numbers", async () => {
    const f = fakeClient();
    const run = await measureLive(chats, f.client, 4);
    expect(run.capped).toBe(true);
    const timed = (run.recorder.samples.get("llm:extraction")?.length ?? 0) + (run.recorder.samples.get("llm:reply")?.length ?? 0);
    expect(timed).toBe(f.complete.mock.calls.length);
    expect(run.recorder.turns).toHaveLength(run.chats);
  });

  it("is labelled live and reports the requests against the cap", async () => {
    const f = fakeClient();
    const run = await measureLive(chats, f.client, 15);
    const report = formatReport({ ...run, mode: "live", config: configRows() }).join("\n");
    expect(report).toMatch(/^LIVE/);
    expect(report).toMatch(/requests\s+\d+ of 15/);
  });

  it("a model error in a turn is a note, not a crash, and the run goes on; the request is counted", async () => {
    const complete = vi.fn<(request: LlmRequest) => Promise<LlmResult>>(async () => {
      throw new Error("model down");
    });
    const run = await measureLive(chats, { complete } as LlmClient, 15);
    expect(run.turns).toBeGreaterThan(0);
    expect(run.calls.used).toBe(complete.mock.calls.length);
  });
});

describe("the post-check on its own", () => {
  it("is timed over the replies and facts it is given", () => {
    const t = postcheckTiming([{ text: "Site visits are free.", facts: ["Site visits are free."] }], 20);
    expect(t?.n).toBe(20);
    expect(t?.p50Us).toBeGreaterThanOrEqual(0);
  });

  it("has nothing to time without a reply", () => {
    expect(postcheckTiming([], 20)).toBeNull();
  });
});

describe("the configured limits", () => {
  const rows = () => Object.fromEntries(configRows().map((r) => [r.what, r.value]));

  it("are read from the code: the turn's target and hard stop, the model timeouts and tries, the debounce, the read receipt", () => {
    const r = rows();
    expect(r["Turn target / hard stop"]).toBe(`${TURN_TARGET_MS / 1000} s / ${TURN_HARD_STOP_MS / 1000} s`);
    expect(r["Debounce: quiet period / longest wait"]).toBe("3 s / 15 s");
    expect(r["Extraction model: a try / all tries"]).toMatch(/8 s \/ 20 s, 3 tries/);
    expect(r["Reply model: a try / all tries"]).toMatch(/15 s \/ 25 s, 3 tries/);
    expect(r["Read receipt"]).toMatch(/3 s/);
    expect(r["Step retries / conversations at once"]).toBe("3 / 1");
  });

  it("add up the longest a customer can wait without a step retry (a retry adds more): the longest debounce, the hard stop and one send", () => {
    expect(rows()["Longest wait without a step retry"]).toBe("50 s (15 s + 25 s + 10 s)");
  });

  it("the 10-second send timeout it quotes is the adapter's own", () => {
    const adapter = readFileSync(new URL("../channels/whatsapp/adapter.ts", import.meta.url), "utf8");
    expect(adapter).toMatch(/DEFAULT_TIMEOUT_MS = 10_000/);
    expect(rows()["WhatsApp send timeout"]).toMatch(/^10 s/);
  });
});
