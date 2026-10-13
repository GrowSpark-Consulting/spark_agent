-- Renewals by PayU auto-debit (0037): who gets the pre-debit notice, who is charged and when, what a paid or failed
-- renewal changes, an annual plan's monthly credits, and pausing after the grace period. Run: pnpm db:test
begin;
create extension if not exists pgtap with schema extensions;
select plan(27);

insert into public.plans (key, name, price_inr, monthly_credits, seats, whatsapp_numbers, feature_keys) values
  ('starter', 'Starter', 2499, 1500, 2, 1, array['ai_auto_reply']),
  ('growth', 'Growth', 5999, 5000, 5, 1, array['ai_auto_reply'])
  on conflict (key) do nothing;  -- the seed may already have them
insert into public.tenants (id, name, vertical, status, plan_key) values
  ('0d100000-0000-0000-0000-000000000001', 'Renews', 'test-pack', 'active', 'starter'),
  ('0d100000-0000-0000-0000-000000000002', 'Downgrades', 'test-pack', 'active', 'growth'),
  ('0d100000-0000-0000-0000-000000000003', 'Lapses', 'test-pack', 'active', 'starter'),
  ('0d100000-0000-0000-0000-000000000004', 'Annual', 'test-pack', 'active', 'starter');
insert into public.subscriptions (id, tenant_id, plan_key, status, billing_cycle, amount_paise, mandate_id, mandate_method, current_period_start, current_period_end, next_plan_key) values
  ('0d200000-0000-0000-0000-000000000001', '0d100000-0000-0000-0000-000000000001', 'starter', 'active', 'monthly', 294882, 'm-1', 'upi', now() - interval '1 month 1 hour', now() - interval '1 hour', null),
  ('0d200000-0000-0000-0000-000000000002', '0d100000-0000-0000-0000-000000000002', 'growth', 'active', 'monthly', 707882, 'm-2', 'enach', now() - interval '1 month 1 hour', now() - interval '1 hour', 'starter'),
  ('0d200000-0000-0000-0000-000000000003', '0d100000-0000-0000-0000-000000000003', 'starter', 'past_due', 'monthly', 294882, 'm-3', 'card', now() - interval '1 month 8 days', now() - interval '8 days', null),
  ('0d200000-0000-0000-0000-000000000004', '0d100000-0000-0000-0000-000000000004', 'starter', 'active', 'yearly', 2948820, 'm-4', 'card', now() - interval '1 month 1 day', now() + interval '10 months', null);

-- Notice ------------------------------------------------------------------------------------------------------------
select is((select array_agg(subscription_id order by subscription_id) from public.renewals_to_notify()),
  array['0d200000-0000-0000-0000-000000000001', '0d200000-0000-0000-0000-000000000002']::uuid[],
  'the mandates whose period ends within four days are due a pre-debit notice (not a past_due one, not the annual one)');
select results_eq($$select amount_paise, status, created from public.begin_renewal('0d200000-0000-0000-0000-000000000001', 'Rone')$$,
  $$values (294882, 'created'::text, true)$$, 'the renewal is recorded with the plan''s price and GST');
select results_eq($$select txnid, created from public.begin_renewal('0d200000-0000-0000-0000-000000000001', 'Rother')$$,
  $$values ('Rone'::text, false)$$, 'asking again for the same period returns the same payment');
select is((select for_period_end from public.payments where txnid = 'Rone'),
  (select current_period_end from public.subscriptions where id = '0d200000-0000-0000-0000-000000000001'), 'the payment names the period it renews');

-- Charge ------------------------------------------------------------------------------------------------------------
select ok(not exists (select 1 from public.renewals_to_charge() where subscription_id = '0d200000-0000-0000-0000-000000000001'),
  'no charge before the notice is out');
update public.subscriptions set pre_debit_for = current_period_end, pre_debit_at = now() + interval '2 days' where id = '0d200000-0000-0000-0000-000000000001';
select ok(not exists (select 1 from public.renewals_to_notify() where subscription_id = '0d200000-0000-0000-0000-000000000001'),
  'the notice goes once a period');
select ok(not exists (select 1 from public.renewals_to_charge() where subscription_id = '0d200000-0000-0000-0000-000000000001'),
  'no charge before the debit time the notice announced');
update public.subscriptions set pre_debit_at = now() where id = '0d200000-0000-0000-0000-000000000001';
select ok(exists (select 1 from public.renewals_to_charge() where subscription_id = '0d200000-0000-0000-0000-000000000001'),
  'the charge is due at the announced debit time, once the period has ended');
select ok(exists (select 1 from public.renewals_to_charge() where subscription_id = '0d200000-0000-0000-0000-000000000002'),
  'an e-NACH mandate needs no notice');

select public.settle_payment('Rone', 'pending');
select ok(not exists (select 1 from public.renewals_to_charge() where subscription_id = '0d200000-0000-0000-0000-000000000001'),
  'a charge in flight is not started again');
select results_eq($$select status, applied from public.settle_payment('Rone', 'failed', null, 'UPI', null, 'Insufficient balance')$$,
  $$values ('failed'::text, true)$$, 'the charge fails');
select results_eq($$select status, charge_attempts from public.subscriptions where id = '0d200000-0000-0000-0000-000000000001'$$,
  $$values ('past_due'::text, 1)$$, 'the subscription is past due after one attempt');
select ok(not exists (select 1 from public.renewals_to_charge() where subscription_id = '0d200000-0000-0000-0000-000000000001'),
  'no retry within two days');
select ok(exists (select 1 from public.renewals_to_charge(now() + interval '3 days') where subscription_id = '0d200000-0000-0000-0000-000000000001'),
  'a retry two days later');
select results_eq($$select created, amount_paise from public.begin_renewal('0d200000-0000-0000-0000-000000000001', 'Rtwo')$$,
  $$values (true, 294882)$$, 'the retry is a new payment for the same period');

select results_eq($$select status, applied from public.settle_payment('Rtwo', 'success', '9002', 'UPI', 294882)$$,
  $$values ('success'::text, true)$$, 'the retry is paid');
select results_eq(
  $$select s.status, s.charge_attempts, s.pre_debit_for is null, s.current_period_start = p.for_period_end, s.current_period_end = p.for_period_end + interval '1 month'
      from public.subscriptions s join public.payments p on p.subscription_id = s.id and p.txnid = 'Rtwo'$$,
  $$values ('active'::text, 0, true, true, true)$$, 'the period moves on a month from where it ended, and the attempts reset');
select results_eq(
  $$select l.delta, l.expires_at = p.for_period_end + interval '2 months'
      from public.credit_ledger l join public.payments p on p.id = l.ref_id where p.txnid = 'Rtwo' and l.reason = 'plan_grant'$$,
  $$values (1500, true)$$, 'the month''s credits are granted to the end of the next month');
select results_eq($$select applied from public.settle_payment('Rtwo', 'success', '9002', 'UPI', 294882)$$, $$values (false)$$,
  'a repeated success changes nothing');

-- A downgrade takes effect at renewal ---------------------------------------------------------------------------------
select results_eq($$select amount_paise from public.begin_renewal('0d200000-0000-0000-0000-000000000002', 'Rdown')$$,
  $$values (294882)$$, 'the next cycle is charged at the plan it moves to');
select public.settle_payment('Rdown', 'success', '9003', 'NB', 294882);
select results_eq($$select s.plan_key, s.next_plan_key, s.amount_paise, t.plan_key from public.subscriptions s join public.tenants t on t.id = s.tenant_id where s.id = '0d200000-0000-0000-0000-000000000002'$$,
  $$values ('starter'::text, null::text, 294882, 'starter'::text)$$, 'and the business is on it from then');

-- Lapse ---------------------------------------------------------------------------------------------------------------
select is((select array_agg(subscription_id) from public.lapse_overdue_subscriptions()), array['0d200000-0000-0000-0000-000000000003']::uuid[],
  'a mandate past due seven days after its period ended lapses');
select results_eq($$select s.status, t.status from public.subscriptions s join public.tenants t on t.id = s.tenant_id where s.id = '0d200000-0000-0000-0000-000000000003'$$,
  $$values ('cancelled'::text, 'paused'::text)$$, 'its business is paused');
select is((select count(*)::int from public.audit_logs where tenant_id = '0d100000-0000-0000-0000-000000000003' and action = 'subscription.lapsed'), 1,
  'and the lapse is in the audit log');

-- Annual plan ----------------------------------------------------------------------------------------------------------
select is(public.grant_annual_credit_months(), 1, 'an annual plan gets its second month''s credits a month in');
select is(public.grant_annual_credit_months(), 0, 'and only once');

select is(
  (select array_agg(f order by f) from unnest(array['begin_renewal', 'renewals_to_notify', 'renewals_to_charge', 'grant_annual_credit_months', 'lapse_overdue_subscriptions']) f
    where has_function_privilege('authenticated', (select p.oid from pg_proc p where p.proname = f and p.pronamespace = 'public'::regnamespace), 'execute')
       or has_function_privilege('anon', (select p.oid from pg_proc p where p.proname = f and p.pronamespace = 'public'::regnamespace), 'execute')),
  null, 'the browser can call none of the renewal functions');

select * from finish();
rollback;
