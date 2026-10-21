# 21 Oct (Dev 1): reply prompt v3 — a stable script for Hindi, and nothing said about the team that no fact says

For Dev 2 and Dev 3. **Nothing in your area changed.** The files touched are Dev 1's: a new `prompts/reply_v3.ts`, one import in `pipeline/reply.ts`, the prompt tests and the fingerprint test, two expected strings in existing tests, chats. The extraction prompt, `plan.ts`, the fixed texts (`fixed-texts.ts`), the packs, booking, notify, billing, the frontend and migrations are untouched. `reply_v2.ts` is untouched (prompt versioning rule); the pipeline now uses v3 and the trace says version 3.

## 1. What was wrong

1. **The script of a Hindi reply was not stable.** For a customer who writes Hindi in English letters (chat 244: "3bhk 85L gr noida west 2 month me lena h"), one live run replied in English letters and the next in Devanagari. The extractor now reads it correctly as `hi`, but the reply model was only told "The customer writes in: Hindi" (no script), and reply rule 5 said "likewise for Malayalam and Hindi", so it guessed.
2. **The reply model sometimes claimed the team had been told something no fact says.** Seen live in chat 203: "Budget and 3 months timeline pathi team kitta sollirukkren" (I have told the team the budget and timeline). The assistant does not do that. The post-check cannot catch it: it only checks amounts, dates and times.

## 2. What was built (`reply_v3.ts`; everything else is v2, word for word)

- **Rule 5** (replaced): reply in the customer's language **and in the script of the customer's latest message**. Tamil script for Tamil, Tanglish for Tanglish, English for English; Hindi in Devanagari if the customer wrote Devanagari and in English letters (Hinglish) if they wrote English letters; if the message mixes both, the script most of its words use; the same for Malayalam and any other language that can be written in either script; numbers and dates are written exactly as the facts give them.
- **Rule 10** (new): never say or imply that the team has been told, informed or asked, or that anyone will do or say something, and never say that details were noted, passed on or shared with the team, **unless a fact in `<facts>` (or the `<task>`) says so**. Three examples of what NOT to write. The one thing rule 3 allows stays: saying you will check with the team when the facts do not answer a question.
- **The label line** ("The customer writes in: <label>") is written inside the prompt file (`LANGUAGE_HELP` and `buildReplyMessages`), so no code outside `reply_v3.ts` changed. The labels for `hi`, `ml` and `other` now carry the script instruction ("Hindi, written in the script of the customer's latest message (Devanagari or English letters)"). `en`, `ta` and `ta-en` are unchanged, because their script is already part of their meaning.

## 3. Decisions

- **Rule 10 and rule 3.** Rule 3 says to "say you will check with the team" when the facts do not answer. That is itself a promise about the team, so rule 10 names it as the one exception. Without it the new rule would stop the safe answer.
- **"(or the `<task>`)".** The price-negotiation reply is driven by a task line that tells the model to say a team member will take over, and the same turn also carries a fact that says so. Allowing "the task" means the model is never forced to contradict its own instruction.
- **The examples of what not to write** are 8 or more words long, so a reply that copies the first one is refused by the existing "copied from the rules" check, which is the right result.
- The Hindi script is decided by the **customer's latest message**, in the prompt. Nothing in the code looks at the letters.

## 4. A side effect to judge from a live run: how times are written in Tamil and Hindi replies

The sentence "Write numbers and dates exactly as the facts give them" is new in rule 5. The facts for an offer of times read "Sun 11 Oct, 10:00 am". So a Tamil or Hindi (or Hinglish) reply may now be pushed toward writing "10:00 am" instead of the spoken forms ("காலை 10 மணி", "सुबह 10 बजे", "10 baje"). That is not wrong: the post-check accepts both forms, and the chats that check times (244 accepts "baje") accept both. But it changes how the reply reads for a Tamil or Hindi customer, and **whether it reads naturally should be judged from a live run**, not from these tests. If it reads badly, the fix is one sentence in a v4 of the reply prompt.

## 5. Reported only (not changed)

- **The fixed lines for `hi` are always Devanagari** (`pipeline/fixed-texts.ts`: team will confirm, please type, handover, sorry-then-handover, area options, out of credits, opt-out, exit question and buttons, the STOP hint and the privacy line). A Hinglish customer still gets those in Devanagari; v3 only fixes the lines the reply model writes. That was Part B of an earlier PR and is not changed here.
- The runner cannot check that a reply has **no** Devanagari or that it does **not** match a pattern. `notContains` is a literal, case-sensitive text.

## 6. Tests

- `prompts/reply_v3.test.ts` (new): the v2 tests pointed at v3 (one regex updated for the reworded rule 5), plus tests for rule 5 (all four script cases and the numbers sentence), the three label lines, rule 10 (its wording, "(or the task)", the rule 3 exception, the three examples), the leak check on the first example, and that rules 1-4 and 6-9, the business block, both tones and the task/facts of five actions are v2 word for word. Run first against an unchanged copy of v2: 15 of the new tests failed; after the wording all pass.
- `fingerprints.test.ts`: a v3 fingerprint; the v1 and v2 fingerprints are unchanged. `reply.test.ts`: version 3. `reply-language-whole-turn.test.ts`: the one expected string for the label of a high-confidence "other" language.
- New chats **271** (Hindi, Devanagari customer, Devanagari reply expected) and **272** (Hinglish customer, two turns, English-letter replies expected both times), both `needsNativeCheck`.
- Chats **203** and **207** also check that the reply does not contain "team kitta soll" (a promise to the team). This is a literal text check, so it catches "team kitta sollirukkren" and "team kitta sollitu varen" but not "team kitta check pannitu solren"; it is a weak net. Chat 244 was not edited: its checks already accept "baje".

```
pnpm --filter @pakka/backend test:conversations        # 194 passed, 0 failed
pnpm --filter @pakka/backend exec vitest run src/agent/prompts
pnpm --filter @pakka/backend typecheck
```

Live (costs money; run on purpose): see the PR description for the three commands.

## 7. Notes for Dev 2 and Dev 3

Nothing in your area changed. The reply model's wording is the only thing that changes; the plan, the facts, the post-check, the fixed lines, the handover and the booking flow are the same.

## 8. Follow-ups

1. **`notMatches` in the runner.** Add a negative pattern check (a regular expression the reply must NOT match) to the conversation runner and its loader, so the promise-to-the-team check in 203 and 207 can cover every wording, and so 272 can say "no Devanagari". The runner is outside this task's files; today only the literal `notContains` exists.
2. Judge from a live run how times read in Tamil and Hindi replies (section 4).
3. If a live run still shows a promise about the team, a code check could look for it, but it needs a list of wordings per language; the prompt rule is the first step.
4. The fixed Hindi lines in English letters for Roman-letter customers (the Part B options of an earlier PR) are still open.
5. A native reader should check the Tamil and Hindi chats 271 and 272.
