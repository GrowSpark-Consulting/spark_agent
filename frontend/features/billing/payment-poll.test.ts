import type { PaymentView } from "@pakka/types";
import { describe, expect, it, vi } from "vitest";
import { apiErrorFromBody } from "@/lib/errors";
import { BillingDataError } from "./billing-data";
import { MAX_READ_FAILURES, POLL_INTERVAL_MS, POLL_WINDOW_MS, pollPayment, sleepMs, type PaymentOutcome } from "./payment-poll";

const view = (status: PaymentView["status"], over: Partial<PaymentView> = {}): PaymentView => ({
  id: "20000000-0000-4000-8000-000000000002",
  kind: "subscribe",
  status,
  amountInr: 2948.82,
  failureReason: null,
  createdAt: "2026-10-13T10:00:00.000Z",
  ...over,
});
const apiError = (status: number, code: string) => apiErrorFromBody(status, { error: { code, message: "no" } });

/** Runs the poll on a fake clock: each sleep moves the clock, so a minute of polling takes no time. */
function run(reads: (() => Promise<PaymentView>)[]) {
  let t = 0;
  const sleeps: number[] = [];
  const fetchPayment = vi.fn(async () => {
    const next = reads.shift();
    if (!next) throw new Error("the poll asked more times than the test expected");
    return next();
  });
  const controller = new AbortController();
  const outcome = pollPayment({
    fetchPayment,
    signal: controller.signal,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  });
  return { outcome, fetchPayment, sleeps };
}
const ok = (v: PaymentView) => () => Promise.resolve(v);
const fail = (e: unknown) => () => Promise.reject(e);

describe("pollPayment", () => {
  it("stops at success, and asks no more", async () => {
    const { outcome, fetchPayment } = run([ok(view("created")), ok(view("pending")), ok(view("success"))]);
    expect(await outcome).toEqual<PaymentOutcome>({ kind: "success", payment: view("success") });
    expect(fetchPayment).toHaveBeenCalledTimes(3);
  });

  it("stops at failed with PayU's reason", async () => {
    const failed = view("failed", { failureReason: "Insufficient funds" });
    const { outcome } = run([ok(view("pending")), ok(failed)]);
    expect(await outcome).toEqual<PaymentOutcome>({ kind: "failed", payment: failed });
  });

  it("is final on the first read when the payment is already settled (a repeated visit)", async () => {
    const { outcome, sleeps } = run([ok(view("success"))]);
    expect((await outcome)?.kind).toBe("success");
    expect(sleeps).toEqual([]);
  });

  it("asks every 5 seconds for about a minute, then says still processing, never success", async () => {
    const reads = Array.from({ length: 30 }, () => ok(view("pending")));
    const { outcome, fetchPayment, sleeps } = run(reads);
    expect(await outcome).toEqual<PaymentOutcome>({ kind: "processing" });
    expect(new Set(sleeps)).toEqual(new Set([POLL_INTERVAL_MS]));
    expect(fetchPayment.mock.calls.length).toBe(POLL_WINDOW_MS / POLL_INTERVAL_MS + 1);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(POLL_WINDOW_MS);
  });

  it("treats an unknown payment (404 / not_found) as invalid at once", async () => {
    const { outcome, fetchPayment } = run([fail(apiError(404, "not_found"))]);
    expect(await outcome).toEqual<PaymentOutcome>({ kind: "invalid" });
    expect(fetchPayment).toHaveBeenCalledTimes(1);
  });

  it("rides out a network blip and then reports what the API says", async () => {
    const { outcome } = run([fail(new TypeError("fetch failed")), fail(apiError(503, "upstream_failed")), ok(view("success"))]);
    expect((await outcome)?.kind).toBe("success");
  });

  it("gives up with an error after repeated read failures instead of pretending to wait", async () => {
    const { outcome, fetchPayment } = run(Array.from({ length: MAX_READ_FAILURES }, () => fail(new TypeError("fetch failed"))));
    const result = await outcome;
    expect(result?.kind).toBe("error");
    expect(result && result.kind === "error" && result.error.code).toBe("network");
    expect(fetchPayment).toHaveBeenCalledTimes(MAX_READ_FAILURES);
  });

  it("counts only consecutive failures", async () => {
    const reads = [fail(new TypeError("fetch failed")), fail(new TypeError("fetch failed")), ok(view("pending")), fail(new TypeError("fetch failed")), fail(new TypeError("fetch failed")), ok(view("success"))];
    expect((await run(reads).outcome)?.kind).toBe("success");
  });

  it("stops at once on a refusal or an answer that is not a payment (asking again won't change it)", async () => {
    for (const err of [apiError(403, "forbidden"), apiError(401, "unauthenticated"), new BillingDataError("payment")]) {
      const { outcome, fetchPayment } = run([fail(err)]);
      expect((await outcome)?.kind).toBe("error");
      expect(fetchPayment).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps polling through a rate limit", async () => {
    const { outcome } = run([fail(apiError(429, "rate_limited")), ok(view("success"))]);
    expect((await outcome)?.kind).toBe("success");
  });

  it("returns null when it is aborted before it starts, and reads nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchPayment = vi.fn(ok(view("success")));
    expect(await pollPayment({ fetchPayment, signal: controller.signal })).toBeNull();
    expect(fetchPayment).not.toHaveBeenCalled();
  });

  it("returns null, not the answer, when it is aborted while a read is in flight", async () => {
    const controller = new AbortController();
    const outcome = pollPayment({
      fetchPayment: async () => {
        controller.abort();
        return view("success");
      },
      signal: controller.signal,
    });
    expect(await outcome).toBeNull();
  });

  it("returns null when it is aborted between reads", async () => {
    const controller = new AbortController();
    const outcome = pollPayment({ fetchPayment: ok(view("pending")), signal: controller.signal, sleep: sleepMs });
    await Promise.resolve();
    controller.abort();
    expect(await outcome).toBeNull();
  });
});

describe("sleepMs", () => {
  it("rejects when the signal aborts, and clears its timer", async () => {
    const controller = new AbortController();
    const pending = sleepMs(60_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(sleepMs(1, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("resolves after the wait", async () => {
    vi.useFakeTimers();
    const done = vi.fn();
    void sleepMs(5_000, new AbortController().signal).then(done);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
