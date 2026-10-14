-- 0032 and 0040: a business routed through one of our platform numbers (a trial on the shared demo number) is answered,
-- and its staff alerted, through that number; a business with no working number of its own is alerted through our
-- platform number (0040); another business's own number is never used. Run: pnpm db:test
begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

insert into auth.users (id, email) values
  ('0f000000-0000-0000-0000-0000000000a1', 'fallback-trial@test.local'),
  ('0f000000-0000-0000-0000-0000000000a2', 'fallback-own@test.local'),
  ('0f000000-0000-0000-0000-0000000000a3', 'fallback-none@test.local');
-- P: our platform business with the shared demo number. T: a trial routed through it. X: a business with its own number.
-- O: its own number, and an old chat on the demo number. N: no number and no chats.
insert into public.tenants (id, name, vertical) values
  ('0f100000-0000-0000-0000-00000000000b', 'Platform', 'test-pack'),
  ('0f100000-0000-0000-0000-00000000000c', 'Routed trial', 'test-pack'),
  ('0f100000-0000-0000-0000-00000000000d', 'Own number', 'test-pack'),
  ('0f100000-0000-0000-0000-00000000000e', 'Own and old demo chat', 'test-pack'),
  ('0f100000-0000-0000-0000-00000000000f', 'Nothing yet', 'test-pack');
insert into public.channels (id, tenant_id, type) values
  ('0f200000-0000-0000-0000-00000000000b', '0f100000-0000-0000-0000-00000000000b', 'whatsapp'),
  ('0f200000-0000-0000-0000-00000000000d', '0f100000-0000-0000-0000-00000000000d', 'whatsapp'),
  ('0f200000-0000-0000-0000-00000000000e', '0f100000-0000-0000-0000-00000000000e', 'whatsapp');
insert into public.whatsapp_connections (id, tenant_id, channel_id, method, waba_id, phone_number_id, token_enc, token_type, connected_by, status) values
  ('0f300000-0000-0000-0000-00000000000b', '0f100000-0000-0000-0000-00000000000b', '0f200000-0000-0000-0000-00000000000b', 'platform', 'waba-p', 'pn-fallback-demo', 'enc', 'system_user', 'system', 'active'),
  ('0f300000-0000-0000-0000-00000000000d', '0f100000-0000-0000-0000-00000000000d', '0f200000-0000-0000-0000-00000000000d', 'manual_byo', 'waba-x', 'pn-fallback-own', 'enc', 'system_user', 'system', 'active'),
  ('0f300000-0000-0000-0000-00000000000e', '0f100000-0000-0000-0000-00000000000e', '0f200000-0000-0000-0000-00000000000e', 'manual_byo', 'waba-o', 'pn-fallback-own-o', 'enc', 'system_user', 'system', 'active');
insert into public.contacts (id, tenant_id, phone) values
  ('0f400000-0000-0000-0000-00000000000c', '0f100000-0000-0000-0000-00000000000c', '+919800000901'),
  ('0f400000-0000-0000-0000-00000000000d', '0f100000-0000-0000-0000-00000000000d', '+919800000902'),
  ('0f400000-0000-0000-0000-00000000000e', '0f100000-0000-0000-0000-00000000000e', '+919800000903');
insert into public.conversations (id, tenant_id, contact_id, channel_id, last_message_at) values
  -- The routed trial's customer, on the demo number's channel.
  ('0f500000-0000-0000-0000-0000000000c1', '0f100000-0000-0000-0000-00000000000c', '0f400000-0000-0000-0000-00000000000c', '0f200000-0000-0000-0000-00000000000b', now()),
  -- A conversation of the trial pointed at X's channel: X's own number must never be used for it.
  ('0f500000-0000-0000-0000-0000000000c2', '0f100000-0000-0000-0000-00000000000c', '0f400000-0000-0000-0000-00000000000c', '0f200000-0000-0000-0000-00000000000d', null),
  ('0f500000-0000-0000-0000-0000000000d1', '0f100000-0000-0000-0000-00000000000d', '0f400000-0000-0000-0000-00000000000d', '0f200000-0000-0000-0000-00000000000d', now()),
  ('0f500000-0000-0000-0000-0000000000e1', '0f100000-0000-0000-0000-00000000000e', '0f400000-0000-0000-0000-00000000000e', '0f200000-0000-0000-0000-00000000000b', now());
insert into public.memberships (tenant_id, user_id, role, whatsapp_phone) values
  ('0f100000-0000-0000-0000-00000000000c', '0f000000-0000-0000-0000-0000000000a1', 'owner', '+919800000911'),
  ('0f100000-0000-0000-0000-00000000000e', '0f000000-0000-0000-0000-0000000000a2', 'owner', '+919800000912'),
  ('0f100000-0000-0000-0000-00000000000f', '0f000000-0000-0000-0000-0000000000a3', 'owner', '+919800000913');

-- notify_target --------------------------------------------------------------------------------------------------
select is((select connection_id from public.notify_target('0f100000-0000-0000-0000-00000000000c', '0f500000-0000-0000-0000-0000000000c1')),
  '0f300000-0000-0000-0000-00000000000b'::uuid, 'a routed trial''s chat is answered through the demo number it came in on');
select is((select connection_id from public.notify_target('0f100000-0000-0000-0000-00000000000d', '0f500000-0000-0000-0000-0000000000d1')),
  '0f300000-0000-0000-0000-00000000000d'::uuid, 'a business with its own number still uses it');
select throws_ok($$select * from public.notify_target('0f100000-0000-0000-0000-00000000000c', '0f500000-0000-0000-0000-0000000000c2')$$,
  'PA409', null, 'another business''s own number is never used, whatever channel a chat points at');
select throws_ok($$select * from public.notify_target('0f100000-0000-0000-0000-00000000000c', null, '+919800000999')$$,
  'PA409', null, 'a test message still needs the business''s own number');
-- End to end with Dev 1's 0031: a visitor's message stored for the routed trial on the demo channel is answered there.
select is((select connection_id from public.notify_target('0f100000-0000-0000-0000-00000000000c',
            (select conversation_id from public.store_inbound_message('0f100000-0000-0000-0000-00000000000c', '0f200000-0000-0000-0000-00000000000b',
               '+919800000904', 'Visitor', 'wamid.fallback-1', 'text', 'Hi', null, null, now())))),
  '0f300000-0000-0000-0000-00000000000b'::uuid, 'a chat stored by the demo routing (0031) is answered through the demo number');

-- notify_staff_target --------------------------------------------------------------------------------------------
select is((select connection_id from public.notify_staff_target('0f100000-0000-0000-0000-00000000000c', '0f000000-0000-0000-0000-0000000000a1')),
  '0f300000-0000-0000-0000-00000000000b'::uuid, 'a routed trial''s staff are alerted through the demo number');
select results_eq(
  $$select c.channel_id, c.mode, 'staff' = any(ct.tags) from public.conversations c join public.contacts ct on ct.id = c.contact_id
     where c.tenant_id = '0f100000-0000-0000-0000-00000000000c' and ct.phone = '+919800000911'$$,
  $$values ('0f200000-0000-0000-0000-00000000000b'::uuid, 'human'::text, true)$$,
  'the alert is stored in the trial''s own business, on the demo number''s channel, in human mode with a staff contact');
select is((select connection_id from public.notify_staff_target('0f100000-0000-0000-0000-00000000000e', '0f000000-0000-0000-0000-0000000000a2')),
  '0f300000-0000-0000-0000-00000000000e'::uuid, 'a business with its own number alerts through it, even with an old demo chat');
select is((select connection_id from public.notify_staff_target('0f100000-0000-0000-0000-00000000000f', '0f000000-0000-0000-0000-0000000000a3')),
  '0f300000-0000-0000-0000-00000000000b'::uuid, 'a business with no number and no chats is alerted through our platform number (0040)');
select results_eq(
  $$select c.channel_id, 'staff' = any(ct.tags) from public.conversations c join public.contacts ct on ct.id = c.contact_id
     where c.tenant_id = '0f100000-0000-0000-0000-00000000000f' and ct.phone = '+919800000913'$$,
  $$values ('0f200000-0000-0000-0000-00000000000b'::uuid, true)$$,
  'its alert is stored in its own business, on the platform number''s channel, with a staff contact');
-- A business whose own number has failed: the platform number too.
update public.whatsapp_connections set status = 'failed' where id = '0f300000-0000-0000-0000-00000000000d';
insert into public.memberships (tenant_id, user_id, role, whatsapp_phone) values ('0f100000-0000-0000-0000-00000000000d', '0f000000-0000-0000-0000-0000000000a3', 'owner', '+919800000914');
select is((select connection_id from public.notify_staff_target('0f100000-0000-0000-0000-00000000000d', '0f000000-0000-0000-0000-0000000000a3')),
  '0f300000-0000-0000-0000-00000000000b'::uuid, 'a business whose only number failed is alerted through the platform number');
-- With no platform number active either, there is nothing to send through.
update public.whatsapp_connections set status = 'failed' where id = '0f300000-0000-0000-0000-00000000000b';
select throws_ok($$select * from public.notify_staff_target('0f100000-0000-0000-0000-00000000000f', '0f000000-0000-0000-0000-0000000000a3')$$,
  'PA409', null, 'with no number of its own and no active platform number, nothing to alert through');
update public.whatsapp_connections set status = 'active' where id = '0f300000-0000-0000-0000-00000000000b';

set local role authenticated;
select throws_ok($$select * from public.notify_target('0f100000-0000-0000-0000-00000000000c', '0f500000-0000-0000-0000-0000000000c1')$$,
  '42501', null, 'the browser still cannot call notify_target');
reset role;

select * from finish();
rollback;
