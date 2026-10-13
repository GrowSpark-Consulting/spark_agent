# 13 Oct (Dev 1): step 8 audit and the latency harness (PR 6). What was built, what was found, and what touches Dev 2's and Dev 3's areas

Dev 1 files: `backend/src/agent/pipeline/step8-audit.test.ts`, `backend/src/conversation-tests/latency*.ts` (the harness, its report and tests), a small timing hook in `conversation-tests/run-chat.ts`, the `latency:chats` script in `backend/package.json`. **No agent behaviour, prompt, rule or model changed.** No migration.

## 0. What "step 8" is taken to mean (an assumption, agreed 13 Oct)

`docs/handover.md` (lines 396 to 400) says the pipeline has eight steps and three exits, but the diagram that named them is not in the repo. Only steps 4 (extraction), 5 (decide), 6 (act, calendar) and 7 (reply) are named in the document and the code. This PR reads **step 8 as the tail of a turn: the send, the record, and the guarantees "one reply per turn, never twice, never silence", plus the turn's 10-second target and 25-second hard stop** (`agent/pipeline/reply.ts` `sendReply`, `answerAfterFailure`, `inngest/process-message.ts`, `turn-deadline.ts`). If the online diagram says something else, this note and the audit tests are what to correct.

## 1. The latency harness (`pnpm latency:chats`, local only, never in CI)

`pnpm --filter @pakka/backend latency:chats [--live] [--max-calls N] [--rounds N]` runs the scripted conversations (`tests/conversations`) through the real pipeline steps and times each step and each call. It prints a table per stage and labels every number: **MOCKED** (the pipeline's own code time: the models answer at once, the store and the knowledge base are in memory, nothing is sent), **LIVE** (the real models for one turn of seven chats: at most 15 requests by default, hard limit 20. A call is only made if its worst case, three tries, still fits under the cap, and every request is counted by the tries it took, whether the call succeeded or failed; sender, knowledge base and store are still fakes, so nothing is sent and nothing touches a database; needs `ANTHROPIC_API_KEY`), **CONFIG** (a limit read from the code), **MEASURED SEPARATELY** (the post-check, timed on its own) and **NOT MEASURED**. The timing is a hook in `run-chat.ts` (`StageProbe`): names and milliseconds only, nothing when it is not given, and the chats still pass unchanged.

### Results, 13 Oct

**LIVE** (7 turns, 13 of the 15 requests, about $0.026; extraction on the Haiku role, reply on the Sonnet role; a small sample, so p95 is the largest value):

| Stage | calls | p50 | p95 / max |
|---|---|---|---|
| Whole turn (stop check, understanding, reply, until handed to the sender) | 7 | 3.7 s | 4.5 s |
| Step: extract (the extraction model plus saving its reading) | 7 | 1.8 s | 2.4 s |
| Step: reply (the reply model, post-check, send, record) | 7 | 1.8 s | 2.7 s |
| Step: save-fields, retrieve, plan, qualify, act, plan-act, handoff (code and fakes) | | under 30 ms each | 24 ms (act) |
| Call: extraction model | 7 | 1.8 s | 2.3 s |
| Call: reply model | 6 | 1.8 s | 2.7 s |
| Call: knowledge-base search (fake) / send (fake) / calendar (fake) | 2 / 7 / 5 | under 1 ms / 0.05 ms / 0.01 ms | 0.06 / 0.10 / 22 ms |
| Post-check, timed on its own (350 runs) | | 95 µs | 200 µs |
| Reply regenerated after the post-check | 0 of 6 | | |
| Steps per turn run by this harness (production has about 6 more) | 7.0 | | |
| Turns over the 10 s target / the 25 s hard stop | 0 / 0 | | |

**MOCKED** (53 chats, 385 turns, the set run 5 times): the whole turn is 2.5 ms at p50, 8.2 ms at p95 and 97 ms at most (the largest are booking turns); extract 1.2 ms, reply 0.3 ms, the post-check 79 µs at p50 and 222 µs at p95; 6.8 steps per turn; the post-check refused a first reply 5 times (one scripted chat, five runs). **The pipeline's own code is under 1 percent of a live turn: the two model calls are almost all of it.**

**CONFIG** (read from the code): turn target 10 s, hard stop 25 s; debounce 3 s quiet period and 15 s longest wait; 3 retries per step, one conversation at a time; each model try 8 s (extraction) or 15 s (reply), all tries 20 s or 25 s, 3 tries; WhatsApp send timeout 10 s, never retried; read receipt at most 3 s and skipped when under 8 s of the target is left. The longest a customer can wait from their last message to the end of a run **without a step retry** is 15 s + 25 s + 10 s = 50 s; a retried step (3 retries, with Inngest's backoff) or the safe line after a run gave up adds to it.

**NOT MEASURED here:** the wait before a run starts (every reply waits at least the 3-second debounce after the customer's last message; the live turn above does not include it), Inngest's own time per step (the harness runs 7 steps per turn and production about 6 more: `started`, `resolve`, `batch`, `lead`, `gate` and the read receipt; each is a separate invocation), the real database (resolve, batch, lead and gate are not run by the harness; every step's reads and writes are in memory), the real knowledge-base search (the query embedding and the vector search), and the real send (the Meta call, `notify.send`'s credit and record steps, and the webhook that stores the message).

**What the numbers say, without tuning anything:** a typical live turn is about 3.7 s of model time; with the 3-second debounce a customer waits about 7 s before the send and Meta's delivery, which leaves about 3 s of the 10-second target for everything not measured here (the webhook, the queue, Inngest's per-step time, the database, the search and the send). Whether that is enough needs the same table measured on staging.

## 2. The audit (`step8-audit.test.ts`): what holds, and two gaps

Pinned (passing): the marker on the message is written before the answered rows and both after the send; a reply that could not be delivered leaves the messages unanswered, so the next run collects them; no model call can outlast the turn (each role's total timeout is within the hard stop, which is later than the target). Existing tests in `reply.test.ts` already cover one send per turn, an unknown outcome counted as answered, the safe line past the hard stop, a gave-up run and every way step 4 ends.

**Gaps, each marked `it.fails` (it passes while the gap exists and fails when the code is fixed, to be turned into an ordinary test). No fix is in this PR; each would be a separate small PR, and none is started:**

1. **(Addressed in the PR described in `2026-10-13-day6-dev1-reply-idempotency-key.md`; the `refund_credits` interaction it depended on was fixed in #163.) The reply is sent to `notify.send` without an idempotency key.** `notify.send` dedupes on a key (`idempotencyKey`) and the other senders (reminders, nudges, alerts, the demo replies) use one; `sendReply` does not. A run that dies after Meta accepted the reply and before the marker and the answered rows are written is retried by Inngest and sends the reply again. The marker and the audit row close this except in that window. A fix is a key naming the turn's last message, in `reply.ts`: no change to `notify.send`.
2. **A retry of the reply step asks the reply model again.** The text is written and sent in one step; a send that failed in a way waiting can fix throws, and the retry writes the text again: another model call (about 1.8 s and a cost), and a different text. Splitting the writing from the sending into two steps would keep the first text. With 3 retries, and up to two reply-model calls in an attempt (the post-check can ask for one more), that is up to 6 extra reply-model calls in a turn, usually none.

## 3. Observations, not changed and not tests

1. **A reply that cannot be delivered for a reason that will not pass is silent for both the customer and the staff.** Pinned as it is: `whatsapp_not_connected`, outside the 24 hours and the feature switched off return `not_sent`, open no handover, send no alert and no notice. The messages stay unanswered and are collected with the customer's next message, but nobody is told. `inngest/process-message.ts` already records that a sweep for messages nobody answered is "still the follow-up".
2. **The send is not bound by the turn's clock.** `notify.send` takes no deadline; the adapter's own 10-second timeout is the only bound, so a send that starts at the hard stop can end 10 seconds after it. (The safe line must still go out after the hard stop, so the send is rightly not cancelled by it.)
3. **The wait before a run is outside the turn's clock.** The clock starts at the run's first step, after the debounce, so the 10-second target does not include the 3-second (up to 15-second) wait.
4. **Within one run the understanding is sequential:** extraction, then saving the reading and scoring, then the knowledge-base search (it needs the question the extraction read), then the plan, then the reply model, then the send. The two model calls are in sequence by design. The read receipt runs alongside the understanding (`Promise.all` in `inngest/process-message.ts`).
5. **One run at a time per conversation depends on Inngest's concurrency key** (pinned in `inngest/process-message.test.ts`). Inside the pipeline, the check right before the send narrows a race between two runs but does not remove it.

## 4. What touches Dev 2's area (no file, table, function or route of Dev 2 changed)

Nothing is called or changed. Two points that concern Dev 2's code, noted for the record: `notify.send` takes no deadline or abort signal (observation 2), and a reply it refuses or cannot deliver is reported to the pipeline as a status only (observation 1). The missing idempotency key (gap 1) is on Dev 1's side: `notify.send` already supports it.

## 5. What touches Dev 3's area

Nothing.

## 6. Known limits of the harness

1. The live run is seven turns of the real-estate pack's scripted chats: a sample, not a distribution. A real percentile needs more turns than a 15-request cap allows. The live results above were taken before the cap counted failed requests and reserved three tries per call; that run made 13 requests and never reached the cap, and the final rule would have allowed every one of them.
2. Mocked numbers are code time only. They say where the code spends time, not what a customer waits.
3. The harness measures the steps `run-chat.ts` runs (stop check, understanding, reply). It does not run `started`, `resolve`, `batch`, `lead`, `gate` or the read receipt. It imports `inngest/process-message.ts` to read the function's configured limits, which loads the production modules (all lazy: nothing connects at import); a future top-level read of the environment or a database in them would show up here.
4. Not run on staging or against Meta, by design.
