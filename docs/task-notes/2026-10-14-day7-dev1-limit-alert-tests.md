# 14 Oct (Dev 1): the hourly rate limit and the daily AI cap stop the agent and alert the owner, proved on the whole turn (Day 7, exit test 4)

Dev 1 files only: `backend/src/agent/pipeline/whole-turn-limit-alert.test.ts` (new, 57 tests), `backend/src/test-support/whole-turn-world.ts` (additive options and the owner-alert step), small edits to `whole-turn-limit.test.ts` and `whole-turn.test.ts`. No production code changed. No migration. Nothing of Dev 2's or Dev 3's edited.

## 1. What was missing

`whole-turn-limit.test.ts` (#211) proved the stop (no model call, no reply, no charge, STOP honoured). It left out the `limit-notice` step, so "and tells the owner" was proved only in parts (`lib/ai-limits.test.ts` for words and keys), and the real numbers were never run end to end.

## 2. What the world does now

The whole-turn world mirrors `inngest/process-message.ts` including the `limit-notice` step: the real `tellOwnersAboutLimit` and the real `sendAccountNotice`, with a fake team (owner, admin, staff, an owner with no alert number) and a fake send that keeps one alert per key like `notify.send`. New options (all additive): `aiLimitFrom` (the limit lookup itself, so the real `aiLimitFor` can run on a fake `ai_limits`), `wrapLlm` (the real `withSpendGuard` around the scripted model), `modelCostUsd`, `members`, `alertSends`, `alertRecipientsFail`, `now`. A limited turn now has the step `limit-notice` after `stop-check-gated`; the existing step-list and failure-injection tests include it.

## 3. What is proved (through the real webhook handler and the Inngest-like emulator)

- **Each of the three limits:** the owner and the admin with an alert number are told once each; the staff member and the owner with no alert number are not; the customer hears nothing; the words are the limit's own, with the inbox link (the chat's link for one customer); the alert holds none of the customer's text, number or name, and no secret.
- **Once per key:** a second message 20 minutes later, a replayed event or webhook, and a retry of the step after it already told them send nothing more. The business pace and the chat limit tell again in a later hour; the cap tells again only on the next day in India (checked across the 00:00 IST boundary).
- **Failures:** every alert refused, every send throwing (with a poisoned message), every alert skipped, the team lookup failing, nobody with an alert number, no team: the turn still ends stopped, no reply, no AI call, no customer message, no credit, and the step is not retried. A refusal for one person does not stop the other's alert.
- **STOP while limited:** opted out, one confirmation, no owner alert. A chat a person has, the assistant switched off, an opted-out contact: their own reason, no alert. No limit: answered, no alert.
- **Real numbers:** 20 AI replies in an hour are answered; the 21st, 22nd and 23rd are stopped with no model call, no reply and no credit, and the owners are told once (the limit is asked for this business and this chat, once per turn). When the hour passes the assistant answers again. For the business pace, at 299 counted one more is answered and at 300 the next is stopped, told once; with the cap and the pace both reached, the pace is the one the owners hear. For the cap, with the real spend guard: a turn that ends exactly at the cap finishes, the next message is stopped before any model call, the owners are told once that day (also 5 hours later), and the next India day it is answered again.
- **The cap reached while a turn runs** (after the gate, before the reply call): the customer gets exactly one message, the fixed safe line ("Let me confirm that with the team"), one credit, no handoff, the reply model never called, nothing retried; the next message is stopped and the owners are told.
- **Other AI features:** a business over its cap gets no model call for the lead card; its words are the plain ones, nothing throws, and the log holds only the code `over_budget`.
- **Drift guard:** the function tells owners and admins only (`roles: ["owner", "admin"]`), through `sendAccountNotice`, in a step of its own after the stop check; the world has the same roles, step and condition.

Checked to be able to fail: `>` instead of `>=` on the chat threshold (2 tests red), the alert key made per call instead of per hour (2 red), and `"staff"` added to the roles in `process-message.ts` (1 red). The key mutation first passed: the clock never moved inside the hour; a test with the clock 20 minutes on was added and then caught it.

## 4. Known limits (pinned by tests, nothing changed)

1. **One alert per chat per hour.** The chat limit's key is per business, chat and hour (`lib/ai-limits.ts` `limitNoticeKey`). 50 chats that each reach the limit in one hour make 50 alerts for each owner and admin (the cap and the business pace make one); one flooded chat alerts every hour, 24 a day. A bot flooding many chats would flood the owners' WhatsApp. Pinned in the test block "KNOWN LIMIT". A fix is in Dev 2's `lib/ai-limits.ts` (for example key the chat alert per business per hour, or stop after a few a day).
2. **The owners are told when the next message is stopped, not when the cap is reached.** A turn that crosses the cap finishes (one reply); nobody is told until another customer message arrives and is stopped. If none comes, no alert. The cap-reached moment is in the model client's guard (`withSpendGuard`), which has no way to tell anyone.
3. **The cap check in the model client is cached for a minute per business** (`cachedOverCap`), so a call can pass up to a minute after the cap was reached; the gate's own check, made on every turn, is not cached.

## 5. Not proved

The real `ai_limits` function and the hour and day windows (`supabase/tests/ai_limits.test.sql`, Dev 2's); the real list of who is alerted (`notify/staff-alerts.ts`); the real `notify.send` (the fake follows its idempotency rule); delivery of an alert outside the 24-hour window (a template); the real Inngest (the emulator follows its replay rules); a `limit-notice` step that is the production one (the world mirrors it; the drift guard pins the roles, the step and its place).
