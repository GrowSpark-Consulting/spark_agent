-- 0024_api_roles_no_truncate: the browser's roles cannot empty a table (9-day plan, Day 5: tenant isolation).
--
-- Row-level security filters SELECT, INSERT, UPDATE and DELETE, but not TRUNCATE. Supabase grants every table
-- privilege to anon and authenticated, TRUNCATE included, so a role that could ever run raw SQL could empty any
-- business's table. PostgREST and GraphQL never send TRUNCATE, so nothing reaches it today; this closes it anyway, for
-- today's tables and (through the default privileges of the role that runs migrations) every later one.
-- supabase/tests/isolation.test.sql checks every table.

revoke truncate on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke truncate on tables from anon, authenticated;
