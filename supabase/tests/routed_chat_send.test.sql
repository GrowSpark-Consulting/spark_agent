-- The chain a visitor to the shared demo number goes through, end to end in the database (Day 6): demo_admit (0029) starts the route, store_inbound_message
-- (0031) stores the chat under the routed business on the platform number's channel, and Dev 2's notify_target and notify_staff_target (0032) find the
-- platform connection to answer on. If any of the three changes, this fails. Run: pnpm db:test
begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

insert into auth.users (id, email) values ('c9000000-0000-0000-0000-000000000001', 'routed-owner@test.local');
insert into public.tenants (id, name, vertical, status) values
  ('c1000000-0000-0000-0000-00000000000a', 'Platform business', 'test-pack', 'active'),   -- owns the demo number's connection (the front desk)
  ('c1000000-0000-0000-0000-00000000000b', 'Routed trial',      'test-pack', 'trial'),    -- a business a code routes to
  ('c1000000-0000-0000-0000-00000000000c', 'Other business',    'test-pack', 'trial');    -- never written to on the platform number
insert into public.channels (id, tenant_id, type) values ('c2000000-0000-0000-0000-00000000000a', 'c1000000-0000-0000-0000-00000000000a', 'whatsapp');
insert into public.whatsapp_connections (id, tenant_id, channel_id, method, waba_id, phone_number_id, token_enc, token_type, status, connected_by)
  values ('c3000000-0000-0000-0000-00000000000a', 'c1000000-0000-0000-0000-00000000000a', 'c2000000-0000-0000-0000-00000000000a', 'platform', 'chain-waba', 'chain-demo-pn', 'enc', 'system_user', 'active', 'system:seed');
insert into public.memberships (tenant_id, user_id, role, whatsapp_phone) values
  ('c1000000-0000-0000-0000-00000000000b', 'c9000000-0000-0000-0000-000000000001', 'owner', '+919800000999'),
  ('c1000000-0000-0000-0000-00000000000c', 'c9000000-0000-0000-0000-000000000001', 'owner', '+919800000998');

create temp table admitted as
  select * from public.demo_admit('+919800000777', 'wamid.chain1', 30, timestamptz '2026-10-13 10:00:00+05:30', 'c1000000-0000-0000-0000-00000000000b');
select is((select allowed::text || '/' || message_tenant_id::text from admitted), 'true/c1000000-0000-0000-0000-00000000000b', 'a valid code is admitted and routed to its business');

create temp table stored as
  select * from public.store_inbound_message('c1000000-0000-0000-0000-00000000000b', 'c2000000-0000-0000-0000-00000000000a', '+919800000777', 'Visitor', 'wamid.chain1', 'text', 'Hi', null, '{"routeCode":"DEMO-X"}'::jsonb, timestamptz '2026-10-13 10:00:01+05:30');
select is((select c.tenant_id::text || '/' || c.channel_id::text from public.conversations c where c.id = (select conversation_id from stored)),
  'c1000000-0000-0000-0000-00000000000b/c2000000-0000-0000-0000-00000000000a', 'the chat is the routed business''s, on the platform number''s channel');
select is((select inserted from public.store_inbound_message('c1000000-0000-0000-0000-00000000000b', 'c2000000-0000-0000-0000-00000000000a', '+919800000777', 'Visitor', 'wamid.chain1', 'text', 'Hi', null, '{}'::jsonb, timestamptz '2026-10-13 10:00:02+05:30')),
  false, 'a redelivered message stores nothing new');

select is((select connection_id from public.notify_target('c1000000-0000-0000-0000-00000000000b', (select conversation_id from stored))),
  'c3000000-0000-0000-0000-00000000000a'::uuid, 'an answer in that chat goes out on the platform connection');
select is((select connection_id from public.notify_staff_target('c1000000-0000-0000-0000-00000000000b', 'c9000000-0000-0000-0000-000000000001')),
  'c3000000-0000-0000-0000-00000000000a'::uuid, 'an alert to that business''s staff goes out on the platform connection too');
-- 0040 (Dev 2, at Dev 1's request): with no number of its own and no chat on ours, the alert goes through the platform number.
select is((select connection_id from public.notify_staff_target('c1000000-0000-0000-0000-00000000000c', 'c9000000-0000-0000-0000-000000000001')),
  'c3000000-0000-0000-0000-00000000000a'::uuid, 'a business with no chat on the platform number is alerted through it all the same (0040)');

-- The front desk: a visitor with no route is stored with the business that owns the connection, which answers on its own row.
create temp table desk as
  select * from public.store_inbound_message('c1000000-0000-0000-0000-00000000000a', 'c2000000-0000-0000-0000-00000000000a', '+919800000888', 'No code', 'wamid.chain2', 'text', 'hello', null, '{}'::jsonb, timestamptz '2026-10-13 10:05:00+05:30');
select is((select connection_id from public.notify_target('c1000000-0000-0000-0000-00000000000a', (select conversation_id from desk))),
  'c3000000-0000-0000-0000-00000000000a'::uuid, 'the front desk answers on the platform connection it owns');

-- A message id belongs to one business: a redelivery of the front desk's message cannot be stored for the routed one (the router decides a redelivery by its holder).
select throws_ok(
  $$select * from public.store_inbound_message('c1000000-0000-0000-0000-00000000000b', 'c2000000-0000-0000-0000-00000000000a', '+919800000888', 'No code', 'wamid.chain2', 'text', 'hello', null, '{}'::jsonb, now())$$,
  'PA409', null, 'a message id the front desk holds is refused for another business');

-- Delivery statuses: an outbound message is recorded under the business of its chat, so that is the business a status is applied for.
insert into public.messages (tenant_id, conversation_id, direction, sender, body, provider_msg_id, delivery_status)
  values ('c1000000-0000-0000-0000-00000000000b', (select conversation_id from stored), 'out', 'ai', 'hello', 'wamid.chain-out', 'accepted');
select is(public.apply_message_status('c1000000-0000-0000-0000-00000000000a', 'wamid.chain-out', 'delivered'), false, 'a status is not applied for the business that owns the number''s connection');
select is(public.apply_message_status('c1000000-0000-0000-0000-00000000000b', 'wamid.chain-out', 'delivered'), true, 'it is applied for the routed business, whose chat holds the message');

select * from finish();
rollback;
