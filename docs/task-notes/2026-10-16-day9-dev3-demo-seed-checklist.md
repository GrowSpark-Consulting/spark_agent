# Day 9, Dev 3: demo-seed checklist (16 Oct 2026)

Status: **a checklist only. No seed script exists and nothing here has been run.** It complements `2026-10-15-day8-dev3-demo-seed-plan.md`, which explains the approach; this note says what must be settled before anyone writes or runs it.

## Blockers (nothing starts until these are answered)

| # | Question or dependency | Owner | State |
|---|---|---|---|
| 1 | **The `notify.send()` bypass.** Inserting `messages` rows directly skips `notify.send()`, which the project rules say all outbound messages use. No message is sent, but it is an explicit exception to a non-negotiable rule. May the seed write `messages` directly? Or is there an approved test mechanism that goes through it with sending switched off? | Owner / Raja | **Open. Not assumed.** |
| 2 | **Docker.** The seed has to be proven on a disposable database first. This machine has no Docker | Whoever has Docker (Dev 2) | Open |
| 3 | A dedicated tenant, not one of the three routed `DEMO-*` businesses | Owner / Dev 2 | Proposed in the plan |
| 4 | Who runs it on staging, and when | Raja / Dev 2 | Open |

## Safeguards the script must have

- [ ] A fixed tenant id, and **every statement scoped by that id**. No truncate, no unscoped delete.
- [ ] Deterministic row ids, so a re-run replaces rather than duplicates.
- [ ] Dates relative to now (`now() - interval`), so "this week" stays this week.
- [ ] One transaction: delete the dedicated tenant's seed rows, then insert.
- [ ] No route code on the tenant, so no live message can ever land in it.
- [ ] Synthetic data only: contacts use the reserved fictional 555-01xx style numbers, never real numbers or real names.
- [ ] No secrets, no auth users or passwords in the repo (the repo is public). Membership for the presenter is a separate manual `insert` from the existing seed file's instructions.
- [ ] `messages.credits_charged` and `credit_ledger` kept consistent, so the credit meter's estimate is sensible.
- [ ] A bookings spread that respects the exclusion constraint (distinct slots), including one for today.
- [ ] Some enquiries after the business's hours, so "after-hours enquiries handled" is non-zero.
- [ ] The insert triggers behave: `0049` audit triggers (service-role writes are not audited) and `0050` `queue_webhook_events` (acts only when the business has a webhook endpoint; it has none). Confirm neither sends anything.

## Verification before anyone says "seed data exists"

1. `pnpm db:start`, `pnpm db:reset` on a **disposable local** database (needs Docker).
2. Run the script, then run it again: row counts unchanged.
3. `pnpm db:test` still passes (`seed.test.sql`, `isolation.test.sql`, `demo_routing.test.sql`).
4. Sign in as the demo member: Home's four numbers equal `select` counts (enquiries, qualified, booked, after-hours); Inbox, Leads and Calendar show the week; a second business sees none of it.
5. Only then on staging, **once, by a developer**, with the date recorded in a note. Never `db reset --linked`.

## Cleanup plan

- A matching `delete ... where tenant_id = <dedicated id>` script, run the same way and recorded.
- After the demo: remove the tenant's rows, or leave them and say so.
- If anything unexpected appears on staging, stop and report: do not repair by hand.

## Not claimed

No part of this has been run. The existing seed (`supabase/seed/demo_tenants.sql`) creates no conversations, messages, leads or bookings for the demo businesses.
