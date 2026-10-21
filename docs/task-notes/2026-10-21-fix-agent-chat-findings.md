# 21 Oct (Dev 1): the three findings from the 60 realistic chats

For Dev 2 and Dev 3. **Nothing in your area changed.** The only code file touched is `backend/src/agent/scheduling/slot-choice.ts` (the reader of "which time did the customer pick?", Dev 1's agent code) and the test runner in `backend/src/conversation-tests/`. No booking, notify, billing, frontend, prompt, pack or migration file changed. The booking engine itself was not touched: the reader only decides which offered time a customer meant, and the engine books it exactly as before.

Related: `2026-10-21-feat-agent-realistic-chats.md` (the 60 chats and where the findings came from).

## Part A. Spoken picks of an offered time (code fix)

**The problem.** When the agent offers three visit times, the customer can pick one in words. The reader knew the formal Tamil "இரண்டாவது" but not how people type it, "ரெண்டாவது", and knew no Hindi at all. A real customer was asked to choose again instead of being booked.

**What it understood before, and what was added** (all in the existing patterns in `slot-choice.ts`):

| | Understood before | Added |
|---|---|---|
| First | first, 1st, option 1; முதல்; mudhal/muthal | ஒண்ணாவது, ஒன்னாவது, ஒன்றாவது; onnavathu/onnavadhu/onnavatu; typos frist, fisrt, firts; Hindi पहला/पहली/पहले, pehla/pehli/pehle/pahla (முதல்ல உள்ளது was already read, because முதல் is inside it; now it has a test) |
| Second | second, 2nd; இரண்டாவது; rendavathu/rendavadhu; irandavathu | ரெண்டாவது (and ரெண்டாவதுதான், any ending); rendavatu, randavathu; typos secnd, secound, seccond, sencond; Hindi दूसरा/दूसरी/दूसरे, doosra/dusra/doosri/dusri |
| Third | third, 3rd, #3; மூன்றாவது; moonravathu/moonavathu | மூணாவது, மூனாவது; moonavatu; typos thrid, thired; Hindi तीसरा/तीसरी/तीसरे, teesra/tisra/teesri |

**Two guards so the new words cannot book by mistake:**

1. **A Hindi pick counts only when the message is the pick and little else.** "दूसरा / doosra" also means "other" ("दूसरा दिन" is another day, "doosra time dikhao" is show me another time). So the word is read only when the rest of the message is small filler: वाला, ठीक है, वही, चलेगा, हाँ, जी, बुक कर दो, कर दो, ok, and the Roman versions (wala, theek hai, wahi, chalega, haan, ji, book kar do, kar do). "दूसरा वाला बुक कर दो", "doosra wala chalega", "doosra wala theek hai" book. "दूसरा दिन चलेगा" does not.
2. **A message that asks a question is never a pick.** If it holds a question word (எவ்ளோ, எங்க, என்ன, evlo, enna, कितने, क्या, kitne, kya, how much, what…) the place word is ignored and the customer is asked again kindly, so the question can be answered. "ரெண்டாவது எவ்ளோ?", "दूसरा वाला कितने का है?", "doosra wala kitne ka hai" book nothing. A question mark on its own does not count, only a question word: "ரெண்டாவது ஓகே வா?", "rendavadhu ok ah?" and "second one please?" still book. The Hindi yes/no word क्या / kya is allowed only as the last word of a pick, so "दूसरा वाला ठीक रहेगा क्या?" and "doosra wala chalega kya?" book, while "दूसरा वाला क्या है" (what is it) does not. The words are matched as whole words (என்னால is not என்ன). This guard applies to every language, English included ("what is the second one" is now a question, not a pick). A time such as "3 pm" or "the 3 pm one" is not touched.

**Also checked not to match:** "wait a second", "give me a second", "10 seconds", "12nd", "ரெண்டு மணி" (two o'clock), "மூணு மணிக்கு", "ஒண்ணு", "rendu mani", "pehle se bataya hai".

**Tests.** Written first and shown failing (48 failed), then the fix. `slot-choice.test.ts` has the new groups. Three new chats: **260** (Tamil, "ரெண்டாவது", books the second), **261** (Tamil, "மூணாவது ஓகே சார்", books the third), **262** (Hindi: "दूसरा वाला कितने का है?" is answered and nothing is booked, then "दूसरा वाला" books the second). I ran them against the old `slot-choice.ts`: all three fail there and pass now. Chat 227 only lost the sentence about the bug in its description.

## Part B. Hinglish and the fixed lines (written up in the PR, no code changed)

The fixed lines exist only in English, Tamil, Tanglish and Devanagari Hindi (`pipeline/fixed-texts.ts`). The extractor says `hi` for Hindi in Roman letters, so those customers get the Devanagari lines. See the PR description for the lines affected and the two options. Nothing was changed.

## Part C. A turn can say the knowledge base is empty

**What was wrong in my earlier note.** The earlier note (`2026-10-21-feat-agent-realistic-chats.md`) says the "two misses in a row, then a person" handover can only be checked in mock mode because `--live` always returns the chat's own text. **That was not correct for chats that used `mock: { kb: [] }`.** The runner reads `mock.kb` in both modes (nothing tied it to mock mode), so those turns already saw an empty knowledge base live. Chats 210 and 250 had moved the handover under `mockOnly` for no real reason.

**What changed.**
- A turn can now say `kb: []` (outside the `mock:` block), which is clearly the same in mock and live. The one place that picks the text is `knowledgeBaseForTurn` in `run-chat.ts`: the turn's `kb`, else the old `mock.kb`, else the chat's `kb`. The loader schema (`schema.ts`) accepts it. `mock.kb` still works.
- Runner tests: the picking order; `[]` means empty, not "use the chat's"; two empty turns in a row hand over (`kb_gap`); a miss, an answered turn and a miss do not.
- Chats **210** and **250** now use `kb: []` on both turns and check the handover (`kb_gap`, human mode) under `expect`, so `--live` checks it too. They also expect `intent: question`. **230** uses `kb: []` on its two unanswerable turns, so the "miss, answered, miss → no handover" check runs live too.
- 204 and the other single-miss chats were not changed (no handover check, and they already worked live through `mock.kb`).
- One thing to know: with an empty knowledge base the reply is the fixed line, so on those turns `--live` does not ask the real reply model. It checks the code (miss, fallback line, handover) and the extraction, not the model's wording.

## How to test

```
pnpm --filter @pakka/backend test:conversations              # 184 passed, 0 failed
pnpm --filter @pakka/backend exec vitest run src/agent/scheduling src/conversation-tests
pnpm --filter @pakka/backend typecheck
```

Live (costs money; run on purpose): `pnpm --filter @pakka/backend test:conversations -- --live --only 210-tanglish,250-hindi,227-tamil,260-tamil,261-tamil,262-hindi`

## Decisions

- Spoken spellings were added to the existing patterns; only the Hindi words needed a new, stricter pattern (the whole message), because they also mean "other".
- A question word makes a message not a pick. The cost: a customer who writes a pick plus a question word is asked again once. That is safer than booking the wrong time.
- Old `mock.kb` kept, so no existing chat changed.

## Follow-ups

- A native reader should check the Hindi filler words and the question words (they are a short list, not complete). If a real customer's pick is missed, add the spelling to the pattern and a test.
- The Hinglish question (Part B) needs a decision before any code.
- Spoken Hindi numbers as picks ("2 नंबर वाला") are not read yet.
- Correct the earlier note when convenient (the claim above).
