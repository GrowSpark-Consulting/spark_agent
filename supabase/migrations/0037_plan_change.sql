-- 0037_plan_change: changing plan (decision 20; docs/handover.md, module 8: "upgrades apply at once with prorated
-- credits, downgrades next cycle"). POST /api/billing/change-plan, backend/src/billing/checkout.ts.
--
-- begin_plan_change(tenant, plan, txnid) decides, for a business with an active plan (PA409 without one; PA428 while
-- a renewal is past due, since that comes first):
--   * the same plan: a scheduled downgrade is cancelled ('kept'), or nothing ('unchanged');
--   * a cheaper plan: scheduled for the next cycle (subscriptions.next_plan_key; the renewal charges the new price on
--     the same mandate) ('scheduled');
--   * a dearer plan: an upgrade now ('upgrade'). The business pays the price difference for the rest of the period
--     (at least ₹1, PayU's minimum; GST added) and approves a new mandate at the new full price in the same PayU step.
--     A pending subscription records it (replaces_subscription_id = the current one), and the payment carries the
--     extra credits: the rest of the current credit month at the new plan's monthly credits, less the old plan's.
-- settle_payment (replacing 0036's) applies a paid upgrade: the old subscription is cancelled (the server then revokes
-- its mandate at PayU), the new one is active over the same period with the new mandate, the business moves to the new
-- plan, and the extra credits join the current month's credits (same expiry, so the same rollover). An upgrade paid
-- after its plan was replaced or lapsed is kept cancelled and audited for a refund. Server only.

alter table public.subscriptions add column replaces_subscription_id uuid references public.subscriptions(id) on delete set null;

create function public.begin_plan_change(p_tenant_id uuid, p_plan_key text, p_txnid text, p_created_by uuid default null, p_now timestamptz default now())
returns table (action text, payment_id uuid, amount_paise int, mandate_paise int, billing_cycle text, effective_at timestamptz)
language plpgsql
set search_path = ''
as $$
declare
  s public.subscriptions;
  v_old public.plans;
  v_new public.plans;
  v_mult int;
  v_fraction numeric;
  v_base int;
  v_gst int;
  v_mandate int;
  v_months int;
  v_month_start timestamptz;
  v_month_end timestamptz;
  v_credits int;
  v_subscription_id uuid;
  v_payment_id uuid;
begin
  perform 1 from public.tenants t where t.id = p_tenant_id for no key update;
  if not found then
    raise exception 'begin_plan_change: unknown business' using errcode = 'PA404';
  end if;
  select * into s from public.subscriptions sub where sub.tenant_id = p_tenant_id and sub.status in ('active', 'past_due') for update;
  if not found then
    raise exception 'begin_plan_change: the business has no plan to change' using errcode = 'PA409';
  end if;
  if s.status = 'past_due' then
    raise exception 'begin_plan_change: a renewal is past due' using errcode = 'PA428';
  end if;
  select * into v_new from public.plans pl where pl.key = p_plan_key and pl.key <> 'trial' and pl.price_inr > 0;
  if not found then
    raise exception 'begin_plan_change: % is not a plan that can be bought', p_plan_key using errcode = 'P0001';
  end if;
  select * into v_old from public.plans pl where pl.key = s.plan_key;

  if v_new.key = v_old.key then
    if s.next_plan_key is not null then
      update public.subscriptions sub set next_plan_key = null where sub.id = s.id;
      insert into public.audit_logs (tenant_id, actor, action, entity, entity_id, diff)
      values (p_tenant_id, coalesce(p_created_by::text, 'system'), 'subscription.downgrade_cancelled', 'subscription', s.id, jsonb_build_object('plan_key', v_old.key));
      return query select 'kept'::text, null::uuid, null::int, null::int, s.billing_cycle, p_now;
    else
      return query select 'unchanged'::text, null::uuid, null::int, null::int, s.billing_cycle, p_now;
    end if;
    return;
  end if;

  if v_new.price_inr < v_old.price_inr then
    update public.subscriptions sub set next_plan_key = v_new.key where sub.id = s.id;
    insert into public.audit_logs (tenant_id, actor, action, entity, entity_id, diff)
    values (p_tenant_id, coalesce(p_created_by::text, 'system'), 'subscription.downgrade_scheduled', 'subscription', s.id,
            jsonb_build_object('from', v_old.key, 'to', v_new.key, 'at', s.current_period_end));
    return query select 'scheduled'::text, null::uuid, null::int, null::int, s.billing_cycle, s.current_period_end;
    return;
  end if;

  -- Upgrade: the price difference for the rest of the billing period.
  v_mult := case s.billing_cycle when 'yearly' then 10 else 1 end;
  v_fraction := greatest(0, least(1,
    extract(epoch from (s.current_period_end - p_now)) / nullif(extract(epoch from (s.current_period_end - s.current_period_start)), 0)));
  v_base := greatest(100, round((v_new.price_inr - v_old.price_inr) * 100 * v_mult * coalesce(v_fraction, 1)))::int;
  v_gst := round(v_base * 18 / 100.0)::int;
  v_mandate := v_new.price_inr * 100 * v_mult;
  v_mandate := v_mandate + round(v_mandate * 18 / 100.0)::int;

  -- Extra credits: the rest of the current credit month (credits come monthly, whatever the billing cycle).
  v_months := (extract(year from age(p_now, s.current_period_start)) * 12 + extract(month from age(p_now, s.current_period_start)))::int;
  v_month_start := s.current_period_start + make_interval(months => greatest(v_months, 0));
  v_month_end := least(v_month_start + interval '1 month', s.current_period_end);
  v_credits := round((v_new.monthly_credits - v_old.monthly_credits) * greatest(0, least(1,
    extract(epoch from (v_month_end - p_now)) / nullif(extract(epoch from (v_month_end - v_month_start)), 0))))::int;
  if v_credits < 1 then
    v_credits := null;
  end if;

  -- An upgrade started before and abandoned waits as a pending subscription: this one replaces it.
  update public.subscriptions sub set status = 'cancelled' where sub.tenant_id = p_tenant_id and sub.status = 'pending';
  insert into public.subscriptions (tenant_id, plan_key, status, billing_cycle, amount_paise, replaces_subscription_id)
  values (p_tenant_id, v_new.key, 'pending', s.billing_cycle, v_mandate, s.id)
  returning id into v_subscription_id;
  insert into public.payments (tenant_id, subscription_id, kind, txnid, base_paise, gst_paise, amount_paise, credits, plan_key, billing_cycle, created_by)
  values (p_tenant_id, v_subscription_id, 'plan_change', p_txnid, v_base, v_gst, v_base + v_gst, v_credits, v_new.key, s.billing_cycle, p_created_by)
  returning id into v_payment_id;
  return query select 'upgrade'::text, v_payment_id, v_base + v_gst, v_mandate, s.billing_cycle, p_now;
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
    update public.tenants t set setup_call_paid_at = coalesce(t.setup_call_paid_at, now()) where t.id = p.tenant_id;
  else
    perform 1 from public.tenants t where t.id = p.tenant_id for no key update;
    select * into s from public.subscriptions sub where sub.id = p.subscription_id for update;
    if p.kind = 'plan_change' then
      select * into s_old from public.subscriptions sub where sub.id = s.replaces_subscription_id for update;
      -- The plan it upgrades must still be the live one.
      v_refund := s_old.id is null or s_old.status not in ('active', 'past_due');
    else
      v_duplicate := exists (
        select 1 from public.subscriptions sub
        where sub.tenant_id = p.tenant_id and sub.status in ('active', 'past_due') and sub.id <> p.subscription_id
      );
      v_refund := v_duplicate or (p.kind = 'renewal' and s.current_period_end is distinct from p.for_period_end);
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
      update public.subscriptions sub
         set status = 'active', mandate_id = p_provider_payment_id, mandate_method = v_mandate_method, plan_key = p.plan_key,
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

revoke execute on function public.begin_plan_change(uuid, text, text, uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.settle_payment(text, text, text, text, int, text) from public, anon, authenticated;
grant execute on function public.begin_plan_change(uuid, text, text, uuid, timestamptz) to service_role;
grant execute on function public.settle_payment(text, text, text, text, int, text) to service_role;
