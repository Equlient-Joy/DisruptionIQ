# DisruptionIQ: Autonomous Disruption Detection & Decision Support

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.3+-black.svg)](https://bun.sh/)
[![React](https://img.shields.io/badge/React-19.1-cyan.svg)](https://react.dev/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-blue.svg)](https://www.postgresql.org/)
[![Playwright](https://img.shields.io/badge/Playwright-E2E-green.svg)](https://playwright.dev/)
[![Tests](https://img.shields.io/badge/Tests-36%20Pass%20%7C%205%20E2E%20Pass-brightgreen.svg)]()

> **PS 1: DisruptionIQ — From Delivery Delays to Recovery Plans**  
> Autonomous disruption detection, dependency graph propagation, and decision support for high-consequence electronics supply chains. DisruptionIQ turns carrier delays, warehouse outages, freight document discrepancies, and IoT condition excursions into constraint-validated, human-reviewed recovery plans with strict separation of duties and an immutable audit trail.

---

## Table of Contents

1. [Overview & Core Value](#overview--core-value)
2. [Stack & Architecture](#stack--architecture)
3. [Prerequisites & Quick Start](#prerequisites--quick-start)
4. [Demo Accounts & Role Matrix](#demo-accounts--role-matrix)
5. [Demonstration Walkthroughs](#demonstration-walkthroughs)
   - [Scenario A: Shared Upstream Delay & Warehouse Outage](#scenario-a-shared-upstream-delay--warehouse-outage)
   - [Scenario B: Quality Excursion, Document Discrepancy & Outage Replay](#scenario-b-quality-excursion-document-discrepancy--outage-replay)
6. [Challenge & Research Opportunity Coverage](#challenge--research-opportunity-coverage)
   - [Mandatory Requirements (B1–B9)](#mandatory-requirements-b1b9)
   - [Mandatory Constraints (C1–C5)](#mandatory-constraints-c1c5)
   - [12 Selected Research Opportunities](#12-selected-research-opportunities)
7. [System Boundaries & Intentional Limitations](#system-boundaries--intentional-limitations)
8. [Testing & Verification](#testing--verification)

---

## Overview & Core Value

Modern electronics supply chains face compound disruptions: single upstream fab outages cascade across multiple Tier-1 suppliers, IoT temperature excursions quietly compromise delicate microcontrollers, and freight paperwork discrepancies stall customs clearance. 

Conventional ERPs either sound alarms too late or flood operators with unranked, noisy alerts. Furthermore, pure LLM "autonomous agents" risk hallucinating inventory, allocating already-committed stock, or bypassing critical authorization policies.

**DisruptionIQ resolves this with a dual-engine architecture:**
- **Deterministic Core**: All inventory reservations, multi-tier dependency propagation, lead-time calculations, warehouse capacities, role-based authorization checks, and separation-of-duties rules execute in hardened, deterministic TypeScript with PostgreSQL transactional guarantees.
- **AI Situational Support**: Generates grounded executive briefings, risk syntheses, and document extraction explanations that are strictly bounded by verified operational facts.
- **Human-in-the-Loop Governance**: Every recovery action requires explicit confirmation by an authorized human stakeholder. Proposers cannot approve their own plans (enforced even for administrators).

```
                                  DISRUPTIONIQ ARCHITECTURE
                                  
  Inbound Signals                      Deterministic Engine                      Human-in-the-Loop UI
+------------------+             +-------------------------------+             +-----------------------+
| Carrier Webhooks | ----------> |   Semantic Invariant Check    |             |  React 19 Dashboard   |
| CSV / JSON Feeds |             |   Idempotency & Deduplication |             |  Risk-Ranked Orders   |
| IoT Sensor Telemetry           |   Multi-Tier DAG Propagation  | ----------> |  Feasibility Badges   |
| Freight Documents|             |   Constraint Revalidation     |             |  Separation of Duties |
+------------------+             +-------------------------------+             +-----------------------+
                                                 |                                         |
                                                 v                                         v
                                 +-------------------------------+             +-----------------------+
                                 |  PostgreSQL 17 / Drizzle ORM  | <---------- | Explicit Confirmation |
                                 |  Transactional State Locking  |             | Simulated Execution   |
                                 |  Immutable Audit Decisions    |             | Before / After Diffs  |
                                 +-------------------------------+             +-----------------------+
```

---

## Stack & Architecture

- **Runtime & Toolchain**: [Bun](https://bun.sh/) (v1.3+) with native TypeScript execution and bundled high-performance test runner.
- **Backend**: [Hono](https://hono.dev/) on Bun.
  - Server-side cookie sessions (`diq_session`, `HttpOnly`, `SameSite=Strict`).
  - Strict input validation with [Zod](https://zod.dev/).
  - Robust streaming CSV ingestion with [Papa Parse](https://www.papaparse.com/).
  - In-memory PDF text extraction with [PDF.js](https://mozilla.github.io/pdf.js/).
- **Database & Persistence**:
  - [PostgreSQL 17](https://www.postgresql.org/) with [Drizzle ORM](https://orm.drizzle.team/) and [postgres.js](https://github.com/porsager/postgres).
  - Multi-process row-level locking (`SELECT ... FOR UPDATE`) guarantees serializable atomic state updates.
  - Native embedded mode powered by [@electric-sql/pglite](https://pglite.dev/) for instantaneous, zero-setup local development and isolated testing.
  - Relational projections with foreign keys, check constraints (`quantity >= 0`, `reserved <= quantity`), and indexed queries.
- **Frontend**:
  - [React 19](https://react.dev/) + [Vite 7](https://vitejs.dev/).
  - Asynchronous state management and polling cache via [@tanstack/react-query](https://tanstack.com/query).
  - Modern iconography with [Lucide React](https://lucide.dev/).
  - Zero-dependency custom design system optimized for high-density logistics dashboards with light/dark adaptive tokens.
- **Test Automation**:
  - **Bun Test**: 36 comprehensive domain, API, and persistence tests.
  - **Playwright**: 5 end-to-end browser workflows exercising real user authentication, multi-role handoffs, scenario executions, and partner portal scoping.

---

## Prerequisites & Quick Start

### Prerequisites
- [Bun](https://bun.sh/) (v1.3.0 or higher).
- [Docker](https://www.docker.com/) (optional, for running standalone PostgreSQL 17 via `docker-compose.yml`). If Docker is not running, DisruptionIQ automatically defaults to embedded PGlite.

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

### 3. Build & Initialize Database
Compile the frontend client and run schema migrations and seed data:
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

### Development Mode
For live hot-reloading across both backend and frontend:
```bash
# Terminal 1: Backend API watcher
bun run dev

# Terminal 2: Vite client dev server
bun run dev:web
```

---

## Demo Accounts & Role Matrix

DisruptionIQ enforces backend-verified Role-Based Access Control (RBAC). The login screen features **one-click demo account buttons** for rapid evaluation:

| Role | Demo Account Email | Name | Permitted Capabilities | Prohibited Actions |
|---|---|---|---|---|
| **Operations Analyst** | `analyst@disruptioniq.local` | Alex Rivera | View disruptions, correlate alerts, run scenarios, generate recovery proposals, modify quantities. | Cannot approve recovery plans (Separation of Duties). Cannot trigger workspace reset. |
| **Supply Chain Manager** | `manager@disruptioniq.local` | Priya Sharma | Approve internal recovery plans (Reallocate, Expedite, Split), toggle integration outages, assign collaborative tasks. | Cannot self-approve plans they created/modified. Cannot approve third-party supplier contracts. |
| **Warehouse Operator** | `warehouse@disruptioniq.local` | Kabir Rao | Review physical stock discrepancies, manage quality quarantines, release inspected lots, confirm freight documents. | Cannot approve expedites or financial spending. |
| **Procurement Approver** | `procurement@disruptioniq.local` | Ananya Iyer | Review and approve Alternative Supplier recovery plans, evaluate vendor lead times and minimum order commitments. | Cannot approve warehouse reallocations or self-approve proposals. |
| **Administrator** | `admin@disruptioniq.local` | Dev Admin | Full operational visibility, security oversight, manual stock disposition, full workspace scenario reset. | **Cannot self-approve** their own proposed recovery plans. |
| **Partner Supplier** | `partner@nexus-components.example` | Maya Chen | Scoped view of shared incidents, update assigned cross-company collaboration tasks. | Completely redacted: No internal customer orders, inventory lots, or decision audit records. |

> **Universal Demo Password:** `disruption-demo`

---

## Demonstration Walkthroughs

DisruptionIQ includes two end-to-end reproducible scenarios accessible directly from the dashboard header or API.

### Scenario A: Shared Upstream Delay & Warehouse Outage
*Demonstrates: Multi-Tier Dependency Propagation, Alert Corroboration, Joint Exposure, Constraint-Validated Recovery, Separation of Duties, and Simulated Execution.*

1. **Sign in as Operations Analyst** (`analyst@disruptioniq.local`).
2. Click **Scenario A (Delay + Outage)** in the top action bar:
   - Ingests a 48-hour delay for Tier-2 wafer supplier **Core Silicon**.
   - Propagates delay downstream to Tier-1 assemblers **Atlas Assemblies** and **Beacon Electronics**.
   - Triggers an outage at **West Distribution Hub**.
   - Introduces a same-scope cycle count conflict for **Lot West** (100 vs. 95 units), safely freezing the disputed lot.
3. Navigate to **Incidents & Recovery**:
   - Notice the consolidated incident correlating 3 alerts into a single actionable event without noise.
   - Review high-risk customer orders: **Meridian Medical** (Critical, 24h deadline) and **Civic Transit** (High, 30h deadline).
4. Click **Generate Recovery Options**:
   - The engine generates all four recovery options:
     1. **Reallocate Inventory**: Feasibility evaluated against uncommitted usable stock and receiving warehouse outage.
     2. **Expedite Shipment**: Checks in-transit shipment `shipment-atlas`, calculating express transit floor (8 hours) and savings.
     3. **Alternative Supplier**: Evaluates approved supplier `Reserve Circuit Works` (lead time 10h, min order 25 units) vs. unverified suppliers.
     4. **Split Customer Order**: Calculates feasibility of immediate partial shipment to prevent complete line stoppage.
   - Each option displays clear constraint validation badges and detailed rationale explaining why certain options fail.
5. Click **Modify** on a proposed plan to adjust quantity to `60` units:
   - Notice the plan version increments from `v1` to `v2`.
   - The system records Alex Rivera as the modifier.
   - **Separation of Duties Verification**: The "Review & confirm" button is disabled for Alex Rivera with a permission note: *"Modifier cannot self-approve a revised plan."*
6. Click **Log Out** and sign in as **Supply Chain Manager** (`manager@disruptioniq.local`):
   - Return to **Incidents & Recovery**.
   - Click **Review & confirm** on the modified plan.
   - The confirmation modal displays the before/after operational impact. The submit button remains disabled until the reviewer checks: *"I confirm this simulated operational execution."*
   - Click **Confirm simulated recovery**.
7. Observe immediate deterministic updates:
   - Plan status transitions to `executed`.
   - Order fulfillment increments by 60 units.
   - Warehouse capacity and lot quantities decrement atomically.
   - Navigate to **Decision History** to inspect the full immutable audit trail with before/after state diffs and rule version citations.

---

### Scenario B: Quality Excursion, Document Discrepancy & Outage Replay
*Demonstrates: IoT Condition Excursion, Automatic Quarantine, Freight Document Automation, Offline Continuity Fallback, and Durable Replay Reconciliation.*

1. **Sign in as Supply Chain Manager** (`manager@disruptioniq.local`).
2. Click **Scenario B (Quality + Doc + Outage)** in the top action bar:
   - An IoT temperature sensor reports 37°C for 25 minutes on `lot-east` (violating the controller threshold of >30°C for >=15 min).
   - `lot-east` is automatically placed under **quality quarantine**, immediately removing its stock from availability calculations.
   - A freight manifest (`synthetic-atlas-manifest.txt`) is ingested with a quantity discrepancy (127 claimed vs. 120 in trusted PO).
   - A malformed event (negative stock count) and an unmapped sensor reference are submitted, testing data observability.
   - External integration outage is enabled (`integrationOutage = true`), putting inbound signals into a durable queue.
3. Navigate to **Inventory & Transport**:
   - Observe the **Quality & Condition Monitoring** card highlighting the 37°C temperature excursion.
   - Review the lot status table: `lot-east` is marked `quarantined`.
4. Log out and sign in as **Warehouse Operator** (`warehouse@disruptioniq.local`):
   - Navigate to **Data & Evidence**:
   - Locate the freight document claim card. The system highlights: *"Quantity mismatch: document 127, shipment 120; raw claim does not override trusted stock."*
   - Click **Confirm reviewed claim**. Kabir Rao acknowledges the discrepancy, updating the document status to `confirmed` without corrupting trusted inventory.
5. Log back in as **Supply Chain Manager** (`manager@disruptioniq.local`):
   - Navigate to **Data & Evidence**:
   - The **Integration Continuity** banner displays active outage status.
   - Click **Capture event** to simulate an inbound carrier update during offline mode. The event is durably queued.
   - Click **Restore integration** to re-establish connectivity.
   - Click **Replay queue**:
     - All queued events are replayed with their original effective timestamps.
     - Stale and duplicate checks ensure delayed events cannot overwrite newer trusted state.

---

## Challenge & Research Opportunity Coverage

### Mandatory Requirements (B1–B9)

| ID | Problem Statement Requirement | Implementation & Verification Evidence | Source File(s) | Test Citation |
|---|---|---|---|---|
| **B1** | Data import (CSV/JSON) & carrier webhook | Streaming parser supporting CSV & JSON imports for all entities with row-level error reporting. Authenticated carrier webhook endpoint with secret verification. | `src/server/imports.ts`<br>`src/server/app.ts` | `tests/api.test.ts` (lines 28, 94-97) |
| **B2** | Linked relational data model | Full multi-tier graph linking Suppliers &rarr; Shipments &rarr; Warehouses &rarr; Lots &rarr; Orders &rarr; Line Items with foreign key constraints. | `src/server/schema.ts`<br>`src/server/repository.ts` | `tests/repository.test.ts` (lines 8-25) |
| **B3** | Disruption detection & impact analysis | Real-time detection of late shipments, supplier delays, and stock shortages. Graph traversal identifies all affected downstream orders. | `src/domain/events.ts`<br>`src/domain/impact.ts` | `tests/domain.test.ts` (lines 11-13) |
| **B4** | Risk ranking with explainable factors | Priority scoring combining uncovered shortage, customer SLA (critical/high), deadline proximity, financial penalties, and outage status. | `src/domain/impact.ts` | `tests/domain.test.ts` (lines 12-13) |
| **B5** | AI-assisted recovery options | Generation of all 4 recovery options: Reallocate, Expedite, Alternative Supplier, Split Order. Evaluated against real constraints with AI summaries. | `src/domain/plans.ts`<br>`src/server/ai.ts` | `tests/domain.test.ts` (lines 14-21) |
| **B6** | Approve / reject / modify workflow | Multi-step lifecycle: Propose &rarr; Modify (version bumped) &rarr; Reject / Approve. Operational execution occurs **only after explicit confirmation**. | `src/domain/plans.ts`<br>`src/client/components/forms.tsx` | `tests/domain.test.ts` (lines 15-17)<br>`tests/e2e/workflow.spec.ts` |
| **B7** | Notifications & full audit trail | In-app real-time notification queue and immutable Decision ledger capturing every state mutation with JSON before/after snapshots. | `src/domain/common.ts`<br>`src/server/repository.ts` | `tests/api.test.ts` (lines 40-42) |
| **B8** | Comprehensive operational dashboard | Unified operational dashboard presenting Active Disruptions, Affected Orders, Pending Approvals, and Recovery Progress. | `src/client/components/operations.tsx`<br>`src/client/App.tsx` | `tests/e2e/workflow.spec.ts` (lines 55-144) |
| **B9** | Backend-enforced RBAC & separation of duties | Server-side role authorization across 5 roles + partner. Hard block preventing creators/modifiers/admins from approving their own plans. | `src/server/app.ts`<br>`src/domain/plans.ts` | `tests/api.test.ts` (lines 26-27, 37-39)<br>`tests/domain.test.ts` (lines 19-20) |

---

### Mandatory Constraints (C1–C5)

| ID | Mandatory Constraint | Implementation & Verification Evidence | Source File(s) | Test Citation |
|---|---|---|---|---|
| **C1** | Persistent database required | PostgreSQL 17 + Drizzle ORM (with embedded PGlite for local testing). All entities, states, sessions, and audits persist across server restarts. | `src/server/repository.ts`<br>`src/server/schema.ts` | `tests/repository.test.ts` (lines 8-25) |
| **C2** | Reproducible synthetic data | Fictional high-reliability electronics supply chain dataset with defined component BOMs, lead times, and failure scenarios. | `src/domain/seed.ts` | `tests/domain.test.ts` (lines 1-24) |
| **C3** | Demonstrate at least two scenarios | Scenario A (compound delay + outage) and Scenario B (condition excursion + document mismatch + offline queue replay). | `src/domain/engine.ts` | `tests/e2e/workflow.spec.ts` (Scenarios A & B) |
| **C4** | Deterministic logic for critical paths | Hard rule: Inventory balances, deadlines, costs, and permissions are 100% deterministic code. AI is strictly bounded to summaries. | `src/domain/plans.ts`<br>`src/domain/events.ts` | `tests/domain.test.ts` (lines 14-21) |
| **C5** | Safe handling of invalid/conflicting data | Semantic validation rejects invalid quantities and impossible state transitions; conflicting stock claims mark lots `disputed` without state corruption. | `src/domain/events.ts` | `tests/domain.test.ts` (lines 1-10) |

---

### 12 Selected Research Opportunities

| # | Research Opportunity | Capability Implemented | Technical Evidence & UI Location |
|---|---|---|---|
| **1** | **Data Reconciliation & Trust** | Raw source claims preserved; payload canonicalization prevents duplicate event processing; same-time physical contradictions freeze stock into `disputed` status. | `src/domain/events.ts: ingestEvent()`<br>**UI**: *Data & Evidence &rarr; Raw Event Log* |
| **2** | **ETA Confidence & Volatility** | Revision history tracking across all carriers; spread calculation flags volatile forecasts; prevents stale updates from overwriting newer accepted ETAs. | `src/domain/impact.ts: getImpact()`<br>**UI**: *Inventory & Transport &rarr; Shipment History* |
| **3** | **Constraint-Validated Recovery** | Deterministic validation checks warehouse capacity, hard reservations, uncommitted transit stock, supplier eligibility, and customer deadlines. | `src/domain/plans.ts: constraints()`<br>**UI**: *Incidents & Recovery &rarr; Recovery Plans* |
| **4** | **Multi-Tier Dependencies** | Directed graph traversal maps upstream Tier-2 silicon dependencies down to Tier-1 assemblies; distinguishes verified links from partner declarations. | `src/domain/common.ts: upstreamPaths()`<br>**UI**: *Supply Network &rarr; Multi-Tier Hierarchy* |
| **6** | **Freight Document Automation** | Regex and text extraction of consignment IDs, quantities, and dates from manifests/bills of lading; flags discrepancies against trusted ERP records. | `src/domain/engine.ts: inspectDocument()`<br>**UI**: *Data & Evidence &rarr; Freight Documents* |
| **7** | **Cross-Company Collaboration** | Multi-organization tenancy model; partner suppliers access scoped portal with assigned action tasks; all internal stock and customer orders redacted. | `src/server/app.ts: redact()`<br>**UI**: *Collaboration & Tasks (Partner View)* |
| **8** | **Alert Prioritization & Noise Reduction** | Correlates related signals for the same entity into single incident objects; ranks customer order impact by shortage, SLA, and financial penalty. | `src/domain/common.ts: incident()`<br>**UI**: *Operations Overview &rarr; Orders at Risk* |
| **9** | **Compound Disruptions** | Joint impact evaluation for simultaneous supplier delays and facility outages; prevents double counting of shared stock and orders. | `src/domain/impact.ts: getImpact()`<br>**UI**: *Incidents & Recovery &rarr; Compound Exposure* |
| **11** | **Data Observability** | Semantic invariant validator catches negative stock, impossible transitions (delivered &rarr; transit), and broken foreign keys before state mutation. | `src/domain/events.ts: validation()`<br>**UI**: *Data & Evidence &rarr; Invariant Alerts* |
| **12** | **Continuity & Outage Fallback** | Durable in-flight queue during external system outages; replay reconciliation with original effective timestamps and stale-check protection. | `src/domain/events.ts: replayQueue()`<br>**UI**: *Data & Evidence &rarr; Integration Outage* |
| **13** | **Decision Traceability** | Reconstructable audit ledger recording every decision actor, timestamp, rule version, linked evidence IDs, and complete JSON before/after state diffs. | `src/domain/common.ts: audit()`<br>**UI**: *Decision History &rarr; Audit Ledger* |
| **15** | **Quality & Condition Monitoring** | Telemetry ingestion evaluating temperature excursions against product limits (>30°C for >=15 min); automatic lot quarantine and authorized disposition. | `src/domain/events.ts`<br>**UI**: *Inventory & Transport &rarr; Quality Monitoring* |

---

## System Boundaries & Intentional Limitations

To maintain uncompromising enterprise reliability and security, DisruptionIQ observes the following deliberate design boundaries:

1. **Scanned PDF OCR**: In-memory text extraction uses deterministic string normalization and PDF.js text layer parsing. Scanned images or bitmaps without text layers are explicitly flagged as `review` (0% extraction confidence) rather than guessed using probabilistic OCR models, preventing hallucinated inventory counts from entering trusted databases.
2. **AI Provider Independence**: The AI situational briefing module is powered by standard OpenAI-compatible endpoints (`/v1/chat/completions`). If no API key is provided (`AI_API_KEY=""`), the system gracefully marks AI briefings as unavailable while 100% of deterministic disruption detection, ranking, constraint validation, and plan execution remains fully operational.
3. **Simulated External Execution**: DisruptionIQ models the internal operating system of a distributor or OEM. Plan approvals simulate downstream ERP order updates and carrier bookings within the relational database, recording full audit diffs without placing unconfirmed financial orders with external live freight APIs.

---

## Testing & Verification

DisruptionIQ incorporates a multi-layer verification suite covering domain logic, HTTP APIs, database persistence, and full browser interactions.

### Run All Test Suites

```bash
# 1. Typecheck the entire TypeScript codebase
bun run typecheck

# 2. Compile the production client bundle
bun run build

# 3. Run all 36 unit, domain, API, and repository tests
bun test

# 4. Run all 5 end-to-end browser workflows in Playwright
bun run test:e2e
```

### Test Suite Summary

- **Typecheck**: `0` errors across entire server, client, domain, and test suites.
- **Vite Production Build**: `1,724` modules transformed cleanly into optimized production assets.
- **Unit & Domain Tests (`bun test`)**: `36` passed, `0` failed, `151` assertions in ~1.9s.
  - Source reconciliation & idempotency (10 tests)
  - Impact ranking & multi-tier propagation (3 tests)
  - Deterministic recovery & separation of duties (8 tests)
  - Freight document review & partner scoping (3 tests)
  - Authenticated REST API & RBAC permissions (8 tests)
  - PostgreSQL transaction concurrency & relational projections (4 tests)
- **End-to-End Playwright Tests (`bun run test:e2e`)**: `5` passed, `0` failed in ~9.8s.
  - `a. Authentication and Demo Login`: Login screen verification, role pill switching, session chip display.
  - `b. Scenario A Workflow`: Shared delay, warehouse outage, 4 recovery options, proposal modification, separation of duties enforcement, manager approval, and simulated execution.
  - `c. Scenario B Workflow`: IoT temperature excursion, lot quarantine, freight document mismatch confirmation, offline event queueing, and replay reconciliation.
  - `d. Partner Scoping`: Multi-tenant data isolation, verified redaction of internal orders/lots/audits for external partner users.
  - `e. Demo Reset`: Full workspace reset to baseline seed state with audit log preservation.

---

## License & Attribution

Developed for the Overclock '26 Hackathon under **Problem Statement 1 (DisruptionIQ)**. Built with Bun, React, and PostgreSQL.
