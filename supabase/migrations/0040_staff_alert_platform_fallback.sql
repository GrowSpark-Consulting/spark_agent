-- 0040_staff_alert_platform_fallback: alerts and account notices reach a business with no working number of its own
-- (Dev 1's ask in docs/task-notes/2026-10-13-day6-dev1-health-jobs.md, item 1; Dev 2, 14 Oct).
--
-- notify_staff_target (0019, 0032) picked the business's own active number, else the platform number its customers'
-- latest chat is on. A business whose only number has just failed, or a trial whose customers have not written yet,
-- had neither, so the alert about the dead number, and the trial and billing notices (account_notice), could not be sent
-- at all. Now, as a last resort, our own platform number (the oldest active 'platform' connection: the shared demo
-- number), with the staff conversation on its channel under the business, the arrangement 0032 already uses.
--
-- Unchanged: the business's own number comes first, then the platform number its customers wrote on; notify_target
-- (customers) is untouched, so a customer is only ever written to on the channel they used. Outside the member's 24-hour
-- window the send needs an approved staff_alert template on that connection, as before. Signature and grants unchanged
-- (server only, 0019).

create or replace function public.notify_staff_target(p_tenant_id uuid, p_user_id uuid)
returns table (
  connection_id uuid, conversation_id uuid, contact_id uuid, to_phone text, opted_out boolean,
  last_customer_msg_at timestamptz, language text, recent_test_messages int
)
language plpgsql
set search_path = ''
as $$
-- The output columns (contact_id, …) share names with conversations' columns; in SQL here they mean the columns.
#variable_conflict use_column
declare
  v_phone text;
  v_connection_id uuid;
  v_channel_id uuid;
  v_contact_id uuid;
  v_conversation_id uuid;
begin
  select m.whatsapp_phone into v_phone
  from public.memberships m
  where m.tenant_id = p_tenant_id and m.user_id = p_user_id;
  if v_phone is null or v_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'notify_staff_target: this person has no WhatsApp number for alerts' using errcode = 'PA404';
  end if;

  select w.id, w.channel_id into v_connection_id, v_channel_id
  from public.whatsapp_connections w
  where w.tenant_id = p_tenant_id and w.status = 'active'
  order by w.created_at
  limit 1;
  if v_connection_id is null then
    -- No number of its own: the platform number its customers' latest chat is on (a trial on the shared demo number).
    select w.id, w.channel_id into v_connection_id, v_channel_id
    from public.conversations c
    join public.whatsapp_connections w on w.channel_id = c.channel_id
    where c.tenant_id = p_tenant_id and w.method = 'platform' and w.status = 'active'
    order by c.last_message_at desc nulls last, c.created_at desc
    limit 1;
  end if;
  if v_connection_id is null then
    -- No number of its own and no chat on one of ours (its number has failed, or it never had one): our own platform
    -- number, the oldest active one (the demo number), so an alert about a dead number, or a notice about the account,
    -- still reaches the owner.
    select w.id, w.channel_id into v_connection_id, v_channel_id
    from public.whatsapp_connections w
    where w.method = 'platform' and w.status = 'active'
    order by w.created_at
    limit 1;
  end if;
  if v_connection_id is null then
    raise exception 'notify_staff_target: no active WhatsApp connection' using errcode = 'PA409';
  end if;

  insert into public.contacts as ct (tenant_id, phone, tags)
  values (p_tenant_id, v_phone, array['staff'])
  on conflict (tenant_id, phone) do update
    set tags = case when 'staff' = any(ct.tags) then ct.tags else array_append(ct.tags, 'staff') end
  returning ct.id into v_contact_id;

  select c.id into v_conversation_id
  from public.conversations c
  where c.tenant_id = p_tenant_id and c.contact_id = v_contact_id and c.channel_id = v_channel_id and c.status = 'open';
  if v_conversation_id is null then
    insert into public.conversations (tenant_id, contact_id, channel_id, mode)
    values (p_tenant_id, v_contact_id, v_channel_id, 'human')
    on conflict (tenant_id, contact_id, channel_id) where status = 'open' do nothing
    returning id into v_conversation_id;
    if v_conversation_id is null then
      -- Another session opened it first (the one-open-conversation index made this insert wait): use theirs.
      select c.id into v_conversation_id
      from public.conversations c
      where c.tenant_id = p_tenant_id and c.contact_id = v_contact_id and c.channel_id = v_channel_id and c.status = 'open';
    end if;
  end if;

  return query
    select v_connection_id, c.id, ct.id, ct.phone, ct.opted_out_at is not null, c.last_customer_msg_at, ct.language, 0
    from public.conversations c join public.contacts ct on ct.id = c.contact_id
    where c.id = v_conversation_id and c.tenant_id = p_tenant_id;
end
$$;

revoke execute on function public.notify_staff_target(uuid, uuid) from public, anon, authenticated;
grant execute on function public.notify_staff_target(uuid, uuid) to service_role;
