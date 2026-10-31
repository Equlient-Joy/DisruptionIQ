# DisruptionIQ: Autonomous Disruption Detection & Decision Support

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.3+-black.svg)](https://bun.sh/)
[![React](https://img.shields.io/badge/React-19.1-cyan.svg)](https://react.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-blue.svg)](https://www.postgresql.org/)
[![Tests](https://img.shields.io/badge/Tests-102%20Pass%20%7C%2015%20Suites-brightgreen.svg)]()

> **DisruptionIQ — Operational Control Room & Decision Support**  
> Autonomous disruption detection, dependency graph propagation, interaction-aware risk scoring, and decision support for high-consequence supply chains. DisruptionIQ turns carrier delays, warehouse outages, inventory holds, and large freight documents into constraint-validated, human-reviewed recovery plans under risk-tiered governance with an immutable audit trail.

---

## Table of Contents

1. [Overview & Core Value](#overview--core-value)
2. [Stack & Architecture](#stack--architecture)
3. [Prerequisites & Quick Start](#prerequisites--quick-start)
4. [Demo Accounts & Role Matrix](#demo-accounts--role-matrix)
5. [Judge Evaluation Walkthrough](#judge-evaluation-walkthrough)
6. [Challenge & Architectural Compliance](#challenge--architectural-compliance)
7. [Testing & Verification](#testing--verification)

---

## Overview & Core Value

Modern supply chains face complex, compound disruptions: single upstream fab delays cascade across multiple Tier-1 suppliers, warehouse outages block inventory throughput, and freight paperwork discrepancies stall distribution.

Conventional ERP systems flood operators with unranked, noisy alerts without showing customer order consequence. Meanwhile, pure LLM "autonomous agents" risk hallucinating inventory, allocating already-committed stock, or bypassing governance checks.

**DisruptionIQ resolves this with a hardened dual-engine architecture:**
- **Deterministic Accounting Core**: All inventory balances, hard commitments, multi-tier dependency propagation, lead-time calculations, warehouse capacities, and transaction serialization execute in deterministic TypeScript with PostgreSQL row-level locks and relational projections.
- **Interaction-Aware Impact Engine**: Replaces opaque 0–100 scores with a calibrated **0.0–10.0 impact score** (rounded to 1 decimal place) that strictly evaluates zero shortage as 0.0, isolates up to 2 primary bottleneck drivers, and computes independent evidence confidence.
- **Risk-Tiered Human Authorization**: Routine recovery actions execute with a single approval (self-approval permitted for authorized operators). High-risk actions require independent two-person authorization where the first approval mutates zero operational resources. Emergency situations permit administrator break-glass execution with auditable justification ($\ge 20$ chars).
- **Resilient Integration Inboxes**: Isolated per-integration connections (`carrier`, `warehouse`, `supplier`, `document`, `ai`) ensure an offline carrier connection never stalls warehouse cycle counts, with non-mutating preview before targeted replay.
- **Large Document Pipeline**: Asynchronously ingests freight bills up to 25 MB and 100 pages, storing bytes in Postgres `bytea` and chunking text into 4,000-character page-aware chunks without serializing full text into dashboard payloads.
- **Empty Baseline for Judges**: Starts with an operationally empty workspace ready for judge-provided datasets, paired with six 1-click demo personas.

---

## Stack & Architecture

- **Runtime & Toolchain**: [Bun](https://bun.sh/) (v1.3+ / v1.4.4) with native TypeScript execution and bundled high-performance test runner.
- **Backend**: [Hono](https://hono.dev/) on Bun.
  - Server-side cookie sessions (`diq_session`, `HttpOnly`, `SameSite=Strict`).
  - Strict input validation with [Zod](https://zod.dev/).
  - Robust streaming CSV ingestion with [Papa Parse](https://www.papaparse.com/).
  - Large document text extraction with [PDF.js](https://mozilla.github.io/pdf.js/) (`pdfjs-dist`).
- **Database & Persistence**:
  - [PostgreSQL 17](https://www.postgresql.org/) with [Drizzle ORM](https://orm.drizzle.team/) and [postgres.js](https://github.com/porsager/postgres).
  - Multi-process row-level locking (`SELECT ... FOR UPDATE`) guarantees serializable atomic state updates.
  - Native embedded mode powered by [@electric-sql/pglite](https://pglite.dev/) for instantaneous, zero-setup local development and isolated test execution.
  - Dedicated Postgres `bytea` document storage table (`document_files`), chunk storage table (`document_chunks`), and integration inboxes (`integration_inbox`).
- **Frontend**:
  - [React 19](https://react.dev/) + [Vite 7](https://vitejs.dev/).
  - Asynchronous state management and polling cache via [@tanstack/react-query](https://tanstack.com/query).
  - Modern iconography with [Lucide React](https://lucide.dev/).
  - Zero-dependency custom design system optimized for high-density logistics dashboards with light/dark adaptive tokens.
- **Test Automation**:
  - **Bun Test**: 102 domain, API, document pipeline, integration resilience, impact scoring, authorization, client state, and persistence tests across 15 test files.
  - **Playwright**: 9 browser workflows covering account access, recovery approvals, import feedback, outages, documents, and workspace clearing.

---

## Prerequisites & Quick Start

### Prerequisites
- [Bun](https://bun.sh/) (v1.3.0 or higher).
- [Docker](https://www.docker.com/) (optional, for running standalone PostgreSQL 17 via `docker-compose.yml`). The sample configuration uses embedded PGlite. To use standalone PostgreSQL, remove `DATABASE_MODE=pglite` and set `DATABASE_URL`; connection failures do not silently switch databases.

### 1. Installation
Clone the repository and install dependencies:
```bash
bun install
```

### 2. Environment Configuration
Copy the sample environment file:
```bash
cp .env.example .env
```
*Note: Default settings run in `DEMO_MODE=true` with embedded PostgreSQL (`PGlite`), allowing complete out-of-the-box operation without external database configuration.*

The local workspace is persisted under `.data/workspace`. A new workspace contains no operational records. Restarting preserves records that you explicitly imported or ingested. Enterprise datasets and scenario builders live only under `tests/fixtures`; the production app never loads them. Demo sign-in roles remain available, with account details supplied by the server.

AI provider calls are disabled by default. Set `AI_FEATURES_ENABLED=true` and configure a provider key to enable them. With AI disabled, the copilot and background agents use deterministic fallback responses.

### 3. Build & Initialize Database
Compile the frontend client and run schema migrations:
```bash
bun run build
bun run db:migrate
bun run db:seed
```

### 4. Start the Application
Start the integrated production server on port 3000:
```bash
bun start
```
Open **[http://127.0.0.1:3000](http://127.0.0.1:3000)** in your browser.

---

## Demo Accounts & Role Matrix

DisruptionIQ enforces backend-verified Role-Based Access Control (RBAC). The login screen features **one-click demo account buttons** for rapid evaluation:

| Role | Demo Account Email | Name | Permitted Capabilities | Prohibited Actions |
|---|---|---|---|---|
| **Operations Analyst** | `analyst@disruptioniq.demo` | Operations Analyst | View disruptions, correlate alerts, ingest signals, generate recovery proposals, modify quantities. | Cannot approve recovery plans. Cannot clear workspace. |
| **Supply Chain Manager** | `manager@disruptioniq.demo` | Supply Chain Manager | Authorize routine plans, provide first/second approval on high-risk plans, manage integration outages & replay. | Cannot self-approve high-risk plans they created/modified. |
| **Warehouse Supervisor** | `warehouse@disruptioniq.demo` | Warehouse Supervisor | Review physical stock discrepancies, manage inventory lot holds (`available` vs `held`), confirm freight documents. | Cannot approve expedites or financial spending. |
| **Procurement Approver** | `procurement@disruptioniq.demo` | Procurement Approver | Review and approve Alternative Supplier recovery plans, review freight documents. | Cannot approve warehouse reallocations or self-approve high-risk proposals. |
| **Administrator** | `admin@disruptioniq.demo` | Administrator | Full operational visibility, security oversight, emergency break-glass execution, clear workspace. | Cannot approve high-risk plans they proposed without audited break-glass reason. |
| **Partner Viewer** | `partner@disruptioniq.demo` | Partner Viewer | Scoped view of participating incidents, inspect assigned cross-company collaboration tasks. | Completely redacted: No internal customer orders, inventory lots, plans, or decisions. |

> **Universal Demo Password:** `disruption-demo`

---

## Judge Evaluation Walkthrough

The workspace starts as an empty, professional control room. Follow this step-by-step path to evaluate the full platform:

### 1. Ingest Master Data
1. Sign in as **Operations Analyst** (`analyst@disruptioniq.demo`).
2. Click **Import CSV / JSON** in the top action bar:
   - Select **suppliers** and click **Insert suppliers CSV header** to populate the template.
   - Paste supplier rows and submit.
   - Repeat for **warehouses**, **lots**, **shipments**, and **orders**.
3. Inspect the live dashboard: inventory lots appear with hard reservations, multi-tier dependency topology renders in SVG, and customer order delivery schedules are tracked.

### 2. Ingest Disruption Signals
1. Click **Capture event**:
   - Ingest a `supplier_delay` event: downstream shipment arrival times automatically shift.
   - Ingest a `warehouse_outage`: warehouse status toggles and downstream orders are flagged.
   - Ingest a contradictory `stock_count`: the lot status safely shifts to `disputed` without corrupting physical stock.

### 3. Inspect Interaction-Aware Impact Scoring
1. Navigate to **Incidents & Recovery**:
   - The platform calculates an exact **0.0–10.0 impact score** for each exposed order.
   - Review the **Bottleneck Drivers** tag (identifying the top factors exceeding operational thresholds).
   - Check the **Evidence Confidence** badge (`high`, `medium`, or `low`).
   - Click the details dropdown to inspect the complete 5-component score breakdown.

### 4. Generate Recovery Options & Risk-Tiered Authorization
1. Click **Generate Recovery Options**:
   - The deterministic candidate engine enumerates options across all 4 categories: `reallocate`, `split_order`, `expedite`, and `alternative_supplier`.
   - Infeasible options are retained with explicit constraint failure reasons.
2. For a **Routine Plan**:
   - Single approval by an authorized manager executes the action immediately.
3. For a **High-Risk Plan** (cost $\ge \$2,000$ or score $\ge 7.0$):
   - First approver approves: status updates to `awaiting_second_approval` (zero operational inventory or warehouse capacity is mutated).
   - Sign out and sign in as a distinct second approver (e.g. `admin@disruptioniq.demo`).
   - The second approver confirms: live constraints revalidate and resources commit atomically.
4. For emergency situations:
   - Administrator break-glass button prompts for an auditable emergency justification ($\ge 20$ characters) and records `reviewStatus: 'required'`.

### 5. Resilient Continuity Inboxes
1. Navigate to **Data & Evidence**:
   - Review per-integration status cards (`carrier`, `warehouse`, `supplier`, `document`, `ai`).
   - Click **Simulate outage** on the carrier connection.
   - Ingest new carrier events: they are safely buffered in the integration inbox.
   - Click **Preview**: inspect the non-mutating simulation of reconciliation results without committing state.
   - Click **Restore connection** and **Replay**: events reconcile chronologically with idempotency checks.

### 6. Large Freight Document Pipeline
1. In **Data & Evidence**, click **Upload document**:
   - Upload a freight bill or manifest (up to 25 MB and 100 pages).
   - The system returns `202 Accepted` immediately.
   - The asynchronous worker stores bytes in Postgres `bytea`, chunks into 4,000-character page-aware chunks, and updates the claim with an excerpt.
   - Click **View extracted chunks** to inspect cursor-paginated chunks on demand.

### 7. Clear Workspace
1. Sign in as **Administrator** (`admin@disruptioniq.demo`).
2. Click **Clear workspace**:
   - Confirms clearing operational data.
   - Resets operational collections to empty while preserving the complete append-only audit trail and appending an auditable `demo_reset` decision record.

---

## Challenge & Architectural Compliance

| Requirement / Constraint | Implementation Evidence | Source Files | Test Suite |
|---|---|---|---|
| **Empty Baseline for Judges** | `createEmptyState()` initializes zero operational records; CSV/JSON templates provided. | `src/domain/seed.ts`<br>`src/client/components/forms.tsx` | `tests/normalize.test.ts` |
| **0.0–10.0 Impact Scoring** | Interaction-aware 5-factor scoring strictly bounded 0.0–10.0 with 1 decimal; top 2 drivers; confidence. | `src/domain/impact.ts`<br>`src/client/components/operations.tsx` | `tests/impact.test.ts` |
| **Recovery Option Seam** | Pure candidate generation with non-persisting constraint checking. | `src/domain/plans.ts` | `tests/plans.test.ts` |
| **Risk-Tiered Approvals** | Routine single approval vs high-risk dual approval (`awaiting_second_approval`) vs admin break-glass ($\ge 20$ chars). | `src/domain/plans.ts`<br>`src/client/components/forms.tsx` | `tests/plans.test.ts` |
| **Generic Lot Disposition** | Replaced cold-chain telemetry with manual quality/inspection holds (`available` vs `held`). | `src/domain/engine.ts`<br>`src/server/app.ts` | `tests/domain.test.ts` |
| **Integration Continuity Inboxes** | Selective circuit breakers per integration; non-mutating preview; targeted replay. | `src/domain/events.ts`<br>`src/server/repository.ts` | `tests/integrations.test.ts` |
| **Large Document Pipeline** | 25 MB / 100 pages limit; Postgres `bytea` storage; 4,000-char chunks; excerpt only in dashboard. | `src/server/documents.ts`<br>`src/client/components/evidence.tsx` | `tests/documents.test.ts` |
| **Persistent PostgreSQL Storage** | PostgreSQL 17 + Drizzle ORM (embedded PGlite + client-server pool); serializable row locks. | `src/server/repository.ts`<br>`src/server/schema.ts` | `tests/repository.test.ts` |
| **Deterministic Core & AI Boundary** | `AI_FEATURES_ENABLED=false` by default; AI does not score, plan, or mutate operational state. | `src/server/ai.ts`<br>`src/server/app.ts` | `tests/api.test.ts` |

---

## Testing & Verification

Execute the complete test suite:
```bash
# Run all 102 unit and API tests across 15 test files
bun test

# Run TypeScript strict typecheck
bun run typecheck

# Run production build
bun run build

# Run browser workflows with a fresh in-memory database on port 3100
bun run test:e2e
```

## Day-by-day synthetic enterprise feed

Generate an explicit source file without importing data:

```powershell
bun run generate:enterprise --seed judges-2026 --start-date 2026-11-01 --days 7 --out .cache/enterprise-demo.json
```

Sign in as Supply Chain Manager or Administrator, open **Data & Evidence**, choose the file under **Enterprise simulation**, and click **Load simulation dataset**. **Start day 1** and **Next day** each deliver one atomic batch. **Pause** blocks further days; **Resume** does not deliver data. Progress and actual recovery actions survive refresh and restart. Login and attachment keep operational records empty until explicit delivery.

See [the presentation runbook](docs/simulation-feed.md) for the day sequence, permissions, frozen UTC clock, duplicate/retry behavior and deliberate demo reset.
