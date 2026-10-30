# DisruptionIQ data design

Status: interview in progress. Updated 30 October 2026.

This document records the data-design discussion. Recommendations are proposals until the user accepts them. The earlier opportunity summary is research synthesis, not an approved application design.

## Feature scope established 30 October 2026

The user selected ChatGPT research opportunities **1, 2, 3, 4, 6, 7, 8, 9, 11, 12, 13 and 15** on top of base supply chain management and explicitly required strict adherence to the problem statement. All twelve selections are included; the earlier summary's priorities and deferrals no longer determine scope. Opportunities **5, 10 and 14** are not selected as additional modules; overlapping mandatory baseline capabilities still apply.

See [selected feature scope and challenge checklist](<C:/Users/LENOVO/Desktop/Hackathon/docs/Planning/selected-feature-scope.md>) for the exact opportunity names, data needs, safe missing-data behavior and compliance evidence. The two-page problem statement lists mandatory features and constraints, but no separate weighted evaluation rubric. Research metrics must not be presented as official scoring criteria.

This settles feature inclusion only. The operating domain, organizational view, integration boundary, undisclosed-dependency behavior, detailed permissions and schema choices below remain open.

## User-established intent

- Plan the application one component at a time, beginning with data.
- Work slowly and examine inputs, outputs, processing, ownership, access limitations, integrations, and the database model in detail.
- For each opportunity, identify the data and connections needed to support it and what happens when those data are unavailable.
- Examine multi-tier shared-supplier exposure, supplier participation, API integrations, manual CSV/JSON imports, geopolitical signals, and limits on interpreting risk.
- Record settled vocabulary and significant design decisions as the discussion proceeds.

## Challenge constraints

The supplied problem statement requires CSV/JSON imports, at least one simulated carrier webhook, linked suppliers/shipments/warehouses/inventory/orders, persistence, synthetic data, and at least two disruption scenarios. Inventory rules, deadlines, permissions, and safe handling of invalid/duplicate/conflicting updates use deterministic logic. Simulated execution follows confirmation. These are challenge constraints, not choices of database technology or production integration architecture.

## First decision round: open

1. Whose operational view does the product serve: a focal company's private view of its supply chain, or a shared network across participating companies?
2. Which operating domain anchors the initial design: component-based manufacturing, distribution of finished goods, or another specific domain?
3. What data-access boundary should the initial version support: synthetic demonstrations and manual imports, or named real integrations as well?
4. How should the product represent and act on undisclosed or unverified upstream dependencies?

No answers have been accepted yet.

## Existing project state

Read-only workspace reconnaissance found planning documents only, with no application code, database schema, migrations, or synthetic datasets. No existing CONTEXT.md, ADRs, or applicable AGENTS.md were found. Technology, integration, and data-model proposals in the opportunity summary have not been accepted as design decisions.

## Decision tree

- Operating domain and focal business
  - Business objects, quantities, units, locations, and time semantics
  - Required decisions and their output contracts
  - Minimum data for each decision
- Organizational view and permitted access
  - Ownership and authority of each fact
  - External participation and disclosure boundaries
  - Permissions, confidentiality, and organization-specific supplier identity
- Initial source/integration boundary
  - Imports, supplier declarations, internal exports, and webhook contracts
  - Real connector/provider evaluation when scope is settled
  - Validation, event ordering, freshness, reconciliation, and correction
- Evidence and unknown dependencies
  - Observed facts, partner declarations, inference, and scenario assumptions
  - Geographic signals versus facility-specific operational disruption
  - Coverage, confidence, verification, and behavior when data are missing
- Agreed domain objects and data contracts
  - Relationships, cardinalities, history, and consistency rules
  - Database choice and schema
  - Representative datasets and acceptance scenarios

Branches will be revisited as answers reveal additional decisions. A schema will follow agreed domain meanings and data contracts.

## Documentation discipline

Create the root CONTEXT.md glossary when the first term is resolved; use it only for domain vocabulary. Create an ADR only for an accepted decision with meaningful reversal cost, a real trade-off, and context a future reader would need. Until then, keep proposals and open questions here.
