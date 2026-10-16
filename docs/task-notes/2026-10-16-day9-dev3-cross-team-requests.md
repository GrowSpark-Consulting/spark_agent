# Day 9, Dev 3: requests to the team (16 Oct 2026)

Status: **requests; none answered.** Dev 3 continues the work that does not depend on them. Nothing below is built on a guess: each item says what the screen does today.

## Dev 1: where do these settings live?

Today the Agent settings screen saves persona, tone and handoff triggers (`GET` and `PATCH /api/agent/settings`). The shared schema **rejects `languages`**.

1. Where are **languages, lead-scoring and qualification rules, and the takeover default** stored, and by which route? The backend reads none of them from `tenants.agent_settings` today.
2. If it is `agent_settings`: the key names, the validation, and that writes merge and never replace.
3. Business hours stay under Booking setup (`tenants.business_hours`); the screen links there.
4. Is returning an own-number chat to the AI wanted? It is blocked in `conversations/mode.ts` today.

## Dev 2

1. **Plan and feature editing.** `PATCH /api/admin/plans/:key` and `/features/:key` exist. How does an admin read the **global** features (not a tenant's)? Plans are readable by the browser already.
2. **Open a tenant's dashboard with an audit entry.** There is no route. Needed: the route, its request and response, who may call it, how tenant isolation is kept, and the audit row (the acting admin named).
3. **Message media.** Is the browser signing URLs with the member's session (what the screen does now) approved? Who may read a file, and how long may a URL live? (Questions in `2026-10-15-day7-dev3-open-questions.md`.)
4. **Outbound webhooks.** Is there any read of recent deliveries? Is `test` rate limited? (Same note.)
5. The staging items in the rehearsal request: migrations applied, environment variable names set.

## Owner / team

1. **Invoice list:** may the billing screen read `payments` directly under the member's own session (the table has row-level security, members read, the server writes), or does Dev 2 build a list route? Dev 3 will only use direct reads after checking the policy and the columns, never bypassing RLS.
2. **Demo seed:** approval, or an alternative, for writing `messages` without `notify.send()` (see the seed checklist).

## Raja

1. Staging access and logins, two test businesses, and a Meta test number (rehearsal request).
2. Whether `e2e` becomes a required check.
3. Approved pricing content for the landing page, and the demo number to use.
4. The freeze date and who approves exceptions (freeze proposal).
5. The `accessibility` PR: approval to push the branch.

## Meta

1. **App Review for Embedded Signup**, and the app and configuration ids. Until then the Embedded Signup path stays behind its flag, with mocked tests as the only evidence.
2. A test number and recipients Meta allows.

Credentials and ids must be sent through the password manager, never in notes or chat.
