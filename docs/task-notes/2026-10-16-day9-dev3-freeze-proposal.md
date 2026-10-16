# Day 9, Dev 3: release-freeze proposal (16 Oct 2026)

Status: **a proposal only. No freeze is in force and no date is set.** The Day 8 task list says to "freeze all non-fix work at the end of the day"; that depends on the two shared staging rehearsals, which have not happened. The decisions below belong to Raja and the team.

## Proposed rule (to be agreed)

From the freeze, `main` accepts only:
1. Fixes for **P0** defects (see `2026-10-16-day9-dev3-triage.md`).
2. Fixes for **P1** defects that the rehearsals show are needed, if the owner of the area and Raja agree.
3. Test and CI stability fixes that change no application behaviour.
4. Documentation.

Everything else waits until after the demo: new screens, refactors, shared-helper clean-ups, the landing page, dependency upgrades, new migrations that are not fixes.

## Decisions required

| # | Decision | Owner | Why it matters |
|---|---|---|---|
| 1 | The freeze date and time | Raja | No date is set; this note does not invent one |
| 2 | Is it tied to the rehearsals (freeze once both pass) or to the calendar? | Raja | The task list ties it to the end of the rehearsal day |
| 3 | Who approves an exception | Raja | A single named approver avoids debate on demo day |
| 4 | Is Dev 3's pending work (accessibility, invoices, agent settings, admin editing, landing) in or out of the freeze? | Raja with Dev 1, Dev 2, Dev 3 | Several items are P1 but block on other teams |
| 5 | Is `e2e` a required check during the freeze? | Raja | A flaky required check can block an urgent fix |
| 6 | What runs on demo day: the last green `main`, per the Day 8 fallback | Raja | The fallback says the demo runs on the last green `main` |

## Unresolved risks at the time of writing

- **No staging evidence yet.** Mocked tests pass (CI `check`, `migrations` and `e2e` succeeded on `main`), but the real RLS, Realtime, Meta, PayU and signed-media behaviour has not been seen by this team.
- **The accessibility fixes are not on `main`** (local branch only).
- **Demo data does not exist.** Home, Inbox, Leads and Calendar are empty for a demo owner until a seed is run.
- **E2E flakiness is reduced, not proven gone.** Three races from the Realtime catch-up read were found and fixed in specs; one residual failure was seen in 150 runs of one of them. Watch the first CI runs.
- **Blocked items:** agent settings (Dev 1), admin plan editing and open-tenant (Dev 2), invoice contract (Dev 2 or owner), Embedded Signup (Meta App Review).

## What Dev 3 will do once a freeze is agreed

Stop merging non-fix work, keep fixes small and one per branch, and report a short status after each rehearsal.

Recording the decision: put the agreed date, approver and exceptions here, with the name of who agreed.
