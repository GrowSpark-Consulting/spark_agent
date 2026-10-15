# 15 Oct (Dev 1): GET and PATCH /api/agent/settings (Day 8)

For Dev 2 and Dev 3. Dev 1 files, plus three small changes in shared files, each with its owner's OK or a stated reason: `backend/src/agent/settings/agent-settings.ts` (new, with its test), `backend/src/server/agent-settings-route.test.ts` (new), `backend/src/test-support/fake-settings-db.ts` (new), two added entries in `backend/src/server/routes.ts`, one line in `backend/src/server/audit-coverage.test.ts` (section 4), **shared types in `packages/types/src/agent-settings.ts`** (new, exported from `index.ts`, with its test; added at Dev 3's request) and **two lines in `frontend/lib/api/backend-routes.test.ts`** (section 5, with Dev 3's OK). No migration, no other frontend file, no `docs/contracts.md` or `docs/dashboard-screen-contracts.md` changed.

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
- **The shapes are shared** (`packages/types`, at Dev 3's request): the backend builds its checks from the shared field schemas (keys, tones, the trigger rules, the persona's maximum), types its answer with `AgentSettings` and assigns the validated body to `UpdateAgentSettings`, so the screen and the route cannot drift (a compile error and a test say so). The Zod validation stays in the backend, which adds what needs the agent's cleaning or the database: the persona's wording and the active-service check.
- **Only the five switchable triggers are accepted:** `kb_gap`, `asked_human`, `complaint`, `negotiation`, `hot_lead`. The agent also reads the aliases `gap`, `human`, `price_negotiation` and `hot`; those are read, never written, and a stored alias entry is replaced when its trigger is sent so the list never holds two answers for one trigger. `stuck`, `credits_exhausted` and `opt_out` are handovers a business cannot switch off, so the route refuses them.
- **A stored value that is not an object** (it cannot happen through the column's default, but the browser can write anything) makes PATCH answer 409 and write nothing, rather than throw something away.
- **A change that changes nothing** writes nothing and writes no audit row.

## 4. Notes for Dev 2 (Shaaz)

- **One line added to `backend/src/server/audit-coverage.test.ts` to list the new `PATCH /api/agent/settings` route; the shared test requires every write route to be listed. No other change to that file.**
- Nothing of yours was edited. The route does not touch credits, notify, billing or the jobs.
- The route writes `audit_logs` through `lib/audit.ts` (`writeAudit`, called through `auditQuietly`: a failed audit write is logged and never fails a change that was already made).

## 5. Notes for Dev 3 (Dhatri)

- **Two lines added to NO_BROWSER_CALLER in backend-routes.test.ts with your OK; remove them when the Agent screen calls the route.** (`GET /api/agent/settings` and `PATCH /api/agent/settings`, reason "Agent settings screen not connected yet (Dev 3)". Nothing else in that file changed, and no authorization check.)
- **Shared types are in packages/types.** Import them like this:

  ```ts
  import { AgentSettings, UpdateAgentSettings, AGENT_TRIGGER_KEYS, AGENT_PERSONA_MAX_LENGTH } from "@pakka/types";
  import type { AgentTriggerKey, AgentTriggerRow, AgentTone } from "@pakka/types";
  ```

  `AgentSettings` and `UpdateAgentSettings` are Zod schemas with the same-named types (`z.infer`), like the other shared contracts. `UpdateAgentSettings.safeParse(body)` checks a form before sending; it does not judge the persona's wording (the server does).
- **Day 8 limits (what the Agent screen should not offer yet):**
  - **Languages:** nothing reads a per-business language setting. The reply follows the customer's own words (English, Tamil, Tanglish, Hindi, plus Malayalam by the model). Telugu (`te`) is in the screen contract but not supported anywhere. Show it read-only, or leave it out.
  - **Scoring weights and thresholds:** they come from the pack (`packs/<key>.json`, for example hot 70, warm 40). A business's own values would live in `tenants.pack_overrides`, which is server-only, has no writer yet, and applies only with the Pro feature `custom_scoring`. Editing is a separate piece; show the pack's values read-only.
  - **Takeover default:** it exists per member (`memberships.takeover_pref`: inbox, own_number or ask), not per business. It belongs in Settings or Team, where each member sets their own, not here.
  - **Business hours:** the agent reads `tenants.business_hours` (and the timezone). Link to Settings; do not keep a copy on the Agent screen.
  - **Handover triggers:** only the five below have a switch. `stuck` is in the pack list but nothing reads a setting for it, so a toggle for it would do nothing.
- **Suggestion:** the booking-service section (`frontend/features/settings/booking-service.ts`) reads the whole `agent_settings` object and writes the whole object back. That keeps the other keys, but it is not safe against two writers at once: a save that read just before the route's write can silently erase it. The route's compare-and-set protects the route, not that browser write. Later, please have that section (and the Agent screen) save through `PATCH /api/agent/settings` with `{ bookingServiceId }`, which also checks the service server-side. Nothing breaks if you do not: both write the same column and the browser write still works. The column's browser grant was left as it is.

## For the frontend

**GET `/api/agent/settings`** (Bearer token, `X-Pakka-Tenant`; any member) and the answer of a **PATCH** have this shape (`AgentSettings`):

```ts
interface AgentSettings {
  persona: string | null;               // the assistant's name; null = the default
  tone: 'friendly' | 'formal';
  privacyNotice: boolean;               // the first AI reply to a contact carries the privacy notice
  bookingServiceId: string | null;      // the service the assistant books when there are several
  handoffTriggers: {                    // always the same five, in the order of AGENT_TRIGGER_KEYS
    key: 'kb_gap' | 'asked_human' | 'complaint' | 'negotiation' | 'hot_lead';
    label: string; example: string;     // words for the screen
    highPriority: boolean;              // the handover is opened as high priority
    enabled: boolean;
  }[];
}
```

**PATCH body** (`UpdateAgentSettings`; owner or admin): any of these keys, at least one, nothing else. Send only what changed.

```ts
{ persona?: string | null,
  tone?: 'friendly' | 'formal',
  privacyNotice?: boolean,
  bookingServiceId?: string | null,
  handoffTriggers?: { key: 'kb_gap' | 'asked_human' | 'complaint' | 'negotiation' | 'hot_lead', enabled: boolean }[] }
```

**Validation rules:**
- `persona`: a name, at most 30 characters (extra spaces are tidied first); letters, numbers, spaces and . ' & - only. `null` or an empty string clears it.
- `tone`: `friendly` or `formal`.
- `privacyNotice`: a boolean.
- `handoffTriggers`: **only the changed `{ key, enabled }` items**, over the five keys, each key once, at least one. The server merges them by key; triggers you do not send keep their state. `stuck`, `credits_exhausted`, `opt_out` and the older names (`gap`, `human`, `price_negotiation`, `hot`) are refused.
- `bookingServiceId`: a UUID or `null` (clears it). A UUID must be an **active service of this business**.
- Any other key is refused, and naming a business in the body is refused: the business comes from the session.
- Keys you do not send are kept, and so are keys the screen does not know about.

**Errors** use the envelope `{ error: { code, message, fields? } }`:
- **401** `unauthenticated`: no token or a bad one.
- **403** `forbidden`: staff on PATCH (staff can read); `no_membership`: no business.
- **409** `conflict`: someone else changed the settings three times in a row (reload and try again), or the stored value has an unexpected format (nothing was changed).
- **422** `validation_failed`, with `fields` named by key, for example `{ persona: "Use 30 characters or fewer: a name, not a sentence." }` or `{ bookingServiceId: "That isn't an active service of your business." }`. An unknown key is named as its own field.

## 6. Follow-ups

- **Scoring edits** (`pack_overrides`): a writer with plan lock (`custom_scoring`) and validation against the pack, separate from this route.
- **Move the booking-service section to the route** (Dev 3, above), then the browser's write to `agent_settings` is only a fallback.
- **A native speaker for any wording** is not involved here (the labels and examples in `HANDOFF_TRIGGERS` are English, for Dev 3 to translate if the screen is).
- `docs/contracts.md` (open decision 8, "agent_settings and last_check shapes"): the shape is now in `packages/types`; the contracts file itself was not edited (shared, reviewed in pairs).
- Remove the two `NO_BROWSER_CALLER` lines when the Agent screen calls the route (Dev 3).
