-- The trial's messages and its end (0039): which day is due for whom, who is paused, and that a business that paid is
-- never paused or told its trial is ending. Run: pnpm db:test
begin;
create extension if not exists pgtap with schema extensions;
select plan(30);

insert into public.plans (key, name, price_inr, monthly_credits, seats, whatsapp_numbers, feature_keys) values
  ('trial', 'Trial', 0, 300, 2, 1, array['ai_auto_reply']),
  ('starter', 'Starter', 2499, 1500, 2, 1, array['ai_auto_reply'])
  on conflict (key) do nothing;  -- the seed may already have them
-- One business per case; trial_ends_at relative to now.
insert into public.tenants (id, name, vertical, status, plan_key, trial_ends_at) values
  ('0a700000-0000-0000-0000-00000000000a', 'Day three', 'test-pack', 'trial', 'trial', now() + interval '3 days 12 hours'),
  ('0a700000-0000-0000-0000-00000000000b', 'Day five', 'test-pack', 'trial', 'trial', now() + interval '1 day 12 hours'),
  ('0a700000-0000-0000-0000-00000000000c', 'Day six', 'test-pack', 'trial', 'trial', now() + interval '12 hours'),
  ('0a700000-0000-0000-0000-00000000000d', 'Ended', 'test-pack', 'trial', 'trial', now() - interval '1 hour'),
  ('0a700000-0000-0000-0000-00000000000e', 'Ended but subscribed', 'test-pack', 'trial', 'trial', now() - interval '1 hour'),
  ('0a700000-0000-0000-0000-00000000000f', 'Ended, payment pending', 'test-pack', 'trial', 'trial', now() - interval '1 hour'),
  ('0a700000-0000-0000-0000-000000000010', 'Just started', 'test-pack', 'trial', 'trial', now() + interval '6 days 20 hours'),
  ('0a700000-0000-0000-0000-000000000011', 'Paying', 'test-pack', 'active', 'starter', now() - interval '20 days'),
  ('0a700000-0000-0000-0000-000000000012', 'Paused long ago', 'test-pack', 'paused', 'trial', now() - interval '5 days');
insert into public.subscriptions (tenant_id, plan_key, status, billing_cycle, amount_paise, mandate_id, current_period_start, current_period_end) values
  ('0a700000-0000-0000-0000-00000000000e', 'starter', 'active', 'monthly', 294882, 'm-e', now() - interval '2 hours', now() + interval '1 month'),
  ('0a700000-0000-0000-0000-000000000011', 'starter', 'active', 'monthly', 294882, 'm-p', now() - interval '10 days', now() + interval '20 days');
insert into public.payments (tenant_id, kind, txnid, base_paise, gst_paise, amount_paise, credits, plan_key, billing_cycle, status) values
  ('0a700000-0000-0000-0000-00000000000f', 'subscribe', 'Spending', 249900, 44982, 294882, 1500, 'starter', 'monthly', 'pending');

create function pg_temp.due() returns text language sql as $$
  select string_agg(t.name || ':' || d.day, ', ' order by t.name)
  from public.trial_notices_due() d join public.tenants t on t.id = d.tenant_id
  where t.id::text like '0a700000-%'
$$;

-- Which day is due -----------------------------------------------------------------------------------------------------
select is(pg_temp.due(), 'Day five:5, Day six:6, Day three:3',
  'four days out is day 3, two days out day 5, one day out day 6; nothing yet for a trial just started, a paying business or one that subscribed');

-- The end of the trial ---------------------------------------------------------------------------------------------------
select is((select array_agg(tenant_id order by tenant_id) from public.pause_expired_trials()), array['0a700000-0000-0000-0000-00000000000d']::uuid[],
  'only the ended trial with no plan and no payment in flight is paused');
select results_eq($$select status from public.tenants where id = '0a700000-0000-0000-0000-00000000000d'$$, $$values ('paused'::text)$$,
  'it is paused');
select is((select count(*)::int from public.audit_logs where tenant_id = '0a700000-0000-0000-0000-00000000000d' and action = 'tenant.trial_ended'), 1,
  'and the end of its trial is audited');
select results_eq($$select status from public.tenants where id = '0a700000-0000-0000-0000-00000000000e'$$, $$values ('trial'::text)$$,
  'a business with a live plan is never paused by its trial ending');
select results_eq($$select status from public.tenants where id = '0a700000-0000-0000-0000-00000000000f'$$, $$values ('trial'::text)$$,
  'nor one whose plan payment is still pending at PayU');
select results_eq($$select status from public.tenants where id = '0a700000-0000-0000-0000-000000000011'$$, $$values ('active'::text)$$,
  'nor a paying business');
select is((select count(*)::int from public.pause_expired_trials()), 0, 'running it again pauses nothing more');

select is(pg_temp.due(), 'Day five:5, Day six:6, Day three:3, Ended:7',
  'the paused trial is now due its day-7 notice; one paused long ago is not');

-- Claims: once, safe to retry, never stale ------------------------------------------------------------------------------
select is(public.claim_trial_notice('0a700000-0000-0000-0000-00000000000a', 3, 'run-1'), 'claimed', 'a run claims the day-3 notice');
select is(public.claim_trial_notice('0a700000-0000-0000-0000-00000000000a', 3, 'run-1'), 'claimed', 'a retry of that run still holds it');
select is(public.claim_trial_notice('0a700000-0000-0000-0000-00000000000a', 3, 'run-2'), 'already', 'another run does not');
select is(public.claim_trial_notice('0a700000-0000-0000-0000-00000000000a', 0, 'run-2'), 'superseded', 'an earlier day is never sent after a later one');
select ok(position('Day three' in pg_temp.due()) = 0, 'a claimed day is no longer due');

select is(public.claim_trial_notice('0a700000-0000-0000-0000-00000000000c', 3, 'run-1'), 'claimed', 'a claim for an earlier day is allowed while no later day has gone out');
select is(pg_temp.due(), 'Day five:5, Day six:6, Ended:7', 'and the latest day is still due after it');
select is(public.claim_trial_notice('0a700000-0000-0000-0000-00000000000c', 6, 'run-1'), 'claimed', 'then the later day');

select is(public.claim_trial_notice('0a700000-0000-0000-0000-00000000000d', 7, 'run-1'), 'claimed', 'the paused trial''s day-7 notice is claimed');
select is(public.claim_trial_notice('0a700000-0000-0000-0000-00000000000d', 6, 'run-1'), 'not_eligible', 'a day-6 notice after the end is not');
select is(public.claim_trial_notice('0a700000-0000-0000-0000-000000000012', 7, 'run-1'), 'not_eligible', 'nor a day-7 notice days after the end');

-- A business that pays during its trial is told nothing more -------------------------------------------------------------
update public.tenants set status = 'active', plan_key = 'starter' where id = '0a700000-0000-0000-0000-00000000000b';
insert into public.subscriptions (tenant_id, plan_key, status, billing_cycle, amount_paise, mandate_id, current_period_start, current_period_end)
values ('0a700000-0000-0000-0000-00000000000b', 'starter', 'active', 'monthly', 294882, 'm-b', now(), now() + interval '1 month');
select is(public.claim_trial_notice('0a700000-0000-0000-0000-00000000000b', 5, 'run-3'), 'not_eligible', 'a stale day-5 claim for a business that just paid is refused');
select ok(position('Day five' in coalesce(pg_temp.due(), '')) = 0, 'and nothing is due for it');
-- The ended trial subscribes after its pause: no stale "trial ended" notice.
update public.tenants set status = 'active', plan_key = 'starter' where id = '0a700000-0000-0000-0000-00000000000d';
delete from public.trial_notices where tenant_id = '0a700000-0000-0000-0000-00000000000d';
select is(public.claim_trial_notice('0a700000-0000-0000-0000-00000000000d', 7, 'run-4'), 'not_eligible', 'a business that paid after its trial ended is not told it ended');
select is((select count(*)::int from public.pause_expired_trials()), 0, 'and is never paused again');

-- An extended trial moves its messages ---------------------------------------------------------------------------------
update public.tenants set trial_ends_at = now() + interval '5 days' where id = '0a700000-0000-0000-0000-000000000010';
select ok(position('Just started' in coalesce(pg_temp.due(), '')) = 0, 'five days out nothing is due');
update public.tenants set trial_ends_at = now() + interval '3 days' where id = '0a700000-0000-0000-0000-000000000010';
select ok(position('Just started:3' in pg_temp.due()) > 0, 'three days out its day-3 notice is due');

select throws_ok($$select public.claim_trial_notice('0a700000-0000-0000-0000-000000000010', 4, 'run-1')$$, 'P0001', null, 'only the five notice days exist');
select throws_ok($$select public.claim_trial_notice('0a700000-0000-0000-0000-000000000010', 3, ' ')$$, 'P0001', null, 'a claim names its run');
select is(public.claim_trial_notice('0a700000-0000-0000-0000-0000000000ff', 3, 'run-1'), 'not_eligible', 'an unknown business is not eligible');

select is(
  (select array_agg(x order by x) from (
     select f as x from unnest(array['trial_notices_due', 'claim_trial_notice', 'pause_expired_trials']) f
      where has_function_privilege('authenticated', (select p.oid from pg_proc p where p.proname = f and p.pronamespace = 'public'::regnamespace), 'execute')
         or has_function_privilege('anon', (select p.oid from pg_proc p where p.proname = f and p.pronamespace = 'public'::regnamespace), 'execute')
     union all
     select 'trial_notices' where has_table_privilege('authenticated', 'public.trial_notices', 'select') or has_table_privilege('anon', 'public.trial_notices', 'select')
   ) q),
  null, 'the browser can neither call these nor read the notices');

select * from finish();
rollback;
