# 12 Oct (Dev 1): hardening the manual WhatsApp connection. What was built, and what touches Dev 2's and Dev 3's areas

Everything of Dev 1's is in `backend/src/channels/whatsapp/connect/` (plus tests and the contract doc `docs/whatsapp-connection-contract.md`, two appended lines). No file, table,
migration or endpoint of Dev 2 or Dev 3 changed.

## 1. App secret of Spark Agent's own app (PR 1)

1. `connectManual` refuses an app secret equal to `META_APP_SECRET` with `validation_failed` and `fields.appSecret`, before Meta is asked and before anything is saved. Both connect
   routes (`POST /api/whatsapp/manual`, `POST /api/admin/whatsapp/manual`) share it. The reason: the platform app's webhooks are signed with `META_APP_SECRET`, and `inbound.ts`
   trusts a `manual_byo` connection only on its own secret, so such a connection would have every message dropped. Spark Agent's own numbers are connected by the team.
2. A token that Meta reports as expired or no longer valid (OAuth error 190 or HTTP 401) on connect or recheck makes `token_permissions` a `fail` with "The access token has
   expired or is no longer valid. Create a new one in Meta and connect the number again." and the connection `failed`. No new status value (the constraint in
   migration 0003 is unchanged). Any other rejection keeps the general message. Error 190 also covers a revoked token, so the words say "or is no longer valid".

For Dev 3: the new message arrives as `last_check.checks[0].message`, and the refusal as `fields.appSecret` on the form. Nothing in the shapes changed.
For Dev 2: nothing. The send path (`meta-errors.ts`) already mapped 190 to `whatsapp_not_connected` and is unchanged.
