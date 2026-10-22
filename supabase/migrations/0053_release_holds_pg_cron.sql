-- 0053_release_holds_pg_cron: lapsed booking holds are tidied by Postgres itself (pg_cron), not by an Inngest cron.
--
-- The Inngest `release-holds` function ran every minute only to call release_expired_holds() (0015). On Inngest's free plan
-- (50,000 executions a month) that alone used about 2,900 executions a day with no customers. The work is one indexed update
-- (bookings_held_expiry_idx), so it runs here instead, at the same cadence, costing nothing on Inngest.
--
-- Same behaviour as before: every minute, holds past hold_expires_at become 'expired'. The schedule is unchanged on purpose:
-- confirm_booking refuses a hold only once it is no longer 'held', so a longer gap would let a customer confirm a hold that ran
-- out minutes ago. Correctness never depended on the tidy: hold_slot expires an overlapping lapsed hold before it inserts, and
-- the slot search, the agent and the calendar all treat a lapsed hold as free.
--
-- pg_cron keeps a row per run in cron.job_run_details; a second job keeps a week of them.
-- The cron schema is not reachable from the browser: only the database owner can schedule or see jobs.

create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule('release-expired-holds', '* * * * *', $$select public.release_expired_holds()$$);
select cron.schedule('purge-cron-run-details', '17 3 * * *', $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$);
