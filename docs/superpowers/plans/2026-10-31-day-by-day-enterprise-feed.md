# Day-by-day Enterprise Feed Implementation Plan

**Primary goal:** A presenter explicitly delivers one day of synthetic enterprise activity, resolves issues through the actual recovery workflow, and controls when the next day arrives.

**Architecture:** External seeded JSON generator; shared validation; one transactional day with persistent idempotent receipt and frozen clock; controls in Data & Evidence.

**Spec:** ../specs/2026-10-31-day-by-day-enterprise-feed-design.md

**Execution:** Native implementation in the current feature branch, preserving prior uncommitted cleanup. This file records execution of the approved plan; detailed verification/rulings live in .cache/feed-progress.md.

## Phase 0: Documentation discovery

**How this serves the primary goal:** Confirm existing ingestion, transaction, clock and UI contracts before changing them.

- [x] Read Repository.mutate, importRows, ingestEvent/replayQueue, normalization, empty initialization, role guards and browser harness.
- [x] Identify gaps: dependency imports, optional event identifiers, day controls, package/progress normalization and reset generations.

## Phase 1: Shared validation and staging

**How this serves the primary goal:** Accept an explicit inspectable file without generating enterprise records during startup or attachment.

- [x] Task 1: src/domain/catalog.ts shares catalog/event schemas and checked nonoverwriting append. Dependencies validate endpoints, confidence and cycles; ordinary imports retain partial acceptance.
- [x] Task 2: src/shared/simulation.ts and src/domain/simulation-dataset.ts define/validate package and receipts, canonical SHA-256 identity, consecutive UTC dates, UTF-8/day limits, reference order and fail-closed persistence normalization.

## Phase 2: Atomic day and frozen clock

**How this serves the primary goal:** A click delivers exactly one day while preserving actual recoveries.

- [x] Task 3: src/domain/simulation.ts attaches, pauses/resumes and advances. Data, clock, receipt and cursor commit together; request retry precedes status checks. Public event validation shares day boundary; semantics preserve anomaly evidence.
- [x] Test rollback, concurrency, pause races, historical/empty days, lost responses, disk restart, document mappings and confirmed recovery carryover in tests/simulation.test.ts.

## Phase 3: Secured API and provenance

**How this serves the primary goal:** Controls work across sessions and restarts without exposing unreleased records.

- [x] Task 4: src/server/simulation.ts registers authenticated summary/attachment/advance/control routes. Role checks, source/partner redaction, pre-day-1 guards and post-commit triage.
- [x] Reset removes source/progress, preserves audit/receipt metadata, increments generation and blocks old document callbacks from recreating claims.
- [x] API/document tests check roles, malformed source, replacement/cursors, public boundary paths, source leakage, resets and stale jobs.

## Phase 4: External dataset

**How this serves the primary goal:** Supply repeatable fictional enterprise activity through ingestion rather than preset runtime state.

- [x] Task 5: scripts/synthetic/generator.ts and scripts/generate-enterprise-data.ts export explicit JSON/presenter guide using seed/date/duration, with no database access or fixture imports.
- [x] Test 1/7/30 days, deterministic identity, shared dependencies, four recovery types, two disruptions, anomaly evidence, held lots and document mismatch.
- [x] Regression: discrepancy counts use a separate incoming lot to avoid replenishing consumed recovery stock.

## Phase 5: Presenter UI

**How this serves the primary goal:** Judges can see real day results while the presenter controls progression.

- [x] Task 6: simulation-feed.tsx displays source preview, Start day 1/Next day/Pause/Resume, persistent progress, UTC clock, snapshot counts and live outcomes. Recover lost response using saved receipt/current status.
- [x] Browser tests cover explicit load/pause/reload, ambiguous response recovery and independent human approval carried into later days.

## Phase 6: Verification and handoff

**How this serves the primary goal:** Prove and document a repeatable demonstration without modifying operational data.

- [x] Task 7 runbook: docs/simulation-feed.md and README generator/control instructions.
- [x] Final verification: 129 unit/API tests, 12 browser workflows and strict build pass; targeted outage browser recheck passes after the receipt replay fix.
- [x] Independent review: no remaining confirmed findings. Production fixture-import scan and diff whitespace check clean.
- [x] Sample export ready; actual server runs on port 3000 without automatically loaded enterprise records.

**Review focus:** Lost responses; concurrent pause/advance; future public inputs; historical/empty days; recoveries and later inventory replay. Future data must never leak through dashboard or audit.

**Commands:** bun test; bun run build; bun run test:e2e; git diff --check. Test PGlite/browser port 3100 only. No commit/push is part of this request.
