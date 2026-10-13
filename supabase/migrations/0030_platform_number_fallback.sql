-- 0030_platform_number_fallback: a business whose customers write to one of our own numbers (the shared demo number a
-- trial is routed through, Dev 1's demo routing; 9-day plan, Day 6) is answered through that number (Dev 2, 13 Oct).
--
-- A routed trial has no connection of its own: its customers' conversations are on the platform number's channel, and
-- that number's single connection row (method 'platform') belongs to our platform business. Until now notify_target and
-- notify_staff_target only took the business's own connection, so nothing could be sent in those chats. One shared row
-- (not a copy per routed business) keeps the token in one place and the number's approved templates in one set
-- (whatsapp_templates.meta_template_id is unique).
--
--   * notify_target, for a conversation: the active connection on the conversation's channel, the business's own or a
--     platform number's (the business's own first). The conversation's channel is set by the server when a message is
--     stored, so a business only ever reaches a platform number its own customers wrote to. A number typed by staff
--     (the test message) still needs the business's own number.
--   * notify_staff_target: the business's own active number, else the platform number its customers' latest chat is on.
--   * The sender decrypts a platform row's token with that row's own business (backend/src/channels/whatsapp/
--     message-sender.ts), since the token was encrypted for it.
-- Signatures and grants are unchanged (server only, from 0009 and 0019).

create or replace function public.notify_target(
  p_tenant_id uuid, p_conversation_id uuid default null, p_to text default null
)
returns table (
  connection_id uuid, conversation_id uuid, contact_id uuid, to_phone text, opted_out boolean,
  last_customer_msg_at timestamptz, language text, recent_test_messages int
)
language plpgsql
set search_path = ''
as $$
declare
  v_connection_id uuid;
  v_channel_id uuid;
  v_conversation_id uuid := p_conversation_id;
  v_contact_id uuid;
begin
  if (p_conversation_id is null) = (p_to is null) then
    raise exception 'notify_target: pass either a conversation or a number' using errcode = 'P0001';
  end if;

  if p_conversation_id is not null then
    select c.channel_id, c.contact_id into v_channel_id, v_contact_id
    from public.conversations c
    where c.id = p_conversation_id and c.tenant_id = p_tenant_id;
    if not found then
      raise exception 'notify_target: conversation not found' using errcode = 'PA404';
    end if;
    -- The business's own number on this channel, else the platform number its customer wrote to.
    select w.id into v_connection_id
    from public.whatsapp_connections w
    where w.channel_id = v_channel_id and w.status = 'active'
      and (w.tenant_id = p_tenant_id or w.method = 'platform')
    order by (w.tenant_id = p_tenant_id) desc, w.created_at
    limit 1;
  else
    if p_to !~ '^\+[1-9][0-9]{7,14}$' then
      raise exception 'notify_target: % is not an E.164 number', p_to using errcode = 'P0001';
    end if;
    select w.id, w.channel_id into v_connection_id, v_channel_id
    from public.whatsapp_connections w
    where w.tenant_id = p_tenant_id and w.status = 'active'
    order by w.created_at
    limit 1;
  end if;
  if v_connection_id is null then
    raise exception 'notify_target: no active WhatsApp connection' using errcode = 'PA409';
  end if;

  if p_to is not null then
    insert into public.contacts as ct (tenant_id, phone, tags)
    values (p_tenant_id, p_to, array['test'])
    on conflict (tenant_id, phone) do update
      set tags = case when 'test' = any(ct.tags) then ct.tags else array_append(ct.tags, 'test') end
    returning ct.id into v_contact_id;

    select c.id into v_conversation_id
    from public.conversations c
    where c.tenant_id = p_tenant_id and c.contact_id = v_contact_id and c.channel_id = v_channel_id
    order by c.created_at desc
    limit 1;
    if v_conversation_id is null then
      insert into public.conversations (tenant_id, contact_id, channel_id)
      values (p_tenant_id, v_contact_id, v_channel_id)
      returning id into v_conversation_id;
    end if;
  end if;

  return query
    select v_connection_id, c.id, ct.id, ct.phone, ct.opted_out_at is not null,
           c.last_customer_msg_at, ct.language,
           (select count(*)::int from public.audit_logs a
             where a.tenant_id = p_tenant_id and a.action = 'test_message.sent'
               and a.created_at > now() - interval '1 hour')
    from public.conversations c join public.contacts ct on ct.id = c.contact_id
    where c.id = v_conversation_id and c.tenant_id = p_tenant_id;
end
$$;

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

-- Same signatures as 0009 and 0019, so their grants stand; restated so nothing depends on that. Server only.
revoke execute on function public.notify_target(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.notify_staff_target(uuid, uuid) from public, anon, authenticated;
grant execute on function public.notify_target(uuid, uuid, text) to service_role;
grant execute on function public.notify_staff_target(uuid, uuid) to service_role;
