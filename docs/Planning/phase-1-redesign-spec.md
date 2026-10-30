# DisruptionIQ Phase 1 Redesign Specification

> Status: Approved implementation specification  
> Date: 31 October 2026  
> Scope: Judge-ready application refinement before AI-agent or decision-model integration

## Primary outcome

DisruptionIQ starts as an empty, professional supply-chain control room that accepts judge-supplied data, calculates an explainable operational-priority score, survives differentiated integration outages, processes larger freight documents safely, and applies risk-tiered human authorization without turning routine work into an approval bottleneck.

Phase 1 remains a **hybrid decision-control system**: exposure accounting, feasibility checks, authorization, and execution are deterministic. AI-based prioritization, AI recovery planning, JEV, and CLEF are deferred.

## Source priority

When implementation sources disagree, use this order:

1. This specification and the user's decisions recorded here.
2. `docs/Planning/selected-feature-scope.md` and the supplied problem statement for mandatory challenge constraints.
3. The current implementation and `docs/artifacts/` for existing behavior that must be migrated.
4. `C:\Users\LENOVO\Downloads\disruptioniq_enhancement_and_scm_plan.md` as non-authoritative reference material only.

The external reference contributes useful concepts but its code snippets and unsupported claims must not be copied blindly.

## 1. Impact assessment

### Output contract

`Impact.score` becomes a one-decimal number from `0.0` to `10.0`.

Risk bands:

- `low`: `0.0-3.9`
- `moderate`: `4.0-6.9`
- `high`: `7.0-8.9`
- `critical`: `9.0-10.0`

Add:

- `band`
- `drivers`, containing at most two displayed threshold-crossing drivers
- `factorScores`, containing the complete auditable component breakdown
- `confidence: 'high' | 'medium' | 'low'`
- `confidenceReasons`

### Deterministic formula

Let:

```text
exposureRatio = shortage / max(1, remainingOrderQuantity)
```

All severity components are gated by actual exposure. If `shortage === 0`, shortage-dependent severity is zero even when a delay, priority label, or penalty exists.

1. **Uncovered demand — 0.0 to 3.0**
   - `3.0 * exposureRatio`
2. **Deadline pressure — 0.0 to 2.0**
   - Multiply `2.0 * exposureRatio` by:
     - `1.00` when overdue or `<=12h`
     - `0.75` when `<=24h`
     - `0.40` when `<=72h`
     - `0.20` when `<=168h`
     - `0.05` otherwise
3. **Recovery feasibility — 0.0 to 2.0**
   - Multiply the following tier by `exposureRatio`:
     - `0.0`: at least two feasible, on-time recovery candidates
     - `0.5`: exactly one feasible, on-time candidate
     - `1.5`: candidates exist, but none can arrive on time
     - `2.0`: no candidate passes deterministic resource constraints
4. **Cascading exposure — 0.0 to 1.5**
   - `min(1.5, 0.5 * linkedActiveIncidentCount) * exposureRatio`
   - A verified shared upstream dependency affecting multiple downstream paths counts as at least two linked disruption vectors.
5. **Business consequence — 0.0 to 1.5**
   - Priority base: critical `0.9`, high `0.6`, normal `0.2`
   - Penalty component: `0.6 * min(1, penaltyCents / HIGH_RISK_PENALTY_CENTS)`
   - Clamp to `1.5`, then multiply by `exposureRatio`.

The final score is the one-decimal, `0.0-10.0` clamp of the component sum.

### Drivers and confidence

Candidate drivers include uncovered demand, deadline pressure, lack of feasible recovery, cascading disruption, warehouse unavailability, and business consequence. Rank triggered drivers by factor contribution, then operational urgency, and expose at most two.

Missing or stale evidence does **not** add risk points. It changes confidence:

- `high`: required references exist, relevant integrations are online, and ETA/inventory evidence is current.
- `medium`: one non-critical source is stale or incomplete.
- `low`: a required integration is offline, poison/dead-letter messages exist, supplier/warehouse linkage is missing, or unresolved contradictory evidence affects the order.

## 2. Recovery planning seam

Rename the product concept from “Four Deterministic Recovery Strategies” to **Recovery Option Framework**.

Introduce a `RecoveryPlanner` interface and a default `DeterministicTemplatePlanner`. Candidate enumeration and constraint evaluation must be pure and non-persisting so impact scoring can evaluate recoverability without creating plans or audit entries.

The existing four action templates remain the Phase 1 fallback:

- reallocate inventory
- split order
- expedite shipment
- alternative supplier

Future agent implementations may propose ranked multi-step plans, but every proposal must use the same deterministic constraint validator and authorization workflow.

## 3. Authorization and execution

Authorization risk is separate from disruption severity. A plan is `high` risk when any condition is true:

- linked impact score is `>=7.0`
- plan type changes to an alternative supplier
- incremental cost is `>= HIGH_RISK_COST_CENTS`
- linked order penalty is `>= HIGH_RISK_PENALTY_CENTS`
- execution consumes at least 50% of the source's currently usable stock/capacity
- evidence confidence is `low`

Fictional demo defaults:

```text
HIGH_RISK_COST_CENTS=200000
HIGH_RISK_PENALTY_CENTS=500000
```

Both remain environment-configurable and must be described as demonstration policy, not universal industry thresholds.

### Routine actions

- An authorized manager, procurement approver, or administrator may approve and execute alone.
- Self-approval is allowed for routine actions.
- Existing explicit confirmation and live constraint revalidation remain mandatory.

### High-risk actions

- Require two distinct approval records from authorized actors.
- The plan creator and last modifier cannot count as either independent approver.
- The first approval changes the plan to `awaiting_second_approval` and performs no operational mutation.
- The second distinct approval re-runs constraints and executes atomically.
- Any modification clears prior approvals and increments the plan version.

### Break-glass

Only an administrator may bypass the second approval. The request must include:

- `breakGlass: true`
- explicit confirmation
- a non-trivial reason of at least 20 characters

Execution records the reason, actor, plan version, timestamp, pre-execution evidence, and `reviewStatus: 'required'`; it also creates a notification for retrospective review. Break-glass is never the default admin path.

## 4. Cold-chain removal and generic holds

Remove:

- `condition_reading`
- `Reading` and `State.readings`
- temperature thresholds and automatic quarantine
- `condition_excursion`
- sensor forms, metrics, panels, scenarios, tests, documentation, and diagrams

Retain generic inventory quality control by changing lot status:

```text
'available' | 'held' | 'disputed'
```

Manual hold/release remains available to the warehouse manager and administrator. Persisted `quarantined` values migrate to `held`.

## 5. Continuity and reconciliation

Replace the global outage boolean with per-integration health:

```text
'online' | 'degraded' | 'offline' | 'recovering'
```

Initial integration kinds are carrier API, warehouse WMS, supplier EDI, document processor, and AI service. A connection record contains status, reason, transition time, last success, failure count, and circuit-open time.

Move queued payloads out of workspace JSON into a dedicated Postgres inbox. Each row contains workspace, integration, source event ID, schema version, source sequence, correlation ID, payload, event time, received time, status, attempt count, next attempt, last error, and replay lineage.

Processing defaults:

- five attempts
- exponential retry beginning at five seconds, capped at five minutes, with jitter
- circuit opens after three consecutive connection failures for 60 seconds
- exhausted or invalid poison messages enter `dead_letter`
- replay supports preview and targeted execution by integration

Idempotency, canonical payload comparison, effective-time ordering, contradiction handling, and stale-fact protection remain authoritative.

A primary-database outage places the application in explicit read-only mode. Phase 1 must not claim durable write capture when the same database used for the inbox is unavailable.

## 6. Document processing

Defaults:

```text
DOCUMENT_MAX_BYTES=26214400
DOCUMENT_MAX_PAGES=100
DOCUMENT_CHUNK_CHARS=4000
DOCUMENT_CHUNK_OVERLAP_CHARS=400
```

Apply the larger body limit only to document upload routes. Imports and ordinary JSON endpoints retain their current smaller limits.

Uploads return `202` with processing metadata. Store metadata, original bytes, processing jobs, and extracted chunks outside workspace JSON. The default `DocumentStorage` adapter uses a dedicated Postgres `bytea` table; the interface permits later object-storage replacement.

Workers claim jobs with short transactions, extract outside the transaction, then batch-insert page-aware chunks. Dashboard responses contain metadata and a short excerpt, never full document text.

Add paginated metadata/chunk retrieval. Upload capacity is independent of future AI context: Phase 1 does not inject a complete document into a model prompt.

## 7. Empty baseline and personas

`createEmptyState()` initializes an operationally empty workspace. Production/demo runtime includes no baked suppliers, warehouses, lots, shipments, orders, incidents, events, plans, documents, or scenarios.

Remove Scenario A/B endpoints and UI actions. “Clear workspace” returns operational state to empty while retaining its audit record.

Automated tests may use fixture builders under `tests/fixtures/`; they must not be imported by production code or exposed through a “Load Demo Dataset” endpoint/button. Judges populate the workspace through ordinary CSV/JSON imports and event/document intake.

Retain six switchable personas:

- administrator
- operations manager
- warehouse manager
- procurement approver
- operations analyst
- partner viewer

Add `viewer` to the role model and database constraint. The partner viewer remains restricted to scoped shared incidents and assigned collaboration information.

## 8. AI boundary

Add `AI_FEATURES_ENABLED=false` as the default. The current AI summary endpoint and types may remain as a future seam, but the UI is hidden and the endpoint refuses requests when the feature is disabled.

Phase 1 does not allow AI to:

- calculate or adjust impact scores
- generate executable commitments
- approve or execute plans
- mutate operational state
- invent probabilities for JEV
- claim causal identification for CLEF

## 9. Persistence migration

Add an explicit `normalizeState()` path for existing workspace JSON:

- supply defaults for new fields
- map `quarantined` to `held`
- remove `readings`
- remove active cold-chain events/incidents/plans while retaining historical audit decisions
- translate the global outage flag into integration health where possible
- invalidate approvals when plan contracts or versions no longer match

Database migrations must be idempotent, index foreign keys, and use partial indexes for pending inbox/jobs. Large content and queues must not be added back into the authoritative workspace JSON.

## 10. Reference plan disposition

Adopt from the external reference:

- Phase 1/Phase 2 separation
- 0-10 score and two displayed drivers
- differentiated outage domains
- empty baseline with personas
- recovery-planner/constraint boundary
- risk and authorization UI badges

Reject or replace:

- unrestricted admin bypass
- its one-checker “two-person” code
- global 32 MB body middleware
- boolean outage modes stored in state JSON
- production demo-data feed endpoint
- claims that old workspace JSON needs no migration
- uncited numerical/platform claims
- immediate JEV/CLEF implementation

## Research references

- [NIST SP 800-53 Rev. 5 — AC-5 and CM-5(4)](https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final)
- [NIST AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework)
- [Microsoft Queue-Based Load Leveling](https://learn.microsoft.com/en-us/azure/architecture/patterns/queue-based-load-leveling)
- [Microsoft Circuit Breaker](https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker)
- [GS1 EPCIS](https://www.gs1.org/standards/epcis)
- [Microsoft guidance for chunking large documents](https://learn.microsoft.com/en-us/azure/search/vector-search-how-to-chunk-documents)

## Explicitly deferred

- AI impact judgment
- AI recovery-plan generation
- provider selection
- JEV probability modeling
- CLEF structural causal modeling
- live ERP/carrier execution
- independent message broker or object-storage deployment
