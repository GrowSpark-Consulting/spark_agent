-- 0031_store_inbound_platform_channel: a customer of the shared demo number is stored under the business their
-- route code names, on the demo number's own channel (docs/handover.md, module 8; migration 0029).
--
-- store_inbound_message (0013) refused any channel that does not belong to the business it stores for (PA404).
-- That refusal stays, with one exception: a channel that belongs to one of OUR OWN 'platform' connections (the
-- shared demo number, created only by the team, never through a client route) may carry a conversation of any
-- existing business. Everything else in the function is 0013's, unchanged: the same arguments and grants, the
-- same replay handling (a message id owned by another business is still PA409), the same one open conversation
-- per business, contact and channel.
-- Server only: the business comes from a verified route code, never from the payload.

create or replace function public.store_inbound_message(
  p_tenant_id uuid, p_channel_id uuid, p_phone text, p_name text, p_provider_msg_id text,
  p_kind text, p_body text, p_media jsonb, p_meta jsonb, p_sent_at timestamptz
)
returns table (conversation_id uuid, message_id uuid, inserted boolean)
language plpgsql
set search_path = ''
as $$
declare
  v_contact_id uuid;
  v_conversation_id uuid;
  v_message_id uuid;
  v_existing record;
  v_at timestamptz := least(p_sent_at, now());
begin
  if p_phone is null or p_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'store_inbound_message: not an E.164 number' using errcode = 'P0001';
  end if;
  if p_kind is null or p_kind not in ('text', 'interactive', 'image', 'audio', 'location', 'document', 'unsupported') then
    raise exception 'store_inbound_message: unknown kind' using errcode = 'P0001';
  end if;
  if p_provider_msg_id is null or p_provider_msg_id = '' or p_sent_at is null then
    raise exception 'store_inbound_message: provider message id and time are required' using errcode = 'P0001';
  end if;
  -- The business's own channel, or the channel of one of our platform connections (the shared demo number).
  if not exists (select 1 from public.channels ch where ch.id = p_channel_id and ch.tenant_id = p_tenant_id)
     and not (
       exists (select 1 from public.tenants t where t.id = p_tenant_id)
       and exists (select 1 from public.whatsapp_connections w where w.channel_id = p_channel_id and w.method = 'platform')
     ) then
    raise exception 'store_inbound_message: channel not found' using errcode = 'PA404';
  end if;

  -- A replay: answer with what is stored, before touching anything else (a closed conversation must not
  -- get an empty open one because a message arrived twice).
  select m.id as id, m.conversation_id as conversation_id, m.tenant_id as tenant_id into v_existing
    from public.messages m where m.provider_msg_id = p_provider_msg_id;
  if found then
    if v_existing.tenant_id <> p_tenant_id then
      raise exception 'store_inbound_message: message id belongs to another business' using errcode = 'PA409';
    end if;
    return query select v_existing.conversation_id, v_existing.id, false;
    return;
  end if;

  insert into public.contacts as ct (tenant_id, phone, name)
  values (p_tenant_id, p_phone, nullif(btrim(p_name), ''))
  on conflict (tenant_id, phone) do update set name = coalesce(ct.name, excluded.name)
  returning ct.id into v_contact_id;

  select c.id into v_conversation_id
    from public.conversations c
   where c.tenant_id = p_tenant_id and c.contact_id = v_contact_id and c.channel_id = p_channel_id and c.status = 'open';
  if v_conversation_id is null then
    insert into public.conversations (tenant_id, contact_id, channel_id)
    values (p_tenant_id, v_contact_id, p_channel_id)
    on conflict (tenant_id, contact_id, channel_id) where status = 'open' do nothing
    returning id into v_conversation_id;
    if v_conversation_id is null then
      -- Another session created it first (the index made this insert wait for it): use theirs.
      select c.id into v_conversation_id
        from public.conversations c
       where c.tenant_id = p_tenant_id and c.contact_id = v_contact_id and c.channel_id = p_channel_id and c.status = 'open';
    end if;
  end if;

  insert into public.messages
    (tenant_id, conversation_id, direction, sender, kind, body, media, meta, provider_msg_id, created_at)
  values
    (p_tenant_id, v_conversation_id, 'in', 'customer', p_kind, p_body, p_media, coalesce(p_meta, '{}'::jsonb),
     p_provider_msg_id, v_at)
  on conflict (provider_msg_id) do nothing
  returning id into v_message_id;
  if v_message_id is null then
    -- The same message arrived in another session at the same time.
    select m.id as id, m.conversation_id as conversation_id, m.tenant_id as tenant_id into v_existing
      from public.messages m where m.provider_msg_id = p_provider_msg_id;
    if not found or v_existing.tenant_id <> p_tenant_id then
      raise exception 'store_inbound_message: message id belongs to another business' using errcode = 'PA409';
    end if;
    return query select v_existing.conversation_id, v_existing.id, false;
    return;
  end if;

  update public.conversations c
     set last_customer_msg_at = greatest(coalesce(c.last_customer_msg_at, v_at), v_at)
   where c.id = v_conversation_id and c.tenant_id = p_tenant_id;

  return query select v_conversation_id, v_message_id, true;
end
$$;
