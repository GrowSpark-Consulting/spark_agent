-- Tenant isolation across every table (9-day plan, Day 5 exit test 3: "the isolation suite passes for every tenant
-- table"). Run: pnpm db:test
--
-- Part 1 reads the catalogue, so nothing new arrives unchecked: a table without tenant_id must be named here, every
-- policy must be for signed-in users and check membership, no secret column is readable from the browser, the browser
-- can call no function but is_member, views read with the caller's rights, and no browser role can TRUNCATE.
-- Part 2 gives two businesses one row in EVERY table that has a tenant_id (the list comes from the catalogue, so a new
-- table fails the fixture check until the fixture below gives it a row) and checks, table by table, that a member of
-- one business can neither read, change, move, delete nor add the other's rows, and that a signed-out visitor can do
-- none of it either. Part 3 checks afterwards that every row is still where it was.
begin;
create extension if not exists pgtap with schema extensions;

-- Helpers, rolled back with the test. They run as the caller (security invoker), so row-level security applies.
create schema iso;
grant usage on schema iso to anon, authenticated;

-- How many rows the query returns for the current role; 0 when the role may not read the table at all.
create function iso.visible(p_sql text) returns int language plpgsql as $$
declare
  n int;
begin
  execute format('select count(*) from (%s) q', p_sql) into n;
  return n;
exception when insufficient_privilege then
  return 0;
end
$$;

-- How many rows an UPDATE or DELETE changed for the current role; 0 when the role may not do it at all (no privilege,
-- or a row that row-level security refuses, which aborts the statement). Any other error fails the test.
create function iso.changed(p_sql text) returns int language plpgsql as $$
declare
  n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
exception when insufficient_privilege then
  return 0;
end
$$;

-- Rows of one business in one table, counted as the migration owner (no row-level security).
create function iso.rows_of(p_table text, p_tenant uuid) returns int language plpgsql as $$
declare
  n int;
begin
  execute format('select count(*) from public.%I where tenant_id = %L', p_table, p_tenant) into n;
  return n;
end
$$;

-- Fixtures, inserted as the migration owner: businesses A and B, one owner each, and one row of each in every table
-- that has a tenant_id. A new business table needs a line here.
insert into auth.users (id, email) values
  ('e1000000-0000-0000-0000-00000000000a', 'iso-a@test.local'),
  ('e1000000-0000-0000-0000-00000000000b', 'iso-b@test.local');
insert into public.plans (key, name, price_inr, monthly_credits, seats, whatsapp_numbers, feature_keys)
  values ('trial', 'Trial', 0, 300, 2, 1, array['reminder_24h'])
  on conflict (key) do nothing;  -- the seed may already have it
insert into public.features (key, name, description, default_on)
  values ('reminder_24h', 'Day-before reminder', 'A reminder the day before.', true)
  on conflict (key) do nothing;
insert into public.tenants (id, name, vertical) values
  ('e0000000-0000-0000-0000-00000000000a', 'Isolation A', 'test-pack'),
  ('e0000000-0000-0000-0000-00000000000b', 'Isolation B', 'test-pack');

do $$
declare
  s text;
  n int := 0;
  t uuid; u uuid; ch uuid; ct uuid; cv uuid; ld uuid; doc uuid; sv uuid; rs uuid; wc uuid;
begin
  foreach s in array array['a', 'b'] loop
    n := n + 1;
    t   := ('e0000000-0000-0000-0000-00000000000' || s)::uuid;
    u   := ('e1000000-0000-0000-0000-00000000000' || s)::uuid;
    ch  := ('e2000000-0000-0000-0000-00000000000' || s)::uuid;
    ct  := ('e3000000-0000-0000-0000-00000000000' || s)::uuid;
    cv  := ('e4000000-0000-0000-0000-00000000000' || s)::uuid;
    ld  := ('e6000000-0000-0000-0000-00000000000' || s)::uuid;
    doc := ('e7000000-0000-0000-0000-00000000000' || s)::uuid;
    sv  := ('e8000000-0000-0000-0000-00000000000' || s)::uuid;
    rs  := ('e9000000-0000-0000-0000-00000000000' || s)::uuid;
    wc  := ('ea000000-0000-0000-0000-00000000000' || s)::uuid;
    insert into public.memberships (tenant_id, user_id, role) values (t, u, 'owner');
    insert into public.channels (id, tenant_id, type) values (ch, t, 'whatsapp');
    insert into public.contacts (id, tenant_id, phone) values (ct, t, '+91980000010' || n);
    insert into public.conversations (id, tenant_id, contact_id, channel_id) values (cv, t, ct, ch);
    insert into public.messages (tenant_id, conversation_id, direction, sender, body) values (t, cv, 'in', 'customer', 'hello ' || s);
    insert into public.leads (id, tenant_id, contact_id) values (ld, t, ct);
    insert into public.kb_documents (id, tenant_id, source_type, title) values (doc, t, 'upload', 'Brochure ' || s);
    insert into public.kb_chunks (tenant_id, document_id, content) values (t, doc, 'Chunk ' || s);
    insert into public.kb_gaps (tenant_id, question, question_norm) values (t, 'Parking ' || s || '?', 'parking ' || s);
    insert into public.services (id, tenant_id, name, duration_min, resource_type) values (sv, t, 'Visit', 60, 'staff');
    insert into public.resources (id, tenant_id, type, name) values (rs, t, 'staff', 'Staff ' || s);
    insert into public.bookings (tenant_id, lead_id, resource_id, service_id, kind, start_at, end_at, status)
      values (t, ld, rs, sv, 'slot', date_trunc('hour', now()) + interval '2 days', date_trunc('hour', now()) + interval '2 days 1 hour', 'confirmed');
    insert into public.catalog_items (tenant_id, type, title) values (t, 'project', 'Towers ' || s);
    insert into public.quotes (tenant_id, lead_id, line_items, total_inr) values (t, ld, '[]', 100);
    insert into public.tenant_features (tenant_id, feature_key, enabled) values (t, 'reminder_24h', true);
    insert into public.subscriptions (tenant_id, plan_key, status) values (t, 'trial', 'active');
    insert into public.credit_ledger (tenant_id, delta, reason) values (t, 300, 'trial_grant');
    insert into public.handoffs (tenant_id, conversation_id, trigger, priority) values (t, cv, 'asked_human', 'normal');
    insert into public.route_codes (code, kind, tenant_id) values ('ISO-' || upper(s), 'trial', t);
    insert into public.audit_logs (tenant_id, actor, action) values (t, 'system', 'test.fixture');
    insert into public.whatsapp_connections (id, tenant_id, channel_id, method, waba_id, phone_number_id, token_enc, token_type, connected_by)
      values (wc, t, ch, 'manual_byo', 'waba-iso-' || s, 'pn-iso-' || s, 'enc', 'business', u::text);
    insert into public.connect_links (token_hash, tenant_id, created_by, expires_at) values (repeat(n::text, 64), t, u, now() + interval '1 day');
    insert into public.consent_logs (tenant_id, contact_id, event, source) values (t, ct, 'notice_shown', 'first_message');
    insert into public.google_calendar_connections (tenant_id, resource_id, refresh_token_enc, scope) values (t, rs, 'enc', 'calendar');
    insert into public.whatsapp_templates (tenant_id, connection_id, name, language, category, components) values (t, wc, 'iso_' || s || '_v1', 'en', 'utility', '{}');
    insert into public.whatsapp_webhook_tokens (tenant_id, token_hash, token_enc) values (t, repeat((n + 2)::text, 64), 'enc');
  end loop;
end
$$;

-- Every table that has a tenant_id, whether members may read it at all, a column the probe UPDATE sets to itself
-- (leads and memberships allow members only a few columns), and B's row as JSON for the INSERT attempts.
create table iso.tables as
  select c.relname::text as name,
         exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polcmd in ('r', '*')) as readable,
         case c.relname when 'leads' then 'stage' when 'memberships' then 'whatsapp_phone' else 'tenant_id' end as probe_column,
         null::jsonb as b_row
  from pg_class c
  where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
    and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped);
do $$
declare
  r record;
begin
  for r in select name from iso.tables loop
    execute format(
      'update iso.tables set b_row = (select to_jsonb(x) from public.%I x where x.tenant_id = %L limit 1) where name = %L',
      r.name, 'e0000000-0000-0000-0000-00000000000b', r.name);
  end loop;
end
$$;
grant select on iso.tables to anon, authenticated;

select plan(19 + 8 * (select count(*)::int from iso.tables));

-- Part 1: the catalogue -------------------------------------------------------------------------------------------

select is(
  (select array_agg(c.relname::text order by c.relname) from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity),
  null,
  'every table has row-level security on');

select is(
  (select array_agg(c.relname::text order by c.relname) from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and not exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)),
  array['features', 'plans', 'platform_admins', 'tenants', 'vertical_packs'],
  'every other table belongs to a business (has tenant_id); a new shared table must be added to this list on purpose');

select is(
  (select array_agg(format('%s.%s', tablename, policyname) order by 1) from pg_policies
    where schemaname = 'public' and roles <> array['authenticated']::name[]),
  null,
  'every policy is for signed-in users: none for signed-out visitors or for everyone');

-- memberships.own_preferences is narrower than membership: a member may change only their own row.
select is(
  (select array_agg(format('%s.%s', p.tablename, p.policyname) order by 1) from pg_policies p
    where p.schemaname = 'public' and p.tablename in (select name from iso.tables)
      and p.qual is not null and p.qual not like '%is_member(tenant_id)%'
      and format('%s.%s', p.tablename, p.policyname) <> 'memberships.own_preferences'),
  null,
  'every policy on a business table reaches only rows of a business the user belongs to');

select is(
  (select array_agg(format('%s.%s', p.tablename, p.policyname) order by 1) from pg_policies p
    where p.schemaname = 'public' and p.tablename in (select name from iso.tables)
      and p.with_check is not null and p.with_check not like '%is_member(tenant_id)%'
      and format('%s.%s', p.tablename, p.policyname) <> 'memberships.own_preferences'),
  null,
  'every policy that lets a member write a business table checks the new row belongs to their business');

select is(
  (select array_agg(format('%s.%s', c.table_name, c.column_name) order by 1) from information_schema.columns c
    where c.table_schema = 'public'
      and (c.column_name like '%\_enc' or c.column_name like '%token_hash%' or c.column_name like '%secret%')
      and (has_column_privilege('authenticated', format('public.%I', c.table_name), c.column_name, 'select')
        or has_column_privilege('anon', format('public.%I', c.table_name), c.column_name, 'select'))),
  null,
  'no encrypted secret or token hash can be read from the browser');

select is(
  (select array_agg(p.proname::text order by 1) from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prorettype <> 'trigger'::regtype
      and has_function_privilege('authenticated', p.oid, 'execute')),
  array['is_member'],
  'a signed-in user can call only is_member; every other function is server-only');

select is(
  (select array_agg(p.proname::text order by 1) from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prorettype <> 'trigger'::regtype
      and has_function_privilege('anon', p.oid, 'execute')),
  null,
  'a signed-out visitor can call no function');

select is(
  (select array_agg(c.relname::text order by 1) from pg_class c
    where c.relnamespace = 'public'::regnamespace
      and (c.relkind = 'm' or (c.relkind = 'v' and not coalesce('security_invoker=true' = any(c.reloptions), false)))),
  null,
  'every view reads with the caller''s rights (so row-level security applies through it), and there is no materialized view');

select is(
  (select array_agg(c.relname::text order by 1) from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and (has_table_privilege('anon', c.oid, 'truncate') or has_table_privilege('authenticated', c.oid, 'truncate'))),
  null,
  'no browser role can TRUNCATE a table (row-level security does not cover TRUNCATE; 0024)');

select is(
  (select array_agg(name order by name) from iso.tables
    where iso.rows_of(name, 'e0000000-0000-0000-0000-00000000000a') <> 1
       or iso.rows_of(name, 'e0000000-0000-0000-0000-00000000000b') <> 1),
  null,
  'the fixture gives each business exactly one row in every business table');

-- Part 2: a member of A, the way PostgREST runs a signed-in dashboard request ---------------------------------------

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e1000000-0000-0000-0000-00000000000a","role":"authenticated"}', true);

select is(iso.visible(format('select 1 from public.%I where tenant_id = %L', name, 'e0000000-0000-0000-0000-00000000000b')), 0,
          name || ': a member of A sees none of B''s rows')
  from iso.tables order by name;

-- The positive control: without it, a table nobody can read would pass every check above.
select is(iso.visible(format('select 1 from public.%I where tenant_id = %L', name, 'e0000000-0000-0000-0000-00000000000a')),
          case when readable then 1 else 0 end,
          name || case when readable then ': a member of A sees A''s own row' else ': nobody reads this table from the browser' end)
  from iso.tables order by name;

select is(iso.changed(format('update public.%I set %I = %I where tenant_id = %L', name, probe_column, probe_column, 'e0000000-0000-0000-0000-00000000000b')), 0,
          name || ': a member of A cannot change B''s rows')
  from iso.tables order by name;

select is(iso.changed(format('update public.%I set tenant_id = %L where tenant_id = %L', name, 'e0000000-0000-0000-0000-00000000000b', 'e0000000-0000-0000-0000-00000000000a')), 0,
          name || ': a member of A cannot move A''s rows to B')
  from iso.tables order by name;

select is(iso.changed(format('delete from public.%I where tenant_id = %L', name, 'e0000000-0000-0000-0000-00000000000b')), 0,
          name || ': a member of A cannot delete B''s rows')
  from iso.tables order by name;

select throws_ok(format('insert into public.%I select * from jsonb_populate_record(null::public.%I, %L::jsonb)', name, name, b_row), '42501', null,
                 name || ': a member of A cannot add a row for B')
  from iso.tables order by name;

-- The tables that belong to no business.
select is(iso.visible($$select 1 from public.tenants where id = 'e0000000-0000-0000-0000-00000000000b'$$), 0,
  'tenants: a member of A cannot see business B');
select is(iso.changed($$update public.tenants set name = name where id = 'e0000000-0000-0000-0000-00000000000b'$$), 0,
  'tenants: a member of A cannot change business B');
select throws_ok($$insert into public.tenants (name, vertical) values ('Another', 'test-pack')$$, '42501', null,
  'tenants: a member cannot create a business directly (signup goes through the server)');
select is(iso.changed('update public.plans set name = name') + iso.changed('update public.features set name = name')
          + iso.changed('update public.vertical_packs set definition = definition'), 0,
  'plans, features and vertical_packs: a member cannot change the catalogue');
select is(iso.changed($$delete from public.plans where key = 'trial'$$) + iso.changed($$delete from public.features where key = 'reminder_24h'$$)
          + iso.changed('delete from public.vertical_packs'), 0,
  'plans, features and vertical_packs: a member cannot delete from the catalogue');
select is(iso.visible('select 1 from public.platform_admins'), 0,
  'platform_admins: a member cannot see who the platform admins are');

-- Signed out.
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

select is(iso.visible(format('select 1 from public.%I', name)), 0, name || ': a signed-out visitor sees no rows')
  from iso.tables order by name;
select throws_ok(format('insert into public.%I select * from jsonb_populate_record(null::public.%I, %L::jsonb)', name, name, b_row), '42501', null,
                 name || ': a signed-out visitor cannot add a row')
  from iso.tables order by name;
select is(iso.visible('select 1 from public.tenants'), 0, 'tenants: a signed-out visitor sees no business');

-- Part 3: nothing moved ---------------------------------------------------------------------------------------------

reset role;
select is(
  (select array_agg(name order by name) from iso.tables
    where iso.rows_of(name, 'e0000000-0000-0000-0000-00000000000a') <> 1
       or iso.rows_of(name, 'e0000000-0000-0000-0000-00000000000b') <> 1),
  null,
  'after every attempt, each business still has exactly its own row in every business table');

select * from finish();
rollback;
