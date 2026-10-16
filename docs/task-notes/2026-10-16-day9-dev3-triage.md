# Day 9, Dev 3: triage list (16 Oct 2026)

Status: **draft for review by Dev 1, Dev 2 and Raja.** Built from the Dev 3 audit of 16 Oct and the state of `main` at `39ffdd2`. Nothing here was run against staging, a real Supabase, Meta or PayU: every "evidence" cell says what would prove the item, not that it is proven.

Priorities: **P0** blocks the demo or release (an unsafe or inoperable critical flow, or the exit test cannot pass). **P1** required product behaviour or a high-priority gap. **P2** polish or optional.

A code fix is marked **code**; an item that needs access, a decision or another team is marked **needs**.

## P0

| # | Item | Kind | Owner | Depends on | Acceptance criteria | Evidence required |
|---|---|---|---|---|---|---|
| P0-1 | Two end-to-end rehearsals on staging, each by a different developer, with no manual database edits (Day 8 exit test) | needs | Raja, with Dev 1, Dev 2, Dev 3 | Staging access, two test businesses, a Meta test number (see the rehearsal request) | `docs/demo-script.md` passes twice; every defect found is triaged P0/P1/P2 and has an owner | Dated run notes for each run, with the commit each ran on |
| P0-2 | A believable week of demo data in a dedicated demo tenant | needs | Dev 3 writes it; owner approves; Dev 2 runs it | Owner approval of the `notify.send()` bypass; a machine with Docker; see the demo-seed checklist | Re-running changes no row counts; `pnpm db:test` passes; Home's four numbers equal the SQL counts; a second business sees none of it | Command output and the counts, recorded in the note |

## P1

| # | Item | Kind | Owner | Depends on | Acceptance criteria | Evidence required |
|---|---|---|---|---|---|---|
| P1-1 | Accessibility fixes (`2ef3926` on local `dev3/a11y-fixes`) merged to `main` | code | Dev 3 | Approval to push | The audit spec runs green on desktop, tablet and mobile; fixes merged with CI green | `a11y-audit.spec.ts` output; CI run link |
| P1-2 | Invoice list on the billing screen | code or needs | Dev 3 (direct RLS read) or Dev 2 (a list route) | Decision: direct reads or a route | A paying owner sees their payments; empty, error and retry states; no other business's rows | Unit tests; mocked E2E; an RLS check on a real database |
| P1-3 | Agent settings: languages, scoring and qualification rules, takeover default | needs | Dev 1 (storage), then Dev 3 | A storage contract | The agreed fields load, save, survive a reload and validate | Spec; backend test that the agent reads them |
| P1-4 | Role matrix: owner, admin and staff on every screen and mutation | code | Dev 3, with Dev 2 for missing server checks | None for the matrix; Dev 2 for gaps found | A written matrix; allowed and denied cases tested for each in-scope route | The matrix file and its specs |
| P1-5 | Loading, empty and error states on newer screens (webhooks, metrics, invites, billing, import, media, admin) | code | Dev 3 | None | A checklist per screen, each state tested, no duplicate submit, no misleading success | The checklist and specs |
| P1-6 | Onboarding wizard: confirm services, slots and toggles steps | code | Dev 3 | None | A spec walks every wizard step at three widths and the values persist | The spec run |
| P1-7 | Admin plan and feature editing | needs | Dev 2 (read path), then Dev 3 | The global features read path | Admins view and edit supported fields; conflicts and refusals shown; audited server-side | Specs; an audit row |
| P1-8 | Open a tenant's dashboard with an audit entry | needs | Dev 2 (route and audit contract), then Dev 3 | An authorized route | The admin opens the tenant; an `audit_logs` row names the admin | The row |
| P1-9 | `e2e` as a required check | needs | Raja | A few green runs | Branch protection updated | Settings page |

## P2

| # | Item | Kind | Owner | Depends on | Acceptance criteria | Evidence required |
|---|---|---|---|---|---|---|
| P2-1 | Landing page with pricing and `wa.me` demo buttons | code | Dev 3 | Approved pricing; configured demo number | Responsive; buttons carry valid `DEMO-*` codes; login and signup unchanged | A spec at three widths |
| P2-2 | One shared E2E settle helper instead of three copies | code | Dev 3 | Approval | The leads-filters, calendar and leads-paging specs use it; no behaviour change | The three specs pass |
| P2-3 | Check other specs for the same catch-up race (for example `leads-filters.spec.ts:101`) | code | Dev 3 | None | Either a reproduced failure with a fix, or recorded as not exposed | Repeat runs |

## Not claimed

- Anything live: WhatsApp, Meta Embedded Signup, PayU, a real Realtime server, real RLS from the browser. Mocked tests are named as mocked in `frontend/tests/e2e/regression-matrix.md`.
- Billing Razorpay wording in older task lists: the product uses PayU (decision 20).

## Update, later on 16 Oct 2026 (after the Day 6 to 8 re-audit)

The full table and its evidence are in `2026-10-16-day9-dev3-status-audit.md`. What changed in this list:

| Item | Change |
|---|---|
| P1-1 accessibility | Still local. `851807d` is on `a11y/semantic-landmarks-headings`, no remote branch. Pinned rules: 0 findings. **Contrast: 67 findings on 39 of 84 records**, waiting for design approval of the colours |
| P1-2 invoices | Unchanged: **no invoice contract**. The two ways forward (a list route with our own numbering, or a payment history read from `payments`) are in D6-2 |
| P1-3 agent settings | Unchanged: languages, scoring rules and the takeover default have no storage contract (Dev 1). Everything the contract has is built |
| P1-4 role matrix | **Written** (`docs/dashboard-roles-and-routes.md`) and **staff allowed-cases tested** (`role-access.spec.ts`); the refusals were already tested. RLS-level proof still needs Docker or staging |
| P1-5 loading, empty, error states | **Loading tests added** for seven screens (`loading-states.spec.ts`); remaining gaps are P2 (section 4 of the audit) |
| P1-6 wizard steps | The wizard's WhatsApp-step saved states are now tested at three widths. Staff, services and slots are links, not steps, by design; "Inviting staff isn't switched on yet" is stale (invites are on `main`) and needs a copy decision |
| P1-7 admin plan and feature editing | **No longer blocked.** The read is the catalogue RLS read the Billing screen already uses; built and tested (mocked), uncommitted |
| P1-8 open a business's dashboard | Unchanged: no route (Dev 2) |
| P1-9 `e2e` as a required check | Unchanged, plus a finding: `cancel-in-progress` cancels the post-merge `e2e` run on `main`, so even a required `e2e` would not report there |
| New P1-10 | `backend/src/kb/fetch-page.test.ts` is flaky (`timeoutMs` 14999 vs 15000) and failed the required `check` on a docs-only commit (`d073c24`). Owner: Dev 1 |
| New P2-4 | The frontend build fetches Google Fonts at build time (`check` failed once for it on `2414c27`). Owner: Dev 2 / Dev 3 |
| P0-2 demo data | A reviewable draft exists (`docs/drafts/demo-week.DRAFT.sql`), guarded so it cannot run. Still blocked on the approval and on Docker |
