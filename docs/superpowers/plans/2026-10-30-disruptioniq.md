# DisruptionIQ Implementation Plan

> Execute the authorized implementation in this session. Use focused parallel agents for independent domain and client work after freezing the shared contracts; integrate and verify the entire application. The user's explicit instruction to proceed supplies execution authorization.

**Goal:** Deliver the mandatory SCM disruption/recovery workflow plus all twelve selected research opportunities.
**Architecture:** A React SPA calls an authenticated Hono API. Pure deterministic TypeScript domain functions mutate a typed operational state; the PostgreSQL repository commits snapshot and linked relational projections atomically. AI is an optional configured service that never controls inventory or permissions.
**Tech Stack:** Bun, TypeScript, React/Vite, PostgreSQL/Drizzle, Hono, Zod, TanStack Query, Papa Parse, PDF.js, Bun tests, Playwright.
**Spec:** `docs/Planning/selected-feature-scope.md`; decisions: `docs/Planning/tech-stack.md`; contracts: `src/shared/types.ts`.

## Global Constraints

- Include opportunities 1,2,3,4,6,7,8,9,11,12,13,15 and all B1-B9/C1-C5 requirements.
- Persistent PostgreSQL; synthetic data; at least two end-to-end scenarios.
- AI for summaries/recommendations; deterministic quantities, deadlines and permissions.
- Backend roles and scoped organization access; prevent prohibited self-approval.
- No execution before confirmation; modifications and approvals must revalidate current constraints.
- Safely preserve invalid, duplicate, stale and conflicting source evidence.

## Review Focus

- Concurrent recovery approvals must not double allocate the same stock.
- Supplier participants must not receive unrelated workspace records or approver privileges.
- Replayed old/duplicate events must not overwrite newer trusted facts.
- Missing evidence, scanned documents or absent AI credentials must be visibly incomplete.
- Compound scenarios and partial shipments must not double count inventory or affected orders.

## Task 1: Shared contracts and deterministic domain

Files: `src/shared/types.ts`, `src/domain/seed.ts`, `src/domain/engine.ts`, `tests/domain.test.ts`.
Interfaces: `createSeedState(now?: Date): State`; `getImpact(state: State): Impact[]`; `generatePlans(state, incidentId, actor): RecoveryPlan[]`; `ingestEvent(state, input, actor): RawEvent`; `decidePlan(state, id, action, actor): RecoveryPlan`; `runScenario(state, scenario: 'A'|'B', actor): void`; `replayQueue(state,actor): void`; `inspectDocument(state,filename,text,actor): DocumentClaim`; `resolveDocument(state,id,actor): DocumentClaim`; `setLotDisposition(state,id,status,actor): void`; `setTaskStatus(state,id,status,actor): void`.

- [x] Write and observe failing domain tests for duplicates/conflicts, valid partial movements, stale replay, ETA uncertainty, shared dependencies, compound exposure, quality holds and authorization.
- [x] Implement synthetic linked dataset and deterministic functions; include all four plan types, hard constraints, complete traceability and collaborative tasks.
- [x] Run `bun test tests/domain.test.ts` and fix failures. Return a coverage summary.

## Task 2: Persistence, authentication, import and API

Files: `src/server/{schema,repository,auth,app,index,migrate,seed,ai,documents}.ts`, `tests/api.test.ts`, `tests/repository.test.ts`.
Interfaces: `createApp(repository): Hono`; `repository.read(): Promise<State>`; `repository.mutate(fn): Promise<T>`; `repository.users(): Promise<Actor[]>`; sessions are cookie-authenticated. All domain exceptions map to a safe 4xx response.

- [x] Write failing API/repository tests: cookie login, forbidden request/self-approval, two concurrent allocations, restart persistence, atomic constraints and partner redaction.
- [x] Implement migrations, indexed relational projections, transaction lock, credential hashing and session expiry.
- [x] Implement `/api/login`, `/api/logout`, `/api/dashboard`, `/api/scenarios`, `/api/events`, `/api/webhooks/carrier`, `/api/import`, `/api/plans/generate`, `/api/plans/:id`, `/api/outage`, `/api/replay`, `/api/documents`, `/api/documents/:id/confirm`, `/api/lots/:id/disposition`, `/api/tasks/:id`, `/api/ai/:incidentId`, `/api/reset`.
- [x] Verify imports and persisted API workflows against PostgreSQL SQL engine; configure production connection and explicit local test mode.

## Task 3: Operational React client

Files: `index.html`, `src/client/{main,App,api,styles}.tsx/css`, optional focused components under `src/client/components/`.
Consumes the shared types and API above. Dashboard response: `{state,impacts,actor,users,aiConfigured,database}`. Errors: `{error:string}`. Login request `{email,password}`. All mutations reload query state.

- [x] Build accessible login, sidebar, overview, incident evidence, risk-ranked orders, recovery comparisons/confirmation, dependency network, data health/imports, document review, collaboration, conditions, outage queue and audit history.
- [x] Provide real forms for CSV/JSON, webhook/event intake and documents. Show AI unavailability, loading/errors and data freshness explicitly.
- [x] Add scenario actions, role switching via actual login, controlled demo reset, responsive layout and semantic dialog confirmation.
- [x] Verify with typecheck, production build and a browser smoke test; no mock dashboard data when API is disconnected.

## Task 4: Integration, scenarios and delivery

Files: `README.md`, `playwright.config.ts`, `tests/e2e/*.spec.ts`, `docs/Planning/implementation-status.md`.

- [x] Run full Bun suite, TypeScript check and Vite build.
- [x] Run browser flow: analyst login, scenario, generated/rejected plan, manager login, confirmation and persistent recovery/audit result.
- [x] Inspect the UI and fix functional/layout defects.
- [x] Document stack, startup commands, demo credentials, both scenario scripts, selected feature coverage and material limitations.
- [x] Review the final application for safety and challenge compliance; report only verified completion and any external setup still needed.
