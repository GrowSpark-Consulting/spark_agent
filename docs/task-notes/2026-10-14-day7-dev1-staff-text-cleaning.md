# 14 Oct (Dev 1): the customer's name, the details they typed and the words a model wrote are cleaned before staff see them (Day 7, staff-text cleaning)

Dev 1 files only (`backend/src/agent/`, `backend/src/channels/whatsapp/inbound.ts`, tests, chats, docs). No migration. Nothing of Dev 2's or Dev 3's is changed. No prompt file changed.

## 1. What was found

- The customer's WhatsApp profile name is stored once (`store_inbound_message` keeps the first it sees) and then read raw by the staff alerts (`notify/staff-alerts.ts` `customerLabel`, Dev 2's), `dashboard/summary.ts` (Dev 2's), the inbox (Dev 3's), the lead card and the greeting staff send from their own number (`handoff/takeover.ts` + `texts.ts`): a name such as `http://evil.example` or `Priya 9876543210` went into staff WhatsApp text and into a message staff send in their own voice.
- A detail the customer typed (an area, a budget) was stored as typed (up to 200 characters) and shown on the lead card; the card's `summary`, `discount` and next step (model-written from the chat, or code-written from those details) are added to the hot-lead and handoff staff alerts (`notify/staff-alerts.ts` `cardLines`), so a typed link or number could ride in through them.
- The customer's own phone number on the card (`contact.phone`) is deliberate: staff call it. It is not changed.

## 2. The cleaners (`agent/scoring/area-text.ts`)

- The strict place cleaner `cleanAreaText` (no link, no `@`, no run of 7 digits, plain characters only, 40 characters) is unchanged and still used for the place a customer is told and for the staff reminder's area. New `refusesAreaText` is the same test without the cut, for a place kept whole on the card.
- New `cleanDisplayText(text, max, phoneDigits)` and `refusesDisplayText(text, phoneDigits)`: the same refusals (a link, an `@`, a run of `phoneDigits` digits of any script with at most two other marks between them, invisible characters removed first) with NO character whitelist, so an emoji name (`Priya 💖`), `Raj_K`, a rupee sign, a percent sign or a tag is kept. Names use 7 digits; values and model words use 10, so `₹1,20,00,000` is not mistaken for a phone number.

## 3. Where it is applied

| Where | What | When it is refused |
|---|---|---|
| `channels/whatsapp/inbound.ts` (the door) | the profile name, `cleanName`: 60 characters | no name is stored (the screens show the masked number, as for a contact with no name) |
| `agent/pipeline/extraction.ts` (the door) | every text detail the model returns | the value is dropped and counted with the other refused values (`invalidValues`); the other details of the answer are kept |
| `agent/handoff/texts.ts` `ownNumberGreeting` | the name in the wa.me greeting | the plain greeting without a name goes; only the first word of a clean name is used |
| `agent/leadcard/card.ts` `assembleCard` | the card's `contact.name` | `null` (the screens show the masked number) |
| `card.ts` `answerLines` and `codeSummary` | each answer: a place (label area, location, place, pincode, pin, locality) is held to the strict test; any other text to the 10-digit test | the line reads "{label}: not shown", and the code-written need and summary leave it out |
| `card.ts` `assembleCard` | the model's need, summary, next step and discount | the code-written words replace all three, the discount is dropped and the card says it is not model-written (`aiWritten: false`) |
| `card.ts` `assembleCard` | the suggested reply (staff would send it as it is) | dropped; the model's other words are kept |
| `agent/handoff/area-reminder.ts` and `booking-change-reminder.ts` | the name in the staff headline (and `customerLabel`) | "A customer", or the masked number from `customerLabel` |

## 4. What staff see

A rejected name: the masked number (for example `+9198xxxxxx21`) in my alerts and on the card, "A customer" when there is no number to fall back on, the plain greeting in the wa.me message. A rejected detail never reaches the card at all for a new message (it is dropped when read); for one stored earlier the card line says "{label}: not shown". A rejected model summary: the code-written summary from the lead's details (what the card shows when the model is unavailable).

## 5. Limits

- Names and details stored BEFORE this change stay as they are in the database. My own read paths clean them (the card, the greeting, my reminders). Dev 2's alert headline and `dashboard/summary.ts`, and Dev 3's screens, read `contacts.name` and `leads.fields` directly: they need the same call (a message for Dev 2 is in the PR description).
- Only links, `@` and phone numbers are refused. A detail with an order written into it but no link or number (chat 89's budget) is shown as typed.
- At extraction a text detail is refused at a run of 10 digits (a phone number), not 7 (the field types are not known there); the area echo and the staff reminder use the strict 7-digit test, so a stored place with 7 to 9 digits is shown as "the area you mentioned" and "an area outside your list".
- A card word with a run of 10 digits or more (a very large amount written out) is replaced by the code-written words.
- A name with an emoji is kept everywhere; a name of only emoji is kept.

- **Dates, times and amounts are not phone numbers** where a 10-digit run is looked for (the extraction, the card's values and the words of a model): a date (`14/10/2026`, `2026-10-14`), a time (`10:30`) and a grouped amount (`1,20,00,000`, `120,00,00,000`) are taken out before the digit run is counted, so they are kept; a phone number next to a date is still caught. A name (7 digits) has no such exemption.
- **A size is not a place**: the card holds a detail to the strict place test only when its label names a place (location, locality, pincode, pin code, place, area), and "Area in sq ft" (a size label: sq, sqft, square, size, ft, feet, metres) is not one, so `1200-1500` is shown.
- A model's words are checked line by line, so digits at the end of one line and the start of the next are not one number.
- Every cleaner reads at most 5,000 characters of its input (the link test is quadratic on a very long run of separators; 20,000 characters took up to 0.7 s before, and now take milliseconds).
- A name or value with a dot and a top-level domain right after a word with no space ("Ravi.in", "Amit.Co", "Dr.Ravi.me") reads as a link and is not shown; "Mr. S. Kumar", "K.S.Ravi" and "Sri.Mary" pass. Separators of three or more characters between phone digits, and digits spelled out as words, are not caught (a documented limit of the approach).
- `backend/.vitest/` (a test cache directory) is untracked and not in `.gitignore`; it is not part of this change.

## 6. Tests (written first; 89 failed before the code)

`scoring/display-text.test.ts` (47), `handoff/greeting-name.test.ts` (14), `leadcard/card-clean.test.ts` (56), `channels/whatsapp/inbound-name.test.ts` (17), `pipeline/extraction-clean.test.ts` (25), plus changes to `booking-change-reminder.test.ts` and `area-reminder-injection.test.ts` (an emoji name is kept). Chats: 87 now shows the dropped value (nothing stored, the customer is asked again), 102 keeps the fixed-words echo with a 7-digit run (stored, not fit to show), 112 is a phone number typed in an area (dropped, the other details kept). The rest of the conversation suite is unchanged.
