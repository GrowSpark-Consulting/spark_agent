-- 0029_demo_routing: the shared demo number (docs/handover.md, module 8: "an inbound message on the demo
-- phone_number_id is routed by the route code in the customer's first message ... Limit: 30 messages per
-- phone per day").
--
-- The demo number stays one shared 'platform' connection row. A routed visitor's conversation is stored on that
-- connection's channel under the business the code names. This migration adds only the visitor's state:
--   * demo_visitors: who has messaged the demo number, the business they were routed to and today's count.
--     Server only: RLS is on with no policies, and anon and authenticated lose every privilege. tenant_id is null
--     until a code routes the visitor.
--   * demo_admit: counts one message from a phone against the day's limit, and starts the visitor's route when
--     the message carries a valid code, all in one locked transaction.

create table public.demo_visitors (
  phone text primary key check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  tenant_id uuid references public.tenants(id) on delete cascade,  -- the business the visitor was routed to; null until a code routes them
  routed_at timestamptz,                                            -- a route is good for 24 hours from here
  last_message_at timestamptz not null default now(),
  msg_day date not null,                                            -- the India calendar day msg_count belongs to
  msg_count int not null default 0 check (msg_count >= 0),
  -- The last 10 admitted message ids and, side by side, the business each was admitted for (null: none), so a
  -- redelivered message is stored for the business it was first stored for, whatever the route is now.
  recent_ids text[] not null default '{}',
  recent_tenants uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

create index demo_visitors_tenant_id_idx on public.demo_visitors (tenant_id);

alter table public.demo_visitors enable row level security;   -- no policies: only service_role reads or writes
revoke all on public.demo_visitors from anon, authenticated;

-- Counts one message from p_phone against the day's limit (the India calendar day) and says what to do with it.
--   * The visitor's row is locked and read first; a replay is judged from that row as it was, never from what
--     this call writes. Two messages from one phone take turns on the lock.
--   * A replay is a message id that was already admitted (one of the last 10). It changes nothing, is allowed
--     again (Meta redelivered a message we took, and storing it is idempotent) and answers with the business it was
--     admitted for. A replay of a message older than the last 10 admitted counts as a new one.
--   * A refused message is not remembered and never starts a route, so its replay is refused again. The count
--     stops at p_limit + 2, so "count = p_limit + 1" is true for exactly one message a day: the one that gets the
--     limit notice.
--   * p_route_tenant is the business a valid route code named (the caller looked it up). When the message is
--     admitted it starts the visitor's route, which replaces an older one. message_tenant_id is that business, or
--     else the business of a route under 24 hours old, or null.
create function public.demo_admit(
  p_phone text, p_wamid text, p_limit int, p_now timestamptz default now(), p_route_tenant uuid default null
)
returns table (allowed boolean, notify_limit boolean, replay boolean, message_tenant_id uuid)
language plpgsql
set search_path = ''
as $$
declare
  v_day date := (p_now at time zone 'Asia/Kolkata')::date;
  v public.demo_visitors;
  v_count int;
  v_allowed boolean;
  v_tenant uuid;
begin
  if p_phone is null or p_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'demo_admit: not an E.164 number' using errcode = 'P0001';
  end if;
  if p_wamid is null or p_wamid = '' or p_limit is null or p_limit < 1 or p_now is null then
    raise exception 'demo_admit: a message id, a time and a positive limit are required' using errcode = 'P0001';
  end if;

  insert into public.demo_visitors (phone, msg_day, msg_count, last_message_at)
  values (p_phone, v_day, 0, p_now)
  on conflict (phone) do nothing;

  select * into v from public.demo_visitors d where d.phone = p_phone for update;

  if p_wamid = any (v.recent_ids) then
    return query select true, false, true, v.recent_tenants[array_position(v.recent_ids, p_wamid)];
    return;
  end if;

  v_count := case when v.msg_day = v_day then least(v.msg_count + 1, p_limit + 2) else 1 end;
  v_allowed := v_count <= p_limit;
  v_tenant := coalesce(p_route_tenant, case when v.routed_at > p_now - interval '24 hours' then v.tenant_id end);

  update public.demo_visitors d
     set msg_count = v_count,
         msg_day = v_day,
         last_message_at = p_now,
         recent_ids = case when v_allowed then (array[p_wamid] || d.recent_ids)[1:10] else d.recent_ids end,
         recent_tenants = case when v_allowed then (array[v_tenant] || d.recent_tenants)[1:10] else d.recent_tenants end,
         tenant_id = case when v_allowed and p_route_tenant is not null then p_route_tenant else d.tenant_id end,
         routed_at = case when v_allowed and p_route_tenant is not null then p_now else d.routed_at end
   where d.phone = p_phone;

  return query select v_allowed, v_count = p_limit + 1, false, case when v_allowed then v_tenant end;
end
$$;

revoke execute on function public.demo_admit(text, text, int, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.demo_admit(text, text, int, timestamptz, uuid) to service_role;
