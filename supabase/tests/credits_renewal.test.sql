-- Rollover and expiry across simulated renewals (9-day plan, Day 5: "Rollover and expiry tests across a simulated
-- renewal"; docs/handover.md, module 7: plan credits roll over for one month, top-ups expire 90 days after purchase,
-- the soonest-expiring credits are spent first). Run: pnpm db:test
--
-- Time cannot move inside a test's transaction (now() is fixed), so a month "passes" by moving every ledger row of
-- the business back by those days (advance), which is the same as the clock moving forward. Starter: 1,500 credits a
-- month, 30-day cycles; each renewal's grant expires at the end of the NEXT cycle (one month of rollover).
begin;
create extension if not exists pgtap with schema extensions;
select plan(17);

insert into public.tenants (id, name, vertical) values ('c5000000-0000-0000-0000-000000000001', 'Renewals', 'test-pack');

create function pg_temp.advance(p_days int) returns void language sql as $$
  update public.credit_ledger
     set created_at = created_at - make_interval(days => p_days), expires_at = expires_at - make_interval(days => p_days)
   where tenant_id = 'c5000000-0000-0000-0000-000000000001'
$$;
create function pg_temp.balance() returns table (plan int, topup int, total int) language sql as $$
  select * from public.credit_balance('c5000000-0000-0000-0000-000000000001')
$$;
create function pg_temp.renew(p_ref text) returns boolean language sql as $$
  select public.renew_plan_credits('c5000000-0000-0000-0000-000000000001', 1500, now() + interval '60 days', p_ref::uuid)
$$;
create function pg_temp.spend(p_amount int) returns boolean language sql as $$
  select public.spend_credits('c5000000-0000-0000-0000-000000000001', p_amount, 'ai_reply')
$$;

-- Day 0: the first month (expires at day 60), and 1,000 of it spent.
select pg_temp.renew('c5100000-0000-0000-0000-000000000001');
select is((select total from pg_temp.balance()), 1500, 'day 0: the month''s 1,500 credits arrive');
select pg_temp.spend(1000);
select is((select total from pg_temp.balance()), 500, 'day 0: 1,000 spent, 500 left');

-- Day 5: a 1,000-credit top-up (expires at day 95).
select pg_temp.advance(5);
select public.grant_credits('c5000000-0000-0000-0000-000000000001', 1000, 'topup', 'c5200000-0000-0000-0000-000000000001');
select results_eq('select plan, topup, total from pg_temp.balance()', $$values (500, 1000, 1500)$$, 'day 5: a top-up is counted apart from plan credits');

-- Day 30: renewal. Month 1's 500 roll over next to month 2's 1,500.
select pg_temp.advance(25);
select pg_temp.renew('c5100000-0000-0000-0000-000000000002');
select results_eq('select plan, topup, total from pg_temp.balance()', $$values (2000, 1000, 3000)$$, 'day 30: month 1''s unspent 500 roll over');
select is((select count(*)::int from public.credit_ledger where tenant_id = 'c5000000-0000-0000-0000-000000000001' and reason = 'cycle_reset'), 0,
  'day 30: nothing is reset, since month 1 is the newest month before the renewal');

-- Day 30: 700 spent, soonest-expiring first: month 1's 500 (day 60), then 200 of month 2 (day 90); the top-up (day 95) is untouched.
select pg_temp.spend(700);
select results_eq(
  $$select -delta, (expires_at - now())::text from public.credit_ledger
     where tenant_id = 'c5000000-0000-0000-0000-000000000001' and reason = 'ai_reply' and created_at = now() order by expires_at$$,
  $$values (500, '30 days'), (200, '60 days')$$,
  'day 30: a spend takes the soonest-expiring credits first, across months');
select results_eq('select plan, topup, total from pg_temp.balance()', $$values (1300, 1000, 2300)$$, 'day 30: 1,300 plan credits and the whole top-up left');

-- Day 60: month 1 has expired (nothing was left of it). Renewal: month 2's 1,300 roll over.
select pg_temp.advance(30);
select is((select total from pg_temp.balance()), 2300, 'day 60: month 1 expires with nothing left in it');
select pg_temp.renew('c5100000-0000-0000-0000-000000000003');
select is((select total from pg_temp.balance()), 3800, 'day 60: month 2''s 1,300 roll over next to month 3''s 1,500 and the top-up');

-- Day 90: month 2's unspent 1,300 expire: plan credits roll over for exactly one month.
select pg_temp.advance(30);
select results_eq('select plan, topup, total from pg_temp.balance()', $$values (1500, 1000, 2500)$$,
  'day 90: month 2''s 1,300 are gone (one month of rollover only)');
select pg_temp.renew('c5100000-0000-0000-0000-000000000004');
select is((select total from pg_temp.balance()), 4000, 'day 90: month 4 arrives');

-- Day 90: 1,200 spent. The top-up expires soonest (day 95), so it goes before month 3 (day 120).
select pg_temp.spend(1200);
select results_eq('select plan, topup, total from pg_temp.balance()', $$values (2800, 0, 2800)$$,
  'day 90: a top-up that expires sooner is spent before plan credits');

-- Day 95: the top-up's day; it was used up, so nothing changes.
select pg_temp.advance(5);
select is((select total from pg_temp.balance()), 2800, 'day 95: the empty top-up expires');

-- Day 95: a renewal that comes early (month 3 and month 4 both still live): only the newest month (4) is kept.
select pg_temp.renew('c5100000-0000-0000-0000-000000000005');
select results_eq(
  $$select delta, (expires_at - now())::text from public.credit_ledger
     where tenant_id = 'c5000000-0000-0000-0000-000000000001' and reason = 'cycle_reset'$$,
  $$values (-1300, '25 days')$$,
  'day 95: an early renewal resets month 3''s 1,300, the month before the newest');
select is((select total from pg_temp.balance()), 3000, 'day 95: month 4''s 1,500 and month 5''s 1,500 remain');

select is(pg_temp.spend(3001), false, 'expired and reset credits can never be spent: 3,001 is refused');
select is(pg_temp.renew('c5100000-0000-0000-0000-000000000005'), false, 'the same renewal is never granted twice');

select * from finish();
rollback;
