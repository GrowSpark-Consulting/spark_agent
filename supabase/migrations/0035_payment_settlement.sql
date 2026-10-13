-- 0035_payment_settlement: starting a PayU payment and applying its verified result (decision 20; 0034's tables).
--
-- begin_payment records a payment before the payer is sent to PayU:
--   * subscribe: a pending subscription (the mandate to approve) for a paid plan and cycle. Refused (PA409) while the
--     business has a live subscription: changing plan is its own flow. Older pending ones are cancelled (an abandoned
--     checkout); if one of them is paid after all, settle_payment still honours it.
--   * topup: a credit pack, for a business on a paid plan (PA409 otherwise: a trial subscribes instead).
--   * setup_fee: once per business (PA409 when already paid).
-- settle_payment applies what PayU says about a payment, as verified by the server with PayU (verify_payment), never
-- what was posted to our URLs. It locks the payment, and a payment already success or failed is final, so the return
-- URL, the webhook and status polling may all call it, in any order, any number of times:
--   * success: the amount must match (PA422 otherwise, nothing applied); then
--       topup      grants the pack (grant_credits, 'topup', ref = the payment: never twice);
--       setup_fee  marks tenants.setup_call_paid_at;
--       subscribe  activates the mandate (mandate_id = PayU's mihpayid), starts the period, moves the business to
--                  active on the plan and grants the first month's credits (renew_plan_credits, ref = the payment).
--                  A second subscription paid while another is live is kept cancelled and audited for a refund.
--   * failed: recorded with PayU's reason; a subscribe's pending subscription is cancelled.
--   * pending: recorded; not_found (the payer never reached PayU): nothing changes.
--   Renewals and plan changes come with the renewal job (they raise here until then).
-- Every applied result writes an audit row. Server only.

alter table public.payments add column credits int check (credits > 0);  -- what the payment grants: a top-up pack, or a plan's month

create function public.begin_payment(
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
    if exists (select 1 from public.subscriptions s where s.tenant_id = p_tenant_id and s.status in ('active', 'past_due')) then
      raise exception 'begin_payment: the business already has a plan' using errcode = 'PA409';
    end if;
    update public.subscriptions s set status = 'cancelled' where s.tenant_id = p_tenant_id and s.status = 'pending';
    insert into public.subscriptions (tenant_id, plan_key, status, billing_cycle, amount_paise)
    values (p_tenant_id, p_plan_key, 'pending', p_billing_cycle, p_base_paise + p_gst_paise)
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

create function public.settle_payment(
  p_txnid text, p_state text, p_provider_payment_id text default null, p_method text default null,
  p_amount_paise int default null, p_reason text default null
)
returns table (payment_id uuid, tenant_id uuid, kind text, status text, applied boolean)
language plpgsql
set search_path = ''
as $$
declare
  p public.payments;
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
      update public.subscriptions s set status = 'cancelled' where s.id = p.subscription_id and s.status = 'pending';
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
  if p.kind not in ('subscribe', 'topup', 'setup_fee') then
    raise exception 'settle_payment: % payments are settled by the renewal job', p.kind using errcode = 'P0001';
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
    v_duplicate := exists (
      select 1 from public.subscriptions s
      where s.tenant_id = p.tenant_id and s.status in ('active', 'past_due') and s.id <> p.subscription_id
    );
    if v_duplicate then
      -- Paid twice (two checkouts at once): the first plan stands, this one waits for a refund.
      update public.subscriptions s set status = 'cancelled', mandate_id = p_provider_payment_id, mandate_method = v_mandate_method
       where s.id = p.subscription_id;
      insert into public.audit_logs (tenant_id, actor, action, entity, entity_id, diff)
      values (p.tenant_id, 'system', 'payment.duplicate_subscription', 'payment', p.id,
              jsonb_build_object('amount_paise', p.amount_paise, 'refund', true));
      return query select p.id, p.tenant_id, p.kind, 'success'::text, true;
      return;
    end if;
    v_period := case p.billing_cycle when 'yearly' then interval '1 year' else interval '1 month' end;
    update public.subscriptions s
       set status = 'active', mandate_id = p_provider_payment_id, mandate_method = v_mandate_method, plan_key = p.plan_key,
           billing_cycle = p.billing_cycle, current_period_start = now(), current_period_end = now() + v_period,
           charge_attempts = 0, pre_debit_for = null
     where s.id = p.subscription_id;
    update public.tenants t set status = 'active', plan_key = p.plan_key where t.id = p.tenant_id;
    -- Credits are monthly whatever the billing cycle; an annual plan's later months come from the renewal job.
    perform public.renew_plan_credits(p.tenant_id, p.credits, now() + interval '1 month', p.id);
  end if;

  insert into public.audit_logs (tenant_id, actor, action, entity, entity_id, diff)
  values (p.tenant_id, 'system', 'payment.succeeded', 'payment', p.id,
          jsonb_build_object('kind', p.kind, 'amount_paise', p.amount_paise, 'plan_key', p.plan_key, 'billing_cycle', p.billing_cycle));
  return query select p.id, p.tenant_id, p.kind, 'success'::text, true;
end
$$;

revoke execute on function public.begin_payment(uuid, text, text, int, int, int, text, text, uuid) from public, anon, authenticated;
revoke execute on function public.settle_payment(text, text, text, text, int, text) from public, anon, authenticated;
grant execute on function public.begin_payment(uuid, text, text, int, int, int, text, text, uuid) to service_role;
grant execute on function public.settle_payment(text, text, text, text, int, text) to service_role;
