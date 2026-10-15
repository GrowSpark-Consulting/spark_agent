# Cost of one processed message

**The question.** How much does one processed message cost us in rupees, and is one credit under **₹0.35**? (₹0.35 per credit is our target, from the Day 8 task list.)

- One **processed message** = one Haiku 4.5 extraction + one Sonnet 5.5 reply, and sometimes a second reply when the post-check refuses the first (a regenerate).
- One **credit** = one AI reply. A regenerate is a second model call, not a second credit, so it makes a credit cost more.

**Everything in this file is an estimate made without calling a model and without Langfuse.** There is no Langfuse access yet. The numbers below come from the real prompts in this repo, with token counts estimated from characters. Section 6 says how to replace them with real ones.

## 1. The answer, as far as an estimate can tell

**Under these assumptions we are over ₹0.35 per credit in every case, even with a perfect cache.** Close, but over.

English price question, 3 knowledge-base chunks of 600 characters, ₹90 to the dollar:

| Case | Extraction | Reply | Regenerate | Total | Per credit |
|---|---|---|---|---|---|
| No cache | $0.0049 | $0.0058 | none | $0.0107 | **₹0.96** |
| Every call a cache hit | $0.0009 | $0.0039 | none | $0.0047 | **₹0.43** |
| Every call a cache write | $0.0060 | $0.0063 | none | $0.0123 | **₹1.11** |
| No cache + a regenerate | $0.0049 | $0.0058 | $0.0062 | $0.0169 | **₹1.52** |
| Cache hits + a regenerate | $0.0009 | $0.0039 | $0.0043 | $0.0090 | **₹0.81** |

The same turn in Tamil script costs about 18% to 40% more (Tamil takes more tokens): ₹1.14 with no cache, ₹0.60 with hits.

Plain reading:

- **The target needs the cache to work and replies to be smaller.** The best case above is ₹0.43; the target is ₹0.35.
- **A quiet chat can cost more with the cache than without it** (every call a "write" is ₹1.11 against ₹0.96). The cache only pays when it is hit within 5 minutes. For this prompt about **21 to 22% of calls must be hits** just to break even (section 3).
- **The reply is now the biggest part.** With everything cached, the Sonnet reply alone is about ₹0.35, and half of that is its output (section 2).

To re-run: `pnpm --filter @pakka/backend cost:per-message` (add `--usd-inr`, `--kb-chunks`, `--kb-chunk-chars`; `--help` lists them).

## 2. What goes into a message, and why it costs this much

From the script's English run (token counts are estimates):

| Part | Tokens | Note |
|---|---|---|
| Extraction, fixed prompt (3 cached blocks) | about 4,500 | the rules, the exit-phrase examples (Tamil and Hindi script count heavily), the pack's fields |
| Extraction, the customer's turn | about 130 | small |
| Extraction, the answer | about 50 | small |
| Reply, fixed prompt (2 cached blocks) | about 1,000 | rules and the persona |
| Reply, the customer's turn | about 900 | **the conversation, the task and the knowledge-base facts: mostly the facts** |
| Reply, the answer | about 200 | about 100 visible plus an assumed 100 thinking tokens |

### The Sonnet reply, by part

The reply is the part to shrink, so here it is split by what the tokens are (the English turn; the script prints the same for the Tamil turn):

| Part | No cache | Share | Cache hit | Share |
|---|---|---|---|---|
| Fixed prompt (rules and persona, about 1,000 tokens) | $0.0020 | 34% | $0.0001 | 3% |
| Knowledge-base context (3 chunks of 600 characters, about 690 tokens) | $0.0014 | 24% | $0.0014 | 35% |
| Conversation history (3 earlier messages and the new one, about 135 tokens) | $0.0003 | 5% | $0.0003 | 7% |
| Task and questions to ask (about 80 tokens) | $0.0002 | 3% | $0.0002 | 4% |
| Output (the answer, about 100 tokens, plus an assumed 100 thinking tokens) | $0.0020 | 34% | $0.0020 | 51% |

How to read it:

- **When the cache works, the fixed prompt almost disappears (3%), and the two parts left to shrink are the output (51%) and the knowledge-base context (35%).** The conversation history and the task are small.
- **Output is the dearest token** ($10 per million against $2 for input), and half of it here is the **assumed** 100 thinking tokens. That figure is a guess: real traces show the true output size, so check it before cutting anything.
- In Tamil script the output grows (Tamil takes more tokens) to 61% of a cached reply, and the history to 10%.
- `pnpm --filter @pakka/backend cost:per-message` prints this table for each scenario.

- The knowledge-base context is the biggest lever on the reply's input: with **1 chunk of 300 characters** a cache-hit credit costs about ₹0.32; with **5 chunks of 1,500 characters** (the most the prompt allows) about ₹0.81.
- The extraction's fixed prompt is large, but it is the same for every message, so it is the part a cache can make nearly free.
- Sonnet 5.5 and Haiku 5.5 use a newer tokenizer that makes about **30% more tokens for the same text** than Haiku 4.5 (Anthropic's pricing page). The script uses a separate ratio for each model.

## 3. The cache, checked against Anthropic's documentation

Source: the prompt-caching and pricing pages, read on 15 Oct 2026.

- **Minimum length that can be cached:** Haiku 4.5 **4,096 tokens**. Sonnet 5.5 **512 tokens**. A prompt shorter than the minimum is processed **without caching and with no error**: the only sign is `cache_read_input_tokens` and `cache_creation_input_tokens` both 0.
- **Lifetime:** 5 minutes by default, refreshed by each hit. Demo traffic and small businesses can easily be quieter than that.
- **Prices:** a write costs 1.25 times the input price; a read costs 0.1 times (Haiku 4.5) or **0.05 times (Sonnet 5.5, $0.10 per million)**.

What that means for our cached blocks (estimated):

| Model | Block | Prefix up to it | Minimum | Verdict |
|---|---|---|---|---|
| Haiku 4.5 (extraction) | 1, the rules | about 1,550 | 4,096 | too short alone: **nothing cached at this breakpoint** |
| | 2, with the examples | about 4,260 | 4,096 | long enough |
| | 3, with the pack's fields | about 4,510 | 4,096 | long enough |
| Sonnet 5.5 (reply) | 1, the rules | about 920 | 512 | long enough |
| | 2, with the persona | about 1,000 | 512 | long enough |

- **The extraction prompt is borderline.** It is estimated at 4,260 to 4,510 tokens against a minimum of 4,096, and the estimate is good to roughly 15%. A shorter pack (fewer fields) or a different tokenizer count could put it under the line, and then **extraction would never cache and nobody would be told**. A pack with many more fields moves it safely over.
- **The only real test is Langfuse:** look at `cache_read_input_tokens` on extraction calls. If it is 0 on repeat calls inside 5 minutes, the prompt is under the minimum.
- Report only: no prompt was changed.

### A price correction made with this work

`llm/models.ts` priced Sonnet 5.5 cache reads at **$0.20** per million. Anthropic's pricing page says **$0.10** (cache reads on Sonnet 5.5 and Opus 5.5 are 0.05 times the input price). It is fixed, with a test. Effect: Langfuse's **estimated** cost for a Sonnet reply that read from the cache is now lower than before (for the usual 3,000 cached tokens, about $0.0003 less per call). The Sonnet reply uses a cached prompt of about 1,000 tokens, so the effect on a single reply is small, but it removes a 2x error in the number we compare against.

## 4. Assumptions (all of them stated, none looked up)

1. **₹90 to the dollar.** A stated assumption, rounded up on purpose so the estimate does not flatter us. It is **not** a looked-up rate. Change it with `--usd-inr` or the `USD_INR_RATE` environment variable (the flag wins).
2. **Tokens are estimated from characters:** Haiku 4.5 3.5 characters per token for English and 1.2 for Tamil script; Sonnet 5.5 and Haiku 5.5 about 30% more tokens. There is no tokenizer in this repo, and counting through Anthropic's API is a model-service call we did not make.
3. **The turn:** 3 knowledge-base chunks of 600 characters (the demo's answers), 3 earlier messages, a reply of about 260 characters, 100 thinking tokens (Sonnet 5.5 at effort "low"; a guess), an extraction answer of about 180 characters.
4. **A regenerate** adds one more reply call with the first reply and about 300 characters of correction in its input. A second extraction try (bad JSON) is not counted.
5. **Prices** are those in `llm/models.ts`: Haiku 4.5 $1 in / $5 out, Sonnet 5.5 $2 in / $10 out. The invoice is the truth.
6. **₹0.35** is a target from the task list. This repo does not say where it comes from (the services research estimate is not in the repo), so it is used as given.

## 5. Things we could tune later (none done here)

Ranked by what the numbers above suggest. Prompt changes would be a new version file (a v3), never an edit.

1. **Retrieved context** (35% of a cached reply). Fewer or shorter knowledge-base chunks in the reply: the 1 x 300 case is under target. Levers: how many chunks go in (the search returns up to 5, `DEFAULT_K` in `kb/retrieve.ts`), the similarity cut-off (`KB_MIN_SIMILARITY`, 0.45, still provisional and meant to be tuned with the 15-query set), and a cap on characters per chunk. Fewer chunks can cost answers, so tune together with the retrieval set.
2. **Make sure the cache actually works.** Check `cache_read_input_tokens` in Langfuse on both models. If extraction does not cache, joining its cached blocks cannot help (the total is what counts); the choices are a longer fixed prompt (more examples, a new v3 prompt) or a cheaper extraction model (below).
3. **A cheaper extraction model.** What-if, **not applied**: Claude Haiku 5.5 is priced at **$0.10 in / $0.50 out per million** (about 10 times cheaper than Haiku 4.5), with cache reads at $0.01 and a 512-token minimum (so its cache would work with room to spare). Its newer tokenizer counts about 30% more tokens, which is already included:

   | English turn | Extraction cost now (Haiku 4.5) | On Haiku 5.5 | Whole message, no cache | Per credit |
   |---|---|---|---|---|
   | No cache | $0.0049 | $0.0006 | $0.0064 (now $0.0107) | ₹0.58 (now ₹0.96) |
   | Cache hits | $0.0009 | $0.0001 | $0.0040 (now $0.0047) | ₹0.36 (now ₹0.43) |

   The Tamil turn: ₹0.74 with no cache, ₹0.52 with hits. Extraction would no longer be the problem, but **the reply would be**: it needs fewer chunks and fewer thinking tokens as well. This needs a quality check on Tamil and Tanglish before anyone switches (extraction is where a wrong reading costs a wrong answer).
4. **Reply output** (51% of a cached reply, the largest single part). The reply is capped at 600 characters; a shorter average and less thinking help most (output is the dearest token). Confirm the real output and thinking size in Langfuse first: the 100 thinking tokens here are a guess.
5. **Regenerates.** Each costs about as much as the reply itself. The count of regenerates per day (reply calls beyond one per message) is in the trace summary: if it is more than a few percent, fixing what the post-check refuses is worth more than any tuning above.
6. **Keep the cache warm.** A business that gets a message every few minutes keeps it hit; a quiet one pays the write price every time. A 1-hour cache lifetime exists (2x write price), and could pay off for quiet businesses: it needs a change to the model client, not done here.

## 6. How to re-run with real Langfuse data

The same script reads traces. **The Langfuse export format used is a guess**, read from what `agent/llm/tracing.ts` writes (a generation with `usageDetails`, `costDetails`, and `metadata.role` and `metadata.input_chars`). It has **not** been checked against a real export, and neither has the API fetch. If a real export differs, change `normalise` in `backend/src/scripts/cost-per-message-lib.ts` and its tests.

1. **From a file** (an export of generations, as JSON): `pnpm --filter @pakka/backend cost:per-message --file export.json --day 2026-10-15`. `--day` is an India day; without it every day in the file is used.
2. **From the API:** put `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` (and `LANGFUSE_BASE_URL` if not the EU cloud; https only) in `backend/.env.local`, then `pnpm --filter @pakka/backend cost:per-message --traces --day 2026-10-15`. With no keys and no file it says so and exits normally. The script never prints a key and sends them only to the https Langfuse address.
3. **Credits:** Langfuse cannot tell a regenerate from a credit. By default one credit is one processed message. For the exact figure pass `--credits <n>` with the number of `ai_reply` credits spent that day from the credit ledger (Dev 2's tables).
4. It prints cost per processed message and per credit in rupees against ₹0.35, the regenerate count, how much of each model's input came from the cache, and a **calibration** per model: the characters per token the traces actually show. Feed those back with `--ratio-extraction` and `--ratio-reply` to sharpen the offline estimate. (The calibration is one blended figure for the prompt and the messages together; Tamil-heavy traffic pulls it down.)

**Wording of the trace output.** A processed message is an extraction call that did not fail. Handover cards (the `summary` role) are listed separately and are not counted. Calls with no cost recorded are priced from their tokens, and the count of those is printed.

## 7. Where the code is

- `backend/src/scripts/cost-per-message.ts`: the command and its help text.
- `backend/src/scripts/cost-per-message-offline.ts`: the offline estimate from the real prompts and the pack's fields.
- `backend/src/scripts/cost-per-message-lib.ts`: pricing, cache rules, rupees, reading traces. Tests next to each file.
- Prices: `backend/src/agent/llm/models.ts` (`estimateCostUsd`). The Haiku 5.5 what-if price is in the lib file, because the agent does not use that model.
