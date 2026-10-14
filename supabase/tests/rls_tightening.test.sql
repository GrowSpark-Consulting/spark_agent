-- What a member may write inside their own business, and what a visitor may write at all (0046). Run: pnpm db:test
begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

insert into auth.users (id, email) values
  ('0d000000-0000-0000-0000-0000000000a1', 'owner@rls.test'),
  ('0d000000-0000-0000-0000-0000000000a2', 'admin@rls.test'),
  ('0d000000-0000-0000-0000-0000000000a3', 'staff-one@rls.test'),
  ('0d000000-0000-0000-0000-0000000000a4', 'staff-two@rls.test');
insert into public.plans (key, name, price_inr, monthly_credits, seats, whatsapp_numbers, feature_keys) values ('pro', 'Pro', 12999, 15000, 999, 3, array['ai_auto_reply'])
  on conflict (key) do nothing;  -- the seed may already have it; four members need more than a trial's two seats
insert into public.tenants (id, name, vertical, status, plan_key) values ('0d100000-0000-0000-0000-00000000000a', 'RLS A', 'test-pack', 'active', 'pro');
insert into public.memberships (tenant_id, user_id, role) values
  ('0d100000-0000-0000-0000-00000000000a', '0d000000-0000-0000-0000-0000000000a1', 'owner'),
  ('0d100000-0000-0000-0000-00000000000a', '0d000000-0000-0000-0000-0000000000a2', 'admin'),
  ('0d100000-0000-0000-0000-00000000000a', '0d000000-0000-0000-0000-0000000000a3', 'staff'),
  ('0d100000-0000-0000-0000-00000000000a', '0d000000-0000-0000-0000-0000000000a4', 'staff');
insert into public.contacts (id, tenant_id, phone) values
  ('0d200000-0000-0000-0000-0000000000a1', '0d100000-0000-0000-0000-00000000000a', '+919800000501'),
  ('0d200000-0000-0000-0000-0000000000a2', '0d100000-0000-0000-0000-00000000000a', '+919800000502'),
  ('0d200000-0000-0000-0000-0000000000a3', '0d100000-0000-0000-0000-00000000000a', '+919800000503');
insert into public.leads (id, tenant_id, contact_id, stage, owner_user_id) values
  ('0d300000-0000-0000-0000-0000000000a1', '0d100000-0000-0000-0000-00000000000a', '0d200000-0000-0000-0000-0000000000a1', 'new', '0d000000-0000-0000-0000-0000000000a3'),
  ('0d300000-0000-0000-0000-0000000000a2', '0d100000-0000-0000-0000-00000000000a', '0d200000-0000-0000-0000-0000000000a2', 'new', '0d000000-0000-0000-0000-0000000000a4'),
  ('0d300000-0000-0000-0000-0000000000a3', '0d100000-0000-0000-0000-00000000000a', '0d200000-0000-0000-0000-0000000000a3', 'new', null);

create function pg_temp.as_user(u uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
$$;
set local role authenticated;

-- Staff: their own leads only -------------------------------------------------------------------------------------------
select pg_temp.as_user('0d000000-0000-0000-0000-0000000000a3');
select lives_ok($$update public.leads set stage = 'engaged' where id = '0d300000-0000-0000-0000-0000000000a1'$$, 'staff move their own lead');
update public.leads set stage = 'lost' where id = '0d300000-0000-0000-0000-0000000000a2';
update public.leads set stage = 'lost' where id = '0d300000-0000-0000-0000-0000000000a3';
select throws_ok($$update public.leads set owner_user_id = '0d000000-0000-0000-0000-0000000000a4' where id = '0d300000-0000-0000-0000-0000000000a1'$$,
  '42501', null, 'staff cannot hand their lead to someone else');
select throws_ok($$insert into public.consent_logs (tenant_id, contact_id, event, source)
                   values ('0d100000-0000-0000-0000-00000000000a', '0d200000-0000-0000-0000-0000000000a1', 'opted_in', 'dashboard')$$,
  '42501', null, 'staff cannot write a consent entry');

-- Admin and owner: any lead of their business --------------------------------------------------------------------------
select pg_temp.as_user('0d000000-0000-0000-0000-0000000000a2');
select lives_ok($$update public.leads set stage = 'qualified', owner_user_id = '0d000000-0000-0000-0000-0000000000a3' where id = '0d300000-0000-0000-0000-0000000000a3'$$,
  'an admin moves and assigns any lead');
select pg_temp.as_user('0d000000-0000-0000-0000-0000000000a1');
select lives_ok($$update public.leads set stage = 'qualified' where id = '0d300000-0000-0000-0000-0000000000a2'$$, 'an owner moves any lead');
select throws_ok($$insert into public.consent_logs (tenant_id, contact_id, event, source)
                   values ('0d100000-0000-0000-0000-00000000000a', '0d200000-0000-0000-0000-0000000000a1', 'deleted', 'dashboard')$$,
  '42501', null, 'nor can an owner: consent entries come from the server only');

reset role;
select results_eq($$select id::text, stage, owner_user_id::text from public.leads where tenant_id = '0d100000-0000-0000-0000-00000000000a' order by id$$,
  $$values ('0d300000-0000-0000-0000-0000000000a1', 'engaged', '0d000000-0000-0000-0000-0000000000a3'),
           ('0d300000-0000-0000-0000-0000000000a2', 'qualified', '0d000000-0000-0000-0000-0000000000a4'),
           ('0d300000-0000-0000-0000-0000000000a3', 'qualified', '0d000000-0000-0000-0000-0000000000a3')$$,
  'staff left other people''s and unassigned leads alone (their updates matched nothing); owner and admin changes landed');
select is((select count(*)::int from public.consent_logs where tenant_id = '0d100000-0000-0000-0000-00000000000a'), 0, 'and no consent entry was made');

-- The server still writes consent entries ---------------------------------------------------------------------------------
select ok(has_table_privilege('service_role', 'public.consent_logs', 'insert'), 'the server keeps its INSERT on consent_logs');
select ok(not exists (select 1 from pg_policy where polrelid = 'public.consent_logs'::regclass and polcmd in ('a', 'w', 'd', '*')),
  'consent_logs has no write policy for the browser');

-- A visitor who is not signed in writes nothing ---------------------------------------------------------------------------
select is(
  (select coalesce(string_agg(c.relname, ', '), '') from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and (has_table_privilege('anon', c.oid, 'insert') or has_table_privilege('anon', c.oid, 'update')
           or has_table_privilege('anon', c.oid, 'delete') or has_table_privilege('anon', c.oid, 'truncate'))),
  '', 'anon has no write grant on any table or view');
create table public.zz_rls_probe (id int);
select ok(not has_table_privilege('anon', 'public.zz_rls_probe', 'insert'), 'nor on a table created later');
select ok(has_table_privilege('authenticated', 'public.leads', 'select') and has_table_privilege('anon', 'public.plans', 'select') is not null,
  'reads are untouched');

select * from finish();
rollback;
