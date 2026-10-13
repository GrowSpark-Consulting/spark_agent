# 13 Oct (Dev 1): demo-number routing by route code (PR 1a). What was built, and what touches Dev 2's and Dev 3's areas

Draft until Dev 2's migration 0030 (his changes to `notify_target`, `notify_staff_target` and `loadSendConnection`) is merged: a routed visitor's chat is stored and queued by this PR, but a reply cannot leave the demo number before that. The menu, the front-desk business and the replies that explain a refusal are the next PR (1b).

Dev 1 files: `supabase/migrations/0029_demo_routing.sql`, `0031_store_inbound_platform_channel.sql`, `backend/src/channels/whatsapp/demo/` (`code.ts`, `route.ts`, `db.ts`, `ports.ts`, tests), `inbound.ts` (a hook), `supabase/tests/demo_routing.test.sql`, `inbound_messages.test.sql` (added tests).

## 1. What the demo number does now

1. The demo number stays one shared `platform` connection row (the seed script's). A message on it (the number's id equals `WHATSAPP_DEMO_PHONE_NUMBER_ID`, the connection is `platform`, the webhook is signed with `META_APP_SECRET`) is routed in `inbound.ts` before it is stored. Any other number, including other `platform` numbers, behaves exactly as before. When `WHATSAPP_DEMO_PHONE_NUMBER_ID` is not set, nothing is routed and the demo number behaves as before this PR (its messages go to the business that owns the connection row), so it must be set wherever the demo number is connected.
2. A route code in the text (`DEMO-<KEY>` or `TRIAL-` and four letters or digits, any case, found in the first 200 characters) is looked up in `route_codes`: it must exist, name a business, not be expired (`expires_at`), and the business must be `trial` or `active` (not paused or cancelled). The business comes only from that row, never from the text. This lookup is one read made before the message is counted.
3. Every message is then counted (`demo_admit`): 30 a day per phone, the day being the India calendar day. The 31st and later are dropped. In the same locked step a valid code starts the visitor's route (`demo_visitors.tenant_id`, `routed_at`), which lasts 24 hours and which a new valid code replaces. A refused message never starts a route. The count stops at 32, so "count = limit + 1" is true once a day (for the limit notice in PR 1b).
4. A message id already admitted (one of the last 10) is a replay: it is not counted again, it does not move the route, and it is let through for the business it was first admitted for (kept next to the id), so storing it again is idempotent. A refused message is not remembered. A redelivery of an older message counts as new.
5. The message is stored under the routed business, on the demo number's own channel, with the code taken out of the text (everything else as written; `Hi` if nothing else was said) and the code kept in `messages.meta.routeCode`. The `whatsapp/message.received` event carries the routed business's id.
6. Without a code, a route under 24 hours old keeps the visitor with the same business, if that business is still `trial` or `active`. Without a code and without a route, with an unknown, expired or paused-business code, or with a route to a business that is no longer live, nothing is stored, queued or answered. Before this PR such a message went to the business that owns the connection row; it no longer does while a demo number is set. PR 1b adds the menu and the explanations.
7. The log line gains `demo_routed=` and `demo_dropped=` counts, only when one is non-zero. No phone, name, text, code or business id is logged.

## 2. Migrations (append-only)

- **0029** adds `demo_visitors` (phone, the routed business, `routed_at`, the day's count, the last 10 admitted message ids with the business each was admitted for) and `demo_admit(phone, wamid, limit, now, route_tenant)`. Server only: RLS on, no policies, anon and authenticated lose every privilege; `demo_admit` is executable by `service_role` only. `tenant_id` is null until a code routes the visitor. The isolation suite gets one `demo_visitors` row per fixture business (one added line in `supabase/tests/isolation.test.sql`, nothing else changed).
- **0031** replaces `store_inbound_message` (same signature and grants, otherwise 0013's body) so that a channel belonging to one of our own `platform` connections may carry a conversation of any existing business. **This relaxes the check that a channel belongs to the business it is stored for (PA404) and needs Dev 2's review.** A channel of another business is still refused, unless it is a `platform` connection's channel; an unknown business is still refused; a message id owned by another business is still PA409. Only service-role code calls it, and the business comes from a verified route code. It is numbered 0031 because 0030 is Dev 2's: until his migration is merged there is a gap, and an environment that gets 0031 first may need `--include-all` when 0030 arrives.
- Tests: `demo_routing.test.sql` (44 checks, including a replay judged at the same time as the original and after the limit, which fail on a version that judges the replay from the row after its own update), six added checks in `inbound_messages.test.sql` (the existing "a channel of another business is refused" check is unchanged and passes), and the isolation suite. `pnpm db:test`: all 28 files pass.

## 3. What touches Dev 2's area (reads only; no file, table, function or route of Dev 2 changed)

1. Reads `route_codes` (the table `create_trial_tenant` writes TRIAL codes to) by code: `tenant_id` and `expires_at`, and `tenants.status` of the named business.
2. `claim_trial_phone` (one trial per owner phone) does not exist yet. `demo/ports.ts` has a port named `claimTrialPhone` whose default says "claimed"; **nothing calls it**. `route.ts` has a comment where a TRIAL code's claim would go. It needs his function's name and arguments.
3. A routed conversation's connection is on the demo channel, which belongs to the business that owns the connection row, not to the routed business. `notify_target` (0009) finds a connection by the conversation's business and channel, so until his 0030 is merged nothing can be sent for a routed chat.
4. Not in this PR: abuse controls at trial creation (one trial per owner phone and per WhatsApp business number) stay in `create_trial_tenant`. A `TRIAL-` code has 4 characters of a 31-symbol alphabet (about 923,000 codes); a wrong code costs the guesser one of their 30 messages a day, and nothing counts wrong codes across phones.

## 4. What touches Dev 3's area

Nothing. The inbox reads no `channel_id` or `channels` (checked in `frontend/features` and `frontend/lib`), so a chat whose channel belongs to another business does not change what it shows. A routed visitor appears as a contact and conversation of the routed business, like any other.

## 5. Known limits and follow-ups (Dev 1)

1. The replay check remembers the last 10 admitted message ids per phone. A redelivery of an older message counts as new. Meta redelivers within minutes, so this is not expected to matter. A redelivery of the one message that got the limit notice (the 31st) is the 32nd, so it gets no second notice.
2. Two messages from one phone handled at the same moment take turns on the visitor's row. If a codeless message is handled before the message with the code, it finds no route and is dropped (answered 200, so Meta does not retry it).
3. Delivery statuses and echoes for the demo number are still applied under the business that owns the connection row (`apply_message_status` filters by business), so a status for an outbound message of a routed business is not applied. To change in PR 1b, with the read receipt: `mark-read.ts` looks for the connection by the business's own id and the conversation's channel, so for a routed chat it finds none and skips (it is best effort).
4. Which connection a routed conversation uses once the routed business also has a number of its own is decided by Dev 2's `notify_target` (0030), not by this PR.
5. The 30 a day limit is a constant (`DEMO_DAILY_LIMIT` in `demo/route.ts`), not a setting.
6. The menu and the refusal wording (English and Tamil) are not written: PR 1b.
7. Not verified against a real Meta account or the staging database; the local database was used for the SQL and mocked Meta and database answers everywhere else.
