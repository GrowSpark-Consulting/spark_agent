# Spark Agent policy documents

**Date:** 2026-10-16  
**Owner:** Dev 1

Created a docs-only policy set under `docs/meta-app/` from the supplied draft and audited retention and provider statements against `origin/main` at `2414c27e5277bc34d40444b0bc04a2f9b88e3fab`.

## Files

- `docs/meta-app/privacy.md`
- `docs/meta-app/terms.md`
- `docs/meta-app/data-deletion.md`
- `docs/meta-app/retention-check.md`

The audit found no general 30-day chat or account/support cleanup job. It found request-based contact deletion and a 30-day-after-trial deletion process for eligible unpaid trial tenants. Billing rows have no general expiry rule, but tenant deletion cascades to payment and credit-ledger rows. Backup and log retention settings are not provable from code; the production checklist describes intended settings that require operator verification. The policy text uses figure-free wording for unresolved periods and includes the verified 30-day unpaid-trial account-deletion behavior.

Raja's legal/accounting decisions and Dev 2's infrastructure confirmations are listed in `retention-check.md`.

## Scope

No code, migrations, configuration, or Dev 2/Dev 3 files were changed. No test suite was run for this docs-only change. A broad search accidentally printed a few non-secret lines from `backend/.env.example`; no key or token was exposed. Further review used explicitly named non-environment files only.
