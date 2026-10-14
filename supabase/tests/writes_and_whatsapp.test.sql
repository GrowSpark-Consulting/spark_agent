-- Member writes (0002) and WhatsApp secrets / consent log (0003). Run: pnpm db:test
begin;
create extension if not exists pgtap with schema extensions;
select plan(45);

-- Fixtures, inserted as the migration owner (bypasses RLS) ----------------------------
-- Tenant A: owner A and staff A2. Tenant B: owner B.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'owner-a@test.local'),
  ('00000000-0000-0000-0000-0000000000a2', 'staff-a@test.local'),
  ('00000000-0000-0000-0000-00000000000b', 'owner-b@test.local');
insert into public.tenants (id, name, vertical) values
  ('10000000-0000-0000-0000-00000000000a', 'Tenant A', 'test-pack'),
  ('10000000-0000-0000-0000-00000000000b', 'Tenant B', 'test-pack');
insert into public.memberships (tenant_id, user_id, role) values
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'owner'),
  ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a2', 'staff'),
  ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b', 'owner');
insert into public.contacts (id, tenant_id, phone) values
  ('20000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', '+910000000001'),
  ('20000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-00000000000b', '+910000000002');
insert into public.leads (id, tenant_id, contact_id) values
  ('30000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a'),
  ('30000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-00000000000b', '20000000-0000-0000-0000-00000000000b');
insert into public.services (id, tenant_id, name, duration_min, resource_type) values
  ('40000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', 'Service A', 30, 'staff'),
  ('40000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-00000000000b', 'Service B', 30, 'staff');
insert into public.resources (id, tenant_id, type, name) values
  ('80000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', 'staff', 'Resource A');
insert into public.channels (id, tenant_id, type) values
  ('50000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', 'whatsapp'),
  ('50000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-00000000000b', 'whatsapp');
insert into public.whatsapp_connections
  (id, tenant_id, channel_id, method, waba_id, phone_number_id, token_enc, token_type, app_secret_enc, connected_by)
values
  ('60000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-00000000000a',
   'manual_byo', 'waba-a', 'pnid-a', 'secret-token-a', 'system_user', 'secret-app-a', 'admin:test'),
  ('60000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-00000000000b', '50000000-0000-0000-0000-00000000000b',
   'manual_byo', 'waba-b', 'pnid-b', 'secret-token-b', 'system_user', 'secret-app-b', 'admin:test');
insert into public.connect_links (token_hash, tenant_id, created_by, expires_at) values
  (encode(sha256(convert_to('link-token-a', 'UTF8')), 'hex'), '10000000-0000-0000-0000-00000000000a',
   '00000000-0000-0000-0000-00000000000a', now() + interval '1 day');
insert into public.catalog_items (id, tenant_id, type, title) values
  ('70000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-00000000000a', 'package', 'Item A'),
  ('70000000-0000-0000-0000-00000000000b', '10000000-0000-0000-0000-00000000000b', 'package', 'Item B');
insert into public.bookings (tenant_id, lead_id, resource_id, start_at, end_at, status) values
  ('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-00000000000a',
   '80000000-0000-0000-0000-00000000000a', '2026-11-01 10:00+05:30', '2026-11-01 11:00+05:30', 'confirmed');

-- Schema checks -------------------------------------------------------------------------

select is(
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relrowsecurity
      and c.relname in ('catalog_items', 'quotes', 'whatsapp_connections', 'connect_links', 'consent_logs')),
  5::bigint,
  'RLS is on for catalog_items, quotes, whatsapp_connections, connect_links and consent_logs');
select ok(
  (select coalesce('security_invoker=true' = any(c.reloptions), false)
     from pg_class c where c.oid = 'public.whatsapp_connections_public'::regclass),
  'whatsapp_connections_public runs with the caller''s privileges (security_invoker)');
select is(
  (select count(*) from pg_attribute
    where attrelid = 'public.whatsapp_connections_public'::regclass and not attisdropped
      and attname in ('token_enc', 'app_secret_enc', 'token_type', 'token_expires_at',
                      'client_business_id', 'connected_by')),
  0::bigint,
  'whatsapp_connections_public has no secret columns');
select hasnt_column('public', 'channels', 'credentials_enc',
  'channels has no credentials column; WhatsApp secrets live only in whatsapp_connections');
select is(
  (select count(*) from pg_policies where schemaname = 'public' and roles <> '{authenticated}'),
  0::bigint,
  'every policy is scoped to signed-in users');
select lives_ok(
  $$insert into public.vertical_packs (key, version, definition) values
    ('test-pack', 1, '{}'), ('test-pack', 2, '{}')$$,
  'a pack can hold several versions');
select lives_ok(
  $$insert into public.bookings (tenant_id, lead_id, kind, start_at, end_at, status) values
    ('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-00000000000a',
     'date_range', '2026-12-01', '2026-12-05', 'confirmed')$$,
  'a date_range booking needs no resource');
select throws_ok(
  $$insert into public.bookings (tenant_id, lead_id, resource_id, start_at, end_at, status) values
    ('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-00000000000a',
     '80000000-0000-0000-0000-00000000000a', '2026-11-01 10:30+05:30', '2026-11-01 11:30+05:30', 'held')$$,
  '23P01', null,
  'the database still blocks double booking a resource');

-- Signed in as owner A ---------------------------------------------------------------

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);

-- WhatsApp secrets
select results_eq('select id from public.whatsapp_connections_public',
  array['60000000-0000-0000-0000-00000000000a'::uuid],
  'the public view shows only the member''s own connection');
select results_eq('select id from public.whatsapp_connections',
  array['60000000-0000-0000-0000-00000000000a'::uuid],
  'non-secret connection columns are readable for the member''s own tenant only');
select throws_ok('select token_enc from public.whatsapp_connections', '42501', null,
  'a member cannot read token_enc');
select throws_ok('select app_secret_enc from public.whatsapp_connections', '42501', null,
  'a member cannot read app_secret_enc');
select throws_ok('select * from public.whatsapp_connections', '42501', null,
  'a member cannot select every column of whatsapp_connections');
select throws_ok($$update public.whatsapp_connections_public set status = 'active'$$, '42501', null,
  'a member cannot write through the public view');
select throws_ok('select token_hash from public.connect_links', '42501', null,
  'a member cannot read connect link token hashes');

-- Own-tenant reads and writes
select is((select count(*) from public.catalog_items), 1::bigint,
  'a member sees only their own catalog');
select lives_ok(
  $$insert into public.services (tenant_id, name, duration_min, resource_type)
    values ('10000000-0000-0000-0000-00000000000a', 'New service', 45, 'staff')$$,
  'a member can add a service');
select lives_ok(
  $$update public.leads set stage = 'qualified' where id = '30000000-0000-0000-0000-00000000000a'$$,
  'a member can move their own lead');
select is((select stage from public.leads where id = '30000000-0000-0000-0000-00000000000a'),
  'qualified', 'the lead stage changed');
select throws_ok(
  $$update public.leads set score = 99 where id = '30000000-0000-0000-0000-00000000000a'$$,
  '42501', null,
  'a member cannot set a lead score');
select lives_ok(
  $$update public.tenants set agent_settings = '{"persona":"Maya"}'
    where id = '10000000-0000-0000-0000-00000000000a'$$,
  'a member can edit agent settings');
select is((select agent_settings ->> 'persona' from public.tenants
            where id = '10000000-0000-0000-0000-00000000000a'),
  'Maya', 'agent settings changed');
select lives_ok(
  $$update public.memberships set takeover_pref = 'inbox'
    where user_id = '00000000-0000-0000-0000-00000000000a'$$,
  'a member can set their own takeover preference');
select throws_ok(
  $$update public.memberships set role = 'admin'
    where user_id = '00000000-0000-0000-0000-00000000000a'$$,
  '42501', null,
  'a member cannot change a role');
select lives_ok(
  $$insert into public.catalog_items (tenant_id, type, title)
    values ('10000000-0000-0000-0000-00000000000a', 'package', 'Item A2')$$,
  'a member can add a catalog item');
select lives_ok(
  $$insert into public.quotes (tenant_id, lead_id, catalog_item_id, line_items, total_inr)
    values ('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-00000000000a',
            '70000000-0000-0000-0000-00000000000a', '[]', 1000)$$,
  'a member can draft a quote for their own lead');
select throws_ok(
  $$insert into public.consent_logs (tenant_id, contact_id, event, source)
    values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000a',
            'deletion_requested', 'dashboard')$$,
  '42501', null,
  'a member cannot log a consent event, even for their own contact: the server writes them (0046)');

-- Cross-tenant writes
select throws_ok(
  $$insert into public.services (tenant_id, name, duration_min, resource_type)
    values ('10000000-0000-0000-0000-00000000000b', 'Injected', 30, 'staff')$$,
  '42501', null,
  'a member cannot add a service to another business');
select throws_ok(
  $$insert into public.catalog_items (tenant_id, type, title)
    values ('10000000-0000-0000-0000-00000000000b', 'package', 'Injected')$$,
  '42501', null,
  'a member cannot add a catalog item to another business');
select throws_ok(
  $$insert into public.quotes (tenant_id, lead_id, line_items, total_inr)
    values ('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-00000000000b', '[]', 1)$$,
  '42501', null,
  'a quote cannot point at another business''s lead');
select throws_ok(
  $$insert into public.quotes (tenant_id, lead_id, catalog_item_id, line_items, total_inr)
    values ('10000000-0000-0000-0000-00000000000a', '30000000-0000-0000-0000-00000000000a',
            '70000000-0000-0000-0000-00000000000b', '[]', 1)$$,
  '42501', null,
  'a quote cannot point at another business''s catalog item');
select throws_ok(
  $$update public.services set tenant_id = '10000000-0000-0000-0000-00000000000b'
    where id = '40000000-0000-0000-0000-00000000000a'$$,
  '42501', null,
  'a member cannot move a row into another business');
select throws_ok(
  $$insert into public.consent_logs (tenant_id, contact_id, event, source)
    values ('10000000-0000-0000-0000-00000000000b', '20000000-0000-0000-0000-00000000000b',
            'opted_out', 'dashboard')$$,
  '42501', null,
  'a member cannot log consent for another business');
select throws_ok(
  $$insert into public.consent_logs (tenant_id, contact_id, event, source)
    values ('10000000-0000-0000-0000-00000000000a', '20000000-0000-0000-0000-00000000000b',
            'opted_out', 'dashboard')$$,
  '42501', null,
  'a consent entry cannot point at another business''s contact');
select throws_ok($$update public.consent_logs set event = 'opted_in'$$, '42501', null,
  'consent history cannot be edited');
select throws_ok($$delete from public.consent_logs$$, '42501', null,
  'consent history cannot be deleted');

-- Attempts that RLS turns into no-ops; checked after switching back to the owner below.
update public.services set name = 'hacked' where id = '40000000-0000-0000-0000-00000000000b';
delete from public.catalog_items where id = '70000000-0000-0000-0000-00000000000b';
update public.leads set stage = 'lost' where id = '30000000-0000-0000-0000-00000000000b';
update public.memberships set takeover_pref = 'own_number'
  where user_id = '00000000-0000-0000-0000-0000000000a2';

-- Signed out -----------------------------------------------------------------------------

reset role;
set local role anon;

select throws_ok('select * from public.whatsapp_connections_public', '42501', null,
  'signed-out visitors cannot read the public connection view');
select throws_ok('select id from public.whatsapp_connections', '42501', null,
  'signed-out visitors cannot read whatsapp_connections');
select is((select count(*) from public.catalog_items), 0::bigint,
  'signed-out visitors see no catalog items');
select is((select count(*) from public.consent_logs), 0::bigint,
  'signed-out visitors see no consent history');
select throws_ok(
  $$insert into public.services (tenant_id, name, duration_min, resource_type)
    values ('10000000-0000-0000-0000-00000000000a', 'Anon', 30, 'staff')$$,
  '42501', null,
  'signed-out visitors cannot write');

-- Back as the migration owner: the cross-tenant attempts above changed nothing ---------

reset role;

select is((select name from public.services where id = '40000000-0000-0000-0000-00000000000b'),
  'Service B', 'another business''s service was not renamed');
select ok(exists (select 1 from public.catalog_items where id = '70000000-0000-0000-0000-00000000000b'),
  'another business''s catalog item was not deleted');
select is((select stage from public.leads where id = '30000000-0000-0000-0000-00000000000b'),
  'new', 'another business''s lead was not moved');
select ok((select takeover_pref is null from public.memberships
            where user_id = '00000000-0000-0000-0000-0000000000a2'),
  'a member cannot change a teammate''s preferences');

select * from finish();
rollback;
