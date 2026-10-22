-- Lapsed holds are tidied by pg_cron (0053), not by an Inngest cron. Run: pnpm db:test
begin;
create extension if not exists pgtap with schema extensions;
select plan(5);

select results_eq(
  $$select schedule, command, active from cron.job where jobname = 'release-expired-holds'$$,
  $$values ('* * * * *'::text, 'select public.release_expired_holds()'::text, true)$$,
  'every minute, Postgres marks lapsed holds expired (the same cadence the Inngest job had)');
select results_eq(
  $$select schedule, active from cron.job where jobname = 'purge-cron-run-details'$$,
  $$values ('17 3 * * *'::text, true)$$,
  'and a daily job keeps the run log to a week');
select is((select count(*)::int from cron.job), 2, 'no other database jobs');
select ok(not has_schema_privilege('authenticated', 'cron', 'usage') and not has_schema_privilege('anon', 'cron', 'usage'),
  'the browser cannot reach the cron schema (it cannot schedule or read jobs)');
select ok(not has_function_privilege('authenticated', 'public.release_expired_holds()', 'execute'),
  'nor call the tidy itself');

select * from finish();
rollback;
