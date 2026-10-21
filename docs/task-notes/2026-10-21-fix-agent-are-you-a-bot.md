# 21 Oct (Dev 1): "are you a bot?" was handed to staff as a request for a person

For Dev 2 and Dev 3. **Nothing in your area changed.** The files touched are Dev 1's: a new `prompts/extraction_v4.ts`, one import in `pipeline/understand.ts`, the prompt tests and the fingerprint test, three chats. `plan.ts`, the reply prompt, the packs, booking, notify, billing, the frontend and migrations are untouched. v3 of the extraction prompt is untouched.

## 1. What was wrong

A live run (chats 04 English, 213 Tanglish "neenga human aa illa robot aa?", 233 Tamil "நீங்க மனுஷனா இல்ல மெஷினா?", 253 Hinglish "tum bot ho ya insaan?") showed the real extraction model labelling a plain "are you a bot?" as intent `talk_to_human`. So the agent handed the chat to staff at high priority and sent the handover line, instead of answering honestly that it is the business's virtual assistant and offering a person (Raja's rule).

**Cause.** The definition of `talk_to_human` in the extraction prompt (the same in v2 and v3) said "... or says they do not want to talk to a bot or an AI and wants someone real", which the model applied to a plain question. The separate `asksIfHuman` flag exists for exactly this question.

## 2. What was built (`extraction_v4.ts`)

- **`talk_to_human`** is only asking FOR a person: a person, a team member, a call back, or "I want a real person", or "I do not want to deal with a bot". It is **not** `talk_to_human` when the customer only asks WHAT they are talking to (a bot, an AI, a machine, a human, a real person): that is `asksIfHuman` true with the intent the message would otherwise have. If the customer does both ("are you a bot? connect me to a person"), it is `talk_to_human` with `asksIfHuman` true.
- **`question` is null** when the customer only asks what they are talking to: it is not a question about the business. This matters: if `question` held it, the knowledge base would be searched, find nothing, and the customer would get the fixed "team will confirm" line instead of the honest answer. When they also ask something about the business, `question` holds that part only.
- **Examples** next to the language examples, both sides, in English, Tanglish, Tamil, Hindi (Devanagari) and Hinglish ("are you a bot?" and its four translations: `question`, `question` null, `asksIfHuman` true; "get me a real person" and its translations: `talk_to_human`; "are you a bot? connect me to a person" and its translations: `talk_to_human`, `asksIfHuman` true; one example with a question about the business after "are you a bot?").
- Raja's phrases 2, 5 and 9 (do not want a bot, want a real person, the bot is useless) are still `talk_to_human`.
- Everything else is v3, word for word. Per the prompt versioning rule v3 is never edited; the pipeline now uses v4 and the trace says version 4.

## 3. What happens next in the code (reported, not changed)

- A message with intent `question`, `question` null and `asksIfHuman` true: `understand.ts:153` makes `hasQuestion` false, `understand.ts:326` skips the knowledge-base search, and `plan.ts` sends it to the reply model, not a fixed line. The case is `nothing_to_look_up` (`plan.ts:317`) when no required details are missing, or `ask_details` (`plan.ts:315`) when required details are still missing, which is the normal case for a new lead in production. Reply rule 1 (say plainly that you are the business's virtual assistant and offer a team member) applies in both.
- `plan.ts:243`: intent `talk_to_human` (with the business's handover setting on) gives the handover line, an `asked_human` handoff at high priority and the chat goes to a person.
- `asksIfHuman` is read into the summary (`understand.ts:150`) and stored, but **nothing else in the code reads it**. A code-side guard is not clean: in the "both" case the model reports `talk_to_human` with `asksIfHuman` true, which is also what the wrong label looks like, so the two cannot be told apart without a new signal (a schema change). Not added.

## 4. Tests

- `prompts/extraction_v4.test.ts` (new): the v3 tests pointed at v4, plus tests for the new `talk_to_human` definition, the "both" rule, the old wording being gone, the `asksIfHuman` line, the `question` null rule and every example. They were run first against a copy of v3: 21 failed, then the wording was written and all 54 pass.
- `fingerprints.test.ts`: a v4 fingerprint (the v1, v2 and v3 fingerprints are unchanged). `understand.test.ts`: one line, version 4.
- New chats **269** (English, "are you a bot? I'd rather talk to a real person") and **270** (Tanglish, "neenga bot ah? oru aal kitta pesanum", `needsNativeCheck`): both must still go to a person (`talk_to_human`, `asked_human` handoff, high priority). They make sure the fix does not swing too far.
- Chat 244 (edit only): the live checks for the times now accept "10:00 am" or "10 baje", "3:00 pm" or "3 baje", "5:30 pm" or "5:30 baje", because a correct Hinglish reply writes "baje". The language check (hi) and the rest are unchanged.

```
pnpm --filter @pakka/backend test:conversations        # 192 passed, 0 failed
pnpm --filter @pakka/backend exec vitest run src/agent/prompts
pnpm --filter @pakka/backend typecheck
```

Live (costs money; run on purpose): see the PR description for the three commands.

## 5. Decisions

- The fix is in the prompt (a new version), not in code: the code already does the right thing with the right label.
- "Both" stays a person request: a customer who also asks for a person must get one.
- `question` is null for a pure "are you a bot?" so the knowledge base is not searched.

## 6. Notes for Dev 2 and Dev 3

Nothing in your area changed. The handover path (`plan.ts`, the handover line, the handoff row) is untouched; only which messages reach it changes.

## 7. Follow-ups

1. Run the live checks (a) 04, 213, 233, 253, 269, 270, 244; (b) the person-handoff and opt-out phrase chats, to see the new wording did not make the model miss a real request for a person; (c) 01, 02, 03, 05, 107, 108.
2. On the `ask_details` path (a new lead with details still missing) the reply model is told to ask for those details; rule 1 should still make it answer the "are you a bot?" first. Worth reading once live.
3. If the model still mislabels it, a separate "asks for a person" flag in the schema would make a code guard possible (a shared-type change).
4. A native reader should check the Tamil and Devanagari examples.
