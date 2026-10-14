-- 0042_billing_cancel: cancelling a plan, paying a past-due plan another way, and two fixes from the PayU audit (13 Oct)
-- (decision 20; backend/src/billing/checkout.ts and renewals.ts).
--
--   * Cancel (POST /api/billing/cancel, owner): the plan stops renewing and ends at the end of the period already paid
--     (subscriptions.cancel_at); no pre-debit notice or charge is made for it again. Resume (POST /api/billing/resume)
--     undoes it while the period lasts. The renewal job ends it at cancel_at (end_cancelled_subscriptions): cancelled,
--     the business paused (the inbox stays readable), its mandate revoked at PayU by the server, the owners told. A plan
--     already past due ends at once when cancelled.
--   * Paying another way: a past-due plan no longer blocks a new checkout. begin_payment lets the owner choose a plan
--     again (refused only while a plan is in good standing), and settle_payment, when that payment succeeds, cancels the
--     past-due plan it replaces (the server revokes its mandate) and starts the new one from now.
--   * A setup fee paid twice (two checkouts at once) is kept but flagged for a refund (payment.needs_refund), as a second
--     plan payment already is. Before, the second payment was recorded as a plain success.
--   * A renewal paid for a plan its owner cancelled (a charge already in flight) is flagged for a refund, not a new period.
--   * The browser loses its INSERT, UPDATE and DELETE grants on payments and subscriptions. Row-level security already
--     refused those writes (members may only read); the grants are revoked as well, like trial_phones and demo_visitors.
-- begin_payment, settle_payment, renewals_to_notify and renewals_to_charge are replaced with their 0036 to 0038 bodies
-- and these changes only. Server only.

alter table public.subscriptions add column cancel_at timestamptz;  -- the owner cancelled: the plan ends here and is not renewed

revoke insert, update, delete on public.payments from anon, authenticated;
revoke insert, update, delete on public.subscriptions from anon, authenticated;

create or replace function public.begin_payment(
  p_tenant_id uuid, p_kind text, p_txnid text, p_base_paise int, p_gst_paise int,
  p_credits int default null, p_plan_key text default null, p_billing_cycle text default null, p_created_by uuid default null
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
  v_setup_paid timestamptz;
  v_subscription_id uuid;
  v_payment_id uuid;
begin
  select t.status, t.setup_call_paid_at into v_status, v_setup_paid from public.tenants t where t.id = p_tenant_id for no key update;
  if not found then
    raise exception 'begin_payment: unknown business' using errcode = 'PA404';
  end if;
  if p_kind not in ('subscribe', 'topup', 'setup_fee') then
    raise exception 'begin_payment: % payments are started by the renewal job', p_kind using errcode = 'P0001';
  end if;

  if p_kind = 'subscribe' then
    if p_billing_cycle is null or p_credits is null
       or not exists (select 1 from public.plans p where p.key = p_plan_key and p.key <> 'trial' and p.price_inr > 0) then
      raise exception 'begin_payment: a subscription needs a paid plan, a cycle and its credits' using errcode = 'P0001';
    end if;
    -- A plan in good standing is changed or resumed, not bought again; a past-due one may be replaced by a new checkout.
    if exists (select 1 from public.subscriptions s where s.tenant_id = p_tenant_id and s.status = 'active') then
      raise exception 'begin_payment: the business already has a plan' using errcode = 'PA409';
    end if;
    update public.subscriptions s set status = 'cancelled' where s.tenant_id = p_tenant_id and s.status = 'pending';
    insert into public.subscriptions (tenant_id, plan_key, status, billing_cycle, amount_paise, replaces_subscription_id)
    values (p_tenant_id, p_plan_key, 'pending', p_billing_cycle, p_base_paise + p_gst_paise,
            (select s.id from public.subscriptions s where s.tenant_id = p_tenant_id and s.status = 'past_due' limit 1))
    returning id into v_subscription_id;
  elsif p_kind = 'topup' then
    if v_status <> 'active' or p_credits is null then
      raise exception 'begin_payment: top-ups are for a business on a paid plan' using errcode = 'PA409';
    end if;
  elsif v_setup_paid is not null then
    raise exception 'begin_payment: the setup fee is already paid' using errcode = 'PA409';
  end if;

  insert into public.payments (tenant_id, subscription_id, kind, txnid, base_paise, gst_paise, amount_paise, credits, plan_key, billing_cycle, created_by)
  values (p_tenant_id, v_subscription_id, p_kind, p_txnid, p_base_paise, p_gst_paise, p_base_paise + p_gst_paise, p_credits,
          case when p_kind = 'subscribe' then p_plan_key end, case when p_kind = 'subscribe' then p_billing_cycle end, p_created_by)
  returning id into v_payment_id;
  return v_payment_id;
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
  s_old public.subscriptions;
  v_mandate_method text := case
    when upper(coalesce(p_method, '')) in ('CC', 'DC', 'CREDITCARD', 'DEBITCARD', 'CARD') then 'card'
    when upper(coalesce(p_method, '')) = 'UPI' then 'upi'
    when upper(coalesce(p_method, '')) in ('NB', 'ENACH', 'NACH', 'NETBANKING') then 'enach'
  end;
  v_period interval;
  v_duplicate boolean;
  v_refund boolean := false;
  v_bucket timestamptz;
  v_setup_paid timestamptz;
  v_replaced uuid;
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
    if p.kind in ('subscribe', 'plan_change') then
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
  update public.payments pm
     set status = 'success', provider_payment_id = coalesce(p_provider_payment_id, pm.provider_payment_id),
         method = coalesce(p_method, pm.method), failure_reason = null, settled_at = now()
   where pm.id = p.id;

  if p.kind = 'topup' then
    perform public.grant_credits(p.tenant_id, p.credits, 'topup', p.id);
  elsif p.kind = 'setup_fee' then
    select t.setup_call_paid_at into v_setup_paid from public.tenants t where t.id = p.tenant_id for no key update;
    if v_setup_paid is not null then
      -- Paid twice (two checkouts at once): the first stands, this one waits for a refund.
      insert into public.audit_logs (tenant_id, actor, action, entity, entity_id, diff)
      values (p.tenant_id, 'system', 'payment.needs_refund', 'payment', p.id,
              jsonb_build_object('kind', p.kind, 'amount_paise', p.amount_paise, 'refund', true));
      return query select p.id, p.tenant_id, p.kind, 'success'::text, true;
      return;
    end if;
    update public.tenants t set setup_call_paid_at = now() where t.id = p.tenant_id;
  else
    perform 1 from public.tenants t where t.id = p.tenant_id for no key update;
    select * into s from public.subscriptions sub where sub.id = p.subscription_id for update;
    if p.kind = 'plan_change' then
      select * into s_old from public.subscriptions sub where sub.id = s.replaces_subscription_id for update;
      -- The plan it upgrades must still be the live one.
      v_refund := s_old.id is null or s_old.status not in ('active', 'past_due');
    else
      -- A new checkout replaces a past-due plan (cancelled below), but not one in good standing.
      v_duplicate := exists (
        select 1 from public.subscriptions sub
        where sub.tenant_id = p.tenant_id and sub.id <> p.subscription_id
          and (sub.status = 'active' or (sub.status = 'past_due' and p.kind = 'renewal'))
      );
      -- A renewal for a plan its owner cancelled (a charge already in flight) is not a new period either.
      v_refund := v_duplicate or (p.kind = 'renewal' and (s.current_period_end is distinct from p.for_period_end or s.cancel_at is not null));
    end if;
    if v_refund then
      -- Paid twice, or for a plan that is no longer the business's: the plan it has stands, and this payment waits for
      -- a refund.
      if p.kind in ('subscribe', 'plan_change') then
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
      -- The past-due plan it replaces ends now; the server revokes its mandate at PayU.
      update public.subscriptions sub set status = 'cancelled'
       where sub.tenant_id = p.tenant_id and sub.status = 'past_due' and sub.id <> s.id
      returning sub.id into v_replaced;
      update public.subscriptions sub
         set replaces_subscription_id = coalesce(sub.replaces_subscription_id, v_replaced), status = 'active', mandate_id = p_provider_payment_id, mandate_method = v_mandate_method, plan_key = p.plan_key,
             billing_cycle = p.billing_cycle, current_period_start = now(), current_period_end = now() + v_period,
             charge_attempts = 0, pre_debit_for = null, pre_debit_at = null
       where sub.id = p.subscription_id;
      -- Credits are monthly whatever the billing cycle; an annual plan's later months come from the renewal job. Like
      -- every plan grant (0005), the month's credits last to the end of the NEXT month: one month of rollover.
      perform public.renew_plan_credits(p.tenant_id, p.credits, now() + interval '2 months', p.id);
    elsif p.kind = 'renewal' then
      update public.subscriptions sub
         set status = 'active', plan_key = p.plan_key, next_plan_key = null, amount_paise = p.amount_paise,
             current_period_start = p.for_period_end, current_period_end = p.for_period_end + v_period,
             charge_attempts = 0, pre_debit_for = null, pre_debit_at = null
       where sub.id = p.subscription_id;
      perform public.renew_plan_credits(p.tenant_id, p.credits, p.for_period_end + interval '2 months', p.id);
    else
      -- plan_change: the old plan ends now (its mandate is revoked by the server), the new one runs over the same period
      -- on the new mandate, which needs its own pre-debit notice before the next renewal.
      update public.subscriptions sub set status = 'cancelled' where sub.id = s_old.id;
      update public.subscriptions sub
         set status = 'active', mandate_id = p_provider_payment_id, mandate_method = v_mandate_method,
             current_period_start = s_old.current_period_start, current_period_end = s_old.current_period_end,
             charge_attempts = 0, pre_debit_for = null, pre_debit_at = null
       where sub.id = s.id;
      if p.credits is not null then
        -- The extra credits join the current month's (the newest live plan grant), so they roll over with it.
        select max(l.expires_at) into v_bucket from public.credit_ledger l
         where l.tenant_id = p.tenant_id and l.reason = 'plan_grant' and l.delta > 0 and l.expires_at > now();
        insert into public.credit_ledger (tenant_id, delta, reason, ref_id, expires_at)
        values (p.tenant_id, p.credits, 'plan_grant', p.id, coalesce(v_bucket, now() + interval '2 months'));
      end if;
    end if;
    update public.tenants t set status = 'active', plan_key = p.plan_key where t.id = p.tenant_id;
  end if;

  insert into public.audit_logs (tenant_id, actor, action, entity, entity_id, diff)
  values (p.tenant_id, 'system', 'payment.succeeded', 'payment', p.id,
          jsonb_build_object('kind', p.kind, 'amount_paise', p.amount_paise, 'plan_key', p.plan_key, 'billing_cycle', p.billing_cycle));
  return query select p.id, p.tenant_id, p.kind, 'success'::text, true;
end
$$;

create or replace function public.renewals_to_notify(p_now timestamptz default now(), p_ahead interval default interval '4 days')
returns table (subscription_id uuid, tenant_id uuid, mandate_id text, mandate_method text, period_end timestamptz)
language sql stable
set search_path = ''
as $$
  select s.id, s.tenant_id, s.mandate_id, s.mandate_method, s.current_period_end
  from public.subscriptions s
  where s.status = 'active' and s.mandate_id is not null and s.current_period_end <= p_now + p_ahead
    and s.pre_debit_for is distinct from s.current_period_end
    and s.cancel_at is null
  order by s.current_period_end
$$;

create or replace function public.renewals_to_charge(
  p_now timestamptz default now(), p_max_attempts int default 3, p_retry_after interval default interval '2 days'
)
returns table (subscription_id uuid, tenant_id uuid, mandate_id text, period_end timestamptz)
language sql stable
set search_path = ''
as $$
  select s.id, s.tenant_id, s.mandate_id, s.current_period_end
  from public.subscriptions s
  where s.status in ('active', 'past_due') and s.mandate_id is not null and s.current_period_end <= p_now
    and s.cancel_at is null
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

-- The owner cancels. 'scheduled': the plan ends at the end of its paid period (asking again changes nothing). 'ended':
-- a past-due plan ends now and the business is paused; mandate_id and mandate_method name the mandate to revoke.
create function public.cancel_subscription(p_tenant_id uuid, p_actor text)
returns table (outcome text, ends_at timestamptz, mandate_id text, mandate_method text)
language plpgsql
set search_path = ''
as $$
declare
  s public.subscriptions;
begin
  perform 1 from public.tenants t where t.id = p_tenant_id for no key update;
  if not found then
    raise exception 'cancel_subscription: unknown business' using errcode = 'PA404';
  end if;
  select * into s from public.subscriptions sub where sub.tenant_id = p_tenant_id and sub.status in ('active', 'past_due') for update;
  if not found then
    raise exception 'cancel_subscription: the business has no plan to cancel' using errcode = 'PA409';
  end if;
  -- An upgrade or checkout started and not paid is dropped too.
  update public.subscriptions sub set status = 'cancelled' where sub.tenant_id = p_tenant_id and sub.status = 'pending';

  if s.status = 'past_due' then
    update public.subscriptions sub set status = 'cancelled' where sub.id = s.id;
    update public.tenants t set status = 'paused' where t.id = p_tenant_id and t.status = 'active';
    insert into public.audit_logs (tenant_id, actor, action, entity, entity_id, diff)
    values (p_tenant_id, p_actor, 'subscription.cancelled', 'subscription', s.id, jsonb_build_object('when', 'now', 'was', 'past_due'));
    return query select 'ended'::text, now(), s.mandate_id, s.mandate_method;
    return;
  end if;
  if s.cancel_at is null then
    update public.subscriptions sub set cancel_at = s.current_period_end, next_plan_key = null where sub.id = s.id;
    insert into public.audit_logs (tenant_id, actor, action, entity, entity_id, diff)
    values (p_tenant_id, p_actor, 'subscription.cancel_requested', 'subscription', s.id, jsonb_build_object('ends_at', s.current_period_end));
  end if;
  return query select 'scheduled'::text, s.current_period_end, null::text, null::text;
end
$$;

-- The owner keeps the plan after all, while the paid period lasts: it renews again.
create function public.resume_subscription(p_tenant_id uuid, p_actor text)
returns timestamptz
language plpgsql
set search_path = ''
as $$
declare
  s public.subscriptions;
begin
  perform 1 from public.tenants t where t.id = p_tenant_id for no key update;
  select * into s from public.subscriptions sub
   where sub.tenant_id = p_tenant_id and sub.status = 'active' and sub.cancel_at is not null and sub.current_period_end > now()
   for update;
  if not found then
    raise exception 'resume_subscription: no cancelled plan to resume' using errcode = 'PA409';
  end if;
  update public.subscriptions sub set cancel_at = null where sub.id = s.id;
  insert into public.audit_logs (tenant_id, actor, action, entity, entity_id, diff)
  values (p_tenant_id, p_actor, 'subscription.resumed', 'subscription', s.id, jsonb_build_object('renews_at', s.current_period_end));
  return s.current_period_end;
end
$$;

-- The renewal job: plans whose owner cancelled them, at the end of their paid period.
create function public.end_cancelled_subscriptions(p_now timestamptz default now())
returns table (tenant_id uuid, subscription_id uuid, mandate_id text, mandate_method text)
language plpgsql
set search_path = ''
as $$
declare
  r record;
begin
  for r in
    select s.id, s.tenant_id, s.mandate_id, s.mandate_method, s.cancel_at
    from public.subscriptions s
    where s.status = 'active' and s.cancel_at is not null and s.cancel_at <= p_now
    for update of s skip locked
  loop
    update public.subscriptions sub set status = 'cancelled' where sub.id = r.id;
    update public.tenants t set status = 'paused' where t.id = r.tenant_id and t.status = 'active';
    insert into public.audit_logs (tenant_id, actor, action, entity, entity_id, diff)
    values (r.tenant_id, 'system', 'subscription.ended', 'subscription', r.id, jsonb_build_object('cancel_at', r.cancel_at));
    tenant_id := r.tenant_id;
    subscription_id := r.id;
    mandate_id := r.mandate_id;
    mandate_method := r.mandate_method;
    return next;
  end loop;
end
$$;

revoke execute on function public.begin_payment(uuid, text, text, int, int, int, text, text, uuid) from public, anon, authenticated;
revoke execute on function public.settle_payment(text, text, text, text, int, text) from public, anon, authenticated;
revoke execute on function public.renewals_to_notify(timestamptz, interval) from public, anon, authenticated;
revoke execute on function public.renewals_to_charge(timestamptz, int, interval) from public, anon, authenticated;
revoke execute on function public.cancel_subscription(uuid, text) from public, anon, authenticated;
revoke execute on function public.resume_subscription(uuid, text) from public, anon, authenticated;
revoke execute on function public.end_cancelled_subscriptions(timestamptz) from public, anon, authenticated;
grant execute on function public.begin_payment(uuid, text, text, int, int, int, text, text, uuid) to service_role;
grant execute on function public.settle_payment(text, text, text, text, int, text) to service_role;
grant execute on function public.renewals_to_notify(timestamptz, interval) to service_role;
grant execute on function public.renewals_to_charge(timestamptz, int, interval) to service_role;
grant execute on function public.cancel_subscription(uuid, text) to service_role;
grant execute on function public.resume_subscription(uuid, text) to service_role;
grant execute on function public.end_cancelled_subscriptions(timestamptz) to service_role;
