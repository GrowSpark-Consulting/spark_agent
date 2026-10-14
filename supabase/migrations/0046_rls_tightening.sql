-- 0046_rls_tightening: the Day 7 row-level-security review (Dev 2; docs/contracts.md, "Who may write what from the browser").
-- Every table's isolation between businesses is proved by supabase/tests/isolation.test.sql; this tightens what a member may
-- write inside their own business, and what a visitor who is not signed in may write at all.
--
--   * consent_logs: a member could add a consent entry from the browser ("opted_in", "deleted"...). Every real entry is
--     written by the server's functions (record_opt_out, record_notice_shown, delete_contact_data), and the dashboard never
--     writes one, so the browser's INSERT goes: a consent record cannot be made up from a member's session.
--   * leads: any member could change any lead's stage, owner, outcome and fields. Now staff change only the leads assigned
--     to them, and cannot hand one to someone else; owners and admins change any lead of their business (as before).
--   * anon (a visitor who is not signed in) keeps no INSERT, UPDATE, DELETE or TRUNCATE grant on any table or view, now or
--     later. Row-level security already refused those writes; the grants are gone as well, like 0042 did for payments.
-- Not changed: quotes (members may draft them; whether approving or marking one sent belongs to the server is open, docs).

drop policy tenant_insert on public.consent_logs;
revoke insert on public.consent_logs from authenticated, anon;

drop policy tenant_update on public.leads;
create policy tenant_update on public.leads
  for update to authenticated
  using (public.is_member(tenant_id) and (public.is_admin(tenant_id) or owner_user_id = (select auth.uid())))
  with check (public.is_member(tenant_id) and (public.is_admin(tenant_id) or owner_user_id = (select auth.uid())));

do $$
declare
  r record;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
  loop
    execute format('revoke insert, update, delete, truncate on public.%I from anon', r.relname);
  end loop;
end;
$$;
-- And on every table a later migration creates.
alter default privileges in schema public revoke insert, update, delete, truncate on tables from anon;
