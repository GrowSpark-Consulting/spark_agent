# 15 Oct (Dev 1): GET and PATCH /api/agent/settings (Day 8)

For Dev 2 and Dev 3. Dev 1 files only: `backend/src/agent/settings/agent-settings.ts` (new, with its test), `backend/src/server/agent-settings-route.test.ts` (new), `backend/src/test-support/fake-settings-db.ts` (new), and two added entries in `backend/src/server/routes.ts`. One line in a shared test file, see section 4. No migration, no frontend file, no `packages/types`, no `docs/contracts.md` or `docs/dashboard-screen-contracts.md` changed.

## 1. What was built and why

The Agent settings screen needs to save the persona, tone, privacy notice, handover switches and booking service of a business. Until now the only writer of `tenants.agent_settings` was the browser, straight to the database under row-level security (Dev 3's booking-service section), with nothing checking what was saved. The agent ignores a value it does not understand (`tone: "warm"` is read as friendly), so a typo saved silently and did nothing. `docs/dashboard-screen-contracts.md` ("Agent settings") proposed `PATCH /api/agent/settings` for Dev 1. It is now there, with a GET to read.

- **GET** (any member): the settings as the agent reads them, plus the five handover rows with their labels.
- **PATCH** (owner or admin): a Zod-checked partial update that **merges** into the stored JSON and never replaces it. Keys it was not given, and keys it does not know (the column holds others, for example `languages`), are kept.

## 2. How to test

- `pnpm --filter @pakka/backend exec vitest run src/agent/settings src/server/agent-settings-route.test.ts src/server/audit-coverage.test.ts`.
- Then `pnpm typecheck`, `pnpm lint`, `pnpm --filter @pakka/backend test`, `pnpm test:conversations`.
- By hand: `curl` with a Bearer token and `X-Pakka-Tenant`: `GET {API}/api/agent/settings`, then `PATCH` with `{"tone":"formal"}`. A staff token on PATCH answers 403; `{"tone":"warm"}` answers 422 with a field error.
- The compare-and-set was also checked on 15 Oct against a real local database (`pnpm db:start`, throwaway script, not committed): a stale value updates nothing, key order does not matter, and of two writers that read the same value exactly one wins. The real service was also run against it: GET, PATCH with a service and a trigger, an unknown service refused, two simultaneous writers on different keys both landed, and the audit row was accepted by the real table.

## 3. Decisions

- **No migration.** The write is a compare-and-set on the JSON that was read (`update ... where id = <business> and agent_settings = <what was read>`), retried 3 times, then a 409 `conflict`. There is no `set_tenant_feature`-style function.
- **Service role, with the role checked in code, and the business taken from the verified session.** The member's role (owner or admin) is checked by `requireRole`; the business never comes from the request. A body that names a business (`tenantId`) is refused as an unknown key.
- **Its own audit row.** The 0049 trigger audits browser writes only and skips the service role, so this route writes `agent_settings.updated` (entity `tenant`): the keys that changed, and from and to for tone, privacy notice, booking service and each handover switch. **The persona text is never logged**, like 0049.
- **GET open to every member, PATCH owner and admin only.**
- **`bookingServiceId` is included** and must be an active service of the business (`null` clears it), which the browser cannot check.
- **Only the five switchable triggers are accepted:** `kb_gap`, `asked_human`, `complaint`, `negotiation`, `hot_lead`. The agent also reads the aliases `gap`, `human`, `price_negotiation` and `hot`; those are read, never written, and a stored alias entry is replaced when its trigger is sent so the list never holds two answers for one trigger. `stuck`, `credits_exhausted` and `opt_out` are handovers a business cannot switch off, so the route refuses them.
- **A stored value that is not an object** (it cannot happen through the column's default, but the browser can write anything) makes PATCH answer 409 and write nothing, rather than throw something away.
- **A change that changes nothing** writes nothing and writes no audit row.

## 4. Notes for Dev 2 (Shaaz)

- **One line added to `backend/src/server/audit-coverage.test.ts` to list the new `PATCH /api/agent/settings` route; the shared test requires every write route to be listed. No other change to that file.**
- Nothing of yours was edited. The route does not touch credits, notify, billing or the jobs.
- The route writes `audit_logs` through `lib/audit.ts` (`writeAudit`, called through `auditQuietly`: a failed audit write is logged and never fails a change that was already made).

## 5. Notes for Dev 3 (Dhatri)

**GET `/api/agent/settings`** (Bearer token, `X-Pakka-Tenant`; any member) and the answer of a **PATCH** have the same shape:

```ts
interface AgentSettings {
  persona: string | null;               // the assistant's name; null = the default
  tone: 'friendly' | 'formal';
  privacyNotice: boolean;               // the first AI reply to a contact carries the privacy notice
  bookingServiceId: string | null;      // the service the assistant books when there are several
  handoffTriggers: {                    // always the same five, in this order
    key: 'kb_gap' | 'asked_human' | 'complaint' | 'negotiation' | 'hot_lead';
    label: string; example: string;     // words for the screen
    highPriority: boolean;              // the handover is opened as high priority
    enabled: boolean;
  }[];
}
```

**PATCH body**: any of these keys, at least one, nothing else (an unknown key is a 422 naming it).

```ts
{ persona?: string | null,              // a name: up to 30 characters, letters, numbers, spaces and . ' & - ; "" or null clears it
  tone?: 'friendly' | 'formal',
  privacyNotice?: boolean,
  bookingServiceId?: string | null,     // an active service of this business; null clears it
  handoffTriggers?: { key: <one of the five>, enabled: boolean }[] }   // merged by key: send only the ones that changed
```

Errors use the usual envelope `{ error: { code, message, fields? } }`: 401, `no_membership` / `forbidden` (staff), `validation_failed` (422, `fields` by key, for example `{ persona: "Use 30 characters or fewer: a name, not a sentence." }`), `conflict` (409: someone else changed it three times in a row, or the stored value has an unexpected format).

**Day 8 limits (what the Agent screen should not offer yet):**
- **Languages:** nothing reads a per-business language setting. The reply follows the customer's own words (English, Tamil, Tanglish, Hindi, plus Malayalam by the model). Telugu (`te`) is in the screen contract but not supported anywhere. Show it read-only, or leave it out.
- **Scoring weights and thresholds:** they come from the pack (`packs/<key>.json`, for example hot 70, warm 40). A business's own values would live in `tenants.pack_overrides`, which is server-only, has no writer yet, and applies only with the Pro feature `custom_scoring`. Editing is a separate piece; show the pack's values read-only.
- **Takeover default:** it exists per member (`memberships.takeover_pref`: inbox, own_number or ask), not per business. It belongs in Settings or Team, where each member sets their own, not here.
- **Business hours:** the agent reads `tenants.business_hours` (and the timezone). Link to Settings; do not keep a copy on the Agent screen.
- **Handover triggers:** only the five above have a switch. `stuck` is in the pack list but nothing reads a setting for it, so a toggle for it would do nothing.

**Suggestion:** the booking-service section (`frontend/features/settings/booking-service.ts`) reads the whole `agent_settings` object and writes the whole object back. That keeps the other keys, but it is not safe against two writers at once: a save that read just before the route's write can silently erase it. The route's compare-and-set protects the route, not that browser write. Later, please have that section (and the Agent screen) save through `PATCH /api/agent/settings` with `{ bookingServiceId }`, which also checks the service server-side. Nothing breaks if you do not: both write the same column and the browser write still works. The column's browser grant was left as it is.

## 6. Follow-ups

- **Scoring edits** (`pack_overrides`): a writer with plan lock (`custom_scoring`) and validation against the pack, separate from this route.
- **Move the booking-service section to the route** (Dev 3, above), then the browser's write to `agent_settings` is only a fallback.
- **A native speaker for any wording** is not involved here (the labels and examples in `HANDOFF_TRIGGERS` are English, for Dev 3 to translate if the screen is).
- Whether the shape should also go in `docs/contracts.md` (open decision 8, "agent_settings and last_check shapes") and `packages/types`: left out on purpose, since those files are shared and reviewed in pairs; this note is the draft.
