# DisruptionIQ: Operations & Systems Reference

This document serves as the authoritative, forensic technical reference manual for all domain operations, data ingestion logic, risk scoring algorithms, recovery authorizations, and data validation rules in **DisruptionIQ**.

---

## Table of Contents
1. [Data Sources & Acquisition Catalog](#1-data-sources--acquisition-catalog)
2. [Security, Session & Identity Operations](#2-security-session--identity-operations)
3. [Repository, Transaction & Database Operations](#3-repository-transaction--database-operations)
4. [Signal Ingestion & Event Operations](#4-signal-ingestion--event-operations)
5. [Impact Assessment & Risk Scoring Operations](#5-impact-assessment--risk-scoring-operations)
6. [Recovery Planning & Authorization Operations](#6-recovery-planning--authorization-operations)
7. [Document Processing & Claim Review Operations](#7-document-processing--claim-review-operations)
8. [Data Import Operations](#8-data-import-operations)
9. [Incident, Lot & Task Operations](#9-incident-lot--task-operations)
10. [AI Decision Support Operations](#10-ai-decision-support-operations)
11. [Workspace Clearing & Governance Operations](#11-workspace-clearing--governance-operations)

---

## 1. Data Sources & Acquisition Catalog

DisruptionIQ ingests data from multiple enterprise supply-chain streams:

| Stream Name | Mechanism | Transport & Payload | Role / Boundary | Ingestion Frequency |
| :--- | :--- | :--- | :--- | :--- |
| **Carrier Tracking EDI/API** | Webhook or Event Intake | HTTP POST JSON (ETA, Status) | Focal Analyst / Secret | Event-driven / Streaming |
| **Warehouse WMS Intake** | Direct Event Intake | HTTP POST JSON (Stock Counts, Outages) | Focal Warehouse / Admin | Real-time cycle count |
| **Supplier EDI Portal** | Direct Event Intake | HTTP POST JSON (Disruptions, Lead Times) | Focal Analyst / Manager | Batch / Real-time alerts |
| **Freight Documents & Bills** | Async Pipeline | PDF, TXT, CSV, JSON ($\le 25\text{ MB}$, $\le 100$ pages) | Focal Operations | On-demand upload |
| **Enterprise Master Catalog** | Bulk Importer | CSV or JSON Arrays ($\le 2\text{ MB}$, $\le 2000$ rows) | Focal Operations | Initial / Periodic batch |

---

## 2. Security, Session & Identity Operations

### 2.1 Demo Personas & Identity Directory
- **`analyst@disruptioniq.demo`** (Alex Rivera): Operations Analyst (`focal`). Correlates signals, assesses order risk & generates recovery options.
- **`manager@disruptioniq.demo`** (Priya Sharma): Supply Chain Manager (`focal`). Authorizes recovery plans, manages outages & assigns collaborative tasks.
- **`warehouse@disruptioniq.demo`** (Kabir Rao): Warehouse Supervisor (`focal`). Inspects lot quality, manages holds & updates receiving.
- **`procurement@disruptioniq.demo`** (Ananya Iyer): Procurement Approver (`focal`). Authorizes alternative supplier options & reviews freight documents.
- **`admin@disruptioniq.demo`** (Dev Admin): Administrator (`focal`). Full workspace administration, security, emergency break-glass, & workspace clearing controls.
- **`partner@disruptioniq.demo`** (Maya Chen): Partner Viewer (`partner`). Scoped external portal with shared incident and assigned task visibility.

### 2.2 Password Hashing & Verification
- **Scrypt Password Hashes**: Standard scrypt hashing via Node `crypto.scryptSync`.
- **Timing-Safe Equality**: Hash digests are compared using `crypto.timingSafeEqual` to eliminate timing attacks.

---

## 3. Repository, Transaction & Database Operations

### 3.1 Concurrency & Mutex Execution
- **In-Process Promise Queue**: Serializes write operations within a node instance.
- **PostgreSQL Row Locks**: State mutations acquire a row-level lock via `SELECT ... FROM workspaces WHERE id = 'focal' FOR UPDATE`.
- **Normalized Projections**: Each state mutation synchronizes relational tables:
  `suppliers`, `warehouses`, `inventory_lots`, `shipments`, `customer_orders`, `order_lines`, `integration_connections`, `integration_inbox`, `document_records`, `document_files`, `document_jobs`, and `document_chunks`.

---

## 4. Signal Ingestion & Event Operations

### 4.1 Supported Event Types
1. `supplier_delay`: Ingests delay hours on a supplier. Traverses downstream paths to delayed shipments and updates baseline arrival dates.
2. `shipment_eta`: Ingests revised shipment estimated arrival times. Records revision history in `etaHistory`.
3. `stock_count`: Ingests physical on-hand counts or lifecycle claims (`on_hand`, `dispatched`, `collected`, `received`).
4. `warehouse_outage`: Toggles warehouse status between `online` and `outage`.
5. `shipment_status`: Tracks delivery lifecycle states (`scheduled`, `in_transit`, `delayed`, `delivered`).

### 4.2 Selective Circuit Breaking & Targeted Replay
- Events targeting offline integrations are queued into `state.queue`.
- Events targeting online integrations process immediately.
- `replayQueue(state, actor, { integrationId, preview })`:
  - `preview: true`: Runs a non-mutating simulation on an isolated clone, predicting accepted, duplicate, stale, and invalid counts.
  - Targeted Replay: Reconciles queued events strictly for the selected integration connection.

---

## 5. Impact Assessment & Risk Scoring Operations

### 5.1 Bounded 0.0–10.0 Scoring Formula
The interaction-aware impact engine (`getImpact`) evaluates unfulfilled orders chronologically:
$$\text{Score} = \text{clamp}(0.0, 10.0, S_{\text{uncovered}} + S_{\text{deadline}} + S_{\text{recovery}} + S_{\text{cascade}} + S_{\text{penalty}})$$

1. **Uncovered Demand Factor**: $3.0 \times \text{exposureRatio}$
2. **Priority & Deadline Factor**: $2.0 \times \text{exposureRatio} \times \text{deadlineMultiplier}$
3. **Recovery Feasibility Factor**: $0.0$ (internal transfer feasible), $0.5$ (expedite feasible), $1.5$ (supplier feasible), $2.0 \times \text{exposureRatio}$ (none feasible).
4. **Cascading Disruption Factor**: $\min(1.5, 0.5 \times \text{dependentOrders} + 0.5 \times \text{unverifiedTier2})$.
5. **Business Consequence Factor**: $\min(1.5, \text{round}(\text{penaltyCents} / 500,000, 1))$.

### 5.2 Bottleneck Drivers & Independent Confidence
- **Top 2 Bottleneck Drivers**: At most 2 factors crossing operational thresholds are highlighted for immediate triage.
- **Evidence Confidence**: Independent rating of `high`, `medium` (stale/volatile ETA history), or `low` (missing ETA history). Missing evidence lowers confidence without artificially inflating risk scores.

---

## 6. Recovery Planning & Authorization Operations

### 6.1 Recovery Option Framework (`generatePlans`)
Synthesizes candidate options across all four categories:
1. `reallocate`: Cross-warehouse lot inventory transfer.
2. `split_order`: Immediate partial delivery leg.
3. `expedite`: Express transit on in-transit shipments.
4. `alternative_supplier`: Alternative sourcing from approved Tier 1 suppliers.

### 6.2 Risk Classification (`classifyPlanRisk`)
Plans are classified as `high` risk if any of the following apply:
- Strategy is `alternative_supplier`.
- Impact score $\ge 7.0$.
- Evidence confidence is `low`.
- Total cost $\ge \$2,000$ ($200,000$ cents) or penalty exposure $\ge \$5,000$.
- Resource consumption $\ge 50\%$ of usable source lot, shipment, or supplier capacity.
Otherwise, the plan is classified as `routine`.

### 6.3 Risk-Tiered Human Authorization
- **Routine Plans**: Executed in a single approval. Self-approval is permitted for authorized managers, procurement approvers, and administrators.
- **High-Risk Plans (Two-Person Rule)**:
  - First approval advances status to `'awaiting_second_approval'` and mutates **zero** operational resources.
  - Second approval by a distinct, independent actor revalidates constraints live and commits execution atomically.
  - Proposers and modifiers are strictly barred from approving.
- **Emergency Break-Glass Execution**:
  - Administrator may bypass dual approval in emergencies with explicit confirmation and non-trivial justification ($\ge 20$ characters).
  - Sets `reviewStatus: 'required'`, notifies stakeholders, and appends an auditable governance record.

---

## 7. Document Processing & Claim Review Operations

### 7.1 Large Asynchronous Pipeline
- Route-specific 25 MB body limit on `/api/documents`.
- Upload returns `202 Accepted` with `{ id, jobId, status: 'processing' }`.
- Original file bytes stored in Postgres `bytea` (`document_files`).
- Background worker extracts pages via PDF.js (enforcing $\le 100$ pages) and chunks text into 4,000-character page-aware chunks with 400-character overlap (`document_chunks`).
- Excerpt (first 500 characters) stored in workspace state; full text is never serialized into dashboard payloads.
- Cursor-paginated chunk retrieval via `GET /api/documents/:id/chunks`.
- Confirmation via `POST /api/documents/:id/confirm`.

---

## 8. Data Import Operations

### 8.1 Batch CSV / JSON Data Import (`POST /api/import`)
- Supports `suppliers`, `warehouses`, `lots`, `shipments`, `orders`, and `events`.
- Strict Zod schema validation per entity (up to 2,000 rows).
- Rejects row collisions and referential integrity failures while accepting valid rows.
- Header templates provided in the user interface for effortless judge data loading.

---

## 9. Incident, Lot & Task Operations

### 9.1 Lot Disposition (`POST /api/lots/:id/disposition`)
- Statuses: `'available'`, `'held'`, `'disputed'`.
- Only authorized warehouse supervisors or administrators can change disposition.
- Reconciling disputed inventory requires administrator authorization and a newer accepted physical count.

### 9.2 Collaboration Tasks (`POST /api/tasks/:id`)
- Tasks are scoped to participating organizations.
- Partner viewers have read-only visibility.

---

## 10. AI Decision Support Operations

### 10.1 AI Boundary
- Default: `AI_FEATURES_ENABLED=false`.
- The AI panel is hidden and `/api/ai/:id` returns 404 when disabled.
- In Phase 1, AI does not calculate impact scores, authorize plans, or mutate operational state.

---

## 11. Workspace Clearing & Governance Operations

### 11.1 Clear Operational Workspace (`POST /api/reset`)
- Administrator action in demo mode.
- Resets operational collections (suppliers, warehouses, lots, shipments, orders, incidents, events, recovery plans, and documents) to empty via `createEmptyState()`.
- Preserves complete decision audit trail and appends an auditable `demo_reset` decision record.
