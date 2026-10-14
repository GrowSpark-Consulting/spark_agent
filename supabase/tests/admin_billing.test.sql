-- The admin panel's billing functions (0041): the business list, extending a trial, granting credits, editing plans and
-- features, and the payments to refund. Run: pnpm db:test
begin;
create extension if not exists pgtap with schema extensions;
select plan(30);

insert into public.plans (key, name, price_inr, monthly_credits, seats, whatsapp_numbers, feature_keys) values
  ('trial', 'Trial', 0, 300, 2, 1, array['ai_auto_reply']),
  ('starter', 'Starter', 2499, 1500, 2, 1, array['ai_auto_reply']),
  ('growth', 'Growth', 5999, 5000, 5, 1, array['ai_auto_reply'])
  on conflict (key) do nothing;  -- the seed may already have them
insert into public.features (key, name, description, default_on) values ('ai_auto_reply', 'AI replies', 'The assistant replies.', true)
  on conflict (key) do nothing;
insert into public.tenants (id, name, vertical, status, plan_key, trial_ends_at, setup_call_paid_at) values
  ('0b100000-0000-0000-0000-000000000001', 'Ended trial', 'test-pack', 'paused', 'trial', now() - interval '2 days', null),
  ('0b100000-0000-0000-0000-000000000002', 'Paying', 'test-pack', 'active', 'growth', null, now() - interval '1 day');
insert into public.route_codes (code, kind, tenant_id, expires_at) values ('TRIAL-AD01', 'trial', '0b100000-0000-0000-0000-000000000001', now() - interval '2 days');
insert into public.trial_notices (tenant_id, day, claimed_by) values
  ('0b100000-0000-0000-0000-000000000001', 0, 'run-a'), ('0b100000-0000-0000-0000-000000000001', 7, 'run-b');
insert into public.subscriptions (tenant_id, plan_key, status, billing_cycle, amount_paise, mandate_id, current_period_start, current_period_end) values
  ('0b100000-0000-0000-0000-000000000002', 'growth', 'active', 'monthly', 707882, 'm-ad', now() - interval '10 days', now() + interval '20 days');
select public.grant_credits('0b100000-0000-0000-0000-000000000002', 120, 'admin');

-- The business list ---------------------------------------------------------------------------------------------------------
select results_eq(
  $$select status, plan_key, credits, subscription_status, current_period_end > now(), setup_call_paid_at is not null
      from public.admin_tenants() where tenant_id = '0b100000-0000-0000-0000-000000000002'$$,
  $$values ('active'::text, 'growth'::text, 120, 'active'::text, true, true)$$,
  'a paying business shows its plan, credits, live subscription and the setup-fee flag');
select results_eq($$select status, subscription_status from public.admin_tenants() where tenant_id = '0b100000-0000-0000-0000-000000000001'$$,
  $$values ('paused'::text, null::text)$$, 'an ended trial shows as paused with no subscription');

-- Extending a trial -------------------------------------------------------------------------------------------------------
-- (Called once in a subquery: BETWEEN would evaluate a function call twice.)
select ok((select e between now() + interval '6 days 23 hours' and now() + interval '7 days 1 hour'
           from (select public.admin_extend_trial('0b100000-0000-0000-0000-000000000001', 7, 'admin:0b900000-0000-0000-0000-000000000001') as e) x),
  'an ended trial is extended from now');
select results_eq($$select status, trial_ends_at > now() + interval '6 days' from public.tenants where id = '0b100000-0000-0000-0000-000000000001'$$,
  $$values ('trial'::text, true)$$, 'and is a trial again');
select ok((select expires_at > now() + interval '6 days' from public.route_codes where code = 'TRIAL-AD01'), 'its TRIAL code follows the new end');
select is((select array_agg(day order by day) from public.trial_notices where tenant_id = '0b100000-0000-0000-0000-000000000001'), array[0]::smallint[],
  'its trial notices start over (the welcome stays sent)');
select is((select count(*)::int from public.audit_logs where tenant_id = '0b100000-0000-0000-0000-000000000001' and action = 'tenant.trial_extended'
            and actor = 'admin:0b900000-0000-0000-0000-000000000001'), 1, 'the extension is audited with the admin');
select ok(public.admin_extend_trial('0b100000-0000-0000-0000-000000000001', 3, 'admin:0b900000-0000-0000-0000-000000000001') > now() + interval '9 days 23 hours',
  'a running trial is extended from its end');
select throws_ok($$select public.admin_extend_trial('0b100000-0000-0000-0000-000000000002', 7, 'admin:0b900000-0000-0000-0000-000000000001')$$,
  'PA409', null, 'a paying business has no trial to extend');
select throws_ok($$select public.admin_extend_trial('0b100000-0000-0000-0000-000000000001', 31, 'admin:0b900000-0000-0000-0000-000000000001')$$,
  'P0001', null, 'at most 30 days at a time');
select throws_ok($$select public.admin_extend_trial('0b100000-0000-0000-0000-000000000001', 7, 'system')$$, 'P0001', null, 'only a platform admin extends');
select throws_ok($$select public.admin_extend_trial('0b100000-0000-0000-0000-0000000000ff', 7, 'admin:0b900000-0000-0000-0000-000000000001')$$,
  'PA404', null, 'an unknown business');

-- Granting credits ---------------------------------------------------------------------------------------------------------
select is(public.admin_grant_credits('0b100000-0000-0000-0000-000000000001', 500, now() + interval '30 days', '0b800000-0000-0000-0000-000000000001', 'Goodwill', 'admin:0b900000-0000-0000-0000-000000000001'),
  true, 'an admin grants credits');
select is(public.admin_grant_credits('0b100000-0000-0000-0000-000000000001', 500, now() + interval '30 days', '0b800000-0000-0000-0000-000000000001', 'Goodwill', 'admin:0b900000-0000-0000-0000-000000000001'),
  false, 'the same request again grants nothing');
select is((select sum(delta)::int from public.credit_ledger where tenant_id = '0b100000-0000-0000-0000-000000000001' and reason = 'admin'), 500, 'granted once');
select results_eq($$select diff->>'amount', diff->>'note' from public.audit_logs where tenant_id = '0b100000-0000-0000-0000-000000000001' and action = 'credits.granted'$$,
  $$values ('500'::text, 'Goodwill'::text)$$, 'audited once, with the note');
select throws_ok($$select public.admin_grant_credits('0b100000-0000-0000-0000-000000000001', 0, null, null, null, 'admin:0b900000-0000-0000-0000-000000000001')$$,
  'P0001', null, 'at least one credit');
select throws_ok($$select public.admin_grant_credits('0b100000-0000-0000-0000-0000000000ff', 10, null, null, null, 'admin:0b900000-0000-0000-0000-000000000001')$$,
  'PA404', null, 'an unknown business');

-- Plans and features -------------------------------------------------------------------------------------------------------
select results_eq($$select name, monthly_credits from public.admin_update_plan('starter', 'Starter plan', null, 1600, null, null, null, 'admin:0b900000-0000-0000-0000-000000000001')$$,
  $$values ('Starter plan'::text, 1600)$$, 'an admin renames a plan and changes its credits; the rest stays');
select results_eq($$select price_inr from public.plans where key = 'starter'$$, $$values (2499)$$, 'its price is unchanged');
select throws_ok($$select * from public.admin_update_plan('growth', null, 6499, null, null, null, null, 'admin:0b900000-0000-0000-0000-000000000001')$$,
  'PA409', null, 'no price change while a business is subscribed at that price (its mandate is for the old amount)');
select results_eq($$select price_inr from public.admin_update_plan('starter', null, 2699, null, null, null, null, 'admin:0b900000-0000-0000-0000-000000000001')$$,
  $$values (2699)$$, 'a price change with nobody subscribed goes through');
select throws_ok($$select * from public.admin_update_plan('trial', null, 99, null, null, null, null, 'admin:0b900000-0000-0000-0000-000000000001')$$,
  'P0001', null, 'the trial stays free');
select throws_ok($$select * from public.admin_update_plan('starter', null, null, null, null, null, array['no_such_feature'], 'admin:0b900000-0000-0000-0000-000000000001')$$,
  'P0001', null, 'a plan lists only real features');
select is((select count(*)::int from public.audit_logs where action = 'plan.updated' and diff->>'key' = 'starter'), 2, 'each plan change is audited');

select results_eq($$select default_on from public.admin_update_feature('ai_auto_reply', null, null, false, 'admin:0b900000-0000-0000-0000-000000000001')$$,
  $$values (false)$$, 'an admin changes a feature''s default');
select is((select count(*)::int from public.audit_logs where action = 'feature.updated' and diff->>'key' = 'ai_auto_reply'), 1, 'audited');

-- Payments to refund --------------------------------------------------------------------------------------------------------
insert into public.payments (id, tenant_id, kind, txnid, base_paise, gst_paise, amount_paise, status, provider_payment_id, settled_at) values
  ('0b700000-0000-0000-0000-000000000001', '0b100000-0000-0000-0000-000000000002', 'setup_fee', 'Fadtwo', 499900, 89982, 589882, 'success', 'mih-2', now());
insert into public.audit_logs (tenant_id, actor, action, entity, entity_id, diff)
values ('0b100000-0000-0000-0000-000000000002', 'system', 'payment.needs_refund', 'payment', '0b700000-0000-0000-0000-000000000001', '{}');
select results_eq($$select tenant_name, kind, amount_paise, provider_payment_id from public.admin_refund_candidates() where payment_id = '0b700000-0000-0000-0000-000000000001'$$,
  $$values ('Paying'::text, 'setup_fee'::text, 589882, 'mih-2'::text)$$, 'a payment flagged for a refund is listed with its business and PayU id');

select is(
  (select array_agg(f order by f) from unnest(array['admin_tenants', 'admin_extend_trial', 'admin_grant_credits', 'admin_update_plan', 'admin_update_feature', 'admin_refund_candidates']) f
    where has_function_privilege('authenticated', (select p.oid from pg_proc p where p.proname = f and p.pronamespace = 'public'::regnamespace), 'execute')
       or has_function_privilege('anon', (select p.oid from pg_proc p where p.proname = f and p.pronamespace = 'public'::regnamespace), 'execute')),
  null, 'the browser can call none of them');
select is((select count(*)::int from public.admin_tenants() where tenant_id::text like '0b100000-%'), 2, 'both businesses are listed');

select * from finish();
rollback;
