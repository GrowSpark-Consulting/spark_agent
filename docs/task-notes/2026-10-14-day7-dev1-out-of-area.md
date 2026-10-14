# 14 Oct (Dev 1): an area the business has no sites in, and the out-of-area pincode (Day 7, PR 1). What was built, and what touches Dev 2's and Dev 3's areas

Dev 1 files: `backend/src/agent/scoring/coverage.ts` (new), `agent/handoff/area-reminder.ts` (new), `agent/pipeline/{plan,plan-booking,understand,reply,store,fixed-texts,runtime}.ts`, `agent/scoring/{score,references}.ts` (one `export`, one added matcher name), `conversation-tests/{run-chat,schema}.ts`, `test-support/fake-pipeline-store.ts`, chats 65 to 70 and `interiors/01` to `04`. One optional field in the shared `packages/types/src/pack.ts`. No migration, no pack file changed, no file of Dev 2 or Dev 3 changed.

## 1. Behaviour

1. A customer names a place the business has no sites in. First reply: a fixed line listing the areas the business does have (at most 6, as the business wrote them), so the customer can choose. No model call, no time offered. The state `options` is kept on the customer's message (`meta.agent.coverage`).
2. The same place named again after the options (as the model extracted it, or found in the customer's own words, section 6; compared after normalising): a fixed line saying there is no property there for now and that the customer will be updated; the state becomes `unavailable`; one staff reminder. The lead stays open (stage unchanged), the chat stays with the assistant (no handover).
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

## 6. A repeat is read from the customer's own words (measured live, 14 Oct)

1. **Why.** The real extraction model is told to give only what a message adds (`extraction_v2.ts` line 52), and the place is already on the lead, so it returns no field for a repeat. Measured first with the strict rule alone (15 requests): 0 of 5 plain repeats ("only Adyar", "Adyar only", "No, I want Adyar only", "I told you, Adyar", "Not interested in other areas, only Adyar please") reached "nothing there".
2. **The rule** (`reply.ts` line 166, `mentionsArea` in `coverage.ts` line 94). The strict path stays first: the model naming the place again. If it did not, the message counts as a repeat when ALL of these hold: the previous state for the SAME stored unserved place is `options` or `unavailable` (so never before the options were shown; a different place gets the options); the customer's words contain the stored place as a whole word after the same normalising (`Adyarpet` does not match; a pincode is matched as digits with an optional single space or dash between them and not inside a longer number; Tamil script is matched as written); and the same message does not also name a place the business has (all of them, normalised, up to 50, kept on the reading as `known`; the 6 a reply lists are not enough). The words are all the messages of the turn joined, so a re-run reads the same text.
3. **Re-measured** (14 Oct, 7 requests, the real extraction model, the first turn scripted so each chat starts from the same options state): the five plain repeats above, a Tanglish repeat ("Adyar dhaan venum") and a Tamil-script repeat of a place first written in Tamil script ("அடையாறு மட்டும் தான்"): **7 of 7 reached "nothing there"**, every one with no field from the model.
4. **Accepted by the decision, not prevented**: after the options, a message that merely mentions the place ("What are the prices in Adyar?", "Not Adyar, Tambaram" with Tambaram not listed) is read as a repeat. Not recognised: a Tamil-script repeat of a place first typed in Latin letters (no transliteration), digits in other scripts, a pincode split across two messages is joined and would count.

## 7. Tests

Written first and run against the old code (red), then green: `packages/types/src/pack.test.ts` (coverage), `coverage.test.ts`, `references.test.ts`, `fixed-texts.test.ts`, `plan-area.test.ts` (every row), `understand-coverage.test.ts`, `store.test.ts` (`getPreviousCoverage`), `area-reminder.test.ts`, `reply-area.test.ts` (end to end, including the repeats read from the words through the reply step: one send, no model call, state kept, reminder once and after the reply, replay, reminder failing, opted out, taken over), `run-chat.test.ts` (the new `areaReminder` expectation). Chats: real-estate 65 (rewritten) and 66 to 74 (71 to 74: repeats with no field from the model, a near-match and another place, Tamil, Tanglish); interiors 01 to 05 (the first interiors chats; their folder is new). `pnpm typecheck`, `pnpm lint` (one existing warning in `leads-board.tsx`), `pnpm test` (backend 4558 passed, 1 expected fail), `pnpm test:conversations` (67 passed), `pnpm packs:sync -- --check` (all three valid, no warnings).

## 8. What touches Dev 2's and Dev 3's areas

Dev 2: nothing changed. Called: `staffAlertRecipients` and `notify.send` (kind `staff_alert`, idempotency key). Dev 3: nothing changed. The shared contract `packages/types/src/pack.ts` gains one optional field (`coverage`); nothing existing changes shape, and the frontend does not read packs.

## 9. Not in this PR

Transliteration between scripts for a repeat (section 6.4); the Hindi / Tamil / Tanglish wording checked by a native speaker; a `coverage` block in a new version of real estate or interiors (needs version 2 and `packs:migrate`, not built).
