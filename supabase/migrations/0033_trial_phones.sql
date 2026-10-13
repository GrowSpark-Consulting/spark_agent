-- 0033_trial_phones: one free trial per WhatsApp number (9-day plan, Day 6 abuse controls; Dev 1, 13 Oct: "refuse a
-- second trial for the same owner phone"). One trial per account is already enforced by create_trial_tenant (0006), and
-- one business per WhatsApp business number by whatsapp_connections.phone_number_id being unique.
--
-- The only verified phone a trial owner gives us is the WhatsApp sender of the message that carries their TRIAL code to
-- the shared demo number (Meta names the sender). The phone typed on the onboarding screen is not verified (its code
-- step is screen-only), so it is never recorded here: recording it would let anyone block someone else's number.
--
-- trial_phones: the first sender of each trial's TRIAL code. A trial has at most one phone and a phone at most one
-- trial, ever: the row outlives the business (tenant_id becomes null when an unpaid trial is deleted), so the same phone
-- cannot start over. The number is kept as a SHA-256 of its digits, so the plain number does not outlive the business.
-- That is not encryption: anyone with database access can hash a number they know and look for it. Server-only: row-
-- level security on, no policies, no browser grants (like platform_admins).
--
-- claim_trial_phone(tenant, phone) is called by the routing step (Dev 1) on a message with a TRIAL code. The phone is
-- the full international number, country code included: WhatsApp's wa_id ('919800000501') and E.164 ('+91 98000
-- 00501') are the same phone. A 10-digit number without its country code is a different phone here, and cannot be told
-- apart from a valid one, so callers pass wa_id as WhatsApp sends it. It answers:
--   'claimed'       the sender is this trial's phone (recorded now, or before): route as usual;
--   'other_sender'  the trial already has another phone, so this is someone else trying it: route as usual;
--   'taken'         the sender already started another trial and this trial has no phone yet: refuse it.

create table public.trial_phones (
  phone_hash text primary key check (phone_hash ~ '^[0-9a-f]{64}$'),
  tenant_id uuid unique references public.tenants(id) on delete set null,
  claimed_at timestamptz not null default now()
);

alter table public.trial_phones enable row level security;
revoke all on public.trial_phones from anon, authenticated;

create function public.claim_trial_phone(p_tenant_id uuid, p_phone text)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_digits text := pg_catalog.regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_hash text;
  v_owner uuid;
begin
  if p_tenant_id is null or not exists (select 1 from public.tenants where id = p_tenant_id) then
    raise exception 'claim_trial_phone: unknown business %', p_tenant_id;
  end if;
  -- The number itself stays out of the message, since errors reach the logs.
  if p_phone is null or p_phone !~ '^\+?[0-9 ()-]+$' or v_digits !~ '^[1-9][0-9]{7,14}$' then
    raise exception 'claim_trial_phone: the phone must be a full international number, country code included';
  end if;
  v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_digits, 'UTF8')), 'hex');

  -- A conflict on either key waits for a claim in flight, so two first messages at once still record one phone.
  insert into public.trial_phones (phone_hash, tenant_id) values (v_hash, p_tenant_id)
  on conflict do nothing;
  if found then
    return 'claimed';
  end if;

  select tp.tenant_id into v_owner from public.trial_phones tp where tp.phone_hash = v_hash;
  if v_owner = p_tenant_id then
    return 'claimed';
  end if;
  if exists (select 1 from public.trial_phones tp where tp.tenant_id = p_tenant_id) then
    return 'other_sender';
  end if;
  return 'taken';
end
$$;

revoke execute on function public.claim_trial_phone(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_trial_phone(uuid, text) to service_role;
