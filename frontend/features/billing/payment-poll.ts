import type { PaymentView } from "@pakka/types";
import { ApiError, formatError, type FormattedError } from "@/lib/errors";
import { BillingDataError } from "./billing-data";

// What happens when PayU sends the payer back to /dashboard/billing?payment=<id>. The redirect proves nothing: the address can be typed by
// anyone and PayU's own post is never trusted. The only evidence is GET /api/billing/payments/:id, whose status is final at success or
// failed; created and pending mean "keep asking". The server asks PayU again at most every 5 seconds (docs/contracts.md), so this asks
// at that pace for about a minute, then stops and says it is still processing; it never calls a payment paid or failed on a guess.

export const POLL_INTERVAL_MS = 5_000;
export const POLL_WINDOW_MS = 60_000;
/** Consecutive failed reads (offline, a 5xx) before giving up with an error instead of "still processing". */
export const MAX_READ_FAILURES = 3;

export type PaymentOutcome =
  /** PayU confirmed it, through the API. */
  | { kind: "success"; payment: PaymentView }
  /** PayU confirmed it did not go through. */
  | { kind: "failed"; payment: PaymentView }
  /** The window ended with the payment still created or pending: the API has no final answer yet. */
  | { kind: "processing" }
  /** The API has no such payment for this business (a wrong, foreign or "unknown" id). */
  | { kind: "invalid" }
  /** The API could not be read, or answered something that is not a payment. */
  | { kind: "error"; error: FormattedError };

export interface PollDeps {
  fetchPayment: (signal: AbortSignal) => Promise<PaymentView>;
  signal: AbortSignal;
  now?: () => number;
  /** Resolves after `ms`, or rejects when the signal aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export function sleepMs(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Polls until the API says success or failed, the window ends, or the read fails for good. Resolves null if aborted. */
export async function pollPayment({ fetchPayment, signal, now = Date.now, sleep = sleepMs }: PollDeps): Promise<PaymentOutcome | null> {
  const deadline = now() + POLL_WINDOW_MS;
  let failures = 0;
  for (;;) {
    if (signal.aborted) return null;
    try {
      const payment = await fetchPayment(signal);
      // The screen moved on while this was in flight (another payment, leaving the page): its answer is not for anyone now.
      if (signal.aborted) return null;
      failures = 0;
      if (payment.status === "success") return { kind: "success", payment };
      if (payment.status === "failed") return { kind: "failed", payment };
    } catch (err) {
      if (signal.aborted) return null;
      if (err instanceof ApiError && (err.status === 404 || err.body.error.code === "not_found")) return { kind: "invalid" };
      // A refusal (signed out, no access) or an unreadable answer will not change by asking again.
      const permanent = err instanceof BillingDataError || (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429);
      failures += 1;
      if (permanent || failures >= MAX_READ_FAILURES) return { kind: "error", error: formatError(err) };
    }
    if (now() + POLL_INTERVAL_MS > deadline) return { kind: "processing" };
    try {
      await sleep(POLL_INTERVAL_MS, signal);
    } catch {
      return null;
    }
  }
}
