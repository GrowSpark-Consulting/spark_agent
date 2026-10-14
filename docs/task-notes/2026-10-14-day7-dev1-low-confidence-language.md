# 14 Oct (Dev 1): a low-confidence "other" language reading is decided in code (Day 7, the root cause of Finding 4)

Dev 1 files only (`backend/src/agent/pipeline/`, tests, chats, docs). No prompt file changed, so no prompt version bump. No migration. Nothing of Dev 2's or Dev 3's touched.

## 1. The defect

Live run, chat 84: a message made of fake tags was read by the extraction as language `other` at confidence 0.1. The reply prompt's task line for `other` is "The customer writes in: a language other than English: reply in that language." and the model wrote about that line ("The task says the customer writes in a language other than English, but the message has no real language content, so I'll go with English."). The Finding 4 PR now refuses such a reply; this PR removes the cause.

## 2. The rule (`agent/pipeline/reply-language.ts`, `languageForReply`)

Only when the reading is `other` AND the confidence is below 0.5 (`LOW_CONFIDENCE`), in this order:
1. Tamil, Devanagari or Malayalam letters in the customer's words (the script with the most letters wins) give `ta`, `hi` or `ml`.
2. Otherwise the contact's stored language (`contacts.language`), when it is `en`, `ta`, `ta-en`, `ml` or `hi`.
3. Otherwise `null`: the task line names no language, and reply rule 5 ("Reply in the customer's language and script") applies from the message itself. It is never forced to English, so Tanglish in Latin letters is still answered in Tanglish.

A high-confidence `other` (a real other language, such as Telugu) and every other reading (`en`, `ta`, `ta-en`, `ml`, `hi`, at any confidence) are passed on unchanged.

## 3. Where it is used

- `plan.ts` computes `modelLanguage` once per decision and uses it on every model-written row (the negotiation row, the booking rows through `plan-booking.ts`, and the generic `model(...)` helper). `plan-booking.ts` receives it as `args.modelLanguage`.
- `PlanInput.customerWords` is new (set in `reply.ts` `loadPlanInput` from the turn's message bodies; optional, so a caller without it falls back to the stored language, else null).
- The script rule is for the reply MODEL only. A fixed line (clarify, handover, the safe fallback, the area lines) gets no script detection of its own: for a Tamil message read as `other` at low confidence it is written in the contact's stored language, else English, as before (the fallback and the privacy notice use `textLanguage(plan.reply.language, ...)`, so for them a detected `ta`/`hi` now does reach them, but `ml` and null do not).
- Script digits are not letters: a lone Devanagari, Tamil or Malayalam digit does not decide a language.
- Fixed lines are unchanged: their language still comes from `textLanguage` (the reading, else the contact's language, else English), which already ignores `other`. The fallback line and the privacy notice use `textLanguage` on `plan.reply.language`, which now may be `ta`/`hi`/`ml`/null instead of `other`; `textLanguage` treats `ml` and `null` as before (not usable, so the contact's language, else English).

## 4. What it costs and what it does not fix

- No model call, no credit change, no prompt text change. One regular expression pass per script over the turn's words.
- A Latin-letter message (Tanglish, or any language typed in Latin letters) read as `other` at low confidence from a contact with no stored language gets NO language line, not English: the model follows rule 5 from the message. If the model then answers in English it is the model's choice, not the code's.
- A contact whose stored language is wrong (for example `en` but who writes in Telugu in Telugu script at low confidence) is answered by the stored language; Telugu script is not one of the three scripts the rule reads. At high confidence the real `other` line is used.
- The extraction itself is not changed: `contacts.language` is still set by whatever already sets it.

## 5. Tests (written first; the helper's file failed with a missing module and 12 plan tests failed before the code)

- `reply-language.test.ts` (24): every reading unchanged at any confidence, `other` at 0.5 and above unchanged, Tamil, Hindi and Malayalam script at low confidence whatever the stored language, the script with most letters in a mixed message, letters among tags, digits and emoji, the stored language (all five) when there is no such script, Tanglish stored, an unusable stored language, null with no script and no stored language, an empty or missing message.
- `plan-language.test.ts` (14): every model-written row carries it (off_topic, a question answered from the knowledge base, details to ask for, a discount request, a cancel question, a booking made), high-confidence `other` unchanged, other readings passed on, fixed lines unchanged.
- `reply-language-whole-turn.test.ts` (9): through the real webhook and the emulator, the reply prompt's language line for the exact message of chat 84 (no "The customer writes in", no "other than English"), real Tamil, Hindi and Malayalam read as `other` at 0.3 (told as Tamil, Hindi, Malayalam), Tanglish at 0.3 (no language line, never English), Telugu at 0.9 (still the `other` line), and `ta-en`, `hi`, `en` at low confidence passed on.
- Chats 106 (the exact chat 84 message), 107 (a Tamil price question read as `other` at 0.3, reply in Tamil script) and 108 (a Tanglish price question read as `other` at 0.3, reply in Tanglish). The existing Tamil, Tanglish and Hindi chats (02, 22 to 25, 30, 31, 68, 69, 73, 74 and the injection chats 76 to 78 and 95) pass in mock mode.
- Live (not run by the PR): `pnpm test:conversations -- --live --max-calls 10 --only "02-price,107-,108-"` shows the real model answering a Tanglish and a Tamil question in the customer's language.
