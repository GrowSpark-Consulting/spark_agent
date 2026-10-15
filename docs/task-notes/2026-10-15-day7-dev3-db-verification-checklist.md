# Day 7: database verification checklist (migrations 0048, 0049, 0050)

Status on 15 Oct 2026: **not run.** Docker is not available on the machine that prepared this, so `pnpm db:test` and `pnpm db:reset` have never been executed for these migrations by Dev 3. Everything below was read from the SQL and its tests, not observed. Run it on a machine with Docker, against the local Supabase stack only (`pnpm db:start`), never a shared or production database.

## Before running
- [ ] `git status` clean, on the commit to be tested (the migrations are append-only: 0048, 0049, 0050 must be the last three, in that order).
- [ ] `pnpm db:start`, then `pnpm db:reset` (applies every migration and `supabase/seed`; #225 changed `supabase/seed/demo_tenants.sql` and `seed.test.sql`).
- [ ] `pnpm db:test` runs every file in `supabase/tests/`. Record the full TAP summary (files, tests, failures) rather than "passed".

## 0048 unpaid-trial deletion (`unpaid_trial_deletion.test.sql`, 18 assertions)
Covered by the test (read, not run): who is listed (`due` from day 30), refusals (before 30 days, paid, on a plan, live subscription), the deletion and its audit row (counts only), `trial_phones.tenant_id` set to null, a retry returns `gone`, `media_object_names` for a business and for some chats, `delete_contact_data` returning `conversation_ids`, execute revoked from `authenticated`.
Not covered by any test I found, to check by hand or add:
- [ ] `has_function_privilege('anon'/'public', ...)` for the four functions (the test checks `authenticated` only); and that `service_role` can still execute them (0048 only revokes, like 0043, and relies on default privileges).
- [ ] Cascade reaches the new 0050 tables: delete a business that has a `webhook_endpoints` row with `webhook_deliveries`; both must go.
- [ ] A business with a `past_due` and a `pending` subscription is not listed (the test names `active`, success payments and "a check"; confirm each branch).
- [ ] `p_now` boundary: exactly 30 days after `trial_ends_at` deletes, 29 days 23 h does not; 23 days is listed with `due` false.
- [ ] Storage: after `delete_unpaid_trial`, `media_object_names` still lists the files (it reads `storage.objects`); then the server's Storage API call removes them. The SQL cannot remove objects, so this needs the backend job (`backend/src/inngest/unpaid-trial-cleanup.ts`) run against a local stack with a real upload, and `storage.objects` checked to be empty for that tenant. Backend unit tests use a fake storage.

## 0049 browser-write audit (`browser_write_audit.test.sql`, 14 assertions)
Covered (read, not run): owner's tenant/service writes, staff's own lead and alert number, no customer detail or phone number in `diff`, a no-op update and a server (service role) write are not audited, triggers exist on `quotes` and the expected table count, execute revoked.
To check:
- [ ] Each trigger fires as a real `authenticated` session via PostgREST, not only `set role` in SQL: `tenants` (update), `services`, `resources`, `catalog_items`, `quotes` (insert/update/delete), `leads`, `memberships` (update).
- [ ] `resources` and `catalog_items` and `quotes` have at least one assertion each (the file names services, tenants, leads and memberships).
- [ ] A member of business A cannot read business B's `audit_logs` rows (RLS on `audit_logs`; existing `rls.test.sql`/`isolation.test.sql` should still pass).
- [ ] Trigger cost: a bulk update of many leads writes one audit row per row; confirm acceptable.

## 0050 outbound webhooks (`outbound_webhooks.test.sql`, 46 assertions)
Covered (read, not run): no table/function privilege for `authenticated`, outbox events for lead/booking/handoff, one row per (business, event, record), endpoint save/rotate/delete with audit rows that hold the host only, claim/record semantics and back-off.
To check:
- [ ] `anon` as well as `authenticated` has no privilege on `webhook_endpoints` and `webhook_deliveries` (RLS on, no policy), and PostgREST returns nothing/403 for a signed-in member.
- [ ] `isolation.test.sql` lines 121-122 insert an endpoint and a delivery for each tenant; confirm member A sees none of either tenant's rows.
- [ ] The outbox trigger never fails the originating write: force an error inside `queue_webhook_events` (for example a bad `events` value) and confirm the lead insert still succeeds with a warning. No test found for the `exception when others` branch.
- [ ] `claimed_until` takeover after 5 minutes under two concurrent sessions (`skip locked`), not only sequential calls.
- [ ] `ENCRYPTION_KEY` round trip for the secret is backend-side (`backend/src/lib/crypto.ts`); the SQL only stores `secret_enc`.

## Cross-cutting
- [ ] `isolation.test.sql` and `rls.test.sql` still pass with the three new migrations (these assert that a signed-in user only calls `is_member`/`is_admin`; `message_media_member_read` and the new security-definer functions must not break that).
- [ ] `pnpm packs:sync -- --check` unaffected (no pack change).
- [ ] Staging only, after the above: a real unpaid trial past 30 days, deletion job run once, then audit row `tenant.deleted` present, tenant rows gone, media gone, `trial_phones` row kept with null tenant.
