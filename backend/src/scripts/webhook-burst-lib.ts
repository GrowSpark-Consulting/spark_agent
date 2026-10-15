import { createHmac } from "node:crypto";

// Load test for POST /api/webhooks/whatsapp (Day 8): a burst of signed webhooks for a phone number id no business owns, so
// the server does the real work (reads the body, checks the signature, looks the number up) and answers 200, and nothing is
// stored, sent or charged. The 10-second reply target depends on this route answering quickly, because Meta retries a slow
// or failing one. The app secret comes from the environment only and is never printed.

export interface BurstOptions {
  url: string;
  secret: string;
  total: number;
  concurrency: number;
  /** Phone number id in the body: digits no real number has. */
  phoneNumberId?: string;
}

export interface BurstResult {
  total: number;
  statuses: Record<string, number>;
  p50: number;
  p95: number;
  max: number;
  seconds: number;
}

export const UNKNOWN_NUMBER_ID = "100000000000000";

export function burstBody(phoneNumberId: string, n: number): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "0",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "0", phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: "Load test" }, wa_id: "910000000000" }],
              messages: [{ from: "910000000000", id: `wamid.burst-${n}`, timestamp: "1760000000", type: "text", text: { body: "load test" } }],
            },
          },
        ],
      },
    ],
  });
}

export const sign = (secret: string, body: string): string => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

export function percentile(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  return sortedMs[Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1)];
}

export async function runBurst(options: BurstOptions, post: typeof fetch = fetch): Promise<BurstResult> {
  const { url, secret, total, concurrency, phoneNumberId = UNKNOWN_NUMBER_ID } = options;
  const times: number[] = [];
  const statuses: Record<string, number> = {};
  let next = 0;
  const started = performance.now();
  const worker = async () => {
    for (;;) {
      const n = next++;
      if (n >= total) return;
      const body = burstBody(phoneNumberId, n);
      const t0 = performance.now();
      let key: string;
      try {
        const res = await post(url, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sign(secret, body) }, body, signal: AbortSignal.timeout(15_000) });
        await res.arrayBuffer();
        key = String(res.status);
      } catch (e) {
        key = e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network_error";
      }
      times.push(performance.now() - t0);
      statuses[key] = (statuses[key] ?? 0) + 1;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, worker));
  times.sort((a, b) => a - b);
  return { total, statuses, p50: Math.round(percentile(times, 50)), p95: Math.round(percentile(times, 95)), max: Math.round(times.at(-1) ?? 0), seconds: Math.round(((performance.now() - started) / 1000) * 10) / 10 };
}

/** Passes when every request answered 200 and the slowest 5% were under the limit. */
export const passes = (r: BurstResult, p95LimitMs = 2000): boolean => (r.statuses["200"] ?? 0) === r.total && r.p95 <= p95LimitMs;
