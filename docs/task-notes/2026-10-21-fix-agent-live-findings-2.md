# 21 Oct (Dev 1): three problems found by a live run of 12 chats

For Dev 2 and Dev 3. **Nothing in your area changed.** The files touched are all Dev 1's agent code: `scoring/area-match.ts` (new) and `scoring/score.ts` (the area check only), `pipeline/postcheck.ts` (the date reader only), `prompts/extraction_v3.ts` (new) and `pipeline/understand.ts` (one import), their tests, and two new chats. The booking engine, notify, billing, the frontend, migrations and the packs are untouched. v2 of the extraction prompt is untouched.

The live run (`--live`, chats 203, 207, 227, 244, 247, 260-266) showed three problems. Each was diagnosed with evidence first.

## 1. A place written in another script or spelling was refused as "no site there"

**What was wrong.** A customer writing "பெரும்பாக்கம்", "பள்ளிக்கரணை", "ग्रेटर नोएडा वेस्ट" or "gr noida west" was told "we have no site there, our sites are in Perumbakkam, Pallikaranai / Greater Noida West, ..." although the place was on the list. The place check looked only for the listed name, letter for letter, inside the customer's words (`judge` in `score.ts`; `normaliseArea` only lowercases and strips punctuation). The same check gives the 20 "area" scoring points, so these customers also lost points.

**What was built.** `scoring/area-match.ts` writes each word as a "sound skeleton": Tamil and Devanagari consonants become Latin ones, vowels are dropped, similar sounds are folded (b/p, d/t, g/k, v/w, ch/s), a word-final y is dropped and doubled letters become one. "பெரும்பாக்கம்", "Perumbakkam" and "Perumbakam" are all `prmpkm`. A listed place is found in the customer's words when its words appear one after the other with the same skeleton. Also accepted: an abbreviation of up to 3 letters ("gr" for "greater") and a Tamil ending on a Tamil word ("பெரும்பாக்கத்துல" = in Perumbakkam). `judge` tries the old exact check first, unchanged, then this.

**The rules it keeps** (code decides; the model only reads):
- The customer's words are only ever compared with the business's own list; nothing is added to it.
- A place that is truly not listed (Anna Nagar, அண்ணா நகர், Gurgaon, गुड़गांव) still gets the options line.
- A place the code cannot read is **never** answered "no site there": a place in a script other than Latin, Tamil or Devanagari (Malayalam, Telugu...) is not judged (`judge` returns "unknown", `readCoverage` returns null). Before, it counted as not listed.
- A name whose skeleton has fewer than 3 letters is never matched by sound, and a pincode (or any word with a digit) must be exact.
- "Adyarpet" is still not "Adyar", and "Velacherypuram" is not "Velachery".

**Not chosen, and why.** (B) Making the extraction model also return which listed area the customer means: needs a new prompt version, the catalog read before every extraction, and is not testable offline. (C) Aliases per business: needs catalog and dashboard changes in Dev 2 / Dev 3 files. Both stay as follow-ups.

**Tests.** `area-match.test.ts` (new): every example from the request, the places that must not match, the unreadable scripts, and the Latin cases that must not change. Two new chats: **267** (Tamil) and **268** (Hindi). Each first sends a place the business does not have (options line, no time offered) and then a listed place in the customer's own script (served, three real times offered). The mock extraction hands over the place as text, as the live model does. Against the old `score.ts` both fail at turn 2 with the live symptom.

## 2. The offer of visit times was replaced by "team will confirm" (chats 203, 207)

**What was wrong.** The code chose to offer times, but the reply failed the post-check for a date twice, so the customer got the fixed line instead of the three times. A probe (a throwaway script, not committed) printed the real drafts: all four were correct. The checker invented dates: it read the number after a month name as a day, so "Sunday 11 Oct 10 am" gave 11/10 **and** 10/10, and "12 Oct 5:30 pm" gave 12/10 **and** 5/10. The facts label has a comma ("Sun 11 Oct, 10:00 am"), but a natural reply often drops it.

**What was changed.** In `datesIn` (`postcheck.ts`) a number right after a month name is **not** a day when it is followed by ":" and digits, or by am/pm (with or without a space). Otherwise it is a day as before. Nothing is loosened: a wrong date still fails.

**Tests.** The four live drafts and five other natural ways to write the same three times must pass, with the exact facts from the probe. "Oct 14 10:00 am", "14 Oct 10:00 am", "Mon 13 Oct 5:30 pm" and a right date with a wrong time must still fail. 13 tests failed before the fix.

## 3. Hindi in English letters was read as Tanglish (chat 244)

**What was wrong.** "3bhk 85L gr noida west 2 month me lena h" came back as `ta-en` and the reply was in Tanglish. Version 2 of the extraction prompt said `hi` is "Hindi" (nothing about English letters) and `ta-en` is Tamil in English letters "or Tamil and English mixed in one message".

**What was changed.** A new `prompts/extraction_v3.ts` (v2 is never edited, by the prompt rule; the pipeline now uses v3 and the trace says version 3). Only the `language` line and a short block of language examples changed: `hi` is Hindi in Devanagari **or in English letters (Hinglish)**; `ta-en` only when the words are Tamil; "decide the language from the words, not from the letters"; six examples ("rate enna sir" and "2bhk venum budget 60L" are `ta-en`; "kitna hai bhai", "2bhk chahiye budget 60L" and the message above are `hi`; "do you have a 2bhk" is `en`). Every key and every other rule is v2, word for word. New tests, and a fingerprint for v3 in `fingerprints.test.ts`.

**When the extractor and the customer disagree.** The extractor's label wins. The reply model is told "The customer writes in: <label>", which overrides its own rule 5 ("reply in the customer's language"), and the fixed lines (handover, area options) use the same label. Nothing re-checks it; the contact's stored language is used only when the label is "other" with low confidence. So one wrong label gave a fully Tanglish reply. This is why the wording fix matters.

## How to test

```
pnpm --filter @pakka/backend test:conversations        # 190 passed, 0 failed
pnpm --filter @pakka/backend exec vitest run src/agent
pnpm --filter @pakka/backend typecheck
```

Live (costs money; run on purpose): see the PR description for the command.

## Decisions

- The area fix is code only: no model, no new field, no catalog change.
- The date fix is in the checker, not in the reply prompt: asking a model to copy a comma is fragile.
- Hinglish is fixed by wording in a new prompt version, not by code that guesses the language from the letters.

## Notes for Dev 2 and Dev 3

Nothing in your area changed. The area check is used by the scoring and by the "no site there" line, both Dev 1 code. No catalog, booking, dashboard or template file was touched.

## Follow-ups

1. **The reply model adds an unrequested sentence when offering times.** In the live drafts for 203 it wrote "Budget and 3 months timeline pathi team kitta sollitu varen..." / "...team kitta check pannitu solren". Nobody asked for it, and it promises something the assistant does not do. Not fixed here. A reply-prompt rule ("when offering times, say only the times and ask which one suits") would be a new reply prompt version.
2. If a live run still shows places refused, add option B (the model suggests which listed area the customer means; the code accepts only an exact item from the list), or per-business aliases (option C).
3. Two different listed places with the same consonants (a rare case) would match each other by sound. Names with a skeleton under 3 letters are never matched this way.
4. Run chat 244 live to confirm the Hinglish wording works with the real model, and look at whether the reply is then in Hindi in English letters.
5. A native reader should check the Tamil and Devanagari letter tables in `area-match.ts` against real places.
