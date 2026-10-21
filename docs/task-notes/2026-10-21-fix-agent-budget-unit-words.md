# 21 Oct (Dev 1): budgets written with Tamil or Hindi unit words were read as a few rupees

For Dev 2 and Dev 3. **Nothing in your area changed.** The only code file touched is `backend/src/agent/scoring/amount.ts` (Dev 1's scoring code) and its unit tests. No booking, notify, billing, frontend, prompt, pack, migration or post-check file changed. The extraction prompt is untouched: keeping the customer's own words is deliberate.

## 1. What was wrong, and what was built

**The bug (found by a live run of chats 227, 260, 261, 262).** The extraction step keeps the customer's own words, so a budget reaches the scoring code as text such as "65 லட்சம்" or "70 लाख". The reader, `parseAmountInr`, knew only Latin units (k, l, lac, lakh, cr, crore). It found the number 65 and no unit it knew, and read it as **65 rupees**. Scoring then saw a budget below the cheapest home, marked the lead disqualified, and the agent closed the chat with "nothing fits" on the first message. The scripted chats never showed it, because their mock extraction hands over a ready number like "65L".

**The fix, all in `amount.ts`:**

| What | Now read |
|---|---|
| Tamil | லட்சம், லட்சத்து…, இலட்சம் (with endings: லட்சத்துக்கு, லட்சத்துக்குள்ள, லட்சம்வரை), கோடி, கோடிக்கு, ஆயிரம் |
| Tanglish | latcham, latsam, laksham, latchum (and endings like latchathukku), kodi, aayiram |
| Hindi | लाख, लाखों, करोड़, करोड (with or without the dot), हज़ार, हजार |
| Roman Hindi | lakh, lakhs, crore, hazaar, hazar |
| Digits | Devanagari ०-९ and Tamil ௦-௯ are turned into 0-9 first; the text is normalised so the dotted Hindi letters match however they were typed |
| Ranges | "50-60 லட்சம்", "50 முதல் 60 லட்சம்", "50 से 60 लाख", "५० से ६० लाख", "50 se 60 lakh", "50 to 60 lakh": both numbers share the unit, as before |

Tamil and Hindi add endings to a word, so those units are read from their stem; the stem must be followed by the letters that really make the word (so லட்சணம், a different word, is not a lakh). The old rule that a letter right after a Latin unit cancels it stays.

**The safety net (the most important part).** A number with **no unit** that is **below 1 lakh** ("65", "70", "5000", the 3 of "3 months") is now unreadable (`null`), never rupees. This also applies to a plain number from the extractor (`65`). `null` is the file's rule for anything it cannot read: scoring gives no points and never fails a lead on it. Still read as rupees: "6500000", "70000000", "65,00,000", "₹80,00,000", "250000", and any plain number of one lakh or more. A number with a unit is never touched by the net ("75k", "50 ஆயிரம்" are 75,000 and 50,000). A range keeps its shared unit ("50-60L", "50 முதல் 60 லட்சம்", "50 से 60 लाख", "५० से ६० लाख" all read); a range with no unit anywhere ("50-60") is `null`.

**The grey case.** "80000" (a bare 80,000) used to be read as 80,000 rupees. It is now `null`. No home costs 80,000 rupees, so it is almost surely "80 thousand" without a unit, a monthly figure or a typo; reading it as exact rupees would close the chat, exactly the bug above. The cost: a customer who really means 80,000 rupees gets no points and no rejection, and the agent carries on.

## 2. How to test

```
pnpm --filter @pakka/backend exec vitest run src/agent/scoring          # the reader and scoring tests
pnpm --filter @pakka/backend test:conversations                          # 188 passed, 0 failed
pnpm --filter @pakka/backend typecheck
```

The unit tests were written first and shown failing (55 failed), then the fix. Four new chats use a budget written in the unit words, handed over **as text in the customer's own words** (not a ready number), so they really use the reader: **263** (Tamil, "65 லட்சம்", offered times then booked), **264** (Tamil, "1 கோடி" for a 3BHK, times offered), **265** (Hindi, "70 लाख", offered then booked), **266** (Hindi, "५० से ६० लाख" in Devanagari digits, times offered). Run against the old `amount.ts`, all four fail (263, 264 and 265 are disqualified on the first message, as seen live; 266 comes out warm instead of hot because the digits were not read). Chats 227, 260, 261 and 262 were not touched.

Live (costs money; run on purpose): see the PR description for the command.

## 3. Decisions

- The net applies to bare numbers only. A number with a unit is believed.
- "80000" is `null`, not rupees (above).
- The unit is read from the word's stem, so Tamil and Hindi endings work without a list of every ending.
- The extraction prompt and the pack's hard-fail rule are not touched: the rule is right, the number was wrong.

## 4. Notes for Dev 2 and Dev 3

Nothing in your area changed. The booking engine, notify, billing, the post-check and the frontend are untouched. `parseAmountInr` is used only by `scoring/score.ts` (the "budget within the price band" rule and the "budget below the cheapest home" hard fail), which is Dev 1's code.

## 5. Follow-ups

1. **KNOWN LIMIT, reported not fixed: a second number in the same text is taken as the other end of a range and borrows the unit.** Today, and before this fix with Latin units: "70 lakh, 2 months" reads as 2 lakh to 70 lakh. With the new unit words the same happens: "65 லட்சம், 2 மாசத்துல" and "70 लाख, 2 महीने में" read as 2 lakh to 65 or 70 lakh (before this fix they read as 2 to 65 or 70 rupees). The top of the range is still right, and the hard fail looks only at the top, so nobody is wrongly disqualified. The bottom is too low, so the price-band check is a little more permissive. This only happens when the budget field holds more than the budget, which the extraction normally avoids. Pinned by a test labelled KNOWN LIMIT in `amount.test.ts`.
2. A number written as a word ("ஒரு கோடி", "एक करोड़", "one crore") has no digits and stays `null`.
3. A compound amount ("1 கோடி 20 லட்சம்", "1 crore 20 lakh") is read as a range, 20 lakh to 1 crore, as with Latin units before.
4. A native reader should check the Tamil and Hindi unit lists and the examples.
