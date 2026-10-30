# DisruptionIQ: Data Flows, Execution Pipelines & Architecture Models

This document models the end-to-end data flows, lifecycle state machines, execution pipelines, and mathematical validation criteria of **DisruptionIQ**.

---

## 1. End-to-End System Data Flow Architecture

The following diagram illustrates how raw source data enters the platform from multiple origins, passes through validation, concurrency locks, and domain engines, and synchronizes to persistent PostgreSQL storage and client views.

```mermaid
flowchart TD
    classDef source fill:#f2f4f8,stroke:#3b5998,stroke-width:2px;
    classDef engine fill:#e8f4f0,stroke:#238b72,stroke-width:2px;
    classDef storage fill:#fff7e6,stroke:#d97706,stroke-width:2px;
    classDef client fill:#fdf2f8,stroke:#db2777,stroke-width:2px;

    subgraph DataSources["External & Inbound Sources"]
        S1["Carrier Webhook (POST /api/webhooks/carrier)"]:::source
        S2["Operator Manual Event Form (POST /api/events)"]:::source
        S3["CSV / JSON Bulk Importer (POST /api/import)"]:::source
        S4["Freight Document Intake (POST /api/documents up to 25 MB)"]:::source
        S5["Integration Continuity Inbox (Targeted Replay)"]:::source
    end

    subgraph TransportAuth["Transport & Ingress Layer"]
        T1["Route Body Limits (25MB docs / 8MB general / 2MB imports)"]
        T2["Session Token Cookie (diq_session) Validation"]
        T3["Role & Org RBAC Check (6 Switchable Personas)"]
        T4["CSRF / Origin Header Guard"]
    end

    subgraph ProcessingPipeline["Authoritative State Mutation Pipeline"]
        direction TB
        L1["Repository Mutex Lock (In-Process Queue)"]
        L2["PostgreSQL SELECT ... FOR UPDATE (Row Lock)"]
        
        subgraph DomainEngines["Domain Logic & State Engines"]
            E1["Validation & Deduplication Engine (canonical sorting)"]:::engine
            E2["Per-Integration Continuity Inboxes (carrier/warehouse/supplier)"]:::engine
            E3["Stale & Contradiction Checker (Dispute Logic)"]:::engine
            E4["Dependency Traversal (upstreamPaths)"]:::engine
            E5["Interaction-Aware Impact Engine (0.0-10.0 Scoring)"]:::engine
            E6["Recovery Option Framework (Pure Candidate Enumeration)"]:::engine
            E7["Risk-Tiered Authorization & Break-Glass Engine (decidePlan)"]:::engine
        end

        L3["Audit Log Appender (Immutable Decisions)"]
        L4["Version Increment (state.version += 1)"]
    end

    subgraph StorageLayer["Dual-Mode PostgreSQL Storage Engine"]
        DB1[("workspaces table (Authoritative JSONB State)")]:::storage
        DB2[("Relational Projections (Drizzle ORM)
        - suppliers, warehouses, inventory_lots
        - shipments, customer_orders, order_lines
        - integration_connections & integration_inbox
        - document_records, document_files, document_chunks")]:::storage
        DB3[("app_sessions (SHA-256 Hashes)")]:::storage
    end

    subgraph EgressClients["Clients & Sinks"]
        C1["Focal Control Room UI (Full State & Exposure)"]:::client
        C2["Partner Supplier Portal (Redacted Scoped View)"]:::client
        C3["AI Decision Support Boundary (Disabled by default in Phase 1)"]:::client
    end

    DataSources --> TransportAuth
    TransportAuth --> L1
    L1 --> L2
    L2 --> DomainEngines
    DomainEngines --> L3
    L3 --> L4
    L4 --> DB1
    L4 --> DB2
    T2 <--> DB3
    
    DB1 -->|Read & Filter| C1
    DB1 -->|"redact() Filter"| C2
    E5 & E6 -->|Prompt Context with SHA-256 Hash| C3
```

---

## 2. Inbound Signal Reconciliation & Ingestion Pipeline

Every raw event passing through `ingestEvent()` undergoes an exact multi-stage decision tree before touching operational records.

```mermaid
flowchart TD
    Start(["Inbound EventInput"]) --> V1{"Schema & Entity Valid?
    - Known Entity ID?
    - Valid Timestamp?
    - Physical Quantity >= 0?
    - Valid Status Transition?"}

    V1 -- No --> S_Invalid["Status = 'invalid'
    (Record raw claim, do not apply)"]
    
    V1 -- Yes --> V2{"Idempotency Key Matches Prior Event?"}
    
    V2 -- Yes --> V3{"Payload Matches Prior?
    (canonical JSON compare)"}
    V3 -- Yes --> S_Dup["Status = 'duplicate'
    (Ignore idempotently)"]
    V3 -- No --> S_ConfKey["Status = 'conflict'
    (Idempotency key reused with new data)"]

    V2 -- No --> V4{"Specific Integration Connection Offline?
    (carrier / warehouse / supplier)"}
    V4 -- Yes --> S_Queued["Status = 'queued'
    (Buffer in integration inbox for targeted replay)"]

    V4 -- No --> V5{"Effective Time < Latest Accepted Time?"}
    V5 -- Yes --> S_Stale["Status = 'stale'
    (Retain evidence, preserve newer truth)"]

    V5 -- No --> V6{"Contradictory Accepted Event at Same Time?"}
    V6 -- Yes --> V7{"Is stock_count on_hand?"}
    V7 -- Yes --> S_Dispute["Status = 'conflict'
    - Mark lot.status = 'disputed'
    - Create 'stock_conflict' incident"]
    V7 -- No --> S_Conf["Status = 'conflict'"]

    V6 -- No --> S_Accepted["Status = 'accepted'
    - Advance state.clock if time > clock
    - Execute applyAccepted()"]

    S_Invalid & S_Dup & S_ConfKey & S_Queued & S_Stale & S_Dispute & S_Conf & S_Accepted --> Audit["Append Decision Audit Record
    (evidenceIds = [input.id])"]
```

---

## 3. Impact Assessment & Risk Scoring Logic Flow

The interaction-aware impact calculation engine (`getImpact()`) translates network disruptions, inventory holds, and warehouse outages into customer delivery exposures bounded between **0.0 and 10.0**.

```mermaid
flowchart TD
    StartCalc(["Run getImpact(state)"]) --> Step1["Initialize Available Warehouse Stock
    - Filter warehouses where status == 'online'
    - Filter lots where status == 'available' (exclude held/disputed)
    - Available = lot.quantity - lot.reserved"]

    Step1 --> Step2["Initialize Available Inbound Shipments
    - Compute availableShipment() for all shipments
    - Accounts for physical receipts and expedite deductions"]

    Step2 --> Step3["Sort Unfulfilled Customer Orders
    Priority: critical (3) > high (2) > normal (1)
    Tie-breakers: deadline ascending, order ID"]

    Step3 --> LoopOrders{"Iterate Over Each Order"}

    LoopOrders --> DeductStock["1. Consume usable local warehouse inventory
    missing = quantity - fulfilled - coveredStock"]

    DeductStock --> DeductShipments["2. Consume inbound shipments matching item & warehouse
    Condition: warehouse online AND shipment.eta <= order.deadline
    missing = missing - coveredShipment"]

    DeductShipments --> CheckCandidates["3. Evaluate Pure Recovery Candidates
    (internal_transfer, expedite, alternative_supplier)"]

    CheckCandidates --> ScoreFormula["4. Calculate 0.0 - 10.0 Impact Score:
    + Uncovered Demand: round(3.0 * exposureRatio, 1)
    + Priority & Deadlines: round(2.0 * exposureRatio * deadlineMult, 1)
    + Feasibility Tier: round(tierWeight * exposureRatio, 1)
    + Cascading Disruption: min(1.5, 0.5 * dependentOrders + 0.5 * unverifiedTier2)
    + Business Consequence: min(1.5, round(penaltyCents / 500000, 1))
    Final Score = clamp(0.0, 10.0)"]

    ScoreFormula --> DriversAndConfidence["5. Determine Drivers & Confidence:
    - Drivers: Up to 2 highest threshold-crossing factors
    - Confidence: high (full evidence), medium (stale/volatile ETA), low (missing ETA)"]

    DriversAndConfidence --> LoopOrders
    LoopOrders -- Complete --> SortImpacts["Sort Results:
    1. Score descending
    2. Hours remaining ascending
    3. Order ID"]
    SortImpacts --> ReturnImpacts(["Return Impact[]"])
```

---

## 4. Recovery Strategy Feasibility & Two-Person Authorization Pipeline

```mermaid
flowchart TD
    classDef pass fill:#e6f4ea,stroke:#137333;
    classDef fail fill:#fce8e6,stroke:#c5221f;

    subgraph Gen["Recovery Option Framework (generatePlans)"]
        direction TB
        O[Exposed Order with Shortage]
        C1["Type: 'reallocate'
        (From other warehouse lots)"]
        C2["Type: 'split_order'
        (Partial leg from other warehouse)"]
        C3["Type: 'expedite'
        (In-transit shipment express routing)"]
        C4["Type: 'alternative_supplier'
        (Approved Tier 1 suppliers)"]
        O --> C1 & C2 & C3 & C4
    end

    subgraph Val["Pure Constraint Validation"]
        direction TB
        K1{"Receiving Warehouse
        Online & Capacity >= Qty?"}
        K2{"Lot Available &
        Usable Stock >= Qty?"}
        K3{"Shipment In-Transit &
        Available Qty >= Qty?"}
        K4{"Supplier Approved &
        Capacity >= Qty >= MinOrder &
        No Disrupted Tier 2 Links?"}
        K5{"Arrival Time <= Order Deadline?"}

        C1 --> K1 --> K2 --> K5
        C2 --> K1 --> K2 --> K5
        C3 --> K1 --> K3 --> K5
        C4 --> K1 --> K4 --> K5
    end

    K5 -- Constraints Pass --> P_Feas["Plan Feasible = true"]:::pass
    K5 -- Constraints Fail --> P_Infeas["Plan Feasible = false
    (Retain with failure reasons)"]:::fail

    subgraph Auth["Risk-Tiered Authorization & Break-Glass"]
        direction TB
        ClassifyRisk{"Classify Plan Risk:
        - Alternative supplier?
        - Score >= 7.0?
        - Low confidence?
        - Cost >= $2,000 / Penalty >= $5,000?
        - Stock deduction >= 50%?"}

        ClassifyRisk -- Routine --> RoutineFlow["Routine Approval:
        Single authorized manager / procurement / admin.
        Self-approval permitted."]
        
        ClassifyRisk -- High-Risk --> HighRiskFlow["Two-Person Rule:
        Approval 1: Status -> 'awaiting_second_approval' (0 mutation)
        Approval 2: Distinct independent approver commits execution.
        Creator and modifier strictly barred from approving."]

        BreakGlass{"Admin Emergency Break-Glass?
        - Actor must be admin
        - Reason >= 20 characters
        - Explicit confirmation"}
        
        BreakGlass -- Commits --> BGCommit["Break-Glass Execution:
        Attaches reviewStatus: 'required'
        Appends audited governance record"]:::pass
    end

    P_Feas --> ClassifyRisk
```

---

## 5. Lifecycle State Machine Diagrams

### 5.1 Event Intake Status Lifecycle
```mermaid
stateDiagram-v2
    [*] --> Ingestion
    Ingestion --> invalid: Schema / Entity / Range Failure
    Ingestion --> duplicate: Idempotency Key & Canonical Payload Match
    Ingestion --> queued: Targeted Integration Offline
    Ingestion --> stale: Effective Time < Latest Accepted Time
    Ingestion --> conflict: Same Time / Scope Contradiction
    Ingestion --> accepted: Valid & Authoritative

    queued --> Ingestion: Targeted Replay after Outage Restored
    conflict --> [*]: Preserved in Journal as Evidence
    duplicate --> [*]: Safely Ignored
    invalid --> [*]: Preserved in Journal
    stale --> [*]: Preserved in Journal
    accepted --> OperationalCommit: applyAccepted()
    OperationalCommit --> [*]
```

### 5.2 Inventory Lot Status Lifecycle
```mermaid
stateDiagram-v2
    [*] --> available: Initial Ingestion / Receipt
    available --> held: Manual Hold by Warehouse Supervisor or Admin
    available --> disputed: Contradictory on_hand Stock Count
    
    held --> available: Quality Release by Warehouse / Admin
    
    disputed --> available: Reconciled by Admin with Newer Accepted Count
    disputed --> [*]: Stock Remains Excluded from Allocations
```

### 5.3 Recovery Plan Status Lifecycle
```mermaid
stateDiagram-v2
    [*] --> proposed: Generated by Operator or Deterministic Engine
    proposed --> proposed: Modified (quantity adjusted, version++)
    proposed --> rejected: Rejected by Reviewer
    proposed --> stale: Pre-execution constraint revalidation fails
    proposed --> awaiting_second_approval: First Approval (High-Risk Plan)
    awaiting_second_approval --> executed: Second Distinct Approval Commits
    proposed --> executed: Single Approval (Routine Plan)
    proposed --> executed: Admin Break-Glass Execution (Reason >= 20 chars)
    
    rejected --> [*]
    stale --> [*]
    executed --> [*]
```

### 5.4 Freight Document Claim Status Lifecycle
```mermaid
stateDiagram-v2
    [*] --> uploading: Upload Initiated (up to 25 MB / 100 pages)
    uploading --> processing: Worker Claims Async Job
    processing --> failed: Exceeds 100 Pages or Unparseable Bytes
    processing --> review: Missing Fields or Scanned Text
    processing --> mismatch: Shipment Not Found or Quantity Discrepancy
    processing --> matched: All Fields Valid & Align with Shipment
    
    review --> confirmed: Explicit Reviewer Confirmation
    mismatch --> confirmed: Explicit Reviewer Confirmation
    matched --> confirmed: Explicit Reviewer Confirmation
    
    confirmed --> [*]: Document Claim Confirmed in Decision Trail
    failed --> [*]: Actionable Error Preserved
```

---

## 6. Mathematical Evaluation & Correctness Criteria

To evaluate whether DisruptionIQ operations are executing correctly, verify the following mathematical bounds and logic constraints:

### 6.1 Inventory Accounting Conservation Invariant
For any inventory lot $L$:
$$0 \le L.\text{reserved} \le L.\text{quantity}$$
$$\text{usableStock}(L) = \begin{cases} L.\text{quantity} - L.\text{reserved} & \text{if } L.\text{status} = \text{'available'} \land \text{warehouse is online} \\ 0 & \text{otherwise} \end{cases}$$

### 6.2 Partial Delivery & Expedite Accounting Invariant
For any shipment $S$ with physical receipts $R_1, \dots, R_m$ and expedite plans $E_1, \dots, E_k$:
$$\text{physicalReceived} + \text{expedited} \le S.\text{quantity}$$
$$\text{availableShipment}(S) = \begin{cases} 0 & \text{if } S.\text{status} = \text{'delivered'} \\ \max(0, S.\text{quantity} - (\text{physicalReceived} + \text{expedited})) & \text{otherwise} \end{cases}$$
When an expedite plan of quantity $Q$ executes, it reserves $Q$ units of transit capacity. Subsequent cumulative delivery receipts of value $V$ add newly received stock $\Delta$ according to:
$$\Delta = \max\left(0, \max(V - \text{expedited}, 0) - \text{physicalReceived}\right)$$
This guarantees that units expedited express are never counted twice when the underlying container arrives.

### 6.3 Customer Order Exposure Invariant
For any open order $O$:
$$0 \le O.\text{fulfilled} \le O.\text{quantity}$$
$$\text{shortage}(O) \le O.\text{quantity} - O.\text{fulfilled}$$
An order's uncovered shortage cannot exceed its remaining unfulfilled units.

### 6.4 Risk Score Bounding & Drivers
For any impact assessment $I$:
$$0.0 \le I.\text{score} \le 10.0$$
Score calculation is strictly bounded between $0.0$ and $10.0$ with 1 decimal place. Exactly zero shortage yields $0.0$.
$$\text{bottleneckDrivers} \le 2$$
At most two primary bottleneck factors crossing operational thresholds are highlighted for immediate human triage.

### 6.5 Risk-Tiered Governance Invariant
For routine actions, authorized self-approval by manager, procurement, or admin is permitted. For high-risk actions ($S \ge 7.0$, alternative supplier, cost $\ge \$2,000$, penalty $\ge \$5,000$, consumption $\ge 50\%$, or low confidence):
$$\text{approvals}.\text{length} = 2 \land A_1.\text{id} \ne A_2.\text{id} \land A_i.\text{id} \ne P.\text{createdBy} \land A_i.\text{id} \ne P.\text{lastModifiedBy}$$
Break-glass execution permits an administrator to bypass the dual approval requirement only with an auditable justification of $\ge 20$ characters, setting `reviewStatus: 'required'`.
