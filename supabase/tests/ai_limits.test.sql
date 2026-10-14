-- Rate limits and the daily AI spend cap (0044). Run: pnpm db:test
begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

insert into public.plans (key, name, price_inr, monthly_credits, seats, whatsapp_numbers, feature_keys) values
  ('starter', 'Starter', 2499, 1500, 2, 1, array['ai_auto_reply']),
  ('trial', 'Trial', 0, 300, 2, 1, array['ai_auto_reply'])
  on conflict (key) do nothing;  -- the seed may already have them
insert into public.tenants (id, name, vertical, status, plan_key) values
  ('0a100000-0000-0000-0000-00000000000a', 'Limits A', 'test-pack', 'active', 'starter'),
  ('0a100000-0000-0000-0000-00000000000b', 'Limits B', 'test-pack', 'trial', 'trial');
insert into public.contacts (id, tenant_id, phone) values
  ('0a200000-0000-0000-0000-0000000000a1', '0a100000-0000-0000-0000-00000000000a', '+919800000301'),
  ('0a200000-0000-0000-0000-0000000000a2', '0a100000-0000-0000-0000-00000000000a', '+919800000302');
insert into public.channels (id, tenant_id, type) values ('0a300000-0000-0000-0000-00000000000a', '0a100000-0000-0000-0000-00000000000a', 'whatsapp');
insert into public.conversations (id, tenant_id, contact_id, channel_id) values
  ('0a400000-0000-0000-0000-0000000000a1', '0a100000-0000-0000-0000-00000000000a', '0a200000-0000-0000-0000-0000000000a1', '0a300000-0000-0000-0000-00000000000a'),
  ('0a400000-0000-0000-0000-0000000000a2', '0a100000-0000-0000-0000-00000000000a', '0a200000-0000-0000-0000-0000000000a2', '0a300000-0000-0000-0000-00000000000a');
-- Chat 1: 3 AI replies this hour and 1 two hours ago; chat 2: 2 this hour; plus a staff reply and a customer message, which don't count.
insert into public.messages (tenant_id, conversation_id, direction, sender, body, created_at)
select '0a100000-0000-0000-0000-00000000000a', c, 'out', 'ai', 'reply', at from (values
  ('0a400000-0000-0000-0000-0000000000a1'::uuid, now() - interval '5 minutes'),
  ('0a400000-0000-0000-0000-0000000000a1', now() - interval '20 minutes'),
  ('0a400000-0000-0000-0000-0000000000a1', now() - interval '50 minutes'),
  ('0a400000-0000-0000-0000-0000000000a1', now() - interval '2 hours'),
  ('0a400000-0000-0000-0000-0000000000a2', now() - interval '10 minutes'),
  ('0a400000-0000-0000-0000-0000000000a2', now() - interval '30 minutes')) as v(c, at);
insert into public.messages (tenant_id, conversation_id, direction, sender, body) values
  ('0a100000-0000-0000-0000-00000000000a', '0a400000-0000-0000-0000-0000000000a1', 'out', 'staff', 'staff reply'),
  ('0a100000-0000-0000-0000-00000000000a', '0a400000-0000-0000-0000-0000000000a1', 'in', 'customer', 'hello');

-- The hourly counts --------------------------------------------------------------------------------------------------------
select results_eq($$select contact_replies_hour, tenant_replies_hour from public.ai_limits('0a100000-0000-0000-0000-00000000000a', '0a400000-0000-0000-0000-0000000000a1')$$,
  $$values (3, 5)$$, 'AI replies in the last hour: this chat''s, and the whole business''s (staff replies and older ones don''t count)');
select results_eq($$select contact_replies_hour from public.ai_limits('0a100000-0000-0000-0000-00000000000a')$$, $$values (0)$$,
  'without a chat, only the business''s count');

-- The cap and today's spend --------------------------------------------------------------------------------------------------
select results_eq($$select spend_today_usd, cap_usd from public.ai_limits('0a100000-0000-0000-0000-00000000000a')$$,
  $$values (0::numeric, 3.000::numeric)$$, 'nothing spent yet; a Starter plan''s default cap is 1,500 credits x 0.002 = USD 3');
select results_eq($$select cap_usd from public.ai_limits('0a100000-0000-0000-0000-00000000000b')$$, $$values (1.00::numeric)$$,
  'a trial''s 300 credits would give 0.6: the floor is USD 1');

select lives_ok($$select public.record_ai_spend('0a100000-0000-0000-0000-00000000000a', 0.0125)$$, 'a call is recorded');
select public.record_ai_spend('0a100000-0000-0000-0000-00000000000a', 0.0075);
select public.record_ai_spend('0a100000-0000-0000-0000-00000000000a', null);
select public.record_ai_spend('0a100000-0000-0000-0000-00000000000a', -5);
select results_eq($$select cost_usd, calls from public.ai_spend_daily where tenant_id = '0a100000-0000-0000-0000-00000000000a'$$,
  $$values (0.020000::numeric, 4)$$, 'calls add up on one row per day; a model with no price, or a nonsense cost, adds a call and nothing else');
select is((select day from public.ai_spend_daily where tenant_id = '0a100000-0000-0000-0000-00000000000a'), (now() at time zone 'Asia/Kolkata')::date,
  'the day is India''s');
select results_eq($$select spend_today_usd from public.ai_limits('0a100000-0000-0000-0000-00000000000a')$$, $$values (0.020000::numeric)$$,
  'and the gate sees today''s spend');

update public.tenants set ai_daily_cap_usd = 0.50 where id = '0a100000-0000-0000-0000-00000000000a';
select results_eq($$select cap_usd from public.ai_limits('0a100000-0000-0000-0000-00000000000a')$$, $$values (0.50::numeric)$$,
  'a platform admin''s cap for one business wins over the plan''s');
select throws_ok($$update public.tenants set ai_daily_cap_usd = -1 where id = '0a100000-0000-0000-0000-00000000000a'$$, '23514', null,
  'a cap cannot be negative');

select ok(not has_function_privilege('authenticated', 'public.record_ai_spend(uuid, numeric)', 'execute')
          and not has_function_privilege('authenticated', 'public.ai_limits(uuid, uuid)', 'execute'), 'server only: functions');
select ok(not has_table_privilege('authenticated', 'public.ai_spend_daily', 'select') and not has_table_privilege('anon', 'public.ai_spend_daily', 'select'),
  'and the spend table');

select * from finish();
rollback;
