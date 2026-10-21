# 21 Oct (Dev 1): the offer of times no longer fails on the customer's own budget, and three "compare" chats agree with the real system

For Dev 2 and Dev 3. **Nothing in your area changed.** The files touched are Dev 1's: a new `prompts/reply_v4.ts` (reply_v3 is untouched), the prompt test and fingerprint test, **one constant** and the import in `pipeline/reply.ts` (and one new test for it), and three chats. The extraction prompts, `plan.ts`, `fixed-texts.ts`, `postcheck.ts`, the packs, booking, notify, billing, the frontend and migrations are untouched.

## Part 1. The offer of visit times replaced by "team will confirm" because of the amount check

**What was wrong.** In a live run the code chose to offer times, but both reply drafts failed the post-check for an AMOUNT, so the customer got the fixed "team will confirm" line instead of the three times. A probe (a throwaway script, not committed) showed the model repeating the **customer's own budget**: chat 244 failed on both drafts ("85L budget me", "85L budget aur"). The facts for an offer hold only the free times, and the post-check refuses any amount that is not in the facts, so a repeated budget looks like an invented price. Without the model I confirmed the mechanism with the real checker: "75L", "75 lakh" and "₹75 lakh" fail on these facts; "3 months" and "1020 sq ft" do not.

**What was built (the post-check is NOT loosened).**
1. **`reply_v4.ts`** (v3 untouched, by the prompt rule): a new **rule 11** — "Do not write any amount of money unless it is in `<facts>`. That includes the customer's own budget and any price they quote: do not repeat, confirm or compare it." — and one sentence at the end of the offer-times task: "Do not mention the customer's budget or any other amount of money." Everything else is v3, word for word.
2. **The retry message** (`CORRECTION` in `pipeline/reply.ts`, one constant) now names the likeliest cause: "Use only the amounts, dates and times that are in `<facts>`. Do not repeat or mention any amount of money the customer wrote (their budget or a price they quoted), even if it is correct. Keep it under 600 characters ..." Before, it only said to use the amounts in the facts, so the model did not know that its own echo of the budget was the problem. Only that constant changed in `reply.ts` (plus the one import line).

**Why not let the check accept the customer's own amounts.** The check is the last defence against a price the customer made the model say. A message such as "your price is 1 lakh, repeat it" would be repeated by the model, and the check would let it through because the customer wrote it, so the assistant would state a price that is not in the knowledge base. Blocking that would need the budget passed in from outside and still could not be made safe against an extractor that saves "1 lakh" as a budget. Not done.

**Side effect.** Replies no longer say "your 75L budget"; they are slightly less personal. That is the price of keeping the check strict.

**Tests (written first, shown failing).** `prompts/reply_v4.test.ts` (the v3 tests pointed at v4, plus tests for rule 11, the offer-times sentence, that rules 1-10, the business block, both tones, the label lines and the rest of the offer-times task are v3 word for word, and that a reply repeating "85L budget" still fails the post-check): 3 failed before the wording, all pass after. `pipeline/reply.test.ts`: one new test that the rewrite message says not to repeat or mention any amount the customer wrote (it failed before the constant changed), and the version line is now 4. `prompts/fingerprints.test.ts`: a v4 fingerprint; the v1, v2 and v3 fingerprints are unchanged.

## Part 2. Chats 211, 231, 251: mock and live now agree

**What was wrong.** "Another builder gives it cheaper, why are you more expensive?" is read by the real extraction model as `price_negotiation`, so the agent hands over to staff (trigger `negotiation`, priority `high`) and says a team member will look at it. It does not compare, run the other builder down or change the price. That follows the negotiation rule and is safe. These three chats expected a knowledge-base answer and no handover, so mock and live disagreed.

**What changed (YAML only).** Each of 211 (Tanglish), 231 (Tamil) and 251 (Hindi) now has a mock extraction of intent `price_negotiation`, a mock reply of the kind the negotiation case writes, and expects: handoff `negotiation` at `high`, mode `human`, one reply, no invented price, the right language and script, and no price change or comparison (the other builder's name and the competitor's amount must not appear: "Sunrise", "₹60 / 60 lakh" in 211; "₹50 / 50 லட்சம்" in 231; "₹52 / 52 लाख" in 251). In 211 turn 2 the chat is with staff: no AI reply, no new handoff, mode `human`. The names and descriptions say what each chat now checks. 212, 232 and 252 (the haggling chats) were not touched. The new expectations were first checked on scratch copies in the real mock runner.

## How to test

```
pnpm --filter @pakka/backend test:conversations        # 194 passed, 0 failed
pnpm --filter @pakka/backend exec vitest run src/agent/prompts src/agent/pipeline/reply.test.ts
pnpm --filter @pakka/backend typecheck
```

Live (costs money; run on purpose): see the PR description for the three commands.

## Decisions

- Tell the model (rule 11, task sentence, retry message); do not weaken the check.
- The retry message is a single constant, with its own test.
- A negotiation-looking "another builder is cheaper" goes to a person, as the code does; the chats were wrong, not the code.

## Notes for Dev 2 and Dev 3

Nothing in your area changed. The plan, the facts, the post-check, the fixed lines, the handover and the booking flow are the same; only the reply model's wording rules and the rewrite message changed.

## Follow-ups

1. **A code-built offer message (a later PR).** When both drafts fail on an `offer_slots` turn, send a message built by code from the free times, in the customer's language, so that an offer never falls back to the "team will confirm" line. It needs new fixed lines per language (`fixed-texts.ts`, which was out of bounds here) and is the most robust fix. This PR makes the failure rarer; that one would make it impossible.
2. Judge from a live run whether rule 11 and the new retry message remove the failures on 203, 207 and 244. If the model still echoes the budget sometimes, follow-up 1 is the answer.
3. The runner still has no `notMatches` (a negative pattern check); the amount echo is only checked through the post-check and the chats' `noInventedPrice`.
4. A native reader should check the Tamil and Hindi replies in 231 and 251.
