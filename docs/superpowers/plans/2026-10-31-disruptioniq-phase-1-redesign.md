# DisruptionIQ Phase 1 Redesign Implementation Plan

## Primary goal

Deliver a judge-ready DisruptionIQ application that starts empty, accepts supplied operational data, prioritizes genuine demand exposure on a 0.0-10.0 scale, handles integration-specific outages, processes larger documents safely, and uses proportionate human authorization while keeping operational execution deterministic.

Authoritative specification: `docs/Planning/phase-1-redesign-spec.md`.

## Phase 0: Freeze documentation and baseline contracts

**How this serves the primary goal:** It prevents implementation from copying contradictory reference snippets or breaking working deterministic behavior while the shared contracts change.

### What to implement

1. Read, in order:
   - `docs/Planning/phase-1-redesign-spec.md`
   - `docs/Planning/selected-feature-scope.md`
   - `docs/artifacts/disruptioniq_implementation_report.md`
   - `docs/artifacts/disruptioniq_operations_reference.md`
   - `docs/artifacts/disruptioniq_data_flows_and_architectures.md`
2. Treat `C:\Users\LENOVO\Downloads\disruptioniq_enhancement_and_scm_plan.md` as reference only and follow the disposition recorded in the specification.
3. Record the current git status and preserve the existing modified `.gitignore` plus untracked `docs/artifacts/` and `scripts/` work.
4. Establish the baseline public contracts from `src/shared/types.ts`, HTTP routes from `src/server/app.ts`, and persistence behavior from `src/server/repository.ts`.

### Allowed APIs and patterns

- Hono route middleware, `bodyLimit`, and Zod parsing already used in `src/server/app.ts`.
- Drizzle schema definitions, indexes, transactions, and `FOR UPDATE` patterns in `src/server/schema.ts` and `src/server/repository.ts`.
- `pdfjs-dist` `getDocument`, `numPages`, `getPage`, `getTextContent`, and `destroy` in `src/server/documents.ts`.
- Domain helpers `audit`, `requireFocal`, `DomainError`, `sourceEvidence`, and `upstreamPaths`.
- Short synchronous `Repository.mutate()` callbacks; async extraction/network work stays outside the workspace lock.
- Current partner redaction boundary in `src/server/app.ts`.

### Documentation references

- Existing implementation plan: `docs/superpowers/plans/2026-10-30-disruptioniq.md`.
- Current artifact exporter: `scripts/export-artifacts.mjs`.
- Postgres migration rules: use indexed foreign keys, `timestamptz`, check constraints, partial indexes for pending work, and short transactions.

### Verification checklist

- Confirm the redesign specification contains every settled user decision.
- Confirm no Phase 2 AI/JEV/CLEF task appears in an implementation phase.
- Confirm dirty worktree entries are preserved.

### Anti-pattern guards

- Do not use the external reference as authority.
- Do not invent Hono, Drizzle, PDF.js, or React Query APIs.
- Do not perform async parsing or external calls while holding the workspace row lock.

## Phase 1: Shared contracts, state normalization, and schema foundations

**How this serves the primary goal:** Every later phase depends on safe types and migrations that work for both fresh empty workspaces and existing persisted data.

### What to implement

1. Update `src/shared/types.ts`:
   - add role `viewer`
   - replace lot status `quarantined` with `held`
   - remove `condition_reading`, `Reading`, and `State.readings`
   - add impact bands, drivers, factor breakdown, and confidence types
   - add `RecoveryPlanner`, plan risk, approval, and break-glass types
   - add integration-health/inbox metadata types
   - replace full-text `DocumentClaim` transport with metadata/excerpt types
2. Add `normalizeState()` in a focused domain/persistence module and call it whenever workspace state is loaded.
3. Update `src/server/schema.ts` and `src/server/migration.sql`:
   - extend the role check with `viewer`
   - migrate normalized lot constraints to `available|held|disputed`
   - add integration connection/inbox tables
   - add document record/file/chunk/job tables
   - index every foreign key
   - add partial pending-work indexes ordered by `next_attempt_at, id`
4. Update repository projection logic to understand `held` and keep large queue/document bodies outside workspace JSON.

### Documentation references

- Existing types: `src/shared/types.ts`.
- Transaction/projection pattern: `src/server/repository.ts:62-121`.
- Existing relational schema: `src/server/schema.ts` and `src/server/migration.sql`.
- State decisions: sections 4, 5, 6, 7, and 9 of the authoritative specification.

### Verification checklist

- Old state with `quarantined`, `readings`, and `integrationOutage` normalizes without crashing.
- Historical decisions remain available after normalization.
- New tables and constraints can be created repeatedly without destructive resets.
- Production modules do not import test fixtures.

### Anti-pattern guards

- Do not assume JSONB automatically supplies new required properties.
- Do not store document binaries, extracted chunks, or retry queues back inside `State`.
- Do not delete audit history while removing cold-chain operational records.

## Phase 2: Pure recovery evaluation and 0.0-10.0 impact scoring

**How this serves the primary goal:** Judges see priorities driven by actual uncovered demand and recoverability instead of isolated delays or missing evidence inflating the score.

### What to implement

1. Extract candidate enumeration and constraint evaluation from `src/domain/plans.ts` into pure reusable recovery functions.
2. Implement `DeterministicTemplatePlanner` without persisting proposals during feasibility checks.
3. Replace `getImpact()` scoring in `src/domain/impact.ts` with the exact five-component formula in the specification.
4. Calculate confidence independently from severity.
5. Produce complete `factorScores`, rank triggered drivers, and expose at most two `drivers`.
6. Preserve deterministic order allocation, `shipmentAccounting()`, dependency paths, and no-double-counting behavior.
7. Update the score display in `src/client/components/operations.tsx` to show `X.X / 10`, risk band, confidence, and two driver badges.

### Documentation references

- Existing allocation/accounting: `src/domain/impact.ts:1-59`.
- Existing scoring replacement point: `src/domain/impact.ts:60-116`.
- Existing candidate/constraint patterns: `src/domain/plans.ts:6-87`.
- UI insertion point: `src/client/components/operations.tsx:10-18`.

### Verification checklist

- Score is one decimal and bounded `0.0-10.0`.
- Zero shortage cannot receive priority, deadline, or penalty severity points.
- Missing/stale data changes confidence, not severity.
- Driver list never exceeds two while the complete factor breakdown remains auditable.
- Multiple feasibility evaluations create no plans or audit records.

### Anti-pattern guards

- Do not copy the reference document's additive formula; it can score fully covered orders and exceed its own component cap.
- Do not call persisting `generatePlans()` from `getImpact()`.
- Do not let an AI model adjust the score in Phase 1.

## Phase 3: Risk-tiered approvals and break-glass execution

**How this serves the primary goal:** Routine work can proceed quickly while financially or operationally consequential actions receive genuine independent control.

### What to implement

1. Add pure plan-risk classification using the thresholds and conditions in the specification.
2. Extend plan lifecycle with `awaiting_second_approval` and version-bound approval records.
3. Refactor `decidePlan()`:
   - routine approval revalidates and executes immediately for an authorized actor
   - high-risk first approval records intent only
   - high-risk second distinct approval revalidates and executes
   - creator/last modifier cannot count as a high-risk approver
   - modification clears approvals
4. Add administrator break-glass request validation, audit detail, notification, and retrospective-review state.
5. Extend the `/api/plans/:id` Zod body contract with approval/break-glass fields.
6. Update `PlanCard` and confirmation dialogs with risk tier, approval progress, independent-review requirements, and a separately labeled break-glass action.

### Documentation references

- Existing live revalidation and atomic mutations: `src/domain/plans.ts:100-126`.
- Existing route permission pattern: `src/server/app.ts` `permit()` calls.
- Existing audit helper: `src/domain/common.ts:20-24`.
- Existing plan UI: `src/client/components/operations.tsx:47-62` and `src/client/components/forms.tsx`.
- NIST control basis linked from the authoritative specification.

### Verification checklist

- Routine self-approval succeeds only for an otherwise authorized role.
- First high-risk approval changes no inventory/order/warehouse/supplier state.
- Same actor cannot supply both approvals.
- Plan modification invalidates approvals from the prior version.
- Break-glass requires admin, confirmation, and a reason; it creates audit and review notification records.
- Competing executions still revalidate and cannot double allocate stock.

### Anti-pattern guards

- Do not implement “two-person” as a single non-creator approval followed by immediate execution.
- Do not grant silent or unconditional admin bypass.
- Do not equate critical customer priority alone with high execution risk.

## Phase 4: Remove cold-chain automation and retain generic holds

**How this serves the primary goal:** The product stays focused on disruption control while preserving the general inventory-safety mechanism needed for disputed or manually held stock.

### What to implement

1. Remove cold-chain validation and application branches from `src/domain/events.ts`.
2. Remove condition scenarios and related code from `src/domain/engine.ts`.
3. Change lot disposition APIs and imports to `available|held` while preserving `disputed` protection.
4. Remove sensor/event controls from forms and the condition-monitoring UI from `resources.tsx`.
5. Remove cold-chain copy, metrics, demo walkthroughs, and diagram nodes.

### Documentation references

- Event validation/application locations: `src/domain/events.ts`.
- Manual disposition: `src/domain/engine.ts` and `/api/lots/:id/disposition` in `src/server/app.ts`.
- UI removal point: `src/client/components/resources.tsx:46-57`.

### Verification checklist

- No production reference to `condition_reading`, `Reading`, `readings`, temperature, thermometer, or `condition_excursion` remains.
- Held and disputed lots remain excluded from allocation and recovery.
- Authorized warehouse/admin users can hold and release lots manually.

### Anti-pattern guards

- Do not remove the generic hold capability.
- Do not map old quarantined stock to available.

## Phase 5: Integration-specific continuity inbox

**How this serves the primary goal:** A carrier failure no longer freezes every data source, and operators can understand, retry, preview, and reconcile each failed integration independently.

### What to implement

1. Add repository methods for integration health, inbox insertion, atomic job claim, retry, dead-letter, preview, and targeted replay.
2. Use short claim/update transactions and `FOR UPDATE SKIP LOCKED`; perform domain processing outside the claim transaction, then commit the result/state mutation separately.
3. Extend event envelopes with integration ID, schema version, sequence, correlation ID, event time, and received time.
4. Map carrier, WMS, and supplier events to their integrations; manual intake remains independently available.
5. Preserve canonical idempotency and effective-time reconciliation when applying claimed rows.
6. Replace `/api/outage` and `/api/replay` with integration-health and targeted replay APIs; support preview before execution.
7. Replace the global continuity banner with per-integration cards showing health, backlog count/age, retry state, dead letters, and freshness.

### Documentation references

- Current idempotency/staleness logic to preserve: `src/domain/events.ts:8-108`.
- Current global replay to replace: `src/domain/events.ts:164-168`.
- Existing continuity UI: `src/client/components/evidence.tsx:18-20`.
- Queue, circuit-breaker, and EPCIS references in the specification.

### Verification checklist

- One offline integration does not queue unrelated source events.
- Duplicate/out-of-order replay cannot overwrite newer facts or double apply effects.
- Attempts are bounded and poison messages become dead letters.
- Preview is non-mutating; targeted replay applies only the selected integration.
- Database-unavailable mode is explicitly read-only rather than falsely “durable.”

### Anti-pattern guards

- Do not use three booleans inside workspace state as the final design.
- Do not clear an entire queue before processing succeeds.
- Do not hold a workspace lock during retry waits or integration calls.

## Phase 6: Large asynchronous document pipeline

**How this serves the primary goal:** Judges can upload realistic freight documents without bloating every dashboard response or exceeding future model context limits.

### What to implement

1. Introduce `DocumentStorage` with a Postgres `bytea` adapter.
2. Apply a document-route-specific 25 MB body limit and retain smaller limits elsewhere.
3. Change upload to create metadata/file/job records and return `202`.
4. Add a worker that claims a document job, uses existing PDF.js page extraction, enforces 100 pages, and writes 4,000-character page-aware chunks with 400-character overlap.
5. Keep job transactions short: claim, extract outside the transaction, then batch-write results.
6. Store claim/extraction metadata and a short excerpt in workspace-facing responses, not complete text.
7. Add document status and cursor-paginated chunk endpoints.
8. Update the evidence UI with processing/ready/review/failed states and on-demand chunk/page viewing.

### Documentation references

- Existing PDF.js extraction/cleanup: `src/server/documents.ts:4-16`.
- Existing safe async-before-mutation pattern: `src/server/app.ts:146-152`.
- Current full-text leak points: `src/shared/types.ts` `DocumentClaim`, `/api/dashboard`, and `src/client/components/evidence.tsx`.

### Verification checklist

- 25 MB and 100-page boundaries are enforced only on document uploads.
- Dashboard payload excludes original bytes and full extracted text.
- Worker failure records an actionable error without losing the uploaded record.
- Page/chunk order and source provenance are stable.
- Phase 1 performs no complete-document AI injection.

### Anti-pattern guards

- Do not raise `app.use('/api/*')` globally.
- Do not perform 100-page extraction inside `Repository.mutate()`.
- Do not store large bytes/chunks in workspace JSON.

## Phase 7: Empty runtime, personas, feature flags, and judge workflow

**How this serves the primary goal:** The application opens cleanly for judge-provided data while role switching and permissions remain easy to demonstrate.

### What to implement

1. Replace the operational seed with `createEmptyState()`.
2. Move reusable artificial records into test-only fixture builders.
3. Remove Scenario A/B endpoints, buttons, descriptions, and reset-to-rich-seed behavior.
4. Keep “Clear workspace” for admins, resetting operational collections to empty while appending audit evidence.
5. Add the partner `viewer` role and align server actors, client persona definitions, labels, and database constraints.
6. Keep ordinary import/event/document flows as the only runtime data-loading mechanisms; provide header-only import templates or schema guidance, not a bundled data-load endpoint.
7. Add `AI_FEATURES_ENABLED=false`; hide the AI panel and refuse the AI route while disabled.

### Documentation references

- Current seed: `src/domain/seed.ts`.
- Independent demo actor seeding: `src/server/repository.ts:35-49` and `src/server/auth.ts`.
- Scenario/reset routes: `src/server/app.ts:85-89,154-181`.
- Scenario controls/persona definitions: `src/client/App.tsx`.
- AI configuration/panel: `src/server/ai.ts` and `src/client/components/operations.tsx:84`.

### Verification checklist

- A fresh workspace contains no operational records.
- All six personas can authenticate and see only permitted information.
- Partner viewer cannot mutate operational or collaboration state unless a future explicit permission is added.
- No production endpoint or button loads bundled business fixtures.
- AI controls are absent by default while deterministic workflows remain available.

### Anti-pattern guards

- Do not expose test fixtures through production imports.
- Do not leave obsolete Scenario B/cold-chain copy in empty states or README.
- Do not delete personas when removing operational seed data.

## Phase 8: Documentation, diagrams, and presentation alignment

**How this serves the primary goal:** Judges receive documentation that describes the product actually running, without stale claims about cold-chain behavior, universal dual approval, or baked scenarios.

### What to implement

1. Update `README.md`, `docs/Planning/implementation-status.md`, and all three source Markdown files under `docs/artifacts/`.
2. Replace architecture diagrams for scoring, recovery authorization, ingestion/continuity, document processing, and state lifecycles.
3. Update `scripts/export-artifacts.mjs` diagram mapping only where required by renamed/added diagrams.
4. Regenerate HTML, SVG, PNG, catalog, and index artifacts.
5. Remove unsupported claims from the external reference, including platform behavior and latency percentages.
6. Document the empty-data judge workflow, six personas, import schemas, break-glass governance, score factors, and explicit AI deferral.

### Documentation references

- Artifact sources: `docs/artifacts/*.md`.
- Exporter: `scripts/export-artifacts.mjs`.
- Reference disposition: section 10 of the authoritative specification.

### Verification checklist

- Search generated docs for old terms: `0-100`, `condition_reading`, `temperature`, `Scenario B`, universal self-approval prohibition, `8 MB`, and `20 pages`.
- Confirm HTML and diagrams agree with Markdown sources.
- Visually inspect regenerated PNG/SVG diagrams for clipping and stale labels.

### Anti-pattern guards

- Do not edit generated HTML/SVG/PNG as the source of truth.
- Do not present fictional thresholds as universal professional standards.

## Phase 9: Final verification and handoff

**How this serves the primary goal:** It proves that the redesign works as one coherent product and leaves a reproducible evidence trail for the final presentation.

### What to implement

1. Verify types, build, domain/API/repository behavior, and browser workflows after all phases are integrated.
2. Check migrations against both a fresh database and a legacy workspace snapshot.
3. Exercise a judge-style flow: empty login, import data, ingest disruptions, inspect score/drivers/confidence, generate recovery options, complete routine and high-risk authorization, simulate one integration outage/replay, and upload a large document.
4. Confirm audit records connect every mutation to actor, evidence, rule version, approvals, and break-glass reason when applicable.
5. Update the implementation-status matrix with verified results only.

### Documentation references

- Package commands: `package.json`.
- Existing verification patterns: `tests/` and `playwright.config.ts`.
- Existing artifact verification claims: `docs/Planning/implementation-status.md`.

### Verification checklist

- No obsolete cold-chain, baked-scenario, global-outage, or full-document-state behavior remains.
- All public interfaces match the authoritative specification.
- Documentation contains only observed verification results.

### Anti-pattern guards

- Do not claim completion from typechecking alone.
- Do not keep stale pass counts or screenshots after behavior changes.
- Do not weaken deterministic resource accounting to make UI flows pass.

## Explicitly not part of this plan

AI impact adjustment, agentic recovery synthesis, provider selection, JEV, CLEF, live ERP/carrier writes, production-scale broker deployment, and production object storage.
