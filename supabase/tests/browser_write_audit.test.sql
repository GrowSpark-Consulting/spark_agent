-- Every change a member makes straight from the dashboard is audited (0049). Run: pnpm db:test
begin;
create extension if not exists pgtap with schema extensions;
select plan(14);

insert into auth.users (id, email) values
  ('0e900000-0000-0000-0000-0000000000a1', 'owner@audit.test'),
  ('0e900000-0000-0000-0000-0000000000a2', 'staff@audit.test');
insert into public.tenants (id, name, vertical) values ('0e910000-0000-0000-0000-00000000000a', 'Audit A', 'test-pack');
insert into public.memberships (tenant_id, user_id, role) values
  ('0e910000-0000-0000-0000-00000000000a', '0e900000-0000-0000-0000-0000000000a1', 'owner'),
  ('0e910000-0000-0000-0000-00000000000a', '0e900000-0000-0000-0000-0000000000a2', 'staff');
insert into public.contacts (id, tenant_id, phone) values ('0e920000-0000-0000-0000-00000000000a', '0e910000-0000-0000-0000-00000000000a', '+919800000701');
insert into public.leads (id, tenant_id, contact_id, stage, owner_user_id, fields) values
  ('0e930000-0000-0000-0000-00000000000a', '0e910000-0000-0000-0000-00000000000a', '0e920000-0000-0000-0000-00000000000a', 'new',
   '0e900000-0000-0000-0000-0000000000a2', '{"budget": "80L"}');
delete from public.audit_logs where tenant_id = '0e910000-0000-0000-0000-00000000000a';  -- the fixtures were the server's: not audited anyway

create function pg_temp.as_user(u uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.last_audit() returns table (actor text, action text, entity text, diff jsonb) language sql as $$
  select a.actor, a.action, a.entity, a.diff from public.audit_logs a where a.tenant_id = '0e910000-0000-0000-0000-00000000000a' order by a.id desc limit 1;
$$;
create function pg_temp.audits() returns int language sql as $$
  select count(*)::int from public.audit_logs where tenant_id = '0e910000-0000-0000-0000-00000000000a';
$$;

set local role authenticated;

-- The owner: the business's settings and its services ----------------------------------------------------------------------
select pg_temp.as_user('0e900000-0000-0000-0000-0000000000a1');
update public.tenants set name = 'Audit A Homes' where id = '0e910000-0000-0000-0000-00000000000a';
select results_eq($$select actor, action, entity, diff from pg_temp.last_audit()$$,
  $$values ('0e900000-0000-0000-0000-0000000000a1'::text, 'tenant.updated'::text, 'tenant'::text,
            '{"changed": ["name"], "name": {"from": "Audit A", "to": "Audit A Homes"}}'::jsonb)$$,
  'the owner renaming the business is audited, naming them, with the old and new name');
update public.tenants set agent_settings = '{"persona": "Priya", "tone": "warm"}' where id = '0e910000-0000-0000-0000-00000000000a';
select results_eq($$select action, diff from pg_temp.last_audit()$$, $$values ('tenant.updated'::text, '{"changed": ["agent_settings"]}'::jsonb)$$,
  'agent settings: which column changed, not its text');
insert into public.services (id, tenant_id, name, duration_min, resource_type) values
  ('0e940000-0000-0000-0000-00000000000a', '0e910000-0000-0000-0000-00000000000a', 'Site visit', 60, 'staff');
select results_eq($$select action, entity from pg_temp.last_audit()$$, $$values ('service.created'::text, 'service'::text)$$, 'a new service is audited');
update public.services set duration_min = 45 where id = '0e940000-0000-0000-0000-00000000000a';
select is((select diff -> 'duration_min' from pg_temp.last_audit()), '{"from": 60, "to": 45}'::jsonb, 'with what changed');
delete from public.services where id = '0e940000-0000-0000-0000-00000000000a';
select is((select action from pg_temp.last_audit()), 'service.deleted', 'and its removal');

-- Staff: their own lead and their own alert number ------------------------------------------------------------------------------
select pg_temp.as_user('0e900000-0000-0000-0000-0000000000a2');
update public.leads set stage = 'engaged', fields = '{"budget": "90L"}' where id = '0e930000-0000-0000-0000-00000000000a';
select results_eq($$select actor, action, diff from pg_temp.last_audit()$$,
  $$values ('0e900000-0000-0000-0000-0000000000a2'::text, 'lead.updated'::text,
            '{"changed": ["fields", "stage"], "stage": {"from": "new", "to": "engaged"}}'::jsonb)$$,
  'staff moving their lead: the stage from and to, the customer''s fields named but never shown');
select ok((select diff::text not like '%90L%' and diff::text not like '%80L%' from pg_temp.last_audit()), 'no customer detail in the audit');
update public.memberships set whatsapp_phone = '+919800000799' where user_id = '0e900000-0000-0000-0000-0000000000a2';
select results_eq($$select action, diff from pg_temp.last_audit()$$, $$values ('membership.updated'::text, '{"changed": ["whatsapp_phone"]}'::jsonb)$$,
  'a member''s own alert number: named, never the number');
select ok((select diff::text not like '%9800000799%' from pg_temp.last_audit()), 'the number is not in the audit');

-- What is not audited here ------------------------------------------------------------------------------------------------------
select pg_temp.audits() as before_noop \gset
update public.leads set stage = 'engaged' where id = '0e930000-0000-0000-0000-00000000000a';
select is(pg_temp.audits(), :before_noop, 'an update that changes nothing is not a change');

reset role;
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);  -- the server: no member
select pg_temp.audits() as before_server \gset
update public.leads set stage = 'qualified' where id = '0e930000-0000-0000-0000-00000000000a';
select is(pg_temp.audits(), :before_server, 'the server''s own write is not audited here (the server audits it itself)');

select ok(exists (select 1 from pg_trigger where tgname = 'audit_browser_write' and tgrelid = 'public.quotes'::regclass)
          and exists (select 1 from pg_trigger where tgname = 'audit_browser_write' and tgrelid = 'public.catalog_items'::regclass)
          and exists (select 1 from pg_trigger where tgname = 'audit_browser_write' and tgrelid = 'public.resources'::regclass),
  'quotes, catalog items and resources are audited the same way');
select is((select count(*)::int from pg_trigger t join pg_class c on c.oid = t.tgrelid
            where t.tgname = 'audit_browser_write' and c.relnamespace = 'public'::regnamespace), 7,
  'every table the browser may write is audited: tenants, services, resources, catalog_items, quotes, leads, memberships');
select ok(not has_function_privilege('authenticated', 'public.audit_browser_write()', 'execute')
          and not has_function_privilege('anon', 'public.audit_browser_write()', 'execute'), 'nobody calls it directly');

select * from finish();
rollback;
