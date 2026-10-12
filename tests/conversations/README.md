# Scripted conversations

One YAML file per chat, in a folder per pack (`tests/conversations/<pack>/NN-name.yaml`). A chat is a business setup and a
list of customer turns; each turn can say what the **mocked** models answer and what must be true afterwards.

```
pnpm test:conversations                          # mock models: what CI runs (also part of `pnpm test`)
pnpm test:conversations -- --only handoff        # only chats whose file or name contains "handoff"
pnpm test:conversations -- --live                # the REAL models (needs ANTHROPIC_API_KEY); never in CI
```

The runner drives the real pipeline steps (`stopCheck`, `understandTurn`, `replyTurn`) on an in-memory store. The knowledge
base returns the chat's own `kb` chunks, and the sender is a fake (nothing is ever sent), in both modes.

- **Mock mode** checks the code around the models: what is kept from the extraction, the plan row, the post-check (no price that
  is not in the knowledge-base text, the safe fallback), the privacy notice, STOP, the opt-out by the model, the handovers.
  It cannot say whether the real model understands a message.
- **`--live`** checks only `expect` (not `mockOnly`) and prints what the real model understood for every turn: intent,
  confidence, the plan row and the reply. This is how Raja's phrase list is checked against the real classifier.
  It costs one or two model calls per turn: run it on purpose, with `--only`.

## A chat

```yaml
name: English price question is answered from the knowledge base only
settings: {}                 # tenants.agent_settings, e.g. { privacyNotice: true }
contact: { alreadySawNotice: true }
kb: ["2BHK of 950 sq ft in Velachery starts at ₹78 lakh."]
turns:
  - customer: "What is the price of a 2BHK in Velachery?"
    mock:                    # what the models say in mock mode
      extraction: { intent: question, fields: { location: Velachery }, question: "..." }
      reply: "A 2BHK in Velachery starts at ₹78 lakh."   # a list = one text per attempt
    expect:                  # both modes
      extracted: { intent: question }
      noInventedPrice: true
      aiReplies: 1
    mockOnly:                # mock mode only
      case: answered_from_kb
```

What can be asserted: `stop`, `extracted` (intent, language, sentiment, asksIfHuman, notInterested, fields), `case`,
`reply` (sent, fixed line and language, buttons, contains, matches, notContains, notice), `noInventedPrice`, `optedOut`, `consent` (the new
consent_logs of the turn), `handoff` (trigger and priority, or null), `mode`, `leadStage`, `leadFields`, `aiReplies`,
`confirmations`, and (with a `booking` setup, below) `leadTemperature`, `leadScore`, `hotLead` (staff were told this turn that the lead turned hot), `voiceNoteAlert` (staff were told a voice note is waiting) and `calendar`. Every turn also checks, always: at most one AI reply, sent as an `ai_reply` through notify.send, and nothing
sent to a contact who opted out.

## Booking chats (Day 3)

A chat with a `booking:` block switches on qualifying and booking, with a small calendar of its own (`backend/src/conversation-tests/calendar.ts`). Without
the block a chat runs as before.

```yaml
booking:
  now: "2026-10-10T04:30:00.000Z"      # the business's clock, fixed: "tomorrow evening" must not depend on when the test runs
  timeZone: Asia/Kolkata                # default
  services: 1                           # active services; exactly one is the only case the assistant books on its own
  catalog:                              # the price bands and areas the pack's scoring compares a customer with
    - { priceFrom: 6000000, attributes: { price_to: 8000000, area: Velachery } }
  slots: ["2026-10-11T04:30:00.000Z"]   # free times (ISO UTC); each lasts an hour
  takenWhenChosen: ["..."]              # someone else takes these first, once, when the customer picks one
  existing: "2026-10-11T09:30:00.000Z"  # a confirmed booking the customer already has
```

- `calendar: { confirmed: [starts], cancelled: n }` is what the booking engine holds after the turn. `leadTemperature` and `leadScore`
  are what the code worked out (they are `mockOnly`: they depend on what the model extracted).
- A turn can say `mock: { credits: zero }`: notify.send refuses the reply for lack of credits and spends nothing.
- The calendar copies Dev 2's booking engine only where a chat needs it (a taken time is `slot_taken`, a hold is not a booking until it is
  confirmed, a lead holds one time at a time). Confirming a booking moves the lead to booked, as Dev 2's `confirm_booking` does in the database.
  The engine itself is tested by Dev 2's own tests and `supabase/tests`; what these chats test is how the assistant uses it.

Not covered here: the gate's other outcomes (a chat a person has, the AI switched off, a contact who opted out earlier) are tested
in `gate.test.ts`; the runner starts every chat with the AI in charge. A turn can be a tap on a reply button (`tap: "exit:talk"`, with the button title as the text) or a voice note (`voice: true`: an audio message with no words). A turn must assert something (`expect` or `mockOnly`).
A STOP chat's later turns show the gate's opted-out outcome.

## The files

- `01`-`11`: the first chats: price questions (English, Tanglish), off-topic, "are you a bot?", prompt injection (05: no invented price, the chat goes to a person as a discount request, and the lead stays `engaged` with score 0 and nothing booked), STOP, no
  privacy notice by default, the notice switched on, and stray characters ("x", "?", "ok", an emoji) that must not start the exit question, and the exit question as two buttons (Talk to the team, Continue).
- `20`-`45`: Raja's phrase list (`docs/reference/opt-out-handoff-phrases.md`), one opt-out and one handover per language.
  The six languages Raja marked (Telugu, Kannada, Bengali, Marathi, Gujarati, Punjabi) have `needsNativeCheck: true`: a
  native speaker must read them before they are final test data.
- `50`-`60`: booking (Day 3): the next details asked two at a time and the lead scored (50), three real times offered in a plain
  message, picked in words and booked (51, exit tests 1 and 2), a time taken by someone else first (52), "tomorrow evening" in the
  business's own time zone (53, also run with the server in other zones by `booking-timezone.test.ts`, exit test 5), nothing free (54),
  moving a booking (55), a cancellation asked about first and then confirmed (56) or refused (57), out of credits: one holding
  message, nothing spent, a person takes over (58, exit test 4), a budget below the cheapest home (59), and a business with several
  services (60). In `--live` mode only `expect` is checked.
- `61`-`63`: handoff triggers (Day 4, Raja's answers of 11 Oct): an angry customer gets one short sorry and a person takes over (61), a customer
  who asks for a discount is never given one and staff are told at once (62), and a lead that turns hot tells staff once while the assistant keeps
  helping and books the visit (63).
- `64`: a voice note (Day 4, Raja, 11 Oct): one polite line asking the customer to type, once however many voice notes follow, staff told, the chat stays
  with the AI, and a later voice note after the customer typed is answered again.
- `65`: an area the business has no homes in (Day 5, out-of-area): the pack has an area rule worth 20 points and no area hard fail, so the customer scores 55 (warm) instead of
  75, is not turned away, and is still offered times because warm passes the offer threshold. This is what the code does today, recorded for Raja to confirm.
  `matches` is a list of regular expressions (any letter case) the reply must each match. Use it under `expect` for wording a real model varies ("10 am" and "10:00 am"), and keep the exact words under `mockOnly` as `contains`, so mock mode stays strict. Chat 51 does this.
