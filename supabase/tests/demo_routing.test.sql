-- The shared demo number (0029): demo_admit (the per-phone daily limit, replays, the route a valid code starts and the
-- 24 hours it lasts) and the demo_visitors table it keeps its state in.
-- Run: pnpm db:test
-- Every demo_admit call passes its own time: inside one test transaction now() never moves, which would hide
-- exactly the bugs a replay check can have.
begin;
create extension if not exists pgtap with schema extensions;
select plan(44);

insert into public.tenants (id, name, vertical) values
  ('d7000000-0000-0000-0000-00000000000a', 'Demo Route A', 'test-pack'),
  ('d7000000-0000-0000-0000-00000000000b', 'Demo Route B', 'test-pack');

-- Every answer of demo_admit is kept under a label, so each is asked once and then read as often as needed.
create temp table res (label text, allowed boolean, notify_limit boolean, replay boolean, message_tenant_id uuid);
create function pg_temp.admit(
  p_label text, p_wamid text, p_now timestamptz, p_phone text default '+919000000001', p_route uuid default null
) returns void language sql as $$
  insert into res select p_label, a.* from public.demo_admit(p_phone, p_wamid, 30, p_now, p_route) a
$$;
create function pg_temp.answer(p_label text) returns text language sql as $$
  select '(' || allowed || ',' || notify_limit || ',' || replay || ',' || coalesce(message_tenant_id::text, '') || ')' from res where label = p_label
$$;

-- Access --------------------------------------------------------------------------------------------------

select ok(has_function_privilege('service_role', 'public.demo_admit(text, text, integer, timestamp with time zone, uuid)', 'execute'),
  'server code can call demo_admit');
select ok(not has_function_privilege('authenticated', 'public.demo_admit(text, text, integer, timestamp with time zone, uuid)', 'execute'),
  'members cannot call demo_admit');
select ok(not has_function_privilege('anon', 'public.demo_admit(text, text, integer, timestamp with time zone, uuid)', 'execute'),
  'signed-out visitors cannot call demo_admit');
select ok(not has_table_privilege('authenticated', 'public.demo_visitors', 'select'), 'members cannot read demo_visitors');
select ok(not has_table_privilege('anon', 'public.demo_visitors', 'select'), 'signed-out visitors cannot read demo_visitors');
select ok((select relrowsecurity from pg_class where oid = 'public.demo_visitors'::regclass), 'demo_visitors has row-level security on');

-- demo_admit: the first message, and replays ----------------------------------------------------------------

do $$ begin perform pg_temp.admit('first', 'w1', timestamptz '2026-10-13 10:00:00+05:30'); end $$;
select is(pg_temp.answer('first'), '(true,false,false,)', 'the first message is allowed, not a replay, and has no route yet');
select is((select msg_count from public.demo_visitors where phone = '+919000000001'), 1, 'and it counts once');

-- A replay at the very same time as the original: it must be judged from the row as it was, not from what
-- this call writes (which already holds the message id).
do $$ begin perform pg_temp.admit('replay_same_time', 'w1', timestamptz '2026-10-13 10:00:00+05:30'); end $$;
select is(pg_temp.answer('replay_same_time'), '(true,false,true,)', 'a redelivered message is a replay, even at the same time');
select is((select msg_count from public.demo_visitors where phone = '+919000000001'), 1, 'and it is not counted again');

do $$ begin perform pg_temp.admit('replay_later', 'w1', timestamptz '2026-10-13 10:01:00+05:30'); end $$;
select is(pg_temp.answer('replay_later'), '(true,false,true,)', 'a replay a minute later is one too');
select is((select msg_count from public.demo_visitors where phone = '+919000000001'), 1, 'and it is still not counted');

-- The limit ------------------------------------------------------------------------------------------------

do $$ begin
  for i in 2..30 loop
    perform pg_temp.admit('m' || i, 'w' || i, timestamptz '2026-10-13 10:02:00+05:30' + make_interval(secs => i));
  end loop;
end $$;
select is((select count(*)::int from res where label ~ '^m[0-9]+$' and allowed), 29, 'messages 2 to 30 are all allowed');
select is((select count(*)::int from res where label ~ '^m[0-9]+$' and notify_limit), 0, 'and none of them gets the limit notice');
select is((select msg_count from public.demo_visitors where phone = '+919000000001'), 30, 'thirty are counted');

do $$ begin
  perform pg_temp.admit('m31', 'w31', timestamptz '2026-10-13 10:10:00+05:30');
  perform pg_temp.admit('m32', 'w32', timestamptz '2026-10-13 10:10:01+05:30');
  perform pg_temp.admit('m33', 'w33', timestamptz '2026-10-13 10:10:02+05:30');
end $$;
select is(pg_temp.answer('m31'), '(false,true,false,)', 'the 31st is refused and is the one that gets the notice');
select is(pg_temp.answer('m32'), '(false,false,false,)', 'the 32nd is refused with no notice');
select is(pg_temp.answer('m33'), '(false,false,false,)', 'and so is the 33rd');
select is((select msg_count from public.demo_visitors where phone = '+919000000001'), 32, 'the count stops at the limit plus two');

-- A replay of a message that was admitted is allowed again even after the limit is passed: storing it is
-- idempotent. (Judged from the stored list, not from today's count.)
do $$ begin perform pg_temp.admit('replay_after_limit', 'w30', timestamptz '2026-10-13 10:11:00+05:30'); end $$;
select is(pg_temp.answer('replay_after_limit'), '(true,false,true,)', 'a replay of an admitted message is allowed after the limit');
select is((select msg_count from public.demo_visitors where phone = '+919000000001'), 32, 'and changes nothing');

-- Only the last ten admitted ids are kept: an older one is a new message, and past the limit it is refused.
do $$ begin perform pg_temp.admit('replay_evicted', 'w2', timestamptz '2026-10-13 10:11:30+05:30'); end $$;
select is(pg_temp.answer('replay_evicted'), '(false,false,false,)', 'a replay older than the last ten admitted counts as new, and is refused past the limit');

-- A refused message is not remembered, so its replay is refused again.
do $$ begin perform pg_temp.admit('replay_refused', 'w31', timestamptz '2026-10-13 10:12:00+05:30'); end $$;
select is(pg_temp.answer('replay_refused'), '(false,false,false,)', 'a replay of a refused message is refused again, with no second notice');
select is((select 'w31' = any (recent_ids) from public.demo_visitors where phone = '+919000000001'), false, 'a refused message id is not remembered');
select is((select cardinality(recent_ids) || '/' || cardinality(recent_tenants) from public.demo_visitors where phone = '+919000000001'), '10/10',
  'only the last ten admitted ids are kept, each with its business');

-- A refused message never starts a route.
do $$ begin perform pg_temp.admit('refused_with_code', 'w_ref', timestamptz '2026-10-13 10:13:00+05:30', '+919000000001', 'd7000000-0000-0000-0000-00000000000a'); end $$;
select is(pg_temp.answer('refused_with_code'), '(false,false,false,)', 'a refused message that carries a valid code is still refused');
select is((select tenant_id from public.demo_visitors where phone = '+919000000001'), null, 'and starts no route');

-- The day is the India calendar day --------------------------------------------------------------------------

do $$ begin
  perform pg_temp.admit('late_same_day', 'w_late', timestamptz '2026-10-13 23:59:59+05:30');
  perform pg_temp.admit('next_day', 'w_next', timestamptz '2026-10-14 00:00:00+05:30');
end $$;
select is(pg_temp.answer('late_same_day'), '(false,false,false,)', 'one second before midnight in India it is still the same day');
select is(pg_temp.answer('next_day'), '(true,false,false,)', 'at midnight in India the count starts again');
select is((select msg_count from public.demo_visitors where phone = '+919000000001'), 1, 'from one');

-- The route: started by a valid code in the same call, kept for 24 hours ------------------------------------------

do $$ begin perform pg_temp.admit('s0', 'ws0', timestamptz '2026-10-13 09:00:00+05:30', '+919000000002'); end $$;
select is(pg_temp.answer('s0'), '(true,false,false,)', 'a visitor with no code yet has no route');
select is((select msg_count from public.demo_visitors where phone = '+919000000002'), 1, 'and one phone''s count is not another''s');

do $$ begin perform pg_temp.admit('s_route', 'ws1', timestamptz '2026-10-13 10:00:00+05:30', '+919000000002', 'd7000000-0000-0000-0000-00000000000a'); end $$;
select is(pg_temp.answer('s_route'), '(true,false,false,d7000000-0000-0000-0000-00000000000a)', 'a valid code starts the route in the same call');
select is((select tenant_id || '@' || (routed_at = timestamptz '2026-10-13 10:00:00+05:30') from public.demo_visitors where phone = '+919000000002'),
  'd7000000-0000-0000-0000-00000000000a@true', 'and it is stored with the time it started');

do $$ begin
  perform pg_temp.admit('s_within', 'ws2', timestamptz '2026-10-14 09:59:59+05:30', '+919000000002');
  perform pg_temp.admit('s_replay', 'ws1', timestamptz '2026-10-13 11:00:00+05:30', '+919000000002');
  perform pg_temp.admit('s_after', 'ws3', timestamptz '2026-10-14 10:00:01+05:30', '+919000000002');
end $$;
select is(pg_temp.answer('s_within'), '(true,false,false,d7000000-0000-0000-0000-00000000000a)', 'a route is still good just under 24 hours on');
select is(pg_temp.answer('s_replay'), '(true,false,true,d7000000-0000-0000-0000-00000000000a)', 'a replay carries its business too');
select is(pg_temp.answer('s_after'), '(true,false,false,)', 'and the route is gone after 24 hours');

-- A new code replaces the route; a replay of an earlier message keeps the business it was first stored for, and
-- does not move the route back.
do $$ begin
  perform pg_temp.admit('s_switch', 'ws4', timestamptz '2026-10-14 11:00:00+05:30', '+919000000002', 'd7000000-0000-0000-0000-00000000000b');
  perform pg_temp.admit('s_replay_after_switch', 'ws2', timestamptz '2026-10-14 11:01:00+05:30', '+919000000002', 'd7000000-0000-0000-0000-00000000000a');
end $$;
select is(pg_temp.answer('s_switch'), '(true,false,false,d7000000-0000-0000-0000-00000000000b)', 'a new valid code moves the visitor to another business');
select is(pg_temp.answer('s_replay_after_switch'), '(true,false,true,d7000000-0000-0000-0000-00000000000a)',
  'a replay is stored for the business it was admitted for, whatever the route is now');
select is((select tenant_id from public.demo_visitors where phone = '+919000000002'), 'd7000000-0000-0000-0000-00000000000b'::uuid,
  'and a replay never moves the route back');

-- Input ------------------------------------------------------------------------------------------------------------

select throws_ok($$select * from public.demo_admit('12345', 'w', 30, now())$$, 'P0001', null, 'a phone that is not E.164 is refused');
select throws_ok($$select * from public.demo_admit('+919000000003', '', 30, now())$$, 'P0001', null, 'a missing message id is refused');
select throws_ok($$select * from public.demo_admit('+919000000003', 'w', 0, now())$$, 'P0001', null, 'a limit below one is refused');
select throws_ok($$select * from public.demo_admit('+919000000003', 'w', 30, now(), 'd7000000-0000-0000-0000-0000000000ff')$$, '23503', null, 'a route to a business that does not exist is refused');

select * from finish();
rollback;
