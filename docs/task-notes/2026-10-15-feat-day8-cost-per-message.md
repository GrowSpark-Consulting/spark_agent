# 15 Oct (Dev 1): cost of one processed message (Day 8)

For Dev 2 and Dev 3. Dev 1 files only: `backend/src/scripts/cost-per-message*.ts` (new), `backend/src/agent/llm/models.ts` and its tests, `backend/package.json` (one script line), `docs/cost-per-message.md` (new). No prompt file, pack, migration or table of anyone's changed.

## 1. What was built and why

**The question:** how much does one processed message cost us in rupees, and is one credit (one AI reply) under the ₹0.35 target from the Day 8 list? One processed message is one Haiku 4.5 extraction plus one Sonnet 5.5 reply, and sometimes a second reply (a regenerate).

- **`pnpm --filter @pakka/backend cost:per-message`** has two modes.
  - **Offline estimate (works today, calls nothing):** builds the real extraction and reply prompts and the real-estate pack's fields, adds typical customer messages and knowledge-base text, estimates tokens from characters, and prices them with the agent's own price table. It shows no cache, every call a cache hit, every call a cache write, and a regenerate. It also shows the Sonnet reply split into its parts, a cache check per model, and a Haiku 5.5 what-if for extraction.
  - **From traces (for when Langfuse access exists):** `--file <export.json>` or `--traces` (the Langfuse API when the two keys are set). It averages real cost per processed message and per credit for an India day, prints how much input came from the cache, and calibrates characters per token for each model. With no file and no keys it says so and exits normally.
- **`docs/cost-per-message.md`:** the numbers, the ₹0.35 comparison, the assumptions, how to re-run with real data, and what to tune later.
- **A price fix** in `llm/models.ts`: Sonnet 5.5 cache reads were priced at $0.20 per million; Anthropic's pricing page says $0.10 (0.05 times the input price). It affects the cost Langfuse shows for a Sonnet call that read from the cache.

**What it found (estimates, English turn, ₹90 to the dollar):** ₹0.96 per credit with no cache, ₹0.43 with every call a cache hit, ₹1.11 with every call a write, ₹0.81 with hits and a regenerate. **Over ₹0.35 in every case.** With the cache working, half of a Sonnet reply's cost is its output and about a third is the knowledge-base context.

## 2. How to test

- `pnpm --filter @pakka/backend exec vitest run src/scripts src/agent/llm` (the cost maths, the price fix, the offline report, the trace reading with a fake `fetch`).
- `pnpm --filter @pakka/backend cost:per-message` and `... cost:per-message --help`.
- With a made-up export file: `... cost:per-message --file <file> --day 2026-10-15`. With neither a file nor keys: `... cost:per-message --traces` prints that there is nothing to read and exits 0.
- Then `pnpm typecheck`, `pnpm lint`, `pnpm --filter @pakka/backend test`, `pnpm test:conversations`.

## 3. Decisions

- **USD to INR is 90, a stated assumption, not a looked-up rate.** Rounded up on purpose so the estimate does not flatter us. One setting: `--usd-inr`, then `USD_INR_RATE`, then 90.
- **₹0.35 per credit is used as given** (the target in the Day 8 task list). This repo does not say where it comes from.
- **The Sonnet 5.5 cache-read price is $0.10 per million**, from the pricing page (it was $0.20). Two existing tests that held the old figure were changed with it.
- **Tokens are estimated from characters**, with a separate ratio for each model: Claude 4.7 and later (Sonnet 5.5, Haiku 5.5) use a newer tokenizer that makes about 30% more tokens than Haiku 4.5. The reason is that nothing here may call a model, and Anthropic's own token counter is a service call.
- **Report only:** no prompt changed, and Haiku 5.5 is a what-if. The agent's models are unchanged.
- **The Langfuse export format and the API fetch are guesses.** They follow what `tracing.ts` writes and Langfuse's public docs from memory; neither was checked against the real thing.
- **The script never prints a key**, and sends the Langfuse keys only to an https address.

## 4. Notes for Dev 2 (Shaaz)

- In trace mode **credits default to processed messages** (one per extraction call that worked), because Langfuse cannot tell a regenerate from a credit. For the exact figure pass **`--credits <n>`** with the number of `ai_reply` credits spent that day, from the credit ledger. I did not read your tables. If you want, tell me which query gives that count for an India day and I will put it in the doc.
- Nothing of yours was edited. The cost estimate does not touch `spend_credits()` or `notify.send`.

## 5. Notes for Dev 3 (Dhatri)

- None expected. The existing lint warning in `frontend/tests/e2e/onboarding/onboarding.spec.ts` (`signIn` unused) is unchanged.

## 6. Follow-ups

- **Re-run with real Langfuse data** as soon as access exists (`--file` or `--traces`, with `--credits` from the ledger), and feed the calibrated ratios back with `--ratio-extraction` and `--ratio-reply`. Check the export format guess first.
- **Confirm whether extraction caches.** Its fixed prompt is estimated at 4,260 to 4,510 tokens against Haiku 4.5's minimum of 4,096, so it is borderline. In Langfuse, `cache_read_input_tokens` must be above 0 on repeat extraction calls inside 5 minutes. If it is 0, extraction is under the minimum and nothing says so.
- **Check the real reply output size and thinking tokens.** The estimate assumes 100 thinking tokens, a guess, and output is half of a cached reply's cost.
- **Options to get under ₹0.35** (none done; prompt changes would be a v3 file): fewer or shorter knowledge-base chunks in the reply (tune with the 15-query retrieval set and `KB_MIN_SIMILARITY`); a shorter reply with less thinking; Haiku 5.5 for extraction ($0.10 in and $0.50 out per million, about ₹0.58 per credit with no cache and ₹0.36 with hits in the English estimate, after a Tamil and Tanglish quality check); fewer regenerates; keeping the cache warm for quiet businesses (a 1-hour lifetime costs 2x to write).
- The ₹0.35 itself: someone should confirm where it comes from, since every case here is over it.
