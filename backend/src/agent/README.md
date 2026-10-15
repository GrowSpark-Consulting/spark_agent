# The agent area

What answers a customer on WhatsApp: how one message becomes one reply, the rules it must keep, where each part lives, how to run and extend it, and what it cannot do yet. Everything here was checked against the code at the commit this file was merged with; a statement that could not be checked is marked **unverified**. The walkthrough for showing it to someone is [docs/demo-script.md](../../../docs/demo-script.md). The product specs are [docs/handover.md](../../../docs/handover.md) and [docs/contracts.md](../../../docs/contracts.md).

**Status of the outside world.** Every test in this repo uses a fake WhatsApp (Meta) and, unless `--live` is passed, scripted models. What happens against the real Meta Cloud API on staging is **unverified here** (the demo script is how it gets verified). Latency on staging is **unverified** (section 7).

## 1. How one message becomes one reply

**The principle.** Code decides. A model does exactly two jobs: it reads the customer's message into a small JSON object (extraction), and it writes the words of the reply from facts the code hands it. Prices, times, who is a good lead, whether to book, when a person takes over: all code. No business logic is in a prompt.

**The path** (one Inngest function, `backend/src/inngest/process-message.ts`; every stage is a `step.run`, so a failure retries that stage only):

| Stage (step id) | What happens | Model? |
|---|---|---|
| Webhook (`channels/whatsapp/`) | Verify Meta's signature, find the business from the number, store the message once (deduped on Meta's message id), emit `whatsapp/message.received`. Never waits on a model or on Meta. | no |
| Run starts | **Debounce 3 s** (at most 15 s after the first message of a burst), **one run per conversation at a time**, 3 retries per step. The run answers the customer's whole unanswered burst, not just the message that started it. | no |
| `started`, `resolve`, `batch`, `lead`, `gate` | Who wrote, their open lead, the unanswered messages (`pipeline/process-message.ts`). The **gate** (`gate.ts`) decides: a chat a person has, the assistant switched off, an opted-out contact, or a limit reached means no AI reply. A photo or voice note is left for staff. | no |
| `stop-check` | STOP is decided by code (`stop.ts`, `consent/stop-words.ts`) before anything is read: opt out, one confirmation, staff told. It also runs when a chat is gated off. | no |
| `mark-read` | Blue ticks, best effort, skipped when the turn is late. | no |
| `extract` | The customer's words become `{language, intent, fields, question, sentiment, confidence, ...}`, validated with Zod (`pipeline/extraction.ts`, prompt `prompts/extraction_v2.ts`). A reading that does not validate twice becomes a clarifying question, never a guess. | **yes**: Haiku role |
| `save-fields`, `qualify` | Valid fields are merged into the lead (`leads.fields`, checked against a schema generated from the pack). Code scores the lead against the pack's rules and the business's own catalog (`scoring/`). | no |
| `retrieve` | Knowledge-base search for the question (`kb/`). | no (embeddings) |
| `plan` | `pipeline/plan.ts` and `plan-booking.ts` pick the case: answer from the KB, ask the next missing detail, offer times, book, cancel, hand over, fixed line. It is a pure function: the table at the top of each file lists every row. | no |
| `act` | Look at the calendar or book, through the booking engine (`scheduling/act.ts`, Dev 2's `booking/bookings.ts`). | no |
| `reply` | The reply model writes the words from the plan's facts (`reply_v2.ts`). The **post-check** (`postcheck.ts`) refuses a reply that names a price the KB does not hold, a time that was not offered, talks about its own prompt or copies the fixed rules, or asks too many questions. It regenerates once, then sends the fixed safe line. Then **notify.send** sends it. | **yes**: Sonnet role |
| `handoff`, tail | Opens a handover when the plan says so, records the reply, writes the answered rows. | no |

The exact models are in `llm/models.ts` (extraction `claude-haiku-4-5-20251001`, reply and summary `claude-sonnet-5-5`). The step list above is the one `docs/task-notes/2026-10-13-day6-dev1-step8-audit.md` reads from the code; the diagram `docs/handover.md` mentions is not in the repo.

**One message, one reply, even when things fail.**

- A reply goes out under the key `reply:<last message id>`. `notify.send` claims that key in `notify_attempts` **before** asking WhatsApp (migration 0045), so a retry, a replayed event or a crash cannot send it twice. A repeat that finds the claim and no record gets "unknown outcome" and never resends.
- The reply step writes a marker (`meta.agent.reply`) after a send and marks every message of the burst answered.
- **A retry does not ask the reply model again.** The model's reply is kept on the turn's last message (`meta.agent.draft`: the plan case and the text) before it is sent. If the send fails in a way waiting can fix and the step runs again, the retry sends that text under the same key instead of writing a new one (it is used only if it was written for the same plan case and still passes the post-check against the facts). Only a real model answer is kept, not fixed words or the safe line after a model failure; the draft is cleared when the send ends for good. A regenerate after a refused reply is still one more call in the first attempt, counted once. Credits are untouched: `notify.send` spends and refunds them by reference. `pipeline/reply-draft.test.ts`.
- If a run gives up after its retries, the **failure handler** (`reply.ts` `answerAfterFailure`) sends one safe line ("Let me confirm that with the team") **unless** it can see the reply already went out: the marker, the row `notify.send` recorded, or a still-`sending` claim in `notify_attempts` (`pipeline/reply-record.ts`). A reading that cannot be checked fails open: the safe line goes (silence is worse).
- A model timeout gives one fixed reply (`model_unavailable`); bad JSON twice gives one clarifying line; a refused or unknown send is never retried by us.
- The price of at-most-once: a process that dies after claiming and before WhatsApp got the message leaves that customer with no reply.
- Proved on the whole turn through the real webhook handler and an Inngest-like emulator: `pipeline/whole-turn*.test.ts`.

## 2. The rules, and what enforces each

| Rule | Enforced by |
|---|---|
| Every table has `tenant_id` and RLS; every server query filters by `tenant_id` | `supabase/tests/isolation.test.sql`; every store call in `pipeline/store.ts` takes the tenant |
| Code decides; the model only extracts (step 4) and writes text (step 7) | The shape of `plan.ts`; Zod on the extraction; the post-check on the reply |
| All outbound messages go through `notify.send`; all credit changes through `spend_credits()` | `notify/send.ts`; `step8-audit.test.ts` |
| Validate every external input and every model output with Zod | `extraction.ts`, `leadcard/`, `lib/` schemas; injection tests |
| Webhooks and Inngest steps are idempotent | `inngest/replay-coverage.test.ts` (Dev 2), `whole-turn-*.test.ts` |
| Check `isEnabled(tenantId, featureKey)` before optional behaviour | `features/is-enabled.ts`; the gate and the booking step |
| No industry names in code; branch on pack capabilities | `packs/interiors-salon-loading.test.ts` scans `backend/src/agent`; packs are data in `packs/*.json` |
| Tokens and app secrets only in `whatsapp_connections`, encrypted; never logged or returned | `lib/crypto.ts`; `log-sweep/*.test.ts` |
| Mask phone numbers in logs; no customer text in logs | `channels/whatsapp/phone.ts` `maskPhone`; `log-sweep/` (a sweep over every log call of a whole turn) |
| A prompt-injection attempt gets no rule text, no discount, no booking for someone else | `pipeline/injection-*.test.ts`, `prompts/injection-prompts.test.ts`, the `inj-` chats (`real-estate/75` to `106`, `interiors/06` to `08`, `salon/10`) |
| AI limits: 20 AI replies per hour per customer, 300 per hour per business, a daily spend cap per business; the owner is told | `lib/ai-limits.ts`, `pipeline/whole-turn-limit*.test.ts` |
| Migrations are append-only | `supabase/migrations/` (never edited, only added) |

Free-text from a customer that staff or another customer would see (a name, a typed area, the words a model wrote) is cleaned first (`scoring/area-text.ts`, `leadcard/card.ts`).

## 3. Where each part lives

All under `backend/src/agent/` unless a path says otherwise.

| Folder | What is in it | Start reading at |
|---|---|---|
| `pipeline/` | The stages: gate, stop, extraction, plan, booking plan, reply, post-check, failure handler, fixed texts (English, Tamil, Tanglish, Hindi), limits | `process-message.ts`, `plan.ts`, `reply.ts` |
| `scheduling/` | Offer times, read a pick ("the second one"), book, move, cancel (asks first) | `act.ts` |
| `scoring/` | Score and temperature from the pack's rules and the catalog; the area check (where the business has sites) | `score.ts`, `qualify.ts`, `coverage.ts` |
| `packs/` | The pack loader, overrides, the lead-field schema, the startup sync | `load.ts`, `sync.ts` |
| `handoff/` | Taking over a chat, the "we are handling it" notice, the staff reminders | `takeover.ts` |
| `leadcard/` | The summary card staff see and the suggested reply | `build.ts` |
| `llm/` | The model client, per-role models, tracing, masking | `anthropic.ts`, `models.ts` |
| `prompts/` | The extraction and reply prompts (versions v1 and v2; v2 is used), exit phrases | `extraction_v2.ts`, `reply_v2.ts` |

Also touched by the agent (other owners): `backend/src/channels/whatsapp/` (adapter, webhook, `demo/` routing for the shared demo number), `backend/src/notify/` (`notify.send`), `backend/src/booking/` (booking engine), `backend/src/billing/`, `backend/src/lib/ai-limits.ts`, `packs/*.json`, `tests/conversations/`, `supabase/migrations/`. The scripted-chat runner is `backend/src/conversation-tests/`.

## 4. Running and checking it

All commands run from the repo root.

| To | Run |
|---|---|
| All tests (backend and frontend) | `pnpm test` |
| Types and lint | `pnpm typecheck`, `pnpm lint` |
| The agent's own tests only | `pnpm --filter @pakka/backend test` (add a path to run one file) |
| The scripted chats, models mocked (what CI runs) | `pnpm test:conversations` |
| Only some chats (file or chat name contains the text; comma separated) | `pnpm test:conversations -- --only handoff,inj-a` |
| The same chats with the **real models** | `pnpm test:conversations -- --live` |
| A pasted file of real chats (for the Tamil and Tanglish tuning) through the real pipeline steps: what the models read and what the pipeline did, per message. Without `--live` it only checks the file; default 20 calls | `pnpm triage:chats <file> [--live] [--kb <file>]` (format: `tests/triage/README.md`) |
| Step timing | `pnpm --filter @pakka/backend latency:chats` (mocked) or `... -- --live` |
| Database tests | `pnpm db:start`, then `pnpm db:test` |
| Check packs without a database | `pnpm packs:sync -- --check` |

**Mock mode** runs the real pipeline steps with scripted models and an in-memory store and calendar. It proves the code around the models (what is kept, the plan, the post-check, STOP, the handovers, the booking). It cannot tell whether the real model understands a message.

**The live check** (`--live`) asks the real models. It needs `ANTHROPIC_API_KEY` in the environment (`backend/.env.local` through tsx; this file is never committed). It is capped: **40 model calls by default, hard limit 60** (`--max-calls N`); a chat the cap stops is reported "NOT RUN", never as a result. It checks only the `expect` block of each turn (not `mockOnly`) and prints, per turn, the intent, the confidence, the plan row and the reply. It costs one or two calls a turn: run it on purpose, with `--only`. It is never run in CI. `latency:chats -- --live` is capped at 15 requests (hard limit 20).

**Writing a chat.** One YAML per chat in `tests/conversations/<pack key>/NN-name.yaml`. The format, every assertion and the booking, failure-injection and calendar options are in [tests/conversations/README.md](../../../tests/conversations/README.md). Change agent behaviour, change or add a chat in the same PR.

## 5. Packs, and how to add one

A **pack** is one JSON file in `packs/` (version 1 today: `real-estate`, `interiors`, `salon`). It holds everything industry-specific: the fields to collect and their labels and order, the scoring rules and thresholds, the hard fails, the booking mode (`bookingModes`: `slot`, `site_visit`, `field_visit`, ...), reminder and feedback offsets relative to an event, handoff triggers, the template set, the starting knowledge-base topics and extra guardrails. The format is `PackDefinition` in `packages/types/src/pack.ts`.

**How it loads.** `pnpm packs:sync` (and the API at startup, before it listens, `server/main.ts`) validates every `packs/*.json` and stores each `(key, version)` in `vertical_packs`, never overwriting. A business is pinned to a version through `tenants.vertical` and `vertical_version`; the agent loads the pack by that key and version (`packs/load.ts`) and merges the business's own overrides. A broken pack is a deployment error; broken overrides only produce warnings.

**To add a pack** (no code branch on a name; if one seems needed, the pack format is missing a capability, so add the capability):

1. Write `packs/<key>.json` (copy the closest existing pack). `pnpm packs:sync -- --check` must pass with no warnings.
2. Add `backend/src/agent/packs/<key>.test.ts` (copy `salon.test.ts`: the file is data, so the test checks the file) and add the key to the expectations in `launch-packs.test.ts` and `interiors-salon-loading.test.ts`.
3. Add `tests/conversations/<key>/` with chats: a price question, details and booking, cancel, a complaint, STOP, an injection (ten is the bar the Day 7 list set).
4. If the pack needs a business to try it on, add a demo business and a `DEMO-<KEY>` route code to `supabase/seed/demo_tenants.sql`, and its services, resources and catalog to `supabase/seed/booking_setup.sql` (the seed is the shared files; ask their owner).
5. `pnpm packs:sync`, then run the chats. Add a note in `docs/task-notes/` with what the pack cannot do yet.

**What a scoring rule can say today.** `score.ts` reads a matcher by shape: `within_<x>_band` (the business's `<x>` price bands from its catalog) and `in_<x>_area(s)` (its `<x>` areas), plus `equals`, `in` and `gte`. A hard fail is `below: <number or reference name>` or a matcher. Any other matcher name is judged by nothing (see the limits).

## 6. Known limits

Pinned by tests or chats, each labelled KNOWN LIMIT there; nothing here is hidden.

1. **Salon scoring.** The salon pack uses matchers `score.ts` does not know (`in_service_catalog`, `is_available_stylist`, `within_working_hours`, `starts_within_days`, and the hard fail `none_in_service_catalog`). They earn nothing, so a salon lead scores 10 at best and **stays cold**, the hard fail **never fires**, and a salon customer is offered times only when they ask to book. Pinned: `tests/conversations/salon/04`, `09`, `packs/interiors-salon-loading.test.ts`.
2. **`starts_within_days` is not judged in any pack** (interiors loses 25 of 100 points, salon 30). Interiors tops out at 75, still hot.
3. **Interiors visit and no pincode.** The pincode is an optional detail. A field visit with no pincode is offered with any technician; with one, only technicians who work there (`findSlots` filters). A pincode nobody works in gets no time and a person takes over (`interiors/11`).
4. **Limit alerts.** The per-customer alert is sent once per customer per hour, so a bot spread over many chats can alert the owner many times; the owner hears of the daily cap only when the next message is stopped; the cap check in the model client is cached for a minute (`docs/task-notes/2026-10-14-day7-dev1-limit-alert-tests.md`).
5. **At-most-once costs a reply** in the rare crash described in section 1.
6. **Tamil and Tanglish wording.** The fixed lines (`pipeline/fixed-texts.ts`) and the demo number's menu (`channels/whatsapp/demo/text.ts`) in Tamil, Tanglish and Hindi are machine drafts that no native speaker has read. Tamil and Tanglish reply quality from the real model is checked only by `--live`, on a few chats (`real-estate/02`, `107`, `108`, `68`).
7. **The demo number's language guess** is a word list (Tamil script, or a few Tanglish words), not a model.
8. **No opt-in after STOP.** There is no START phrase: a contact who sent STOP stays opted out for that business. How staff reverse it is **unverified** here.
9. **Real models and Meta are not in CI.** What `--live` shows is a small sample; what Meta does is checked only by the demo.

## 7. Not measured, not verified

- **Latency on staging** (a Day 7 item): not measured. The live harness measured about 3.7 s of model time per turn on a sample of 7 (13 Oct), which with the 3 s debounce is about 7 s before the send; the wait for Meta, Inngest's time per step and the webhook are not in that number. The target is 10 s, the hard stop 25 s (`conversation-tests/latency.ts`).
- Sending to Meta, receiving from Meta, template delivery outside the 24-hour window, and Inngest's real replay behaviour (the tests use an emulator that follows its rules).
