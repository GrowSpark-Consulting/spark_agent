-- 0036_renewals: renewing a plan by PayU auto-debit (decision 20; the billing-renewals job, backend/src/billing/renewals.ts).
--
-- One renewal payment per subscription and period (payments.for_period_end = the period end it renews); a failed attempt
-- is final, so a retry is a new payment for the same period. The job, once a day:
--   1. renewals_to_notify: active mandates whose period ends within 4 days and whose pre-debit notice is not out yet.
--      begin_renewal records the payment (amount from the plan of the next cycle: next_plan_key, else plan_key; annual =
--      10x; GST added), then the job sends PayU's notice (cards and UPI; RBI) for its first run at least 48 hours away and
--      not before the period ends, and stamps pre_debit_for (the period) and pre_debit_at (that announced debit time).
--   2. renewals_to_charge: mandates whose period has ended and whose announced debit time has come (e-NACH needs no
--      notice), with no renewal pending or paid for the period, fewer than 3 failed attempts, and none in the last 2 days.
--      The job marks the payment pending before it asks PayU to charge, so a crash never charges twice.
--   3. grant_annual_credit_months: an annual plan's credits still come month by month (months 1 to 11 of its year; the
--      payment grants month 0). Each month is granted once (ref = a hash of the subscription and the month).
--   4. lapse_overdue_subscriptions: a mandate still past_due 7 days after its period ended is cancelled and the business
--      paused (its inbox stays readable; choosing a plan in Billing starts again).
-- settle_payment (replacing 0035's) now settles renewals:
--   * success: the period moves on (start = the old end), the plan of the next cycle takes over, the business is active,
--     and the month's credits are granted to the end of the next month (one month of rollover), once (ref = the payment).
--     A renewal paid after its mandate lapsed revives it unless the business has a plan again (then audited for a refund).
--   * failed: the subscription is past_due; the job alerts the owners and retries.
-- Plan changes come next (they still raise). Server only.

alter table public.payments add column for_period_end timestamptz;
create unique index payments_one_open_renewal on public.payments (subscription_id, for_period_end)
  where kind = 'renewal' and status in ('created', 'pending', 'success');

alter table public.subscriptions add column pre_debit_at timestamptz;  -- the debit time the notice for pre_debit_for announced

create function public.begin_renewal(p_subscription_id uuid, p_txnid text)
returns table (payment_id uuid, txnid text, amount_paise int, period_end timestamptz, status text, created boolean)
language plpgsql
set search_path = ''
as $$
declare
  s public.subscriptions;
  v_existing public.payments;
  v_plan public.plans;
  v_base int;
  v_gst int;
  v_id uuid;
begin
  select * into s from public.subscriptions sub where sub.id = p_subscription_id for update;
  if not found or s.status not in ('active', 'past_due') or s.mandate_id is null or s.current_period_end is null then
    raise exception 'begin_renewal: no live mandate to renew' using errcode = 'PA409';
  end if;
  select * into v_existing from public.payments pm
   where pm.subscription_id = s.id and pm.kind = 'renewal' and pm.for_period_end = s.current_period_end
     and pm.status in ('created', 'pending', 'success');
  if found then
    return query select v_existing.id, v_existing.txnid, v_existing.amount_paise, s.current_period_end, v_existing.status, false;
    return;
  end if;
  select * into v_plan from public.plans pl where pl.key = coalesce(s.next_plan_key, s.plan_key);
  v_base := v_plan.price_inr * 100 * (case s.billing_cycle when 'yearly' then 10 else 1 end);
  v_gst := round(v_base * 18 / 100.0)::int;
  insert into public.payments (tenant_id, subscription_id, kind, txnid, base_paise, gst_paise, amount_paise, credits, plan_key, billing_cycle, for_period_end)
  values (s.tenant_id, s.id, 'renewal', p_txnid, v_base, v_gst, v_base + v_gst, v_plan.monthly_credits, v_plan.key, s.billing_cycle, s.current_period_end)
  returning id into v_id;
  return query select v_id, p_txnid, v_base + v_gst, s.current_period_end, 'created'::text, true;
end
$$;

create or replace function public.settle_payment(
  p_txnid text, p_state text, p_provider_payment_id text default null, p_method text default null,
  p_amount_paise int default null, p_reason text default null
)
returns table (payment_id uuid, tenant_id uuid, kind text, status text, applied boolean)
language plpgsql
set search_path = ''
as $$
declare
  p public.payments;
  s public.subscriptions;
  v_mandate_method text := case
    when upper(coalesce(p_method, '')) in ('CC', 'DC', 'CREDITCARD', 'DEBITCARD', 'CARD') then 'card'
    when upper(coalesce(p_method, '')) = 'UPI' then 'upi'
    when upper(coalesce(p_method, '')) in ('NB', 'ENACH', 'NACH', 'NETBANKING') then 'enach'
  end;
  v_period interval;
  v_duplicate boolean;
begin
  if p_state not in ('success', 'pending', 'failed', 'not_found') then
    raise exception 'settle_payment: unknown state %', p_state using errcode = 'P0001';
  end if;
  select * into p from public.payments pm where pm.txnid = p_txnid for update;
  if not found then
    raise exception 'settle_payment: unknown payment' using errcode = 'PA404';
  end if;
  if p.status in ('success', 'failed') or p_state = 'not_found' then
    return query select p.id, p.tenant_id, p.kind, p.status, false;
    return;
  end if;

  if p_state = 'pending' then
    update public.payments pm
       set status = 'pending', provider_payment_id = coalesce(p_provider_payment_id, pm.provider_payment_id), method = coalesce(p_method, pm.method)
     where pm.id = p.id;
    return query select p.id, p.tenant_id, p.kind, 'pending'::text, false;
    return;
  end if;

  if p_state = 'failed' then
    update public.payments pm
       set status = 'failed', failure_reason = left(coalesce(nullif(btrim(p_reason), ''), 'PayU did not say why'), 300),
           provider_payment_id = coalesce(p_provider_payment_id, pm.provider_payment_id), method = coalesce(p_method, pm.method),
           settled_at = now()
     where pm.id = p.id;
    if p.kind = 'subscribe' then
      update public.subscriptions sub set status = 'cancelled' where sub.id = p.subscription_id and sub.status = 'pending';
    elsif p.kind = 'renewal' then
      update public.subscriptions sub set status = 'past_due', charge_attempts = sub.charge_attempts + 1
       where sub.id = p.subscription_id and sub.status in ('active', 'past_due') and sub.current_period_end = p.for_period_end;
    end if;
    insert into public.audit_logs (tenant_id, actor, action, entity, entity_id, diff)
    values (p.tenant_id, 'system', 'payment.failed', 'payment', p.id, jsonb_build_object('kind', p.kind, 'amount_paise', p.amount_paise));
    return query select p.id, p.tenant_id, p.kind, 'failed'::text, true;
    return;
  end if;

  -- success
  if p_amount_paise is not null and p_amount_paise <> p.amount_paise then
    raise exception 'settle_payment: PayU reports % paise, the payment is % paise', p_amount_paise, p.amount_paise using errcode = 'PA422';
  end if;
  if p.kind not in ('subscribe', 'renewal', 'topup', 'setup_fee') then
    raise exception 'settle_payment: % payments are not settled here yet', p.kind using errcode = 'P0001';
  end if;
  update public.payments pm
     set status = 'success', provider_payment_id = coalesce(p_provider_payment_id, pm.provider_payment_id),
         method = coalesce(p_method, pm.method), failure_reason = null, settled_at = now()
   where pm.id = p.id;

  if p.kind = 'topup' then
    perform public.grant_credits(p.tenant_id, p.credits, 'topup', p.id);
  elsif p.kind = 'setup_fee' then
    update public.tenants t set setup_call_paid_at = coalesce(t.setup_call_paid_at, now()) where t.id = p.tenant_id;
  else
    perform 1 from public.tenants t where t.id = p.tenant_id for no key update;
    select * into s from public.subscriptions sub where sub.id = p.subscription_id for update;
    v_duplicate := exists (
      select 1 from public.subscriptions sub
      where sub.tenant_id = p.tenant_id and sub.status in ('active', 'past_due') and sub.id <> p.subscription_id
    );
    if v_duplicate or (p.kind = 'renewal' and s.current_period_end is distinct from p.for_period_end) then
      -- Paid twice (two checkouts at once), or a renewal for a period that is no longer this mandate's: the plan the
      -- business has stands, and this payment waits for a refund.
      if p.kind = 'subscribe' then
        update public.subscriptions sub set status = 'cancelled', mandate_id = p_provider_payment_id, mandate_method = v_mandate_method
         where sub.id = p.subscription_id;
      end if;
      insert into public.audit_logs (tenant_id, actor, action, entity, entity_id, diff)
      values (p.tenant_id, 'system', 'payment.needs_refund', 'payment', p.id,
              jsonb_build_object('kind', p.kind, 'amount_paise', p.amount_paise, 'refund', true));
      return query select p.id, p.tenant_id, p.kind, 'success'::text, true;
      return;
    end if;
    v_period := case p.billing_cycle when 'yearly' then interval '1 year' else interval '1 month' end;
    if p.kind = 'subscribe' then
      update public.subscriptions sub
         set status = 'active', mandate_id = p_provider_payment_id, mandate_method = v_mandate_method, plan_key = p.plan_key,
             billing_cycle = p.billing_cycle, current_period_start = now(), current_period_end = now() + v_period,
             charge_attempts = 0, pre_debit_for = null, pre_debit_at = null
       where sub.id = p.subscription_id;
      -- Credits are monthly whatever the billing cycle; an annual plan's later months come from the renewal job. Like
      -- every plan grant (0005), the month's credits last to the end of the NEXT month: one month of rollover.
      perform public.renew_plan_credits(p.tenant_id, p.credits, now() + interval '2 months', p.id);
    else
      update public.subscriptions sub
         set status = 'active', plan_key = p.plan_key, next_plan_key = null, amount_paise = p.amount_paise,
             current_period_start = p.for_period_end, current_period_end = p.for_period_end + v_period,
             charge_attempts = 0, pre_debit_for = null, pre_debit_at = null
       where sub.id = p.subscription_id;
      perform public.renew_plan_credits(p.tenant_id, p.credits, p.for_period_end + interval '2 months', p.id);
    end if;
    update public.tenants t set status = 'active', plan_key = p.plan_key where t.id = p.tenant_id;
  end if;

  insert into public.audit_logs (tenant_id, actor, action, entity, entity_id, diff)
  values (p.tenant_id, 'system', 'payment.succeeded', 'payment', p.id,
          jsonb_build_object('kind', p.kind, 'amount_paise', p.amount_paise, 'plan_key', p.plan_key, 'billing_cycle', p.billing_cycle));
  return query select p.id, p.tenant_id, p.kind, 'success'::text, true;
end
$$;

create function public.renewals_to_notify(p_now timestamptz default now(), p_ahead interval default interval '4 days')
returns table (subscription_id uuid, tenant_id uuid, mandate_id text, mandate_method text, period_end timestamptz)
language sql stable
set search_path = ''
as $$
  select s.id, s.tenant_id, s.mandate_id, s.mandate_method, s.current_period_end
  from public.subscriptions s
  where s.status = 'active' and s.mandate_id is not null and s.current_period_end <= p_now + p_ahead
    and s.pre_debit_for is distinct from s.current_period_end
  order by s.current_period_end
$$;

create function public.renewals_to_charge(
  p_now timestamptz default now(), p_max_attempts int default 3, p_retry_after interval default interval '2 days'
)
returns table (subscription_id uuid, tenant_id uuid, mandate_id text, period_end timestamptz)
language sql stable
set search_path = ''
as $$
  select s.id, s.tenant_id, s.mandate_id, s.current_period_end
  from public.subscriptions s
  where s.status in ('active', 'past_due') and s.mandate_id is not null and s.current_period_end <= p_now
    and (s.mandate_method = 'enach' or (s.pre_debit_for = s.current_period_end and s.pre_debit_at <= p_now + interval '1 hour'))
    and not exists (
      select 1 from public.payments pm
      where pm.subscription_id = s.id and pm.kind = 'renewal' and pm.for_period_end = s.current_period_end and pm.status in ('pending', 'success'))
    and (select count(*) from public.payments pm
         where pm.subscription_id = s.id and pm.kind = 'renewal' and pm.for_period_end = s.current_period_end and pm.status = 'failed') < p_max_attempts
    and not exists (
      select 1 from public.payments pm
      where pm.subscription_id = s.id and pm.kind = 'renewal' and pm.for_period_end = s.current_period_end
        and pm.status = 'failed' and pm.settled_at > p_now - p_retry_after)
  order by s.current_period_end
$$;

create function public.grant_annual_credit_months(p_now timestamptz default now())
returns int
language plpgsql
set search_path = ''
as $$
declare
  r record;
  v_months int;
  v_month_start timestamptz;
  v_granted int := 0;
begin
  for r in
    select s.id, s.tenant_id, s.current_period_start, pl.monthly_credits
    from public.subscriptions s join public.plans pl on pl.key = s.plan_key
    where s.status in ('active', 'past_due') and s.billing_cycle = 'yearly' and s.current_period_start <= p_now
  loop
    -- Whole months since the year started; month 0 came with the payment, and month 12 is the next year's.
    v_months := (extract(year from age(p_now, r.current_period_start)) * 12 + extract(month from age(p_now, r.current_period_start)))::int;
    continue when v_months < 1 or v_months > 11;
    v_month_start := r.current_period_start + make_interval(months => v_months);
    if public.renew_plan_credits(r.tenant_id, r.monthly_credits, v_month_start + interval '2 months',
                                 md5(r.id::text || ':' || v_month_start::text)::uuid) then
      v_granted := v_granted + 1;
    end if;
  end loop;
  return v_granted;
end
$$;

create function public.lapse_overdue_subscriptions(p_now timestamptz default now(), p_grace interval default interval '7 days')
returns table (tenant_id uuid, subscription_id uuid)
language plpgsql
set search_path = ''
as $$
declare
  r record;
begin
  for r in
    select s.id, s.tenant_id from public.subscriptions s
    where s.status = 'past_due' and s.current_period_end < p_now - p_grace
      and not exists (
        select 1 from public.payments pm
        where pm.subscription_id = s.id and pm.kind = 'renewal' and pm.for_period_end = s.current_period_end and pm.status = 'pending')
    for update of s skip locked
  loop
    update public.subscriptions sub set status = 'cancelled' where sub.id = r.id;
    update public.tenants t set status = 'paused' where t.id = r.tenant_id and t.status = 'active';
    insert into public.audit_logs (tenant_id, actor, action, entity, entity_id, diff)
    values (r.tenant_id, 'system', 'subscription.lapsed', 'subscription', r.id, jsonb_build_object('grace_days', extract(day from p_grace)));
    tenant_id := r.tenant_id;
    subscription_id := r.id;
    return next;
  end loop;
end
$$;

revoke execute on function public.begin_renewal(uuid, text) from public, anon, authenticated;
revoke execute on function public.settle_payment(text, text, text, text, int, text) from public, anon, authenticated;
revoke execute on function public.renewals_to_notify(timestamptz, interval) from public, anon, authenticated;
revoke execute on function public.renewals_to_charge(timestamptz, int, interval) from public, anon, authenticated;
revoke execute on function public.grant_annual_credit_months(timestamptz) from public, anon, authenticated;
revoke execute on function public.lapse_overdue_subscriptions(timestamptz, interval) from public, anon, authenticated;
grant execute on function public.begin_renewal(uuid, text) to service_role;
grant execute on function public.settle_payment(text, text, text, text, int, text) to service_role;
grant execute on function public.renewals_to_notify(timestamptz, interval) to service_role;
grant execute on function public.renewals_to_charge(timestamptz, int, interval) to service_role;
grant execute on function public.grant_annual_credit_months(timestamptz) to service_role;
grant execute on function public.lapse_overdue_subscriptions(timestamptz, interval) to service_role;
