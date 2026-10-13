-- Single use of an assisted connect link (backend/src/channels/whatsapp/connect/connect-link.ts). Run: pnpm db:test
--
-- The API claims a link with ONE conditional UPDATE:
--   update connect_links set used_at = :now where token_hash = :h and used_at is null and expires_at > :now returning tenant_id, created_by
-- and frees its own claim with
--   update connect_links set used_at = null where token_hash = :h and used_at = :claimed_at
-- Postgres runs each statement atomically: a second UPDATE that waits on the first one's row lock re-reads the row once the first commits, sees used_at set and
-- changes nothing. A single-transaction test cannot race two sessions, so this proves the statement's conditions (the second claim, an expired link, a stale
-- release) and that only the server can run it; the lock behaviour is Postgres's.
begin;
create extension if not exists pgtap with schema extensions;
select plan(11);

insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000005a0', 'admin@test.local');
insert into public.tenants (id, name, vertical) values ('7d000000-0000-0000-0000-00000000000a', 'Claim A', 'test-pack');

-- Three links: live, expired, and live but for a stale-release check.
insert into public.connect_links (token_hash, tenant_id, created_by, expires_at) values
  (repeat('1', 64), '7d000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000005a0', now() + interval '1 day'),
  (repeat('2', 64), '7d000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000005a0', now() - interval '1 second');

-- The statements, as the API sends them. They run as the caller and return how many rows they changed.
create function pg_temp.claim(p_hash text, p_at timestamptz) returns int language plpgsql as $$
declare n int;
begin
  update public.connect_links set used_at = p_at
   where token_hash = p_hash and used_at is null and expires_at > p_at;
  get diagnostics n = row_count;
  return n;
end $$;
create function pg_temp.release(p_hash text, p_claimed_at timestamptz) returns int language plpgsql as $$
declare n int;
begin
  update public.connect_links set used_at = null where token_hash = p_hash and used_at = p_claimed_at;
  get diagnostics n = row_count;
  return n;
end $$;
grant execute on function pg_temp.claim(text, timestamptz), pg_temp.release(text, timestamptz) to public;

-- A live link is claimed once ---------------------------------------------------------------------------
select is(pg_temp.claim(repeat('1', 64), '2026-10-14 10:00:00+00'), 1, 'the first claim of a live link changes its row');
select is(pg_temp.claim(repeat('1', 64), '2026-10-14 10:00:01+00'), 0, 'a second claim of the same link changes nothing');
select is((select used_at from public.connect_links where token_hash = repeat('1', 64)), '2026-10-14 10:00:00+00'::timestamptz,
  'the link keeps the time of the claim that won');

-- Expired and unknown links are never claimed ------------------------------------------------------------------
select is(pg_temp.claim(repeat('2', 64), now()), 0, 'an expired link cannot be claimed');
select is((select used_at from public.connect_links where token_hash = repeat('2', 64)), null, 'and stays unused');
select is(pg_temp.claim(repeat('9', 64), now()), 0, 'an unknown link cannot be claimed');

-- A release frees only its own claim ----------------------------------------------------------------------
select is(pg_temp.release(repeat('1', 64), '2026-10-14 09:00:00+00'), 0, 'a release for another claim time frees nothing');
select is(pg_temp.release(repeat('1', 64), '2026-10-14 10:00:00+00'), 1, 'a release for the claim that was made frees the link');
select is(pg_temp.claim(repeat('1', 64), '2026-10-14 10:05:00+00'), 1, 'a freed link can be claimed again, once');

-- Only the server can run it ----------------------------------------------------------------------------------
set local role authenticated;
select throws_ok($$update public.connect_links set used_at = now() where token_hash = repeat('1', 64)$$, '42501', null,
  'a signed-in user cannot claim a link');
reset role;
set local role anon;
select throws_ok($$update public.connect_links set used_at = now() where token_hash = repeat('1', 64)$$, '42501', null,
  'a visitor cannot claim a link');
reset role;

select * from finish();
rollback;
