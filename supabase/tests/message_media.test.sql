-- The message-media bucket (0047): private, members read their own business's files, the server alone writes. Run: pnpm db:test
begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

insert into auth.users (id, email) values
  ('0c000000-0000-0000-0000-0000000000a1', 'member-a@media.test'),
  ('0c000000-0000-0000-0000-0000000000b1', 'member-b@media.test');
insert into public.tenants (id, name, vertical) values
  ('0c100000-0000-0000-0000-00000000000a', 'Media A', 'test-pack'),
  ('0c100000-0000-0000-0000-00000000000b', 'Media B', 'test-pack');
insert into public.memberships (tenant_id, user_id, role) values
  ('0c100000-0000-0000-0000-00000000000a', '0c000000-0000-0000-0000-0000000000a1', 'staff'),
  ('0c100000-0000-0000-0000-00000000000b', '0c000000-0000-0000-0000-0000000000b1', 'owner');
-- As the server would store them (the service role; here the migration owner).
insert into storage.objects (bucket_id, name) values
  ('message-media', '0c100000-0000-0000-0000-00000000000a/0c200000-0000-0000-0000-00000000000a/0c300000-0000-0000-0000-0000000000a1.jpg'),
  ('message-media', '0c100000-0000-0000-0000-00000000000b/0c200000-0000-0000-0000-00000000000b/0c300000-0000-0000-0000-0000000000b1.pdf'),
  ('message-media', 'not-a-business/x/y.jpg');

select results_eq($$select public, file_size_limit from storage.buckets where id = 'message-media'$$,
  $$values (false, 52428800::bigint)$$, 'the bucket is private, 50 MB a file');
select ok(not exists (select 1 from pg_proc where proname = 'media_tenant_id'), 'no helper function a signed-in user could call: the policy checks the path inline');

create function pg_temp.changed(p_sql text) returns int language plpgsql as $$
declare
  n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
end
$$;
create function pg_temp.as_user(u uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
$$;
set local role authenticated;
select pg_temp.as_user('0c000000-0000-0000-0000-0000000000a1');
select results_eq($$select name from storage.objects where bucket_id = 'message-media'$$,
  $$values ('0c100000-0000-0000-0000-00000000000a/0c200000-0000-0000-0000-00000000000a/0c300000-0000-0000-0000-0000000000a1.jpg'::text)$$,
  'a member reads their own business''s files, not another''s, and not a stray path');
select throws_ok($$insert into storage.objects (bucket_id, name) values ('message-media', '0c100000-0000-0000-0000-00000000000a/c/forged.jpg')$$,
  '42501', null, 'a member cannot add a file');
select is(pg_temp.changed($$update storage.objects set name = name || '.x' where bucket_id = 'message-media'$$), 0, 'or change one');
-- A delete goes through the Storage API (storage blocks a direct DELETE with its own trigger), which applies these policies: none lets a member write.
select is((select count(*)::int from pg_policies where schemaname = 'storage' and tablename = 'objects' and cmd <> 'SELECT'
             and (coalesce(qual, '') || coalesce(with_check, '')) like '%message-media%'), 0, 'or remove one: no insert, update or delete policy exists for the bucket');
select pg_temp.as_user('0c000000-0000-0000-0000-0000000000b1');
select is((select count(*)::int from storage.objects where bucket_id = 'message-media'), 1, 'the other business sees only its own file');

reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is((select count(*)::int from storage.objects where bucket_id = 'message-media'), 0, 'a visitor who is not signed in sees nothing');
reset role;
select is((select count(*)::int from storage.objects where bucket_id = 'message-media'), 3, 'and every file is still there');

select * from finish();
rollback;
