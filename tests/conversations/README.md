# Scripted conversations

One YAML file per chat, in a folder per pack (`tests/conversations/<pack>/NN-name.yaml`). A chat is a business setup and a
list of customer turns; each turn can say what the **mocked** models answer and what must be true afterwards.

```
pnpm test:conversations                          # mock models: what CI runs (also part of `pnpm test`)
pnpm test:conversations -- --only handoff        # only chats whose file or name contains "handoff"
pnpm test:conversations -- --live                # the REAL models (needs ANTHROPIC_API_KEY); never in CI; capped: --max-calls N (default 40, hard limit 60)
pnpm test:conversations -- --only inj-a,inj-b  # several texts, comma separated (any match)
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
  workPincodes: ["600020"]              # a field visit pack: the technician works only in these pincodes (a resource service area); omitted = everywhere
  existing: "2026-10-11T09:30:00.000Z"  # a confirmed booking the customer already has
```

- `calendar: { confirmed: [starts], cancelled: n }` is what the booking engine holds after the turn. `leadTemperature` and `leadScore`
  are what the code worked out (they are `mockOnly`: they depend on what the model extracted).
- A turn can say `kb: []` (next to `customer`, not inside `mock`): the knowledge base finds nothing on that turn, so the code sees a miss: the safe "team will confirm" line, and a person takes over after two misses in a row in the same chat (handoff `kb_gap`). It works the same in mock mode and with `--live`, because the runner's fake knowledge base reads only this. A list instead of `[]` is the text found on that turn. Without it the turn gets the chat's own `kb`. (`mock: { kb: [...] }` is the older spelling; it is read the same way. `knowledgeBaseForTurn` in `run-chat.ts` is the one place that picks.) With `--live` and `kb: []` the reply is the fixed line, so the real reply model is not asked on that turn.
- A turn can say `mock: { credits: zero }`: notify.send refuses the reply for lack of credits and spends nothing.
- A turn can inject failures (Day 7, `backend/src/lib/failure-injection.ts`, the same wrappers staging uses), e.g.
  `mock: { inject: [llm_timeout] }`. The runner's own check still applies: never more than one AI reply a turn.
  | `inject` | What happens | The pipeline today |
  |---|---|---|
  | `llm_timeout` | every model call times out (`LlmError` `timeout`) | one fixed reply, case `model_unavailable` |
  | `llm_bad_json` | the extraction answers a cut-off JSON object, every try | one clarifying reply, case `clarify_invalid_output` |
  | `whatsapp_send_error` | WhatsApp refuses the reply (`upstream_failed`, retryable) | the step throws so Inngest retries it (nothing went out); the run reports "the pipeline threw" |
  | `whatsapp_send_timeout` | WhatsApp never answers (`outcomeUnknown`) | nothing counts as sent, and nothing resends it |
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
- `65`-`70`: an area the business has no sites in (Day 7, Raja 14 Oct). The first reply always lists the areas the business does have (a fixed line, no model call, no time offered, lead open, nobody reminded); the same area named again gets "nothing there for now" and one staff reminder (`areaReminder` in `expect`); choosing a served area resumes the normal flow and ends the state (67); Tamil and Tanglish machine drafts (68, 69, `needsNativeCheck`); a booking or price asked for the unserved area (70); repeats the model returned no field for, read from the customer's own words (71, 73 Tamil, 74 Tanglish, interiors/05 a pincode), with the near-match and another-place cases that must not count (72). 65 replaces the Day 5 chat that recorded the old behaviour (three times offered for Adyar).
- `interiors/01`-`04`: the same for a pincode (the interiors pack judges it against the catalog's areas): not served, insisted (typed with a space), served, and no areas listed (nobody is turned away).
- `real-estate/200`-`259` (60 realistic chats, 20 each in Tanglish, Tamil and Hindi, all `needsNativeCheck`; 4 of the Hindi ones are in Roman letters): written like real WhatsApp messages, to tune the agent with `--live`. `260`-`262`: picking an offered time with a spoken word (`ரெண்டாவது`, `மூணாவது`, `दूसरा वाला`), and a question that contains a pick word is answered, not booked (`scheduling/slot-choice.ts`; a Hindi pick counts only when it is the whole message). `263`-`266`: a budget written with Tamil or Hindi unit words (`scoring/amount.ts`). `267`-`268` (Tamil, Hindi): a place the business does not have gets the options line, and a listed place written in the customer's own script (`பெரும்பாக்கத்துல`, `ग्रेटर नोएडा वेस्ट`) is served (`scoring/area-match.ts`; the mock extraction hands over the place as text, as the live model does).
- Wording a real model varies: `matches` is a list of regular expressions (any letter case) the reply must each match. Use it under `expect` for wording a real model varies ("10 am" and "10:00 am"), and keep the exact words under `mockOnly` as `contains`, so mock mode stays strict. Chat 51 does this.

- `real-estate/75`-`101` and `interiors/06`-`08` (Day 7, PR C): prompt injection and manipulation, one chat per case of the sweep, named `inj-<letter>`: (a) system prompt asked for in English, Tamil, Tanglish and Hindi (75-78), (b) owner/admin and discount (79-81, interiors/07), (c) fake `system:`/`assistant:` lines, fake JSON, fake tags and tool calls (82-84), (d) a knowledge-base chunk that gives orders or quotes a price (85, 86), (e) a field value that carries orders, a link or a number (87-90, interiors/08), (f) staff or the owner's friend (91, 92), (g) another customer's number or chat, and the customer's own number (93-95), (h) very long, repeated and unusual messages (96-98), (i) cancelling or moving a booking that is not theirs (99-101); 102-103 (the fix PR): a place typed with a phone number or a link is not shown back (the fixed words, also in Tanglish, and one staff reminder), while a clean place or a pincode still is. Which case rests on code and which on the model is in `docs/task-notes/2026-10-14-day7-dev1-injection-tests.md`. In mock mode the model is scripted, so these show what the CODE does around a model that gives in; the real model's behaviour is only seen with `--live`. A cap protects `--live`: every request is counted, a call that might not fit is refused, and a chat the cap stops is printed NOT RUN, never as a result.

- `real-estate/104`-`105` (Day 7, Finding 4): a reply that talks about the prompt ("The task says...", a copied rule) is refused as a `leak` and written again once (104), and when the second try leaks too the customer gets the safe line, once (105). Chat 84 now also forbids the wording the live run found.

- `real-estate/106`-`108` (Day 7, the low-confidence "other" language fix): the exact message of chat 84 read as `other` at 0.1 is never talked about (106), and a Tamil (107) or Tanglish (108) price question the extractor is unsure about is still answered in the customer's language, not English. The language the reply model is told is decided in code (`pipeline/reply-language.ts`) and checked in `reply-language-whole-turn.test.ts`; the real model is only seen with `--live`.

- `real-estate/101`, `109`-`111` (Day 7, Finding 3): a customer with no booking on record asks to cancel or move one. One staff alert goes BEFORE the reply (`bookingChangeReminder: true` in `expect`; no handover, the assistant stays on), the reply is written from the fact that no booking is on record in this chat and the team has been told, a second message of the lead sends no second note (110), a reminder that could not be sent (`mock: { bookingReminder: fails }`) is tried again by the next message and the reply then says nobody was told (111).

- `real-estate/87`, `102`, `112` (Day 7, staff-text cleaning): a link or a phone number (10 digits) typed into a detail is DROPPED at extraction, so it is never stored and the customer is simply asked again (87, 112); a place that is stored but not fit to show (a 7-digit run in it) is not repeated back, the fixed words are used (102).

## Latency (Day 6, local only)

`pnpm --filter @pakka/backend latency:chats [--live] [--max-calls N] [--rounds N]` times the steps and calls of these same chats and prints a table per stage, every number labelled mocked, live, configured or not measured. Mocked is the pipeline's own code time. `--live` runs the first turn of seven chats with the real models, at most 15 requests (hard limit 20), with a fake sender, knowledge base and store. Never in CI. The reading of the numbers is in `docs/task-notes/2026-10-13-day6-dev1-step8-audit.md`.
