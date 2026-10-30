# DisruptionIQ: selected feature scope and challenge requirements

Updated 30 October 2026. Status: feature selection established by the user; detailed design remains open.

The product consists of base supply chain management plus ChatGPT research opportunities **1, 2, 3, 4, 6, 7, 8, 9, 11, 12, 13 and 15**. All twelve are in scope. The earlier opportunity summary's recommended priorities and deferrals do not override this selection.

## Authority and interpretation

- The user's request determines the additional opportunities to include.
- The user explicitly adopts the supplied problem statement's requirements and constraints. These are mandatory and cannot be dropped to accommodate an additional feature.
- The ChatGPT PDF supplies the opportunity numbering and descriptions. Its suggested architecture, technology choices, schedules, metrics and demonstrations are research proposals, not additional challenge rules or authorization to implement them unchanged.
- The Gemini report and earlier consolidated summary remain supporting research. They do not expand the selected scope or settle the open data-design questions.
- Feature inclusion is settled. The operating domain, exact feature depth, data contracts, integrations, database technology and permission matrix still require design. This document records scope and verification criteria; it does not claim that an application already exists.

Source numbering is from section 4, "Fifteen problem and opportunity areas," on pages 6-10 of the ChatGPT PDF. These are opportunity numbers, not report chapter numbers.

## Mandatory base and challenge workflow

The challenge is "PS 1: DisruptionIQ - From Delivery Delays to Recovery Plans," in Logistics and Supply Chain Management. It requires combining shipment, inventory, supplier and order data to find downstream risks, prioritise affected customer orders and recommend recovery plans.

For this scope, the mandatory base covers linked operational records and the following complete workflow. Additional ordinary SCM modules are not specified by the supplied statement and remain a design question.

### Must include: compliance checklist

The requirement column below follows the supplied problem statement. The evidence column is a proposed way to verify it, not an official scoring scheme.

| ID | Mandatory requirement | Evidence to demonstrate |
|---|---|---|
| B1 | Data import from CSV/JSON and at least one simulated carrier webhook. | Import representative CSV and JSON files; submit a simulated carrier event through the webhook and show its processing. |
| B2 | Linked data model: suppliers, shipments, warehouses, inventory and orders. | Follow a shipment/supplier relationship through inventory to affected order lines; persist these relationships. |
| B3 | Detection of late shipments, supplier delays and stock shortages, with impact analysis. | Exercise all three detection types across the demonstration scenarios; show affected orders and the dependency path. |
| B4 | Risk ranking of orders with an explanation of the factors. | Show ordered affected orders with the actual factors and inputs contributing to each result. |
| B5 | AI-assisted recovery options: reallocate stock, expedite, alternative supplier and split order, based on available data. | Demonstrate the four supported option types across the dataset; show feasible options and why others fail. AI must participate in summaries/recommendations. |
| B6 | Approve/reject/modify workflow; execution simulated only after confirmation. | Exercise each workflow action. Show no operational state change before confirmation and a simulated change after valid confirmation. |
| B7 | Notifications and a full audit trail. | Show a delivered in-application notification or another designed notification mechanism, and trace ingestion, decisions, approval actions and simulated execution. |
| B8 | Dashboard of active disruptions, affected orders, pending approvals and recovery progress. | Show all four views using current persisted data. |
| B9 | Backend-enforced role-based access for Operations Analyst, Supply Chain Manager, Warehouse Operator, Procurement Approver and Administrator; no self-approval where separation of duties applies. | Exercise backend permission checks for the defined role matrix, including unauthorized requests and prohibited self-approval. UI controls alone are insufficient. |

### Constraints: compliance checklist

| ID | Mandatory constraint | Evidence to demonstrate |
|---|---|---|
| C1 | Persistent database required. | Restart the application/backend and show retained records, relationships and decision history. |
| C2 | Generate our own synthetic data; no dataset is provided. | Supply reproducible fictional data and known expected outcomes. |
| C3 | Demonstrate at least two disruption scenarios. | Run two distinct scenarios from a clean dataset; show detection through impact, recovery, review and confirmed simulated execution. |
| C4 | AI for summaries and recommendations; inventory rules, deadlines and permissions must use deterministic logic. | Show structured facts grounding AI output and deterministic checks controlling quantities, time feasibility, permissions and state changes. |
| C5 | Handle duplicate events, invalid data and conflicting updates safely. | Re-submit an event, submit an invalid record and introduce a genuine conflict; preserve evidence without double counting or silently corrupting operational state. |

The supplied **two-page problem statement contains no separate evaluation rubric, numeric marks or criterion weights**. B1-B9 and C1-C5 are the verified mandatory checklist. Metrics suggested in the research PDF are supplementary prototype measurements, not official scoring criteria.

## Selected opportunities

The titles and page references below follow the ChatGPT PDF. The feature slices, data needs and acceptance evidence translate those selections into planning inputs. Exact limits and implementation details remain open; none of these rows is deferred or optional by default.

| Research number | Opportunity | Intended addition above the mandatory base | Minimum additional data | Acceptance evidence |
|---|---|---|---|---|
| 1 | Data reconciliation and trust | Preserve raw claims, map identifiers, deduplicate events, expose provenance/freshness and resolve conflicting operational facts. | Source records, internal/external ID mappings, event and received times, units, lot/location/scope, idempotency keys and resolution records. | A duplicate cannot add stock twice; a genuine same-scope contradiction remains visible; disputed stock cannot silently become available. |
| 2 | ETA confidence and volatility | Show ETA revision history, stability, stale/missing evidence and the consequences for customer deadlines. | Shipment ETA history, prediction/source timestamps, milestones, freshness rules and order deadlines. | Two shipments with the same latest ETA show different stability/confidence when their evidence differs; explain any resulting priority difference. |
| 3 | Constraint-validated recovery | Check candidate recovery options against current usable stock, commitments, capacity, lead times and deadlines; compare feasible choices and explain rejected choices. | Reservations, inventory status, transport/handling durations, receiving/transport capacity, alternate supplier eligibility, relevant minimums, costs and commitments. | Reject an attractive but infeasible option with the exact failed constraint; recheck modified or stale proposals before confirmed simulated execution. |
| 4 | Multi-tier supplier dependencies | Expose upstream facility/component dependencies and shared exposure between apparently independent tier-1 suppliers. | Supplier/facility/component identities, declared dependency edges or BOM links, evidence, verification status and edge confidence. | Two tier-1 suppliers share a declared tier-2 dependency; an upstream disruption reaches both and their linked orders. Unknown links remain visible. |
| 6 | Freight document automation | Extract selected document fields, normalize them, match documents to PO/shipment records and review discrepancies or uncertain fields. | Sample freight documents, extracted field values, source locations, extraction confidence, PO/shipment references and correction history. | Process a sample document, match it to operational records and flag a seeded discrepancy; uncertain fields require confirmation before affecting trusted facts. |
| 7 | Cross-company collaboration | Coordinate one incident through shared evidence, ownership, tasks, deadlines and scoped participant access. | Organization/participant identities, incident memberships, tasks, owners, due dates, activity records and access scope. | Different participants see permitted incident information and their assigned tasks; unrelated organization data and approval powers remain protected by backend checks. |
| 8 | Alert prioritization and noise reduction | Correlate related alerts into incidents, preserve their evidence and prioritize incidents/orders by business exposure and recoverability. | Alert-to-incident relationships, entity/time/root-cause correlation inputs, deadlines, shortages/cover, criticality, confidence and configured scoring factors. | Multiple alerts for one cause become one incident without losing evidence; show why an urgent affected order ranks above a less exposed order. |
| 9 | Cascading and compound disruptions | Propagate combined incidents through dependencies and shared resources; expose overlapping orders and recovery bottlenecks. | Dependency paths, scenario events, event timing, shared resource limits, allocations and single/combined outcome snapshots. | Compare supplier delay alone, warehouse outage alone and both together; compute joint exposure without double counting shared orders or stock. |
| 11 | Supply-chain data observability | Monitor semantic invariants, freshness, completeness, uniqueness and cross-record validity; explain the operational consequences of anomalies. | Domain rules, expected references/transitions, freshness thresholds, validation results, lineage and anomaly-to-business-object links. | Identify seeded impossible transitions, invalid quantities, stale records and broken references; identify affected inventory/orders or explicitly explain why impact cannot be determined. |
| 12 | Continuity fallback during outages | Retain limited incident/event capture during a simulated integration outage and reconcile queued updates after restoration. | Durable queue records, event IDs, event and received times, operator identity, replay status, ordering/version information and conflicts. | Survive a restart with queued events; replay without duplicate effects; a delayed old event cannot silently overwrite newer truth. Exact offline boundary remains to be designed. |
| 13 | AI accountability and decision traceability | Make each recommendation reconstructable from evidence, assumptions, rules, alternatives, model/version, human authorization and simulated outcome. | Decision versions, input/evidence snapshots, rule versions/results, model identifier/version, structured rationale, alternatives, approvals and before/after state. | Inspect why a plan was suggested, why alternatives were rejected, who approved it and what changed; retain prior versions after modification. |
| 15 | Condition monitoring and quality exposure | Connect sensor/inspection events to lots, usable stock and orders; identify excursions and support quarantine, disposition review and replacement recovery. | Product-specific condition limits and duration rules, timestamped readings/inspections, sensor-to-shipment/lot links, lot inventory status and disposition authority/history. | A synthetic excursion affects a known lot, blocks its allocation pending review and exposes dependent orders; authorized disposition and replacement planning are recorded. |

### Boundaries and distinctions that preserve the selections

- **1 versus 11:** reconciliation establishes what conflicting source claims support; observability detects violations of supply-chain data rules and their business consequences. They can share validation/evidence infrastructure while providing distinct results.
- **2 versus 8:** ETA confidence concerns prediction evidence and revisions; alert prioritization uses that evidence alongside deadline, shortage and criticality factors. A heuristic confidence label is not a calibrated delivery probability.
- **3 versus 9:** recovery validation checks an action's feasibility; compound analysis considers multiple incidents competing for the same dependencies and resources. Joint feasibility must use current shared allocations.
- **7 versus 13:** collaboration tracks participants, tasks and coordination; decision traceability reconstructs the operational decision and result. External incident access does not grant approval authority.
- **15 feeds the base and 3:** on-time stock can still be unusable because of a quality hold. Hold status must affect deterministic allocation and recovery calculations.
- **12 feeds 1, 11 and 13:** restored updates pass through validation and reconciliation and preserve their original timing and identity. Replay cannot bypass permissions or confirmation requirements.

## Opportunities not selected

| Research number | Opportunity | Scope boundary |
|---|---|---|
| 5 | Actionable supplier risk | No separate broad supplier-intelligence/news-scoring workflow. Mandatory supplier-delay detection and selected dependency impact analysis still apply. |
| 10 | Affordable SME disruption intelligence | No separate SME affordability/onboarding product initiative. Mandatory CSV/JSON import still applies. |
| 14 | Multimodal handoff and custody gaps | No dedicated multimodal route/custody workflow. Shipment updates, document evidence and semantic validation required by the base/selected features still apply. |

Unselected opportunity modules do not remove overlapping mandatory capabilities. Likewise, selecting an opportunity does not adopt every technology or production integration suggested in its research description.

## Missing-data behavior to carry into data design

These safeguards are planning criteria for safe behavior. Source-specific policies and exact thresholds remain open.

- Keep observed facts, partner declarations, inferred links and fictional scenario assumptions distinguishable.
- Unknown upstream links limit the reachable impact graph; absence of a declared dependency does not prove supplier independence.
- With no ETA revision history, report insufficient evidence for volatility/confidence instead of inventing certainty.
- With absent capacity, transit duration, eligibility or usable-stock evidence, mark feasibility unknown or request verification. Do not present an unchecked plan as verified feasible.
- Different lifecycle quantities are not automatically contradictory: "100 dispatched, 60 collected, 40 received" can be a valid partial movement. Compare the same item/lot, quantity meaning, location, effective time and scope before declaring a conflict.
- Unmatched or uncertain document fields remain reviewable claims until confirmed and linked. Document extraction must not silently override trusted inventory records.
- Missing or ambiguous sensor-to-lot mapping means the potentially affected stock cannot be precisely identified. Missing readings or thresholds cannot prove goods are acceptable; flag the gap for review.
- If a record has broken dependencies, show what can and cannot be assessed. Do not label an order unaffected solely because its linkage is missing.
- During an outage, expose data freshness and queued status; replay history remains auditable, and old approvals must be checked against restored current state.

## Proposed demonstration coverage

These are candidate coverage scenarios, not accepted datasets, fixed timestamps or official evaluation scenarios. They combine selected features so that every selection is visible without requiring twelve unrelated demos.

| Scenario | Proposed demonstration | Coverage |
|---|---|---|
| A: shared supplier delay and compound warehouse outage | Two tier-1 suppliers share a declared tier-2 dependency. A supplier delay creates downstream late-shipment/shortage exposure; a warehouse outage restricts a recovery resource. Include stable/volatile ETA histories, duplicate and truly conflicting updates, correlated alerts and participant tasks. Compare each disruption alone and both together. Review feasible/rejected reallocation, expedite, alternative-supplier and split-order candidates; modify/reject a proposal and confirm a valid one. | Base B1-B9; opportunities 1, 2, 3, 4, 7, 8, 9, 11 and 13. |
| B: condition excursion, document mismatch and integration outage | An on-time shipment contains a lot with a synthetic condition excursion. Extract a freight document and review a quantity mismatch; quarantine the affected lot and identify order shortages. Queue updates through a simulated outage/restart, replay with duplication and an older event, then reconcile and review a replacement recovery plan. | Base detection/impact/recovery/confirmation; opportunities 1, 3, 6, 7, 11, 12, 13 and 15. |

Both scenarios must use consistent quantities, units, reservations, times and relationships. Expected affected orders and permissible state changes should be written before implementation. Synthetic quality thresholds demonstrate configured rules; they do not establish real product safety or regulatory certification.

## Decisions still open

The feature selection does not settle the ongoing data-design interview. Continue that discussion one component at a time:

1. Focal organization and operating domain: whose supply chain and which goods/processes anchor the model?
2. Cross-company boundary: what can each participating organization disclose, read, change and approve?
3. Source boundary: which facts are synthetic, imported, declared by participants or supplied by named integrations?
4. Opportunity depth: document types/fields, dependency tiers, modeled capacities, condition types and the outage/offline boundary.
5. Domain semantics: stock states, reservations, lots, units, deadlines, partial shipments, missing data and correction authority.
6. Exact role/action matrix, separation-of-duties rules and quality-disposition permissions using the five mandatory roles.
7. Only after these meanings are settled: schema, database choice, API contracts, feature sequence and implementation plan.

All twelve selections remain included while these decisions are worked through. No stack, timeline or production write-back has been accepted by this scope update.

## Sources

- [Problem statement](<C:/Users/LENOVO/Desktop/Hackathon/docs/Planning/problem statement.pdf>), both pages, visually inspected: mandatory challenge requirements and constraints.
- [ChatGPT supply-chain research](<C:/Users/LENOVO/Desktop/Hackathon/docs/Planning/chatgpt- supply chain research.pdf>), section 4, pages 6-10: original opportunity numbering, titles and descriptions.
- [Current data-design notes](<C:/Users/LENOVO/Desktop/Hackathon/docs/Planning/data-design.md>): existing open questions; the latest user selection updates scope without answering those questions.
