# 14 Oct (Dev 1): an area the business has no sites in, and the out-of-area pincode (Day 7, PR 1). What was built, and what touches Dev 2's and Dev 3's areas

Dev 1 files: `backend/src/agent/scoring/coverage.ts` (new), `agent/handoff/area-reminder.ts` (new), `agent/pipeline/{plan,plan-booking,understand,reply,store,fixed-texts,runtime}.ts`, `agent/scoring/{score,references}.ts` (one `export`, one added matcher name), `conversation-tests/{run-chat,schema}.ts`, `test-support/fake-pipeline-store.ts`, chats 65 to 70 and `interiors/01` to `04`. One optional field in the shared `packages/types/src/pack.ts`. No migration, no pack file changed, no file of Dev 2 or Dev 3 changed.

## 1. Behaviour

1. A customer names a place the business has no sites in. First reply: a fixed line listing the areas the business does have (at most 6, as the business wrote them), so the customer can choose. No model call, no time offered. The state `options` is kept on the customer's message (`meta.agent.coverage`).
2. The same place named again (as the model extracted it, compared after normalising) after the options: a fixed line saying there is no property there for now and that the customer will be updated; the state becomes `unavailable`; one staff reminder. The lead stays open (stage unchanged), the chat stays with the assistant (no handover).
3. A different unserved place: the options again. A place the business has: the normal flow, and the state is ended (`coverage: null`), so the options come first if an unserved place is named later.
4. A customer who asks to book without naming the place again gets the options again, or "nothing there" if that was already said; never a reminder (only the same place named again after the options is insisting).
5. While a lead's place is unserved, no new time is offered (`plan-booking.ts`); a time the customer is picking from an earlier offer is not booked on the turn they name an unserved place. A lead that is certainly not a fit (hard fail) is still told that first; opt-out, a person, a complaint, a discount and off topic still come first.
6. Nothing is judged, and nobody is turned away, when the pack has no area rule, the business has listed no areas, the customer gave no place, qualifying is off, or the customer is leaving.

## 2. Where the rule lives

`PackDefinition.coverage` (optional, `{ field, match }`, `match` an area matcher such as `in_project_areas`) in `packages/types`. **When a pack has no `coverage`, its first area scoring rule is used.** This is why no pack file changed: `packs:sync` refuses an edit to a published version (and runs when the server starts), so adding the block to `real-estate@1` or `interiors@1` would have failed the deploy. Real estate is read through `location` / `in_project_areas`, interiors through `pincode` / `in_service_area` (the catalog's `areas` hold the pincodes); salon has no area rule. A future version of a pack can name `coverage` itself. The places come from the business's catalog (`references.ts`), the same list scoring uses; both sides are compared after `normaliseArea` (lower case, no punctuation, a pincode typed with a space or dash as digits).

## 3. Where the state is kept and read

1. Step 4's qualify step saves `meta.agent.coverageReading` on the newest message: `{ served, area, shown, areas, named }`. `named` is true when the message gave a place and it is the one saved on the lead (a doubtful reading that did not replace the lead's own place does not count). The step's stored result holds none of these words (tested).
2. The reply's plan step keeps `meta.agent.coverage` (`{ area, stage }`, or `null`) next to `planCase`. `store.getPreviousCoverage` (new, in `PipelineStore`, filtered by `tenant_id` and the conversation) reads the newest earlier customer message that says anything about it, before the batch's first message, so the plan step, the re-plan and the send all read the same state, and a message left unanswered (no credits, a send that could not go) is re-collected by the next turn with an earlier start and its state is not read.
3. Both values are read back through Zod and ignored when they are not in the shape written. `merge_message_agent_meta` keeps a JSON `null`.

## 4. The staff reminder

`agent/handoff/area-reminder.ts`: one `staff_alert` through `notify.send` to each owner and admin with an alert number (Dev 2's `staffAlertRecipients`; sent with `sendToAdmins` from `health-alert.ts`), with our own text: the customer's name or masked number, the place as the customer wrote it (cut to 40 characters, one line), "please add it to your CRM", and the inbox link. Template variables: the headline and the link. Idempotency key `area_unserved:<leadId>:<16 hex of the compared place>:<member id>`: once per lead and place however often the step runs. A new step `area-reminder` runs after the reply was answered; it never throws into the turn. If every send failed it returns `failed` and logs a fixed line (best effort: later turns are in the `unavailable` state and do not send again). `staff_alert` costs no credits and sits behind the `staff_alerts` switch; outside the 24-hour window it needs the approved `staff_alert_v1` template (can't tell from code whether it is approved on staging).

## 5. Texts

Fixed lines `area_options` and `area_unavailable` in English, Tamil, Tanglish and Hindi (`fixed-texts.ts`), filled by `areaText` in one pass (what is put in is never read as a place to fill). **The Tamil, Tanglish and Hindi wording is a machine draft** (chats 68 and 69 are marked `needsNativeCheck`).

## 6. Measured with the real models (14 Oct, 15 requests, about 2 cents)

Five turns of a plain repeat after the options was shown ("only Adyar", "Adyar only", "No, I want Adyar only", "I told you, Adyar", "Not interested in other areas, only Adyar please"): the real extraction model returned **no fields in 5 of 5** (`give_details`, confidence 0.6 to 0.9), so none reached "nothing there". The two Tamil / Tanglish phrases were not measured (the request cap was reached, because each miss also costs a reply-model call). Cause: the extraction prompt says to put in `fields` only what the current message adds or changes (`extraction_v2.ts` line 52), and the place is already on the lead. **So under the strict rule the second line and the reminder are reached only when the model happens to repeat the place.** A rule that compares the customer's own words with the unserved place was not built (not part of the decision).

## 7. Tests

Written first and run against the old code (red), then green: `packages/types/src/pack.test.ts` (coverage), `coverage.test.ts`, `references.test.ts`, `fixed-texts.test.ts`, `plan-area.test.ts` (every row), `understand-coverage.test.ts`, `store.test.ts` (`getPreviousCoverage`), `area-reminder.test.ts`, `reply-area.test.ts` (end to end through the reply step: one send, no model call, state kept, reminder once and after the reply, replay, reminder failing, opted out, taken over), `run-chat.test.ts` (the new `areaReminder` expectation). Chats: real-estate 65 (rewritten) and 66 to 70; interiors 01 to 04 (the first interiors chats; their folder is new). `pnpm typecheck`, `pnpm lint` (one existing warning in `leads-board.tsx`), `pnpm test` (backend 4522 passed, 1 expected fail), `pnpm test:conversations` (62 passed), `pnpm packs:sync -- --check` (all three valid, no warnings).

## 8. What touches Dev 2's and Dev 3's areas

Dev 2: nothing changed. Called: `staffAlertRecipients` and `notify.send` (kind `staff_alert`, idempotency key). Dev 3: nothing changed. The shared contract `packages/types/src/pack.ts` gains one optional field (`coverage`); nothing existing changes shape, and the frontend does not read packs.

## 9. Not in this PR

A rule that does not depend on the model repeating the place (section 6); the Hindi / Tamil / Tanglish wording checked by a native speaker; a `coverage` block in a new version of real estate or interiors (needs version 2 and `packs:migrate`, not built).
