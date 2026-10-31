# Removal of embedded enterprise data — 31 October 2026

The dashboard was reading a persisted legacy demo workspace. Inspection found 5 suppliers, 2 warehouses, 3 lots, 2 shipments, 2 orders, 6 incidents, 12 events, 36 plans, 1 document, and 743 audit records. There were no catalog imports; the audit contained repeated applications of the old synthetic scenarios. Changing new-database initialization to empty had not removed that previously saved data.

The local application now uses `.data/workspace`, initialized without operational records. The previous database remains under `.data/postgres` for recovery. The path change is recorded in the ignored local `.env`; `.env.example` documents the new default. Restarting the app preserves subsequently imported records rather than clearing them.

Enterprise seed construction moved from `src/domain/seed.ts` to `tests/fixtures/enterprise.ts`. Scenario actions moved from `src/domain/engine.ts` to `tests/fixtures/scenarios.ts`. Tests use those builders explicitly; production has no fixture imports or built-in scenario actions.

The login screen renders the accounts supplied by the server. Default demo accounts use role names instead of fictional personal identities. Copilot suggestions no longer name a sample shipment. Event capture requires an explicit payload, and pasted documents require an explicit filename and source text. Role labels, validation rules, and recovery policy constants remain application configuration rather than enterprise records.

Verification of the actual application on port 3000 found zero suppliers, warehouses, lots, shipments, orders, incidents, events, plans, documents, and audit entries. Browser sign-in and Data & Evidence loaded without page errors. The strict build and 102 unit/API tests pass. Browser workflows exercise imports and events supplied explicitly by the test driver.

The requested next stage is a synthetic enterprise feed supplied through normal ingestion: deliver one day's records and events, allow the judge to resolve the day's issues, and inject the next day only when requested. That feed should have its own dataset and progress controls, with no automatic loading on sign-in.
