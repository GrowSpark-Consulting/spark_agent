-- A keyed send is claimed before WhatsApp is asked (0045). Run: pnpm db:test
begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

insert into public.tenants (id, name, vertical) values
  ('0b100000-0000-0000-0000-00000000000a', 'Sends A', 'test-pack'),
  ('0b100000-0000-0000-0000-00000000000b', 'Sends B', 'test-pack');
insert into public.contacts (id, tenant_id, phone) values ('0b200000-0000-0000-0000-00000000000a', '0b100000-0000-0000-0000-00000000000a', '+919800000401');
insert into public.channels (id, tenant_id, type) values ('0b300000-0000-0000-0000-00000000000a', '0b100000-0000-0000-0000-00000000000a', 'whatsapp');
insert into public.conversations (id, tenant_id, contact_id, channel_id) values
  ('0b400000-0000-0000-0000-00000000000a', '0b100000-0000-0000-0000-00000000000a', '0b200000-0000-0000-0000-00000000000a', '0b300000-0000-0000-0000-00000000000a');

select is(public.claim_notify_attempt('0b100000-0000-0000-0000-00000000000a', '0b500000-0000-0000-0000-000000000001', 'ai_reply'), 'claimed',
  'the first attempt claims the message');
select is(public.claim_notify_attempt('0b100000-0000-0000-0000-00000000000a', '0b500000-0000-0000-0000-000000000001', 'ai_reply'), 'in_doubt',
  'a repeat while it is claimed and not recorded (the attempt died, or its record failed) may not send');
select is(public.claim_notify_attempt('0b100000-0000-0000-0000-00000000000b', '0b500000-0000-0000-0000-000000000001', 'ai_reply'), 'in_doubt',
  'and another business cannot take the claim over');

select public.release_notify_attempt('0b100000-0000-0000-0000-00000000000b', '0b500000-0000-0000-0000-000000000001');
select is(public.claim_notify_attempt('0b100000-0000-0000-0000-00000000000a', '0b500000-0000-0000-0000-000000000001', 'ai_reply'), 'in_doubt',
  'nor release it');
select public.release_notify_attempt('0b100000-0000-0000-0000-00000000000a', '0b500000-0000-0000-0000-000000000001');
select is((select status from public.notify_attempts where message_id = '0b500000-0000-0000-0000-000000000001'), 'released',
  'WhatsApp refused it for certain: the claim is released');
select is(public.claim_notify_attempt('0b100000-0000-0000-0000-00000000000a', '0b500000-0000-0000-0000-000000000001', 'ai_reply'), 'claimed',
  'so the next attempt may send');

insert into public.messages (id, tenant_id, conversation_id, direction, sender, body)
values ('0b500000-0000-0000-0000-000000000001', '0b100000-0000-0000-0000-00000000000a', '0b400000-0000-0000-0000-00000000000a', 'out', 'ai', 'sent');
select is(public.claim_notify_attempt('0b100000-0000-0000-0000-00000000000a', '0b500000-0000-0000-0000-000000000001', 'ai_reply'), 'sent',
  'once it is recorded, a repeat is told it went');
select public.release_notify_attempt('0b100000-0000-0000-0000-00000000000a', '0b500000-0000-0000-0000-000000000001');
select is(public.claim_notify_attempt('0b100000-0000-0000-0000-00000000000a', '0b500000-0000-0000-0000-000000000001', 'ai_reply'), 'sent',
  'and a stray release changes nothing about a recorded message');

select ok(not has_function_privilege('authenticated', 'public.claim_notify_attempt(uuid, uuid, text)', 'execute')
          and not has_function_privilege('authenticated', 'public.release_notify_attempt(uuid, uuid)', 'execute'), 'server only: functions');
select ok(not has_table_privilege('authenticated', 'public.notify_attempts', 'select') and not has_table_privilege('anon', 'public.notify_attempts', 'insert'),
  'and the table');

select * from finish();
rollback;
