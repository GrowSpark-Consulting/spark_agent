-- Cancelling a plan, paying a past-due plan another way, and the 0042 fixes (a setup fee paid twice, a renewal charged
-- after cancelling, the browser's write grants). Run: pnpm db:test
begin;
create extension if not exists pgtap with schema extensions;
select plan(27);

insert into public.plans (key, name, price_inr, monthly_credits, seats, whatsapp_numbers, feature_keys) values
  ('starter', 'Starter', 2499, 1500, 2, 1, array['ai_auto_reply']),
  ('growth', 'Growth', 5999, 5000, 5, 1, array['ai_auto_reply'])
  on conflict (key) do nothing;  -- the seed may already have them
insert into public.tenants (id, name, vertical, status, plan_key) values
  ('0e900000-0000-0000-0000-000000000001', 'Cancels', 'test-pack', 'active', 'starter'),
  ('0e900000-0000-0000-0000-000000000002', 'Behind', 'test-pack', 'active', 'starter'),
  ('0e900000-0000-0000-0000-000000000003', 'Pays another way', 'test-pack', 'active', 'starter'),
  ('0e900000-0000-0000-0000-000000000004', 'Setup twice', 'test-pack', 'active', 'starter'),
  ('0e900000-0000-0000-0000-000000000005', 'No plan', 'test-pack', 'trial', 'trial');
insert into public.subscriptions (id, tenant_id, plan_key, status, billing_cycle, amount_paise, mandate_id, mandate_method, current_period_start, current_period_end, next_plan_key) values
  ('0e910000-0000-0000-0000-000000000001', '0e900000-0000-0000-0000-000000000001', 'growth', 'active', 'monthly', 707882, 'm-1', 'upi', now() - interval '28 days', now() + interval '2 days', 'starter'),
  ('0e910000-0000-0000-0000-000000000002', '0e900000-0000-0000-0000-000000000002', 'starter', 'past_due', 'monthly', 294882, 'm-2', 'card', now() - interval '32 days', now() - interval '2 days', null),
  ('0e910000-0000-0000-0000-000000000003', '0e900000-0000-0000-0000-000000000003', 'starter', 'past_due', 'monthly', 294882, 'm-3', 'upi', now() - interval '32 days', now() - interval '2 days', null);

-- Cancel and resume ------------------------------------------------------------------------------------------------------
select results_eq($$select outcome, ends_at = (select current_period_end from public.subscriptions where id = '0e910000-0000-0000-0000-000000000001'), mandate_id
                    from public.cancel_subscription('0e900000-0000-0000-0000-000000000001', '0ea00000-0000-0000-0000-000000000001')$$,
  $$values ('scheduled'::text, true, null::text)$$, 'cancelling a plan in good standing ends it at the end of its paid period');
select results_eq($$select status, cancel_at = current_period_end, next_plan_key from public.subscriptions where id = '0e910000-0000-0000-0000-000000000001'$$,
  $$values ('active'::text, true, null::text)$$, 'it stays active until then, and a scheduled downgrade is dropped');
select results_eq($$select outcome from public.cancel_subscription('0e900000-0000-0000-0000-000000000001', '0ea00000-0000-0000-0000-000000000001')$$,
  $$values ('scheduled'::text)$$, 'cancelling again changes nothing');
select is((select count(*)::int from public.audit_logs where tenant_id = '0e900000-0000-0000-0000-000000000001' and action = 'subscription.cancel_requested'), 1, 'audited once');
select ok(not exists (select 1 from public.renewals_to_notify() where subscription_id = '0e910000-0000-0000-0000-000000000001'), 'no pre-debit notice for a cancelled plan');
select ok(not exists (select 1 from public.renewals_to_charge(now() + interval '3 days') where subscription_id = '0e910000-0000-0000-0000-000000000001'),
  'and no charge once its period ends');

select ok(public.resume_subscription('0e900000-0000-0000-0000-000000000001', '0ea00000-0000-0000-0000-000000000001') > now(), 'the owner resumes it while the period lasts');
select is((select cancel_at from public.subscriptions where id = '0e910000-0000-0000-0000-000000000001'), null, 'it renews again');
select ok(exists (select 1 from public.renewals_to_notify() where subscription_id = '0e910000-0000-0000-0000-000000000001'), 'so its notice is due again');
select throws_ok($$select public.resume_subscription('0e900000-0000-0000-0000-000000000001', 'x')$$, 'PA409', null, 'nothing to resume when it was not cancelled');

-- The end of a cancelled plan ---------------------------------------------------------------------------------------------
select public.cancel_subscription('0e900000-0000-0000-0000-000000000001', '0ea00000-0000-0000-0000-000000000001');
select is((select count(*)::int from public.end_cancelled_subscriptions() where tenant_id = '0e900000-0000-0000-0000-000000000001'), 0, 'not before its period ends');
select results_eq($$select subscription_id, mandate_id, mandate_method from public.end_cancelled_subscriptions(now() + interval '3 days') where tenant_id = '0e900000-0000-0000-0000-000000000001'$$,
  $$values ('0e910000-0000-0000-0000-000000000001'::uuid, 'm-1'::text, 'upi'::text)$$, 'at its end it is ended, naming the mandate to revoke');
select results_eq($$select s.status, t.status from public.subscriptions s join public.tenants t on t.id = s.tenant_id where s.id = '0e910000-0000-0000-0000-000000000001'$$,
  $$values ('cancelled'::text, 'paused'::text)$$, 'the plan is cancelled and the business paused');
select is((select count(*)::int from public.audit_logs where tenant_id = '0e900000-0000-0000-0000-000000000001' and action = 'subscription.ended'), 1, 'and audited');

-- Cancelling a past-due plan, and nothing to cancel ------------------------------------------------------------------------
select results_eq($$select outcome, mandate_id from public.cancel_subscription('0e900000-0000-0000-0000-000000000002', '0ea00000-0000-0000-0000-000000000001')$$,
  $$values ('ended'::text, 'm-2'::text)$$, 'a past-due plan ends at once');
select results_eq($$select s.status, t.status from public.subscriptions s join public.tenants t on t.id = s.tenant_id where s.id = '0e910000-0000-0000-0000-000000000002'$$,
  $$values ('cancelled'::text, 'paused'::text)$$, 'and its business is paused');
select throws_ok($$select * from public.cancel_subscription('0e900000-0000-0000-0000-000000000005', 'x')$$, 'PA409', null, 'a business with no plan has nothing to cancel');

-- Paying a past-due plan another way --------------------------------------------------------------------------------------
select lives_ok($$select public.begin_payment('0e900000-0000-0000-0000-000000000003', 'subscribe', 'Sagain', 249900, 44982, 1500, 'starter', 'monthly')$$,
  'a past-due business may choose its plan again');
select results_eq($$select replaces_subscription_id from public.subscriptions where tenant_id = '0e900000-0000-0000-0000-000000000003' and status = 'pending'$$,
  $$values ('0e910000-0000-0000-0000-000000000003'::uuid)$$, 'the new checkout names the past-due plan it replaces');
select results_eq($$select status, applied from public.settle_payment('Sagain', 'success', 'm-new', 'CC', 294882)$$, $$values ('success'::text, true)$$, 'it is paid');
select results_eq($$select status from public.subscriptions where id = '0e910000-0000-0000-0000-000000000003'$$, $$values ('cancelled'::text)$$,
  'the past-due plan is replaced');
select results_eq($$select status, mandate_id, current_period_end > now() + interval '27 days' from public.subscriptions where tenant_id = '0e900000-0000-0000-0000-000000000003' and status = 'active'$$,
  $$values ('active'::text, 'm-new'::text, true)$$, 'and the new plan runs from now on the new mandate');
select throws_ok($$select public.begin_payment('0e900000-0000-0000-0000-000000000003', 'subscribe', 'Sthird', 249900, 44982, 1500, 'starter', 'monthly')$$,
  'PA409', null, 'a plan in good standing still is not bought again');

-- A setup fee paid twice ----------------------------------------------------------------------------------------------------
select public.begin_payment('0e900000-0000-0000-0000-000000000004', 'setup_fee', 'Fone4', 499900, 89982);
select public.begin_payment('0e900000-0000-0000-0000-000000000004', 'setup_fee', 'Ftwo4', 499900, 89982);
select public.settle_payment('Fone4', 'success', 'mf-1', 'CC', 589882);
select results_eq($$select status, applied from public.settle_payment('Ftwo4', 'success', 'mf-2', 'CC', 589882)$$, $$values ('success'::text, true)$$,
  'a second setup fee paid at the same time is recorded');
select is((select count(*)::int from public.audit_logs where tenant_id = '0e900000-0000-0000-0000-000000000004' and action = 'payment.needs_refund'), 1,
  'and flagged for a refund');

-- A renewal charged after its owner cancelled -------------------------------------------------------------------------------
insert into public.subscriptions (id, tenant_id, plan_key, status, billing_cycle, amount_paise, mandate_id, mandate_method, current_period_start, current_period_end, cancel_at)
values ('0e910000-0000-0000-0000-000000000006', '0e900000-0000-0000-0000-000000000004', 'starter', 'active', 'monthly', 294882, 'm-6', 'upi', now() - interval '31 days', now() - interval '1 hour', now() - interval '1 hour');
insert into public.payments (tenant_id, subscription_id, kind, txnid, base_paise, gst_paise, amount_paise, credits, plan_key, billing_cycle, for_period_end, status)
values ('0e900000-0000-0000-0000-000000000004', '0e910000-0000-0000-0000-000000000006', 'renewal', 'Rlate', 249900, 44982, 294882, 1500, 'starter', 'monthly', now() - interval '1 hour', 'pending');
select public.settle_payment('Rlate', 'success', 'mr-1', 'UPI', 294882);
select is((select count(*)::int from public.audit_logs where tenant_id = '0e900000-0000-0000-0000-000000000004' and action = 'payment.needs_refund'), 2,
  'a renewal charged after the owner cancelled is flagged for a refund');

select ok(not (has_table_privilege('authenticated', 'public.payments', 'insert') or has_table_privilege('authenticated', 'public.payments', 'update')
            or has_table_privilege('authenticated', 'public.subscriptions', 'delete') or has_table_privilege('anon', 'public.subscriptions', 'update'))
          and has_table_privilege('authenticated', 'public.payments', 'select'),
  'the browser keeps reading its payments and plans, and can no longer be granted a write');

select * from finish();
rollback;
