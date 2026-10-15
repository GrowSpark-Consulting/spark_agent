-- 0049_browser_write_audit: every change a member makes straight from the dashboard is in audit_logs (9-day plan, Day 7: "Audit logs
-- for every business-traceable action"). The server audits what goes through it (each route's own action, notify_record's
-- <kind>.sent, the SQL functions); these tables are also written by the browser itself under row-level security (0028, 0046), where
-- nothing of ours saw the change until now:
--   tenants (owners and admins: name, time zone, hours, agent settings)       → tenant.updated
--   services, resources, catalog_items (owners and admins)                     → service.*, resource.*, catalog_item.* (created, updated, deleted)
--   quotes (members)                                                            → quote.*
--   leads (staff on their own, owners and admins on any: stage, owner, outcome, fields) → lead.updated
--   memberships (a member's own alert number and takeover preference)          → membership.updated
-- The row names the member (auth.uid()) and holds the names of the columns that changed, and the old and new values of only the
-- columns listed as safe for each table (a stage, a status, a price, an owner): never a customer's fields, a phone number or the
-- agent settings' text. A write made by the server (the service role, no member) is skipped here: the server audits it itself.
-- Server only: the function is security definer (a member may not write audit_logs) and nobody can call it directly.

create function public.audit_browser_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_new jsonb := case when TG_OP <> 'DELETE' then to_jsonb(NEW) end;
  v_old jsonb := case when TG_OP <> 'INSERT' then to_jsonb(OLD) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_safe text[] := case when TG_NARGS > 1 then TG_ARGV[1:TG_NARGS - 1] else '{}'::text[] end;
  v_changed text[];
  v_diff jsonb;
  k text;
begin
  if v_actor is null then
    return null;  -- the server's own write: audited by the server
  end if;
  if TG_OP = 'UPDATE' then
    select coalesce(array_agg(n.key order by n.key), '{}') into v_changed
      from jsonb_each(v_new) n
     where n.key not in ('updated_at') and n.value is distinct from v_old -> n.key;
    if cardinality(v_changed) = 0 then
      return null;  -- nothing a person would call a change
    end if;
  else
    select coalesce(array_agg(n.key order by n.key), '{}') into v_changed from jsonb_each(v_row) n;
  end if;

  v_diff := jsonb_build_object('changed', to_jsonb(v_changed));
  foreach k in array v_safe loop
    if k = any (v_changed) then
      v_diff := v_diff || jsonb_build_object(k, jsonb_build_object('from', v_old -> k, 'to', v_new -> k));
    end if;
  end loop;

  insert into public.audit_logs (tenant_id, actor, action, entity, entity_id, diff)
  values (
    (case when TG_TABLE_NAME = 'tenants' then v_row ->> 'id' else v_row ->> 'tenant_id' end)::uuid,
    v_actor::text,
    TG_ARGV[0] || '.' || case TG_OP when 'INSERT' then 'created' when 'UPDATE' then 'updated' else 'deleted' end,
    TG_ARGV[0],
    coalesce(v_row ->> 'id', v_row ->> 'user_id')::uuid,
    v_diff
  );
  return null;
end;
$$;
revoke execute on function public.audit_browser_write() from public, anon, authenticated;

create trigger audit_browser_write after update on public.tenants
  for each row execute function public.audit_browser_write('tenant', 'name', 'timezone');
create trigger audit_browser_write after insert or update or delete on public.services
  for each row execute function public.audit_browser_write('service', 'name', 'duration_min', 'price_min', 'price_max', 'active', 'buffer_min', 'min_notice_min');
create trigger audit_browser_write after insert or update or delete on public.resources
  for each row execute function public.audit_browser_write('resource', 'name', 'type', 'active');
create trigger audit_browser_write after insert or update or delete on public.catalog_items
  for each row execute function public.audit_browser_write('catalog_item', 'title', 'price_from', 'price_unit', 'active');
create trigger audit_browser_write after insert or update or delete on public.quotes
  for each row execute function public.audit_browser_write('quote', 'status', 'total_inr', 'approved_by', 'sent_at', 'valid_until');
create trigger audit_browser_write after update on public.leads
  for each row execute function public.audit_browser_write('lead', 'stage', 'owner_user_id', 'outcome');
create trigger audit_browser_write after update on public.memberships
  for each row execute function public.audit_browser_write('membership', 'takeover_pref');
