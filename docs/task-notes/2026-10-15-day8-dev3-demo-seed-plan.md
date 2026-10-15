# Day 8, Dev 3: how to seed "a believable week" in the demo tenant (15 Oct 2026)

Status: **plan only. No seed data for conversations or bookings exists, and nothing here has been run** (no Docker on this machine, no database access). Read from `supabase/config.toml`, `supabase/seed/*.sql`, `supabase/migrations/0001_init.sql` and `docs/environments.md`.

## What the seed does today
- `supabase/config.toml` `[db.seed].sql_paths` loads `plans.sql`, `features.sql`, `demo_tenants.sql`, `booking_setup.sql`. On staging it is applied with `pnpm exec supabase db push --include-seed` (docs/environments.md step 5; never `db reset --linked`).
- `demo_tenants.sql` creates the three demo businesses, the isolation-test businesses and the front-desk business, the `DEMO-*` route codes, and 10,000 credits each for the demo businesses. It creates **no** conversations, messages, leads or bookings for the demo businesses (leads and contacts exist only for the two isolation businesses), **no members** and no logins ("this repo is public"). `booking_setup.sql` adds resources, services and catalog items for real estate.
- So a dashboard opened as a demo owner today shows an empty Home, Inbox, Leads and Calendar.

## Why the existing seed file is the wrong place
1. It runs once per `db push --include-seed` and every insert is `on conflict do nothing`. Timestamps fixed in a file go stale: "this week" would be a month old on demo day. Seed rows must be dated relative to the moment of loading.
2. The three `DEMO-*` businesses receive real demo traffic from the shared demo number. Fake chats mixed into them would show up beside live rehearsal chats and in the Day 8 exit test's counts.
3. `seed.test.sql` and `demo_routing.test.sql` assert facts about those tenants; adding rows there risks those tests.

## Proposed approach (for Dev 2 / the owner to approve)
- A **separate, explicitly invoked** script, not in `sql_paths`: for example `supabase/seed-optional/demo_week.sql`, or a `tsx` script beside `backend/src/scripts/seed-connection.ts` (which already shows the house style for a one-off seeding command). Run by a person on purpose, never by `db reset`.
- Target a **dedicated tenant** (for example "Spark Agent Demo Dashboard", its own fixed id), not one of the routed `DEMO-*` businesses, with a membership for the presenter's account added by the same manual step the seed file already documents. No tenant gets a route code, so no live message can land in it.
- Rows needed, in dependency order (columns from migration 0001; later migrations may add columns, check before writing): `contacts` (unique per tenant and phone; use the reserved fictional 555-01xx style numbers, never real ones) → `channels` → `leads` (stage, score, temperature, `fields`) → `conversations` (`mode`, `last_customer_msg_at`) → `messages` (`direction`, `sender`, `body`, `created_at` spread over seven days, some after the business's hours so "after-hours enquiries handled" is non-zero) → `bookings` (needs a `resource_id`; the exclusion constraint blocks overlapping held/confirmed bookings, so give each a distinct slot; include one for today so "Today's bookings" fills) → optionally `handoffs` for the "Hot leads waiting" card.
- Home's four numbers are computed from `leads.created_at`/`stage`, `bookings.status` (confirmed, completed, no_show) and the business's `business_hours` (`backend/src/dashboard/summary.ts`). The seed must set `tenants.business_hours` and spread `leads.created_at` so each number is non-zero and the after-hours count is believable. It must also keep `messages.credits_charged` and `credit_ledger` consistent, or the credit meter's "leads left" estimate will be nonsense.
- **Idempotent and re-datable**: deterministic ids, `delete ... where tenant_id = <dedicated id>` then re-insert inside one transaction, dates as `now() - interval`. Safe to re-run the morning of the demo. Scope every statement by that tenant id; never truncate.
- Insert triggers to expect: `0049` audit triggers (service role writes are not audited) and `0050` `queue_webhook_events` (only acts when the business has a webhook endpoint; it has none). Confirm neither sends WhatsApp: inserting `messages` rows directly does not go through `notify.send()`, so nothing is sent. This is the one place the "all outbound goes through notify.send()" rule is deliberately bypassed because no message is actually sent; it needs the owner's explicit approval.

## Verification before anyone says "seed data exists"
1. `pnpm db:start` (needs Docker), `pnpm db:reset`, run the script, run it a second time (row counts unchanged).
2. `pnpm db:test` still passes (`seed.test.sql`, `isolation.test.sql`).
3. Sign in as the member; check Home's four numbers against `select` counts, Inbox, Leads, Calendar, and that a second business sees none of it.
4. Only then on staging, once, by a developer, with the date recorded here.
