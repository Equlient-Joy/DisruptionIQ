# Aster Electronics: selected-feature demonstration

This is an explicit fictional source, loaded only by the presenter. It contains three UTC days and five customer orders. All required catalogs arrive on day 1: 6 suppliers, their partner affiliation, 2 upstream dependencies, 4 warehouses, 9 lots and 4 shipments. Customers are recorded on orders, and partner participation uses the existing partner organization; no independent customer or partner tables are invented. Accounts, incident tasks, plans and audit records are managed by the application.

## Features covered

Day 1: Enterprise supply network and interactive dashboard. Day 2 and day 3: #4 upstream propagation, #6 warehouse outage, #13 recovery feasibility/execution, #17 conversational AI/what-if, and #18 history/audit export. AI and audit are available throughout; they do not require extra incident days.

## Load and roles

Sign in as Supply Chain Manager or Administrator. In Data & Evidence, choose judges-selected-features.json, Load simulation dataset, then Start day 1. The simulation requires an empty operational workspace; this export does not clear or import anything automatically. Use Operations Analyst to generate recovery proposals and Supply Chain Manager to review them. If the application marks a chosen proposal high risk, use Administrator as the second independent reviewer; do not generate that proposal as its intended approver.

## Day 1: 2026-11-01 - healthy opening

Four ordinary dispatch/receipt events arrive. Expected result: zero incident records, zero exposed orders, and no shortage. The connector shipment has received 20 of 60 units; its linked lot rises from 80 to 100. Show named nodes, zoom/pan, click supplier/customer/warehouse details, and inspect the verified shared upstream relationship. Sourcing approval and operational health are different; an alternate supplier without transit evidence may correctly display Unknown.

Optional AI prompt: "Show current shipments and their latest ETAs." A useful preview before advancing: "What if SHP-MCU-EAST is delayed by 48 hours?" This should expose Civic Health Devices without changing the workspace.

## Day 2: 2026-11-02 - one supplier-delay incident

The connector receipt increases cumulatively to 40; only 20 additional units are added. NovaSilicon Foundry announces a 48-hour delay, affecting Helios Boards and Orion Circuit Assembly. Exactly one new incident is created: supplier_delay. Both controller orders miss their original supply window: 60 + 40 = 100 uncovered units. No separate shipment_eta events create additional late-shipment incidents.

1. Show the root supplier, downstream entities and affected orders in the graph.
2. Open the incident and ask AI for its cause, affected orders and recovery options.
3. As Operations Analyst, generate recovery proposals. All four recovery strategies have feasible candidates; the small reserve also supplies examples blocked by insufficient unreserved stock. Summit is independent of the disrupted foundry.
4. Recommended execution: for ORD-HEALTH-MCU choose reallocate from LOT-RESERVE-MCU, quantity 60; then for ORD-AUTOMATION-MCU choose reallocate from the same reserve, quantity 40. Review the actual risk badge and required approvals.
5. With both full reallocations executed, the reserve falls from 600 to 500 physical units, its 100 reserved units remain, orders become fulfilled and the supplier incident resolves. No outcomes are pre-approved in the dataset.
6. Open History: inspect proposal, approval and execution records with evidence and before/after snapshots. Export the complete operational audit as JSON or a printable HTML report.

## Day 3: 2026-11-03 - one warehouse-outage incident

The connector receipt increases cumulatively to 60, adding only the final 20 units; its stock reaches 140. Then West Distribution Hub goes offline. Exactly one new incident is created: warehouse_outage. Its power-module and connector orders expose 140 units because receiving and stock access are blocked. Day 2 recoveries, physical stock changes, reservations and audit history remain intact. If day 2 was left unresolved, that prior incident remains; it is not a newly created day 3 incident.

1. Show the warehouse health and its two affected customers. Generate proposals to show that destination outage blocks all recovery paths. The current engine requires an online receiving warehouse; it cannot silently reroute an order to another destination.
2. Ask AI: "What if WH-WEST is restored online?" Its what-if should reduce outage-related shortage by 140 units without changing actual warehouse status.
3. To resolve the actual outage, import judges-selected-features.restore-warehouse.json through Data & Evidence -> Import CSV / JSON -> Events -> JSON. This companion is one explicit presenter action, not an automatically delivered restoration. Alternatively, Capture event with type warehouse_outage, entity WH-WEST, time 2026-11-03T18:00:00.000Z and payload {"status":"online"}.
4. With the warehouse restored, its existing stock covers both orders and the outage incident resolves. This does not mark those customer orders fulfilled or fabricate a recovery execution; distinguish restored coverage from actual fulfillment.
5. Show the resulting History timeline and export the complete audit. Separate AI execution logs are excluded from this export, as requested.

## AI and boundaries

Entity queries and what-if calculations use existing deterministic tools. Generated model summaries require a configured AI provider. Hypothetical results never authorize or execute a recovery. Recovery actions remain human-triggered and are revalidated against current resources.

Pause prevents further day delivery; Resume enables the controls without delivering automatically. Source rows are not reloaded or reset daily. No stock-count, document-mismatch, quality-hold or integration-outage scenarios are included in this selected presentation.
