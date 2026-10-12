-- notify_staff_target (0019): where a staff alert goes. Run: pnpm db:test
begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000006a1', 'staff-owner@test.local'),
  ('00000000-0000-0000-0000-0000000006a2', 'staff-admin@test.local'),
  ('00000000-0000-0000-0000-0000000006a3', 'staff-nophone@test.local'),
  ('00000000-0000-0000-0000-0000000006a4', 'staff-badphone@test.local'),
  ('00000000-0000-0000-0000-0000000006b1', 'staff-other@test.local'),
  ('00000000-0000-0000-0000-0000000006c1', 'staff-offline@test.local');
-- Staff Alerts has four members, so it is on Pro (0027 refuses more members than the plan's seats).
insert into public.plans (key, name, price_inr, monthly_credits, seats, whatsapp_numbers, feature_keys)
  values ('pro', 'Pro', 12999, 15000, 999, 3, array['staff_alerts'])
  on conflict (key) do nothing;  -- the seed may already have it
insert into public.tenants (id, name, vertical, plan_key) values
  ('b6000000-0000-0000-0000-00000000000a', 'Staff Alerts', 'test-pack', 'pro');
insert into public.tenants (id, name, vertical) values
  ('b6000000-0000-0000-0000-00000000000b', 'Staff Other', 'test-pack'),
  ('b6000000-0000-0000-0000-00000000000c', 'Staff Offline', 'test-pack');
insert into public.memberships (tenant_id, user_id, role, whatsapp_phone) values
  ('b6000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000006a1', 'owner', '+919800061001'),
  ('b6000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000006a2', 'admin', '+919800061002'),
  ('b6000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000006a3', 'staff', null),
  ('b6000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000006a4', 'staff', '98000 61004'),
  ('b6000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-0000000006b1', 'owner', '+919800061011'),
  ('b6000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-0000000006c1', 'owner', '+919800061021');
insert into public.channels (id, tenant_id, type) values
  ('b6100000-0000-0000-0000-00000000000a', 'b6000000-0000-0000-0000-00000000000a', 'whatsapp'),
  ('b6100000-0000-0000-0000-00000000000c', 'b6000000-0000-0000-0000-00000000000c', 'whatsapp');
insert into public.whatsapp_connections
  (id, tenant_id, channel_id, method, waba_id, phone_number_id, token_enc, token_type, connected_by, status) values
  ('b6200000-0000-0000-0000-00000000000a', 'b6000000-0000-0000-0000-00000000000a', 'b6100000-0000-0000-0000-00000000000a',
   'manual_byo', 's-waba-a', 's-pnid-a', 'placeholder', 'system_user', 'admin:test', 'active'),
  ('b6200000-0000-0000-0000-00000000000c', 'b6000000-0000-0000-0000-00000000000c', 'b6100000-0000-0000-0000-00000000000c',
   'manual_byo', 's-waba-c', 's-pnid-c', 'placeholder', 'system_user', 'admin:test', 'pending');
-- The admin has also messaged the business as a customer: an open AI conversation already exists.
insert into public.contacts (id, tenant_id, phone, name, tags) values
  ('b6300000-0000-0000-0000-000000000002', 'b6000000-0000-0000-0000-00000000000a', '+919800061002', 'Admin As Customer', array['vip']);
insert into public.conversations (id, tenant_id, contact_id, channel_id, mode) values
  ('b6400000-0000-0000-0000-000000000002', 'b6000000-0000-0000-0000-00000000000a', 'b6300000-0000-0000-0000-000000000002',
   'b6100000-0000-0000-0000-00000000000a', 'ai');

create temporary table t1 on commit drop as
  select * from public.notify_staff_target('b6000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000006a1');
create temporary table t2 on commit drop as
  select * from public.notify_staff_target('b6000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000006a1');

select results_eq($$select connection_id, to_phone, opted_out, recent_test_messages from t1$$,
  $$values ('b6200000-0000-0000-0000-00000000000a'::uuid, '+919800061001'::text, false, 0)$$,
  'a member''s alert number resolves on the business''s active connection');
select results_eq(
  $$select ct.tags, c.mode from t1 join public.contacts ct on ct.id = t1.contact_id join public.conversations c on c.id = t1.conversation_id$$,
  $$values (array['staff'], 'human'::text)$$,
  'the number becomes a contact tagged staff, in a conversation the AI does not answer');
select results_eq($$select contact_id, conversation_id from t2$$, $$select contact_id, conversation_id from t1$$,
  'a second alert reuses the same contact and conversation');

select public.notify_staff_target('b6000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000006a2');
select public.notify_staff_target('b6000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000006a2');
select results_eq($$select tags from public.contacts where id = 'b6300000-0000-0000-0000-000000000002'$$,
  $$values (array['vip', 'staff'])$$, 'a member who is already a contact is tagged staff once, keeping their tags');
select is((select conversation_id from public.notify_staff_target('b6000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000006a2')),
  'b6400000-0000-0000-0000-000000000002'::uuid, 'their open conversation is reused, not duplicated');

select throws_ok($$select * from public.notify_staff_target('b6000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000006a3')$$,
  'PA404', null, 'a member with no alert number is not found');
select throws_ok($$select * from public.notify_staff_target('b6000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000006a4')$$,
  'PA404', null, 'an alert number that is not E.164 is not used');
select throws_ok($$select * from public.notify_staff_target('b6000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000006b1')$$,
  'PA404', null, 'another business''s member is not found');
select throws_ok($$select * from public.notify_staff_target('b6000000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-0000000006c1')$$,
  'PA409', null, 'a business with no active connection is reported as not connected');

select ok(not has_function_privilege('authenticated', 'public.notify_staff_target(uuid, uuid)', 'execute')
      and not has_function_privilege('anon', 'public.notify_staff_target(uuid, uuid)', 'execute')
      and has_function_privilege('service_role', 'public.notify_staff_target(uuid, uuid)', 'execute'),
  'only the server can call notify_staff_target');

select * from finish();
rollback;
