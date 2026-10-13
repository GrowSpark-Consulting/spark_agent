-- 0034_credit_refund_retries: a retried send gets back what every failed attempt spent, not only the first.
--
-- notify.send spends and refunds under the message id, and a keyed send (idempotencyKey) keeps the same id on every
-- attempt, so a job's retry spends again under the same ref_id. 0008 returned 0 once any refund existed for the ref_id:
-- the first failed attempt was refunded, and every later one lost its credits (balance 10 → 9 → 8 after three).
--
-- Fix: refund what is still owed for the ref_id, bucket by bucket: what was spent from the bucket less what was already
-- refunded into it, so each attempt's credits go back to the bucket they came from, with its expiry. A repeated refund
-- with no new spend still returns 0. The body is otherwise 0008's.

create or replace function public.refund_credits(p_tenant_id uuid, p_ref_id uuid)
returns int
language plpgsql
set search_path = ''
as $$
declare
  v_total int := 0;
  b record;
begin
  if p_ref_id is null then
    raise exception 'refund_credits: ref_id is required';
  end if;

  perform 1 from public.tenants where id = p_tenant_id for update;
  if not found then
    raise exception 'refund_credits: unknown tenant %', p_tenant_id;
  end if;

  for b in
    select expires_at, owed
    from (
      select expires_at,
             coalesce(-sum(delta) filter (
               where delta < 0 and reason in ('ai_reply', 'template_utility', 'template_marketing', 'staff_alert', 'admin')
             ), 0)
             - coalesce(sum(delta) filter (where reason = 'refund'), 0) as owed
      from public.credit_ledger
      where tenant_id = p_tenant_id and ref_id = p_ref_id
      group by expires_at
    ) buckets
    where owed > 0
  loop
    insert into public.credit_ledger (tenant_id, delta, reason, ref_id, expires_at)
    values (p_tenant_id, b.owed, 'refund', p_ref_id, b.expires_at);
    v_total := v_total + b.owed;
  end loop;

  return v_total;
end
$$;

-- Same signature, so 0008's grants stand; repeated so nothing depends on that. Server only.
revoke execute on function public.refund_credits(uuid, uuid) from public, anon, authenticated;
grant execute on function public.refund_credits(uuid, uuid) to service_role;
