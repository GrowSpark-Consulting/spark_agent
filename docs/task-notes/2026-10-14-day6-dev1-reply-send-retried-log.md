# 14 Oct (Dev 1): a log line for a reply send that is retried

Dev 1 file: `backend/src/agent/pipeline/reply.ts` (6 lines) and one test in `reply.test.ts`. Nothing of Dev 2's or Dev 3's changed; no SQL; no behaviour change.

1. **What**: when the AI reply's send fails in a way waiting can fix (`retryable`, outcome known), the reply step logs `[pipeline] reply send retried` just before it throws, so Inngest runs the step again (up to 3 retries). A fixed line: a count and nothing else (no ids, phone numbers or text; the existing line next to it, `the reply could not be sent (<code>)`, already carries only the error code).
2. **Why**: the split of "write the reply" from "send the reply" (a saved draft, so a retry does not call the model again) was planned and **not built**: a retry costs one extra model call (about 1.8 s) and only on rare send failures. This line makes the rate visible. Revisit the split if the line shows up on more than a few percent of turns, or if the cost of the extra call grows.
3. **How to read it**: count the lines per day against the `[pipeline] replied:` lines. A run's last attempt is counted too (the function's failure handler then logs `gave up after its retries`), so the count can exceed the number of actual re-runs by at most one per run that failed completely.
4. **Not logged**: a send that failed for good, one whose outcome is unknown (it may have gone out, so it is never resent), a send that was skipped (credits, opt-out, window) or one that went out.
5. **Test**: one test (`reply.test.ts`): a retryable failure logs exactly the one line and throws; a non-retryable failure, an unknown outcome and a normal send log nothing. It fails on the old code.
