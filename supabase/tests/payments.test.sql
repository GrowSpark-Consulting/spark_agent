-- PayU payments (0035, 0036): begin_payment records one, settle_payment applies its verified result exactly once.
-- Run: pnpm db:test
begin;
create extension if not exists pgtap with schema extensions;
select plan(30);

insert into public.plans (key, name, price_inr, monthly_credits, seats, whatsapp_numbers, feature_keys) values
  ('starter', 'Starter', 2499, 1500, 2, 1, array['ai_auto_reply']),
  ('trial', 'Trial', 0, 300, 2, 1, array['ai_auto_reply'])
  on conflict (key) do nothing;  -- the seed may already have them
insert into public.tenants (id, name, vertical, status, plan_key) values
  ('0c100000-0000-0000-0000-000000000001', 'Subscribes', 'test-pack', 'trial', 'trial'),
  ('0c100000-0000-0000-0000-000000000002', 'Fails to pay', 'test-pack', 'trial', 'trial'),
  ('0c100000-0000-0000-0000-000000000003', 'Pays twice', 'test-pack', 'trial', 'trial');

-- Subscribe ---------------------------------------------------------------------------------------------------------
select lives_ok($$select public.begin_payment('0c100000-0000-0000-0000-000000000001', 'subscribe', 'Sone', 249900, 44982, 1500, 'starter', 'monthly')$$,
  'a trial business starts a Starter checkout');
select results_eq($$select status, amount_paise, billing_cycle from public.subscriptions where tenant_id = '0c100000-0000-0000-0000-000000000001'$$,
  $$values ('pending'::text, 294882, 'monthly'::text)$$, 'the mandate to approve waits as a pending subscription, GST included');
select results_eq($$select status, amount_paise, credits from public.payments where txnid = 'Sone'$$,
  $$values ('created'::text, 294882, 1500)$$, 'the payment is recorded before the payer leaves for PayU');

select results_eq($$select status, applied from public.settle_payment('Sone', 'pending', '1001', 'UPI')$$,
  $$values ('pending'::text, false)$$, 'a pending answer is recorded and applies nothing');
select throws_ok($$select * from public.settle_payment('Sone', 'success', '1001', 'UPI', 100)$$,
  'PA422', null, 'a success for another amount applies nothing');
select is((select status from public.payments where txnid = 'Sone'), 'pending', 'the payment is still pending after the wrong amount');

select results_eq($$select status, applied from public.settle_payment('Sone', 'success', '1001', 'UPI', 294882)$$,
  $$values ('success'::text, true)$$, 'the verified success applies');
select results_eq($$select status, mandate_id, mandate_method, current_period_end > now() + interval '27 days' from public.subscriptions where tenant_id = '0c100000-0000-0000-0000-000000000001'$$,
  $$values ('active'::text, '1001'::text, 'upi'::text, true)$$, 'the mandate is active, with PayU''s id and the payment method, for a month');
select results_eq($$select status, plan_key from public.tenants where id = '0c100000-0000-0000-0000-000000000001'$$,
  $$values ('active'::text, 'starter'::text)$$, 'the business is now active on Starter');
select results_eq($$select sum(delta)::int, bool_and(expires_at > now() + interval '58 days') from public.credit_ledger where tenant_id = '0c100000-0000-0000-0000-000000000001' and reason = 'plan_grant'$$,
  $$values (1500, true)$$, 'the first month''s credits are granted, lasting to the end of the next month (rollover)');

select results_eq($$select status, applied from public.settle_payment('Sone', 'success', '1001', 'UPI', 294882)$$,
  $$values ('success'::text, false)$$, 'the same success again (webhook after the return) applies nothing');
select results_eq($$select status, applied from public.settle_payment('Sone', 'failed', null, null, null, 'late failure')$$,
  $$values ('success'::text, false)$$, 'a final payment never changes');
select is((select count(*)::int from public.credit_ledger where tenant_id = '0c100000-0000-0000-0000-000000000001' and reason = 'plan_grant'), 1,
  'the credits were granted once');
select throws_ok($$select public.begin_payment('0c100000-0000-0000-0000-000000000001', 'subscribe', 'Stwo', 249900, 44982, 1500, 'starter', 'monthly')$$,
  'PA409', null, 'a business with a plan cannot start another subscription');
select throws_ok($$select public.begin_payment('0c100000-0000-0000-0000-000000000001', 'subscribe', 'Strial', 0, 0, 300, 'trial', 'monthly')$$,
  'P0001', null, 'the trial plan cannot be bought');

-- Top-up and setup fee ----------------------------------------------------------------------------------------------
select lives_ok($$select public.begin_payment('0c100000-0000-0000-0000-000000000001', 'topup', 'Tone', 119900, 21582, 1000)$$,
  'an active business starts a top-up');
select results_eq($$select status, applied from public.settle_payment('Tone', 'success', '2001', 'CC', 141482)$$,
  $$values ('success'::text, true)$$, 'the top-up is paid');
select results_eq($$select delta, expires_at > now() + interval '89 days' from public.credit_ledger where tenant_id = '0c100000-0000-0000-0000-000000000001' and reason = 'topup'$$,
  $$values (1000, true)$$, 'the pack is granted, expiring in 90 days');
select results_eq($$select applied from public.settle_payment('Tone', 'success', '2001', 'CC', 141482)$$, $$values (false)$$,
  'the pack is never granted twice');
select throws_ok($$select public.begin_payment('0c100000-0000-0000-0000-000000000002', 'topup', 'Ttrial', 119900, 21582, 1000)$$,
  'PA409', null, 'a trial business subscribes instead of topping up');

select lives_ok($$select public.begin_payment('0c100000-0000-0000-0000-000000000001', 'setup_fee', 'Fone', 499900, 89982)$$,
  'the business starts the setup fee');
select public.settle_payment('Fone', 'success', '3001', 'NB', 589882);
select isnt((select setup_call_paid_at from public.tenants where id = '0c100000-0000-0000-0000-000000000001'), null,
  'a paid setup fee flags the business for its onboarding call');
select throws_ok($$select public.begin_payment('0c100000-0000-0000-0000-000000000001', 'setup_fee', 'Ftwo', 499900, 89982)$$,
  'PA409', null, 'the setup fee is paid once');

-- Failure -------------------------------------------------------------------------------------------------------------
select public.begin_payment('0c100000-0000-0000-0000-000000000002', 'subscribe', 'Sfail', 249900, 44982, 1500, 'starter', 'monthly');
select results_eq($$select status, applied from public.settle_payment('Sfail', 'failed', '4001', 'CC', null, 'Bank was unable to authenticate.')$$,
  $$values ('failed'::text, true)$$, 'a failed payment is recorded');
select results_eq($$select p.failure_reason, s.status, t.status from public.payments p join public.subscriptions s on s.id = p.subscription_id join public.tenants t on t.id = p.tenant_id where p.txnid = 'Sfail'$$,
  $$values ('Bank was unable to authenticate.'::text, 'cancelled'::text, 'trial'::text)$$, 'with PayU''s reason; the mandate is cancelled and the business is unchanged');
select results_eq($$select applied from public.settle_payment('Sfail', 'not_found')$$, $$values (false)$$, 'not_found never changes anything');

-- Paid twice -----------------------------------------------------------------------------------------------------------
select public.begin_payment('0c100000-0000-0000-0000-000000000003', 'subscribe', 'Sfirst', 249900, 44982, 1500, 'starter', 'monthly');
select public.begin_payment('0c100000-0000-0000-0000-000000000003', 'subscribe', 'Ssecond', 249900, 44982, 1500, 'starter', 'yearly');
select public.settle_payment('Ssecond', 'success', '5002', 'CC', 294882);
select results_eq($$select applied from public.settle_payment('Sfirst', 'success', '5001', 'CC', 294882)$$, $$values (true)$$,
  'an abandoned checkout that is paid after all is still recorded');
select results_eq($$select count(*)::int, count(*) filter (where status = 'active')::int from public.subscriptions where tenant_id = '0c100000-0000-0000-0000-000000000003'$$,
  $$values (2, 1)$$, 'only one plan is live when a business pays twice');
select is((select count(*)::int from public.audit_logs where tenant_id = '0c100000-0000-0000-0000-000000000003' and action = 'payment.needs_refund'), 1,
  'the second payment is flagged for a refund');

select is(
  (select array_agg(f order by f) from unnest(array['begin_payment', 'settle_payment']) f
    where has_function_privilege('authenticated', (select p.oid from pg_proc p where p.proname = f and p.pronamespace = 'public'::regnamespace), 'execute')
       or has_function_privilege('anon', (select p.oid from pg_proc p where p.proname = f and p.pronamespace = 'public'::regnamespace), 'execute')),
  null, 'the browser can neither start nor settle a payment');

select * from finish();
rollback;
