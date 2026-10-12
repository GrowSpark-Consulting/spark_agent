-- Owner and admin only writes (0028): services, resources, catalog_items and the business's own settings; staff read
-- them, and still move leads and set their own alert number. Run: pnpm db:test
begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

insert into auth.users (id, email) values
  ('0e000000-0000-0000-0000-0000000000a1', 'roles-owner@test.local'),
  ('0e000000-0000-0000-0000-0000000000a2', 'roles-admin@test.local'),
  ('0e000000-0000-0000-0000-0000000000a3', 'roles-staff@test.local');
insert into public.plans (key, name, price_inr, monthly_credits, seats, whatsapp_numbers, feature_keys)
  values ('pro', 'Pro', 12999, 15000, 999, 3, array['ai_auto_reply'])
  on conflict (key) do nothing;  -- the seed may already have it
insert into public.tenants (id, name, vertical, plan_key) values ('0e100000-0000-0000-0000-000000000001', 'Roles', 'test-pack', 'pro');
insert into public.memberships (tenant_id, user_id, role) values
  ('0e100000-0000-0000-0000-000000000001', '0e000000-0000-0000-0000-0000000000a1', 'owner'),
  ('0e100000-0000-0000-0000-000000000001', '0e000000-0000-0000-0000-0000000000a2', 'admin'),
  ('0e100000-0000-0000-0000-000000000001', '0e000000-0000-0000-0000-0000000000a3', 'staff');
insert into public.services (id, tenant_id, name, duration_min, resource_type) values
  ('0e200000-0000-0000-0000-000000000001', '0e100000-0000-0000-0000-000000000001', 'Visit', 60, 'staff');
insert into public.resources (id, tenant_id, type, name) values
  ('0e300000-0000-0000-0000-000000000001', '0e100000-0000-0000-0000-000000000001', 'staff', 'Asha');
insert into public.catalog_items (id, tenant_id, type, title) values
  ('0e400000-0000-0000-0000-000000000001', '0e100000-0000-0000-0000-000000000001', 'property', 'Towers');
insert into public.contacts (id, tenant_id, phone) values ('0e500000-0000-0000-0000-000000000001', '0e100000-0000-0000-0000-000000000001', '+919800000501');
insert into public.leads (id, tenant_id, contact_id) values ('0e600000-0000-0000-0000-000000000001', '0e100000-0000-0000-0000-000000000001', '0e500000-0000-0000-0000-000000000001');

create function pg_temp.changed(p_sql text) returns int language plpgsql as $$
declare n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end $$;

-- Staff ------------------------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"0e000000-0000-0000-0000-0000000000a3","role":"authenticated"}', true);

select is((select count(*)::int from public.services) + (select count(*)::int from public.resources) + (select count(*)::int from public.catalog_items), 3,
  'staff still read the services, resources and catalog');
select throws_ok($$insert into public.services (tenant_id, name, duration_min, resource_type) values ('0e100000-0000-0000-0000-000000000001', 'New', 30, 'staff')$$,
  '42501', null, 'staff cannot add a service');
select is(pg_temp.changed($$update public.services set name = 'Renamed' where id = '0e200000-0000-0000-0000-000000000001'$$), 0, 'staff cannot change a service');
select is(pg_temp.changed($$delete from public.services where id = '0e200000-0000-0000-0000-000000000001'$$), 0, 'staff cannot delete a service');
select throws_ok($$insert into public.resources (tenant_id, type, name) values ('0e100000-0000-0000-0000-000000000001', 'staff', 'New')$$,
  '42501', null, 'staff cannot add a resource');
select is(pg_temp.changed($$update public.resources set name = 'Renamed' where id = '0e300000-0000-0000-0000-000000000001'$$), 0, 'staff cannot change a resource');
select throws_ok($$insert into public.catalog_items (tenant_id, type, title) values ('0e100000-0000-0000-0000-000000000001', 'property', 'New')$$,
  '42501', null, 'staff cannot add to the catalog');
select is(pg_temp.changed($$delete from public.catalog_items where id = '0e400000-0000-0000-0000-000000000001'$$), 0, 'staff cannot delete from the catalog');
select is(pg_temp.changed($$update public.tenants set agent_settings = '{"persona":"Raj"}' where id = '0e100000-0000-0000-0000-000000000001'$$), 0,
  'staff cannot change the business''s settings');
select is(pg_temp.changed($$update public.leads set stage = 'qualified' where id = '0e600000-0000-0000-0000-000000000001'$$), 1, 'staff still move a lead');
select is(pg_temp.changed($$update public.memberships set whatsapp_phone = '+919800000502' where user_id = '0e000000-0000-0000-0000-0000000000a3'$$), 1,
  'staff still set their own alert number');

-- Admin ------------------------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"0e000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
select lives_ok($$insert into public.services (tenant_id, name, duration_min, resource_type) values ('0e100000-0000-0000-0000-000000000001', 'Call', 30, 'staff')$$,
  'an admin adds a service');
select is(pg_temp.changed($$update public.resources set name = 'Asha R' where id = '0e300000-0000-0000-0000-000000000001'$$), 1, 'an admin changes a resource');
select lives_ok($$insert into public.catalog_items (tenant_id, type, title) values ('0e100000-0000-0000-0000-000000000001', 'property', 'Meadows')$$,
  'an admin adds to the catalog');
select is(pg_temp.changed($$update public.tenants set timezone = 'Asia/Kolkata' where id = '0e100000-0000-0000-0000-000000000001'$$), 1,
  'an admin changes the business''s settings');
select throws_ok($$update public.tenants set plan_key = 'starter' where id = '0e100000-0000-0000-0000-000000000001'$$,
  '42501', null, 'an admin still cannot change the plan (a column members are never granted)');

-- Owner ------------------------------------------------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"0e000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
select is(pg_temp.changed($$delete from public.catalog_items where title = 'Meadows'$$), 1, 'an owner deletes from the catalog');
select is(pg_temp.changed($$update public.tenants set agent_settings = '{"persona":"Maya"}' where id = '0e100000-0000-0000-0000-000000000001'$$), 1,
  'an owner changes the business''s settings');

reset role;
select is((select name from public.services where id = '0e200000-0000-0000-0000-000000000001'), 'Visit', 'the staff member''s attempts changed nothing');

select * from finish();
rollback;
