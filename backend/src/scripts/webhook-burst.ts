import { passes, runBurst } from "./webhook-burst-lib";

// pnpm --filter @pakka/backend webhook:burst -- <API origin> [total=200] [concurrency=20]
// META_APP_SECRET must be in the environment (backend/.env.local, or `railway run`). Sends signed webhooks for a phone number
// no business owns: nothing is stored or sent. Prints status counts and p50/p95/max in ms; exits 1 unless all were 200 and
// p95 <= 2000 ms. Run it against staging.

async function main(): Promise<void> {
  const [origin, totalArg, concurrencyArg] = process.argv.slice(2).filter((a) => a !== "--");
  const secret = process.env.META_APP_SECRET;
  if (!origin || !/^https?:\/\/[^/\s]+$/.test(origin)) throw new Error("Usage: webhook:burst <API origin, e.g. https://api.example.com> [total] [concurrency]");
  if (!secret) throw new Error("META_APP_SECRET is not set.");
  const total = Number(totalArg ?? 200);
  const concurrency = Number(concurrencyArg ?? 20);
  if (!Number.isInteger(total) || total < 1 || total > 5000 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 200) throw new Error("total is 1 to 5000, concurrency 1 to 200.");
  const result = await runBurst({ url: `${origin}/api/webhooks/whatsapp`, secret, total, concurrency });
  console.log(JSON.stringify(result));
  console.log(passes(result) ? "PASS: every request answered 200, p95 within 2 s" : "FAIL: see the status counts and p95 above");
  process.exitCode = passes(result) ? 0 : 1;
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : "webhook burst failed");
  process.exitCode = 1;
});
