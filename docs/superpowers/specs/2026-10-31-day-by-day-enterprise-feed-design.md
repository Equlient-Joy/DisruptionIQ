# Day-by-day synthetic enterprise feed

Approved scope: explicit synthetic enterprise ingestion, one day's activity per presenter click, with pause between days. Existing hardcoded-data cleanup stays intact: startup, login, refresh and dataset attachment do not populate operational records.

## Source and control

Generate a reproducible external JSON package using an explicit seed/date/duration. Support 1–30 consecutive UTC days (seven by default), 2 MiB UTF-8 per package and 2,000 combined catalog/event/text-document rows per day. No production imports from test fixtures or synthetic generator scripts.

Each day carries new suppliers, warehouses, dependency declarations, lots, shipments and orders plus normal EventInput records and explicit text document claims. Catalog IDs cannot overwrite existing records. References resolve in delivery order; dependency confidence is 0–1 and edges cannot create cycles. Malformed structural input prevents attachment; semantically invalid/stale/conflicting event claims remain evidence at delivery. No source-provided incidents, risk scores, plans or pre-approved recoveries drive the application.

Focal managers and administrators attach/control a dataset in Data & Evidence. Other focal roles read progress and retain existing operational permissions. Partners cannot read progress/source packages. Initial attachment requires an empty workspace. Identical reattachment is a no-op; a different package requires deliberate existing admin/demo reset. Imports, documents and event capture are blocked between attachment and day 1.

Controls are Start day 1, Next day, Pause and Resume. There is no timer. Pause applies between days; a submitted day commits fully or rolls back. Resume never delivers data. Unresolved issues do not prevent advancement. Final delivery marks complete and retains evidence and current outcomes.

## Atomic ingestion and persistence

Store the bounded source package and progress in existing workspace JSON, explicitly retaining them in normalization and empty-state construction. Each day and receipt/cursor/clock commit in one synchronous Repository.mutate transaction. Preflight package validation runs outside the lock; mutable references, identity, cursor and status recheck inside it. Network/AI work runs only after commit.

A command carries datasetHash, expectedDayIndex and requestId. Receipt retry lookup precedes paused/completed checks. Same request/parameters returns the saved receipt without operational/journal/audit duplication. Reused IDs with changed parameters reject. Concurrent cursors cannot skip a day; losing distinct requests receive 409. Receipts and source survive restart, including a commit with lost HTTP response.

Receipts record actual actor, wall delivery time, before/after clock, catalog counts, event statuses, source-to-document mappings, new incident IDs and computed impact snapshots. Current incidents, affected orders, confirmed recoveries and queue counts remain live persisted facts. Queued status in an old receipt remains a labelled delivery snapshot after replay.

Remove the source package from every dashboard; attachment/control audits contain metadata/fingerprint only, never future rows. Remove simulation progress from partner dashboards and reject partner feed routes. Future source text must not leak via audit snapshots or response errors.

## Clock and recovery

Attachment/pause/resume do not move the clock. First delivery may anchor a historical day only if the workspace remains empty. Later deliveries never move backwards. Process claims in effective-time order, stable for ties, and finish at that UTC day's 23:59:59.999Z, including an empty day.

After attachment, public ingestion and replay cannot advance beyond the delivered day; future-effective claims remain invalid evidence. Older claims retain existing reconciliation guards. Sessions/database/receipt timestamps use wall time; operational deadlines, manual actions and recovery calculations use the frozen simulation clock.

Carry forward quantities, allocations, capacities, approvals, revisions, incidents and audit. Never replace workspace state with a daily scenario snapshot. New absolute counts must not accidentally replenish stock consumed by confirmed recovery; the generated discrepancy exercise uses a separate incoming lot. Plan generation, modification, rejection and confirmation use existing human workflow and current feasibility/separation-of-duties checks.

## Reset and auxiliary work

Reset explicitly removes source/progress and preserves historical audit/receipt metadata. Persist a workspaceGeneration (legacy default 1), increment on reset, and require matching generation plus registered claim for asynchronous document registration/completion/failure/publication. Older work cannot recreate documents or notifications after reset. Existing binary/job records may remain archived.

Post-commit AI triage is auxiliary and may be lost on process crash; deterministic delivery and recovery remain valid. No new durable AI broker, database tables or scheduler are required.

## Demonstration

1. Day 1: opening linked enterprise records and ordinary ETA evidence.
2. Day 2: shared supplier delay, downstream risk and four recovery option types.
3. Day 3: warehouse outage and separate incoming stock for later count review.
4. Day 4: contradictory/invalid counts and document quantity mismatch.
5. Day 5: declared held inventory and an exact duplicate claim.
6. Day 6: carrier evidence for optional presenter-controlled integration outage and replay.
7. Day 7: receipt evidence and new demand; actual outcomes depend on human decisions.

Condition-reading sensor ingestion is currently unsupported; held-lot declarations use existing inventory and authorized disposition rules. Continuous timers, mid-day cancellation, rewind, populated-workspace mixing/replacement, real ERP connectors and PDF/OCR batch orchestration are outside this feed stage; existing selected project opportunities remain unaffected.

## Acceptance

Validate source limits/references/hash, no automatic data, exact single-day delivery, pause/resume, rollback and concurrent requests, lost responses, restart persistence, frozen public/replay clocks, source redaction and role checks, stale document jobs, and real recoveries carried across days. Verify through isolated PGlite and browser port 3100; do not seed/reset operational .data/workspace. See the implementation plan and docs/simulation-feed.md for execution evidence and presenter instructions.
