-- 0045_notify_attempts: a keyed send is claimed before WhatsApp is asked, so it goes out at most once (Day 7; closes the
-- gap in docs/task-notes/2026-10-13-day6-dev1-reply-idempotency-key.md, section 3.1). backend/src/notify/send.ts.
--
-- Before: notify.send recorded a keyed message (notify_record, the messages row its repeat looks for) only after WhatsApp
-- answered. A process that died in between, or a notify_record that failed, left nothing to find, so the retry sent the
-- message again. Now a keyed send first claims its message id here ('sending'):
--   * a repeat that finds the message recorded returns it, as before;
--   * a repeat that finds the claim still 'sending' and no message recorded does NOT send: the earlier attempt may have
--     gone out (it died, or its record failed), so the answer is an unknown outcome, which callers never resend;
--   * an attempt that WhatsApp refused for certain (or that never reached it: no credits) releases its claim, so a later
--     attempt may send.
-- The price is the rare process that dies after claiming and before WhatsApp got the message: that message never goes.
-- At most once, never twice (Day 7: "failures must never produce a second message"). Server only.

create table public.notify_attempts (
  message_id uuid primary key,      -- keyedMessageId(business, kind, key): the id the message is recorded under once sent
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kind text not null,
  status text not null check (status in ('sending', 'released')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index notify_attempts_tenant_id_idx on public.notify_attempts (tenant_id);
alter table public.notify_attempts enable row level security;  -- no policies: server only
revoke all on public.notify_attempts from anon, authenticated;

-- 'claimed': send it. 'sent': it is recorded already (return that). 'in_doubt': an earlier attempt claimed it and never
-- recorded or released it, so it may have gone out: do not send.
create function public.claim_notify_attempt(p_tenant_id uuid, p_message_id uuid, p_kind text)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_claimed uuid;
begin
  if exists (select 1 from public.messages m where m.id = p_message_id and m.tenant_id = p_tenant_id) then
    return 'sent';
  end if;
  insert into public.notify_attempts as a (message_id, tenant_id, kind, status)
  values (p_message_id, p_tenant_id, p_kind, 'sending')
  on conflict (message_id) do update
    set status = 'sending', updated_at = now()
    where a.status = 'released' and a.tenant_id = p_tenant_id
  returning a.message_id into v_claimed;
  return case when v_claimed is null then 'in_doubt' else 'claimed' end;
end;
$$;

-- WhatsApp refused the message for certain, or it was never asked: a later attempt may send.
create function public.release_notify_attempt(p_tenant_id uuid, p_message_id uuid)
returns void
language sql
set search_path = ''
as $$
  update public.notify_attempts
     set status = 'released', updated_at = now()
   where message_id = p_message_id and tenant_id = p_tenant_id and status = 'sending';
$$;

revoke execute on function public.claim_notify_attempt(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.release_notify_attempt(uuid, uuid) from public, anon, authenticated;
