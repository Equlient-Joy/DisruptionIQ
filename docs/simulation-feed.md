# Day-by-day enterprise simulation

The application starts without enterprise records. A synthetic dataset is an external JSON file that you explicitly attach and deliver. Login, attachment, waiting and refresh never deliver a day automatically.

## Generate an inspectable dataset

From the project folder, run:

```powershell
bun run generate:enterprise --seed judges-2026 --start-date 2026-11-01 --days 7 --out .cache/enterprise-demo.json
```

This writes JSON and `.cache/enterprise-demo.presenter.md`; it does not connect to or modify the database. The same seed, start date, duration and generator version reproduce the same source. Choose 1–30 UTC days. Existing output files are retained unless you explicitly add `--overwrite`.

The package includes explicit fictional suppliers, declared dependency edges, warehouses, lots, shipments, customer orders, source events and text claims. It contains no incidents, risk scores, recovery proposals, approvals or precomputed successful outcomes. The seven-day export is small enough for the 2 MiB upload limit and 2,000 combined source rows per day.

## Run the presentation

1. Sign in as **Supply Chain Manager** or **Administrator** and open **Data & Evidence**.
2. Under **Enterprise simulation**, choose `enterprise-demo.json` in **Simulation dataset file**. Check the preview, then click **Load simulation dataset**.
3. Attachment validates every day and relationship but leaves the operational dashboard empty. Click **Start day 1** to ingest the opening records.
4. Review the delivered day's real records, evidence and live metrics. Click **Next day** when ready. Each click commits exactly one whole day.
5. On day 2, switch to **Operations Analyst**, open **Incidents & Recovery**, choose an incident and generate recovery options. Inspect feasible and rejected alternatives. Modify/reject a proposal or switch to independent authorized reviewers to confirm execution. High-risk proposals require two distinct reviewers; confirmation and current constraints remain mandatory.
6. Day 3 adds a warehouse outage. Prior decisions and consumed stock persist. Day 4 adds a discrepancy on a separate new lot, contradictory/invalid counts and a freight-document quantity mismatch. These claims remain evidence; they do not automatically resolve disputes or overwrite inventory from the document.
7. Day 5 adds a lot explicitly declared held and repeats an exact source claim. Inspect unusable stock and safe deduplication. Existing warehouse/admin disposition controls remain available for human review.
8. Before day 6, optionally pause the **carrier integration** using its separate connection control. Deliver day 6, inspect queued carrier evidence, restore the integration and preview/replay its queue. Feed pause and integration outage are separate controls.
9. Day 7 supplies receipt evidence and new demand. Show actual confirmed recoveries and remaining issues. **Simulation complete** stops further delivery and retains the entire history.

The sequence provides two distinct disruptions and all four recovery option types. Results depend on the approvals, modifications, replay actions and timing you choose; the feed does not guarantee a scripted successful ending.

## Pause, restart and progress

**Pause** disables further day delivery. **Resume** re-enables controls without ingesting anything. You can review evidence, generate proposals and approve recoveries while paused. Pause applies between days; an already submitted batch completes atomically or rolls back fully.

The dataset fingerprint, cursor and receipt for every delivered day persist in the workspace. Refreshing, signing out and restarting the server retain them. Duplicate clicks or a lost response cannot repeat a day's operational effects; the UI reconciles saved progress and retains a retry token when needed. A batch that fails structural validation leaves data, cursor and clock unchanged.

The visible day and simulation clock use **UTC**. Explicit first delivery may anchor a historical date only in an empty workspace. Each delivered day finishes at `23:59:59.999Z`; deadlines and recovery calculations use that clock until the next delivery. Authentication and receipt-recording timestamps use real wall time. Events may report older effective evidence, but cannot move the clock beyond the delivered day. Future-effective manual claims are retained as invalid evidence.

Event counts in the receipt are statuses observed at delivery: accepted, duplicate, invalid, conflict, stale and queued. A queued event remains queued in that snapshot even after later replay. **Current** incidents, affected orders, confirmed recoveries and queue counts come from persisted operational state. Neither counts nor recovery outcomes are preset in the UI.

## Access, validation and reset

Only focal manager/admin roles can attach or control the feed. Other focal roles can view progress and retain their existing operational permissions. Partners cannot view feed metadata or unreleased source packages.

Attachment requires an empty operational workspace and never clears imported records automatically. Before day 1, ordinary event capture, catalog imports and document uploads are blocked. After day 1 they are available again, subject to validation and permissions. Imports using a future dataset ID can cause that later day to fail; correct the source/operational conflict explicitly rather than overwriting it.

To repeat a presentation, use the existing **Administrator** workspace-clear action in demo mode, with its confirmation. It clears the active source/progress and operational records, retains prior audit and receipt metadata, and invalidates older asynchronous document jobs. Then attach the file again. No rewind or automatic dataset replacement is provided.

Text claims in a day use deterministic text extraction and normal review. Binary PDFs/OCR use the existing document upload pipeline separately. Sensor `condition_reading` events remain unsupported; the held-lot example is an explicit inventory declaration, not sensor-policy ingestion. AI triage is auxiliary post-commit work: unavailable AI does not roll back a delivered day or authorize recovery.

## Verification

Unit/API tests exercise source validation, fingerprints, boundaries, atomic rollback, pause races, duplicate request recovery, disk restart, access, redaction, document generations and synthetic workflow coherence. Browser tests run on isolated PGlite at port 3100 and include explicit loading, pause/reload, lost response reconciliation and independent recovery approval across days. They never use operational `.data/workspace`.
