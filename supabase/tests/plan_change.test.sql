-- Changing plan (0037): upgrades now with a prorated payment, a new mandate and extra credits; downgrades at the next
-- cycle. Run: pnpm db:test
begin;
create extension if not exists pgtap with schema extensions;
select plan(19);

insert into public.plans (key, name, price_inr, monthly_credits, seats, whatsapp_numbers, feature_keys) values
  ('starter', 'Starter', 2499, 1500, 2, 1, array['ai_auto_reply']),
  ('growth', 'Growth', 5999, 5000, 5, 1, array['ai_auto_reply']),
  ('pro', 'Pro', 12999, 15000, 999, 3, array['ai_auto_reply'])
  on conflict (key) do nothing;  -- the seed may already have them
insert into public.tenants (id, name, vertical, status, plan_key) values
  ('0e700000-0000-0000-0000-000000000001', 'Upgrades', 'test-pack', 'active', 'starter'),
  ('0e700000-0000-0000-0000-000000000002', 'Downgrades', 'test-pack', 'active', 'growth'),
  ('0e700000-0000-0000-0000-000000000003', 'Behind', 'test-pack', 'active', 'starter'),
  ('0e700000-0000-0000-0000-000000000004', 'Trial', 'test-pack', 'trial', 'trial');
-- Halfway through a 30-day period.
insert into public.subscriptions (id, tenant_id, plan_key, status, billing_cycle, amount_paise, mandate_id, mandate_method, current_period_start, current_period_end) values
  ('0e800000-0000-0000-0000-000000000001', '0e700000-0000-0000-0000-000000000001', 'starter', 'active', 'monthly', 294882, 'old-1', 'upi', now() - interval '15 days', now() + interval '15 days'),
  ('0e800000-0000-0000-0000-000000000002', '0e700000-0000-0000-0000-000000000002', 'growth', 'active', 'monthly', 707882, 'old-2', 'card', now() - interval '15 days', now() + interval '15 days'),
  ('0e800000-0000-0000-0000-000000000003', '0e700000-0000-0000-0000-000000000003', 'starter', 'past_due', 'monthly', 294882, 'old-3', 'card', now() - interval '31 days', now() - interval '1 day');
select public.renew_plan_credits('0e700000-0000-0000-0000-000000000001', 1500, now() + interval '45 days', '0e900000-0000-0000-0000-000000000001');

-- Upgrade -------------------------------------------------------------------------------------------------------------
select results_eq(
  $$select action, amount_paise, mandate_paise from public.begin_plan_change('0e700000-0000-0000-0000-000000000001', 'growth', 'Cup')$$,
  $$values ('upgrade'::text, 175000 + 31500, 707882)$$,
  'an upgrade halfway through pays half the price difference with GST, and approves the new full price');
select results_eq($$select status, replaces_subscription_id, amount_paise from public.subscriptions where tenant_id = '0e700000-0000-0000-0000-000000000001' and status = 'pending'$$,
  $$values ('pending'::text, '0e800000-0000-0000-0000-000000000001'::uuid, 707882)$$, 'the new mandate waits, naming the plan it replaces');
select is((select credits from public.payments where txnid = 'Cup'), 1750, 'the upgrade carries half a month of the extra credits');
select results_eq($$select status from public.subscriptions where id = '0e800000-0000-0000-0000-000000000001'$$, $$values ('active'::text)$$,
  'the current plan runs on until the upgrade is paid');

select results_eq($$select status, applied from public.settle_payment('Cup', 'success', 'new-1', 'CC', 206500)$$,
  $$values ('success'::text, true)$$, 'the upgrade is paid');
select results_eq($$select status from public.subscriptions where id = '0e800000-0000-0000-0000-000000000001'$$, $$values ('cancelled'::text)$$,
  'the old plan ends');
select results_eq(
  $$select n.status, n.mandate_id, n.mandate_method, n.plan_key, n.current_period_end = o.current_period_end, n.pre_debit_for is null
      from public.subscriptions n join public.subscriptions o on o.id = n.replaces_subscription_id where o.id = '0e800000-0000-0000-0000-000000000001'$$,
  $$values ('active'::text, 'new-1'::text, 'card'::text, 'growth'::text, true, true)$$,
  'the new plan runs over the same period on the new mandate, and will need its own notice');
select is((select plan_key from public.tenants where id = '0e700000-0000-0000-0000-000000000001'), 'growth', 'the business is on Growth at once');
select results_eq($$select sum(delta)::int, count(distinct expires_at)::int from public.credit_ledger where tenant_id = '0e700000-0000-0000-0000-000000000001' and reason = 'plan_grant'$$,
  $$values (3250, 1)$$, 'the extra credits join this month''s, with the same expiry');
select results_eq($$select applied from public.settle_payment('Cup', 'success', 'new-1', 'CC', 206500)$$, $$values (false)$$,
  'a repeated success changes nothing');

-- Downgrade and keeping the plan ---------------------------------------------------------------------------------------
select results_eq($$select action, payment_id, effective_at = (select current_period_end from public.subscriptions where id = '0e800000-0000-0000-0000-000000000002')
                      from public.begin_plan_change('0e700000-0000-0000-0000-000000000002', 'starter', 'Cdown')$$,
  $$values ('scheduled'::text, null::uuid, true)$$, 'a downgrade is scheduled for the next cycle, with no payment');
select results_eq($$select s.next_plan_key, t.plan_key from public.subscriptions s join public.tenants t on t.id = s.tenant_id where s.id = '0e800000-0000-0000-0000-000000000002'$$,
  $$values ('starter'::text, 'growth'::text)$$, 'the business stays on Growth until then');
select results_eq($$select action from public.begin_plan_change('0e700000-0000-0000-0000-000000000002', 'growth', 'Ckeep')$$, $$values ('kept'::text)$$,
  'choosing the current plan again cancels the downgrade');
select is((select next_plan_key from public.subscriptions where id = '0e800000-0000-0000-0000-000000000002'), null, 'nothing is scheduled any more');
select results_eq($$select action from public.begin_plan_change('0e700000-0000-0000-0000-000000000002', 'growth', 'Csame')$$, $$values ('unchanged'::text)$$,
  'the same plan again changes nothing');

-- Refusals --------------------------------------------------------------------------------------------------------------
select throws_ok($$select * from public.begin_plan_change('0e700000-0000-0000-0000-000000000003', 'pro', 'Cbehind')$$, 'PA428', null,
  'a past-due renewal comes first');
select throws_ok($$select * from public.begin_plan_change('0e700000-0000-0000-0000-000000000004', 'pro', 'Ctrial')$$, 'PA409', null,
  'a trial chooses a plan through checkout');

-- An upgrade paid after the plan it upgraded was replaced -----------------------------------------------------------------
select public.begin_plan_change('0e700000-0000-0000-0000-000000000002', 'pro', 'Clate');
update public.subscriptions set status = 'cancelled' where id = '0e800000-0000-0000-0000-000000000002';
select results_eq($$select applied from public.settle_payment('Clate', 'success', 'new-2', 'CC', (select amount_paise from public.payments where txnid = 'Clate'))$$,
  $$values (true)$$, 'a late upgrade is recorded');
select is((select count(*)::int from public.audit_logs where tenant_id = '0e700000-0000-0000-0000-000000000002' and action = 'payment.needs_refund'), 1,
  'and flagged for a refund, changing no plan');

select * from finish();
rollback;
