# 15 Oct (Dev 1): a retry of the reply step does not ask the reply model again (Day 8)

For Dev 2 and Dev 3. Dev 1 files only: `backend/src/agent/pipeline/reply.ts`, its tests (`reply-draft.test.ts` new, `step8-audit.test.ts`, `whole-turn-matrix.test.ts`), and one sentence in `backend/src/agent/README.md`. No prompt, migration, pack, `notify` file, Dev 2 file or Dev 3 file changed.

## 1. What was built and why

This closes the second finding of the Day 6 step 8 audit (`2026-10-13-day6-dev1-step8-audit.md`), pinned until now by an `it.fails` in `step8-audit.test.ts`.

**The problem.** The `reply` step writes the customer's reply (the Sonnet model, with one regenerate if the post-check refuses it) and then sends it through `notify.send`. When the send fails in a way waiting can fix (a rate limit, a blip), the step throws on purpose and Inngest runs it again, up to 3 retries. The retry re-ran the whole step, so it asked the model again: another call (about 1.8 s and a cost) and often a different text. Worst case was 3 retries times 2 calls, so up to 6 extra reply-model calls in one turn, usually none. The step's result holds no text by design, so Inngest had nothing to reuse. Credits and the customer were never affected: the send is idempotent (key `reply:<last message id>`, the claim in `notify_attempts`), and `notify.send` spends the credit before WhatsApp and refunds it on failure.

**The fix.** The reply the model wrote is kept on the turn's last message (`messages.meta.agent.draft`: the plan case and the text) before it is sent, through the existing `saveAgentMeta`. A retry reads it and sends that text under the same key, without a model call.

- It is used only if it was written for the same plan case and still passes the post-check against the facts of the turn. Otherwise it is ignored and the model is asked as usual.
- It is used even after the turn's clock has run out: it needs no model, and beats the generic safe line.
- Only a real model answer that passed the post-check is kept. Fixed words, and the safe line after a model failure, are not (a retry after a model error should get another chance at a real answer).
- It is cleared (`draft: null`) when the send ends: in the same write that records the reply as sent (and in the unknown-outcome write), and, best effort, when the send fails for good, is skipped (any reason, including no credits), or the chat is no longer in AI mode, the contact opted out, or the message turned out to be answered already.
- A draft write that fails never changes the turn: it is logged as the error class only (the store already logs the database code), never the reply. If the draft cannot be saved the reply is still sent; the cost is only that a retry would ask the model again, as before.

**Cases:**

| Case | What happens |
|---|---|
| Model fails | The fixed fallback goes as before; nothing is kept; a retry asks the model again. |
| Post-check refuses, the regenerate passes | One regenerate in the first attempt, the final text is kept; a retry makes no further call. Still counted once. |
| Post-check refuses twice | The safe line, not kept, as before. |
| Send fails, retryable (up to 3 retries) | One model call in all; every retry sends the same text under the same key. |
| Send fails for good, or is skipped | No retry, as before; the draft is cleared. |
| Draft save or clear fails | Logged without the text; the turn's result is unchanged. |
| Marker or answered rows fail after the send | Absorbed, never a second send, as before. |

## 2. How to test

- `pnpm --filter @pakka/backend exec vitest run src/agent/pipeline/reply-draft.test.ts src/agent/pipeline/step8-audit.test.ts src/agent/pipeline/whole-turn-matrix.test.ts src/inngest/replay-coverage.test.ts`.
- Then, for every workspace, `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm test:conversations`.
- The 5 new whole-turn tests fail on the old `reply.ts` and pass on the new (checked by stashing the change).
- On staging (unverified): make `notify.send` fail once with a retryable error and read the logs: `[pipeline] reply send retried` once, and one reply-model trace in Langfuse for the turn, not two.

## 3. Decisions

- **A draft in the database, not a second Inngest step.** The step results hold no customer-facing text by design, so a split into "write" and "send" steps would have to hand the text over through the database anyway. One step with a draft is the smaller change, and leaves the step list (which Dev 2's `replay-coverage.test.ts` follows) as it was.
- **Reuse is checked, not assumed:** same plan case, and the post-check again against the current facts.
- **Not kept: fixed words and the fallback after a model failure.**
- **Cleared when the send ends for good, best effort.** The draft is the same text a sent reply stores as the outbound message.
- **The prompts are untouched** (they are versioned; no v3 here).

## 4. Notes for Dev 2 (Shaaz)

- **Credits and `notify.send`: nothing changed.** The credit is still spent by `notify.send` before WhatsApp and refunded on failure, by reference; a retry re-sends under the same key (`reply:<last message id>`) and the claim is released after a certain failure, so one credit is spent, on the attempt that goes out. The new whole-turn tests assert one credit (`creditsNet`) with the existing fake of `notify.send`.
- Your `inngest/replay-coverage.test.ts` points at whole-turn tests by name. I only added tests to `whole-turn-matrix.test.ts` and renamed or removed none; the file passes unchanged.
- The `process-message` function and its steps are unchanged.

## 5. Notes for Dev 3 (Dhatri)

- None. `messages.meta.agent.draft` is internal to the pipeline and cleared once the send ends; the inbox does not need to read it (and `meta.agent` was already internal).

## 6. Follow-ups

- When all four attempts fail, the draft stays on that message (the failure handler sends the safe line but does not clear it). Harmless, deleted with the contact's data; could be cleared in the failure handler later.
- Check on staging that a retryable send failure costs one reply-model call (Langfuse), and that `[pipeline] reply send retried` counts how often it happens (the log line was added to judge whether this would ever pay).
- `conversation-tests/latency-report.ts` counts "regenerated replies" as reply-model calls after the first in a turn; with this fix a retry no longer inflates that number.
