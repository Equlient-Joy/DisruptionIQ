# Codebase audit — 31 October 2026

The review covered the React client, Hono API, deterministic domain engine, repository lifecycle, application configuration, and existing automated checks. The initial strict TypeScript check, production build, and 87 unit/API tests passed. Browser coverage still referenced removed scenario buttons and could reuse a server attached to the local workspace database.

## Fixes

- Dashboard HTTP 503 and transport failures show an error with retry instead of the login form. Only HTTP 401 requests sign-in. Successful non-JSON API responses are rejected as protocol errors.
- Demo credentials and account switching appear only when the demo endpoint is enabled. Private administrators do not see the demo-only clear button. Failed sign-out reports its error and retains the session. Successful account transitions clear navigation, dialogs, notifications, and copilot context. Sign-out also clears the query cache.
- Dashboard polling refreshes operational state every ten seconds and processing documents every second while the browser is active.
- Import dialogs show accepted counts and individual rejected-row messages. Partial success remains visible; file-read failures are handled.
- Procurement users can upload documents. Chunk pages use typed query state with visible errors, retry, and pagination. Replay previews expose HTTP failures and disable integration preview buttons while a preview is pending. Partner views omit internal agent activity panels.
- Carrier outage state is derived from its integration connection and survives repository normalization. Updating another connection cannot change the carrier flag. The default outage action selects the actual carrier connection.
- Unknown replay targets return 404 without consuming any queued events. Replays and previews reconcile events in effective-time order. Stock-count reconciliation uses source effective times instead of replay audit timestamps; protection against older counts overwriting independent allocations remains intact. Targeted replay leaves unrelated connections and queues intact.
- Agent event buses belong to their repository. Creating another app cannot redirect the first app's agents into a different database. Repository close waits for pending agent work; clearing listeners no longer erases tracking of running handlers.
- Disabled AI prevents provider calls even when keys are configured. Deterministic fallback responses remain available. The sample environment includes the switch and defaults to persisted local PGlite, matching the quick-start instructions.
- Removed unused imports and declarations. TypeScript now checks unused locals and parameters, and production builds run TypeScript validation before Vite.
- Browser tests use a dedicated server on port 3100 and a fresh in-memory PGlite database, build the current sources, and test the current import/event workflows. They never reuse the operational server on port 3000.

## Verification

The subsequent run against the saved local database exposed a legacy inventory migration failure. The migration now drops the old status constraint before converting `quarantined` to `held`, then restores the current constraint within the same transaction. An upgrade regression verifies preserved quantities and reservations and repeated migration execution. The actual application starts on port 3000; login, dashboard, and Data & evidence were smoke-tested with zero browser errors.

- `bun test`: 102 passing tests across 15 files; no failures.
- `bun run build`: strict TypeScript validation and production bundle both pass.
- `bun run test:e2e`: all 9 Chromium workflows pass.
- `git diff --check`: clean.

Regression tests reproduced the integration targeting/order, outage persistence, dashboard login/error, provider-disable, cross-repository agent, and replay-preview errors before their fixes. Browser workflows also cover partial imports, document chunk retries, independent approvals, failed sign-out, partner visibility, and confirmed clearing with preserved audit.

Verification used embedded PostgreSQL and an isolated browser-test workspace. A standalone PostgreSQL deployment and live external carrier/AI providers were not exercised. The review establishes the listed fixes and passing checks; it does not establish that every possible production input is error-free.

The later hardcoded-data cleanup also verified the running application's empty state, moved enterprise fixtures out of production, removed sample-prefilled operational values, and preserved the old local database. See [hardcoded-data-cleanup.md](hardcoded-data-cleanup.md) for the cause, changes, and requested day-by-day ingestion follow-up.
