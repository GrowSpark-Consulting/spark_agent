# 21 Oct (Dev 1): 60 realistic customer chats in Tanglish, Tamil and Hindi, for tuning the agent

For Dev 2 and Dev 3. **Nothing in your area changed.** This work adds 60 test files in `tests/conversations/real-estate/` (numbers 200 to 259) and this note. No code, prompt, pack, migration, existing chat, `notify` file, booking file or frontend file was changed or touched.

## 1. What was added and why

The chats we had were short and tidy. Real customers on WhatsApp write in a hurry: typos, mixed languages, voice-to-text, "sir", "anna", amounts in lakh, one line with everything in it. We want to tune the agent against that, using the real models. These 60 chats are the material.

- **200 to 219: Tanglish** (Tamil in English letters, language `ta-en`). Made-up project: Aadhira Gardens, Medavakkam.
- **220 to 239: Tamil** (Tamil script, spoken Tamil, language `ta`). Made-up project: Mullai Nagar Heights, Perumbakkam.
- **240 to 259: Hindi** (language `hi`). 16 are in Devanagari and 4 are in Roman letters (244, 249, 253, 257, with `hinglish` in the file name). Made-up project: Shanti Kunj Residency, Greater Noida West.

Each language covers the same spread: price, loan and EMI, possession and RERA, parking or vastu, school and hospital, a visit that gets booked, a budget that is too low, an area the business does not serve, a question the knowledge base cannot answer, comparing with another builder, haggling, "are you a bot?", off-topic, an angry customer, a customer who changes their mind, an NRI buying for a relative, a customer who goes quiet and comes back, a voice note, a vague message that triggers the exit question, and one customer who gives everything in one short shorthand line (203, 224, 244). Each chat has its own made-up project text (2 to 4 short chunks), fake names and no phone numbers. No real company names.

Every file has `needsNativeCheck: true`: they are machine-written and a native speaker must read them before they count as final.

## 2. How to run them

Mock mode (free, what CI runs, models are scripted):

```
pnpm --filter @pakka/backend test:conversations
```

It must say `181 passed, 0 failed` (121 old and 60 new). Only the new ones, one language at a time:

```
pnpm --filter @pakka/backend test:conversations -- --only tanglish
pnpm --filter @pakka/backend test:conversations -- --only tamil
pnpm --filter @pakka/backend test:conversations -- --only hindi
```

Live mode (real Anthropic models, costs money, never in CI):

```
pnpm --filter @pakka/backend test:conversations -- --live --only tanglish
```

Live mode is capped (40 calls by default, 60 at most, `--max-calls N`). The 60 chats need roughly 150 calls, more than one run allows, so run a few chats at a time with a word from the file name, for example `--only tanglish-loan,tanglish-price,tanglish-vastu` (comma separated, any match). Live mode checks only the `expect` block and prints what the model understood for every turn.

## 3. Decisions

- **`expect` holds only what a good model should always do:** the language and intent where the message is clear, `noInventedPrice`, `aiReplies: 1`, the handover and its priority, `reply.sent`, the lead stage, and `reply.matches` (regular expressions) for wording that varies. No exact sentence is under `expect`.
- **Exact sentences, the lead score and temperature, and the reply case go under `mockOnly`.** Every chat has a mock extraction and reply in the customer's own language and script, so it passes in mock mode.
- **Script checks.** Tamil replies must contain Tamil letters (`[஀-௿]{3}`), Hindi replies Devanagari letters (`[ऀ-ॿ]{3}`). Tanglish and Hinglish replies are checked with a short list of common words, since there is no script to test.
- **"Not in the knowledge base".** In mock mode these chats give the turn an empty knowledge base. In live mode the runner always returns the chat's own text, so the real model sees facts that do not answer the question; the check is that it says the team will confirm and invents no figure. For the same reason the handover after two misses in a row (`kb_gap`, chats 210 and 250) is checked in mock mode only.
- **Shorthand chats (203, 224, 244).** The agent only ever asks for the pack's required details (budget, area, timeline); it never asks for the optional ones. So when the customer gives all four in one line (203, 244), nothing is asked again and real visit times are offered. In 224 the customer leaves out the timeline, so the only thing asked is the timeline, and once answered, times are offered.
- **Booking chats** use the same fixed clock as chats 50 to 63 (Saturday 10 Oct, three free times), so the offered times are the same everywhere.
- **Price in the offer message.** When times are offered, the reply may only state the times. A price in that same message is refused by the post-check. The mock replies in these chats keep the price in a separate answer.
- **Fixed lines are not English-only, but they are in the script of the language code.** See section 5, finding 2.

## 4. Notes for Dev 2 and Dev 3

- **Dev 2:** the booking engine and calendar are used exactly as chats 51 to 60 use them. Chats 207, 227, 247 book a visit; 203, 218, 224, 236, 244, 256 and the changed-mind chats offer times. Nothing in `backend/src/booking`, `supabase` or `scheduling` was changed. Finding 1 below is in a file next to your engine (`scheduling/slot-choice.ts`); I did not touch it.
- **Dev 3:** these chats do not touch the WhatsApp adapter, the webhook, templates or the dashboard. The fixed lines they check (exit buttons, voice note, handover, area lines) are the existing ones in `pipeline/fixed-texts.ts`.

## 5. What the chats showed while writing them (not fixed, for the owners)

1. **Spoken Tamil "second one" is not read.** `scheduling/slot-choice.ts` reads "இரண்டாவது" and "rendavadhu" but not "ரெண்டாவது" (the way people say and type it), so it asks again instead of booking. Chat 227 uses "இரண்டாவது" so that it passes. Spoken Hindi ordinals ("दूसरा वाला") are also not listed; chat 247 uses "3 pm वाला", which is read.
2. **Hinglish gets Devanagari fixed lines.** The extractor returns `hi` for Roman-letter Hindi, and the fixed lines for `hi` are in Devanagari. So in chat 249 a customer who writes "gurgaon me 2bhk chahiye" gets the area line in Devanagari. The chat checks the behaviour (areas listed, no time offered) but not the script.
3. **The slot-choice reader and the post-check are strict and good:** a price in an offer-times message is refused. This is the intended behaviour.

## 6. Follow-ups

- **Native-speaker check.** A native Tamil reader and a native Hindi reader should read all 60. Tanglish spelling varies a lot; the chats use one reasonable spelling each.
- **Which to tune first in live mode.** (1) The ones that depend on the model refusing to invent: the "not in the knowledge base" chats (200 turn 2, 202 turn 2, 204, 205 turn 2, 210, 221 turn 2, 222 turn 2, 230, 240 turn 2, 250). (2) The language ones: replies in Tamil script, Tanglish and Hinglish (220, 223, 226, 231, 253, 257). (3) Haggling and anger (212, 215, 232, 235, 252, 255), where the handover and priority must be right. (4) The vague-message chats (206, 238, 239, 259): they depend on how the real model reads a single ambiguous word, so they are the most likely to differ run to run.
- **Run a few times.** A live chat that fails once is a signal, not a verdict. Run it again before changing a prompt.
